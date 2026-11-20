#!/usr/bin/env node
/**
 * `doc-workbench/1` 命令后端：侧栏里的块级工作台。
 *
 * 侧栏宿主只 serve 静态文件，不转发页面的 `/api/*`。所以页面在侧栏里把每一次保存、
 * 派发、裁决、重排都交给 `review.command(...)`；`scripts/lib/review-command.mjs`
 * 把命令送到这里，这里再用**与本地页同一个** `doc-session` 写盘 —— 不另写一份解析、
 * 块级写、journal 或锁判定。
 *
 * 为什么任务板与待核对要落盘（`.doc-workbench/state/`）：模型可能不在这个进程里。
 * 页面派发后，唤醒的模型用下面的 CLI 读任务、加锁、写回；两条路径必须看到同一块锁。
 *
 * 模型侧 CLI（同一份命令后端，不经浏览器口）：
 *   node scripts/doc-command.mjs <review-surface.json> tasks
 *   node scripts/doc-command.mjs <review-surface.json> claim <task_id>
 *   node scripts/doc-command.mjs <review-surface.json> complete <task_id>
 *   node scripts/doc-command.mjs <review-surface.json> patch        # JSON 从 stdin
 *   node scripts/doc-command.mjs <review-surface.json> conflicts
 *
 * 通道只有一套动作词汇：`route` 就是本地宿主那条路的动作名，`body` 是本地服务器本来就会
 * 收到的原始请求体。本地页与侧栏桥发同一个 `{route, body}`，桥不翻译、只转发。
 *
 * 白名单管身份，不管动作：claim / patch / complete 是模型侧身份，从浏览器口一律拒绝；
 * 页面需要的其余动作全部放行。这份身份表是 `review-command.mjs` 唯一使用的来源。
 */
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createDocSession } from './lib/doc-session.mjs';
import { createTaskDispatcher } from './lib/doc-dispatch.mjs';

export const DOC_COMMAND_BACKEND = 'doc-workbench/1';
export const DOC_BINDING_CONTRACT = 'doc-surface/1';

const COMMAND_CLI = fileURLToPath(import.meta.url);
const fail = (code, message) => { throw Object.assign(Error(message), { code }); };

/**
 * 模型侧身份：领取任务、回写 patch、完成。它们只能从模型 CLI 进来；
 * 浏览器口一律拒绝。这不是动作白名单 —— 页面需要的动作都在下面那张路由表里，
 * 桥不再维护另一份名字。
 */
export const DOC_IDENTITY_ROUTES = new Set(['claim', 'complete', 'patch']);

/**
 * 路由表：`route` = 本地宿主那条路的动作名，`body` = 本地服务器本来就会收到的原始请求体。
 * 页面（本地 HTTP 与侧栏桥）与模型 CLI 共用这一张表，没有第二份动作名。
 */
const ROUTES = {
  open: ({ session }) => ({ ok: true, ...session.snapshot() }),
  block: ({ session, body }) => session.saveBlock(body),
  split: ({ session, body }) => session.splitBlock(body),
  merge: ({ session, body }) => session.mergeBlocks(body),
  reorder: ({ session, body }) => session.reorder(body),
  asset_replace: ({ session, body }) => session.replaceAsset(body),
  async feedback({ surface, session, body }) {
    const receipt = session.submitFeedback(body);
    const dispatch = await dispatchFor(surface, receipt.task);
    return { ...receipt, dispatch };
  },
  tasks: ({ session }) => session.tasks(),
  claim: ({ session, body }) => session.claim(body),
  complete: ({ session, body }) => session.complete(body),
  patch: ({ session, body }) => session.patch(body),
  conflicts: ({ session }) => session.conflicts(),
  decide: ({ session, body }) => session.decide(body),
  history: ({ session }) => session.history(),
  restore: ({ session, body }) => session.restore(body),
};

/** 通道认识的每一个动作名（页面 + 模型侧），只有这一份。 */
export const DOC_ROUTES = new Set(Object.keys(ROUTES));

/**
 * 工作稿身份不在通用 surface 契约里（契约不表达审阅语义），而是生成 surface 时写在
 * 它旁边的 `binding.json`。命令后端只从这里解析文档，绝不接受命令体自带的路径。
 */
