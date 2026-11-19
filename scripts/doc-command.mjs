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
 * 模型侧 CLI（同一份命令后端，不经浏览器白名单）：
 *   node scripts/doc-command.mjs <review-surface.json> tasks
 *   node scripts/doc-command.mjs <review-surface.json> claim <task_id>
 *   node scripts/doc-command.mjs <review-surface.json> complete <task_id>
 *   node scripts/doc-command.mjs <review-surface.json> patch        # JSON 从 stdin
 *   node scripts/doc-command.mjs <review-surface.json> conflicts
 *
 * 浏览器只能做页面真正需要的事（open/block/split/merge/reorder/asset_replace/feedback/
 * tasks/conflicts/decide/history/restore）；claim / patch / complete 是模型侧动作，从浏览器
 * 调用一律拒绝。这里导出的白名单也是 `review-command.mjs` 唯一使用的来源。
 */
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createDocSession } from './lib/doc-session.mjs';
import { createTaskDispatcher } from './lib/doc-dispatch.mjs';

export const DOC_COMMAND_BACKEND = 'doc-workbench/1';
export const DOC_BINDING_CONTRACT = 'doc-surface/1';

/** 页面（浏览器）真正需要的操作：保存、派发、裁决、看锁与待核对。 */
export const DOC_BROWSER_OPERATIONS = new Set([
  'open', 'block', 'split', 'merge', 'reorder', 'asset_replace', 'feedback', 'tasks', 'conflicts', 'decide',
  'history', 'restore',
]);
/** 模型侧动作：不在浏览器白名单里。 */
export const DOC_MODEL_OPERATIONS = new Set(['tasks', 'claim', 'complete', 'patch', 'conflicts']);

const COMMAND_CLI = fileURLToPath(import.meta.url);
const fail = (code, message) => { throw Object.assign(Error(message), { code }); };

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
 * 这里再按 backend 自己的白名单收窄一次，并只从 binding.json 解析文档。
 */
export async function runDocCommand(surface, payload, { browser = true } = {}) {
  try {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      fail('command_shape', 'Command must be a JSON object');
    }
    const allowed = browser ? DOC_BROWSER_OPERATIONS : DOC_MODEL_OPERATIONS;
    if (!allowed.has(payload.op)) fail('command_operation', 'This operation is not available on this transport');
    const { docPath } = docBindingOf(surface);
    const session = await sessionFor(docPath);
    switch (payload.op) {
      case 'open':
        return { ok: true, ...session.snapshot() };
      case 'block':
        return session.saveBlock(payload);
      case 'split':
        return session.splitBlock(payload);
      case 'merge':
        return session.mergeBlocks(payload);
      case 'reorder':
        return session.reorder(payload);
      case 'asset_replace':
        return session.replaceAsset(payload);
      case 'feedback': {
        const receipt = session.submitFeedback(payload);
        const dispatch = await dispatchFor(surface, receipt.task);
        return { ...receipt, dispatch };
      }
      case 'tasks':
        return session.tasks();
      case 'claim':
        return session.claim(payload);
      case 'complete':
        return session.complete(payload);
      case 'patch':
        return session.patch(payload);
      case 'conflicts':
        return session.conflicts();
      case 'decide':
        return session.decide(payload);
      case 'history':
        return session.history();
      case 'restore':
        return session.restore(payload);
      default:
        return fail('command_operation', 'Unknown doc-workbench operation');
    }
  } catch (error) {
    return { ok: false, code: error?.code ?? 'doc_command', error: error?.message ?? String(error) };
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
  let payload;
  if (op === 'tasks' || op === 'conflicts') payload = { op };
  else if (op === 'claim' || op === 'complete') {
    if (!args[2]) { console.error(USAGE); process.exit(2); }
    payload = { op, task_id: args[2] };
  } else if (op === 'patch') {
    let input = '';
    try {
      input = readFileSync(0, 'utf8');
    } catch {
      console.error('patch 需要从 stdin 读 JSON');
      process.exit(2);
    }
    try {
      payload = { ...JSON.parse(input), op: 'patch' };
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