export function docBindingOf(surface) {
  const base = surface?.base ?? (surface?.file ? dirname(surface.file) : null);
  if (!base) fail('doc_binding_missing', 'doc-workbench/1 需要宿主给出 surface 文件位置');
  const bindingPath = join(base, 'binding.json');
  if (!existsSync(bindingPath) || !statSync(bindingPath).isFile()) {
    fail('doc_binding_missing', `找不到工作稿绑定：${bindingPath}`);
  }
  let binding;
  try {
    binding = JSON.parse(readFileSync(bindingPath, 'utf8'));
  } catch {
    fail('doc_binding_missing', `工作稿绑定不是合法 JSON：${bindingPath}`);
  }
  if (!binding || binding.contract !== DOC_BINDING_CONTRACT || typeof binding.doc !== 'string' || !binding.doc) {
    fail('doc_binding_missing', `工作稿绑定形状不对（需要 ${DOC_BINDING_CONTRACT}）：${bindingPath}`);
  }
  let docPath;
  try {
    docPath = realpathSync(resolve(base, binding.doc));
  } catch {
    fail('doc_binding_missing', `绑定的工作稿不存在：${resolve(base, binding.doc)}`);
  }
  const root = surface.projectRoot ? realpathSync(surface.projectRoot) : null;
  if (root && docPath !== root && !docPath.startsWith(root + sep)) {
    fail('doc_binding_missing', '绑定的工作稿落在 project_root 之外');
  }
  if (!statSync(docPath).isFile()) fail('doc_binding_missing', `绑定的工作稿不是文件：${docPath}`);
  return { docPath, bindingPath };
}

/** 唤醒文案：模型要凭它直接开工，所以任务、稿子、块、人的话、下一步命令都在里面。 */
export function wakeTextOf(surface, task) {
  const surfaceFile = surface?.file ?? '';
  const next = surfaceFile
    ? `node ${COMMAND_CLI} ${surfaceFile} tasks`
    : `node ${COMMAND_CLI} <surface.json> tasks`;
  const anchors = task.blocks.map((block) => block.anchor).join('、');
  return [
    `文字工作台派发了一条块级反馈任务 ${task.id}。`,
    `工作稿：${task.doc.path}`,
    `只改这些块：${anchors}（块外一个字都不要动）。`,
    '',
    `人的意见：${task.text}`,
    '',
    `下一步：运行 \`${next}\` 读取任务，claim 后按块 patch 写回；不要直接重写整份文件。`,
  ].join('\n');
}

function dispatchFor(surface, task) {
  const channel = surface?.host === 'local' ? 'inbox' : 'wake';
  const base = { task_id: task.id, status: task.status };
  if (channel === 'inbox') {
    // 没有插件（本地宿主）：同一条任务落收件箱，模型用 doc-inbox 读，与本地页完全一致。
    const delivered = createTaskDispatcher({ docPath: task.doc.path })(task);
    return delivered.then((receipt) => ({ ...receipt, channel: 'inbox', task_id: task.id, status: task.status }));
  }
  const surfaceFile = surface?.file ?? '';
  return {
    ...base,
    channel: 'wake',
    text: wakeTextOf(surface, task),
    next: surfaceFile ? `node ${COMMAND_CLI} ${surfaceFile} tasks` : '',
  };
}

/**
 * 同一进程里的会话缓存：侧栏每 3 秒要读一次锁，每次重新恢复 journal / 补锚点太浪费。
 * 会话本身不在内存里攒文档内容，每次快照都读盘；任务板在每次写前 refresh，所以缓存
 * 不会让另一个进程（模型 CLI）的改动看不见。
 */
const sessions = new Map();
async function sessionFor(docPath) {
  const existing = sessions.get(docPath);
  if (existing) return existing;
  const created = await createDocSession({ docPath });
  sessions.set(docPath, created);
  return created;
}

/**
 * 执行一条 doc-workbench 命令。调用方（review-command 或 CLI）已经做过路径包含性校验；
 * 这里再按身份边界收窄一次，并只从 binding.json 解析文档。
 */
export async function runDocCommand(surface, payload, { browser = true } = {}) {
  try {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      fail('command_shape', 'Command must be a JSON object');
    }
    const { route } = payload;
    if (typeof route !== 'string' || !route) fail('command_shape', 'Command 需要 route（本地宿主的动作名）');
    const body = payload.body === undefined ? {} : payload.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) fail('command_shape', 'Command body 必须是 JSON 对象');
    // 身份边界，不是动作白名单：模型侧动作不能从浏览器口进来。
    if (browser && DOC_IDENTITY_ROUTES.has(route)) {
      fail('command_operation', `浏览器不能执行模型侧动作 ${route}：领取任务 / 回写 patch / 完成只能走 doc-command.mjs CLI`);
    }
    const handler = ROUTES[route];
    if (!handler) fail('command_operation', `未知的动作 ${route}；动作名就是本地宿主的路由名`);
    const { docPath } = docBindingOf(surface);
    const session = await sessionFor(docPath);
    return await handler({ surface, session, body });
  } catch (error) {
    return {
      ok: false,
      code: error?.code ?? 'doc_command',
      error: error?.message ?? String(error),
      ...(error?.details ? { details: error.details } : {}),
    };
  }
}

/** CLI 自己按宿主的方式解析 surface：路径只从 surface 文件推，不信任命令行以外的上下文。 */
function loadSurfaceForCli(surfacePath) {
  const file = realpathSync(resolve(surfacePath));
  if (!statSync(file).isFile()) throw Error(`不是文件：${file}`);
  const data = JSON.parse(readFileSync(file, 'utf8'));
  if (data?.contract_version !== 'review-surface/2.0.0') throw Error('surface 契约版本不对');
  if (data.command_backend !== DOC_COMMAND_BACKEND) throw Error(`不是 ${DOC_COMMAND_BACKEND} 的 surface`);
  const base = dirname(file);
  const dir = realpathSync(resolve(base, String(data.dir ?? '.')));
  const projectRoot = realpathSync(resolve(base, String(data.project_root ?? '.')));
  if (dir !== projectRoot && !dir.startsWith(projectRoot + sep)) throw Error('surface.dir 落在 project_root 之外');
  if (isAbsolute(data.entry) || !data.entry) throw Error('surface.entry 必须是 dir 内的相对路径');
  return { file, base, data, dir, projectRoot, host: 'local' };
}

const isCli = (() => {
  try {
    return process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
  } catch {
    return false;
  }
})();

if (isCli) {
  const USAGE = `用法：
  node scripts/doc-command.mjs <review-surface.json> tasks
  node scripts/doc-command.mjs <review-surface.json> claim <task_id>
  node scripts/doc-command.mjs <review-surface.json> complete <task_id>
  node scripts/doc-command.mjs <review-surface.json> patch        # JSON 从 stdin
  node scripts/doc-command.mjs <review-surface.json> conflicts`;
  const args = process.argv.slice(2);
  const surfaceArg = args[0];
  const op = args[1];
  if (!surfaceArg || !op) { console.error(USAGE); process.exit(2); }
  // 模型 CLI 与浏览器走同一张路由表：`route` 是动作名，`body` 是原始请求体。
  let payload;
  if (op === 'tasks' || op === 'conflicts') payload = { route: op };
  else if (op === 'claim' || op === 'complete') {
    if (!args[2]) { console.error(USAGE); process.exit(2); }
    payload = { route: op, body: { task_id: args[2] } };
  } else if (op === 'patch') {
    let input = '';
    try {
      input = readFileSync(0, 'utf8');
    } catch {
      console.error('patch 需要从 stdin 读 JSON');
      process.exit(2);
    }
    try {
      payload = { route: 'patch', body: JSON.parse(input) };
    } catch {
      console.error('stdin 不是合法 JSON');
      process.exit(2);
    }
  } else {
    console.error(USAGE);
    process.exit(2);
  }
  runDocCommand(loadSurfaceForCli(surfaceArg), payload, { browser: false }).then((receipt) => {
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
    process.exit(receipt.ok ? 0 : 1);
  }).catch((error) => {
    console.error(error?.message ?? error);
    process.exit(1);
  });
}
