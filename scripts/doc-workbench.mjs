#!/usr/bin/env node
/**
 * 文字工作台的本地入口（没有 DSH 侧栏时的那个页面）。
 *
 * 用法：node scripts/doc-workbench.mjs <storyline.md|by-page.md> [--port 0] [--open]
 *
 * 这里只做「HTTP 怎么进、怎么出」：路由、同源校验、静态文件与图片。块怎么切、怎么只写
 * 被改的那一块、journal、锁与待核对，全在 `scripts/lib/doc-session.mjs` —— 侧栏的
 * `doc-workbench/1` 命令后端用的是同一个会话，所以两条入口没有第二份写盘逻辑。
 *
 * 命令面（页面与 eval 共用同一个入口）：
 *   GET  /api/doc                打开文档（补齐缺失锚点、重建重复锚点）并返回块
 *   POST /api/block              人改一块：{anchor, content, base_sha256, base_block_sha256?}
 *   POST /api/block/split        人按回车分块：{anchor, before, after, base_sha256}
 *   POST /api/block/merge        人把空块并进前一块：{anchor, previous, content, base_sha256}
 *   POST /api/asset/replace      换掉图块引用的文件：{anchor, content_base64, base_sha256}
 *   POST /api/reorder            重排（一次一个动作），返回重排后的整份快照
 *   POST /api/structure          改结构（rename-* / add-page / add-chapter / add-source / add-page-anchor）
 *   POST /api/feedback           派发块级反馈任务；回执带 dispatch.channel（wake / inbox）
 *   GET  /api/tasks              模型读任务
 *   POST /api/task/claim         模型开始处理（锁块）
 *   POST /api/task/complete      模型不写回、直接完成
 *   POST /api/patch              模型一次写回多块：{task_id, patches:[{anchor, content}]}
 *   GET  /api/conflicts          人读待核对：磁盘版本 + 模型版
 *   POST /api/conflict/decide    裁决一块：{anchor, decision: mine|model|discard}
 *   GET  /api/history            列出历史版本（每次写盘前存上一版，新的在前）
 *   POST /api/history/restore    恢复一版：{id, base_sha256}（恢复也是一次新编辑）
 *   GET  /api/notes              列出批注（主文件 + 归档，含块快照）
 *   POST /api/note               加一条草稿：{anchor|anchors, text}
 *   POST /api/note/delete        删一条草稿：{id}
 *   POST /api/note/reopen        重新打开：{id}（已提交 / 已归档 → 草稿）
 *   POST /api/note/submit        整批提交：草稿 → 已提交，建一条任务
 *
 * 没有侧栏插件时，派发把同一条任务落进文档同目录的 `.doc-workbench/inbox/`，
 * 模型用 `scripts/doc-inbox.mjs list|take` 读；有插件（onTask）时同一条任务交给它唤醒。
 * 旧 JSON 主稿（`.proposal-work/page-architecture.json` 这类）只读挂载：
 * GET /api/doc 给出 readonly 快照，所有写入口 409 readonly，磁盘零变化。
 */
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { imageMime, realPathInside, resolveInside } from './lib/doc-assets.mjs';
import { createTaskDispatcher } from './lib/doc-dispatch.mjs';
import { createDocSession } from './lib/doc-session.mjs';
import { DOC_SCRIPT_SOURCES, docScriptFile } from './lib/doc-scripts.mjs';

const HERE = fileURLToPath(new URL('..', import.meta.url));
const ASSETS = join(HERE, 'assets', 'workbench');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

/** 这些错误是请求形状不对（400），其余写盘/锁冲突是 409。 */
const BAD_REQUEST_CODES = new Set([
  'block_request', 'feedback_request', 'feedback_text', 'feedback_scope',
  'task_request', 'task_id', 'task_scope', 'task_blocks',
  'patch_request', 'patch_blocks', 'conflict_request', 'conflict_decision', 'conflict_anchor',
  'reorder_request', 'reorder_op', 'structure_request', 'structure_op', 'structure_title',
  'asset_request', 'asset_type', 'asset_content',
  'history_request', 'history_id',
  'note_request', 'note_text', 'note_anchor', 'note_id', 'note_missing', 'notes_empty', 'notes_orphaned',
]);

/** 只接受工作台页面自己的同源 JSON 写入：别的网页不能借浏览器改本地文档或派发任务。 */
function allowWrite(request, response, server, host, code) {
  const allowedOrigin = `http://${host}:${server.address().port}`;
  if (request.headers.host !== `${host}:${server.address().port}`
    || (request.headers.origin !== undefined && request.headers.origin !== allowedOrigin)) {
    json(response, 403, { ok: false, code: `${code}_origin`, error: '只接受工作台自己的写入请求' });
    return false;
  }
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || '')) {
    json(response, 415, { ok: false, code: `${code}_content_type`, error: '写入请求必须是 application/json' });
    return false;
  }
  return true;
}

function readBody(request, limit = 2 * 1024 * 1024) {
  return new Promise((done, failRequest) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > limit) failRequest(Object.assign(Error('请求体过大'), { code: 'block_request' }));
    });
    request.on('end', () => done(body));
    request.on('error', failRequest);
  });
}

function json(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(body);
}

function serveFile(response, file, type) {
  const bytes = readFileSync(file);
  response.writeHead(200, { 'content-type': type ?? MIME[extname(file).toLowerCase()] ?? 'application/octet-stream', 'cache-control': 'no-store' });
  response.end(bytes);
}

/** 文档旁边的图片：只放行文档目录内的普通**图片**文件，不接受绝对路径与跨目录。 */
function assetFile(docPath, url) {
  const requested = new URL(url, 'http://127.0.0.1').searchParams.get('path') ?? '';
  // 包含性只认 doc-assets 的实现：字符串前缀 + realpath 各写一遍就是两份会漂移的判据。
  const file = resolveInside(docPath, requested);
  if (!file) return null;
  if (!imageMime(file)) return null; // 同源 /asset 不能把 HTML / JS 当资产发出去
  if (!existsSync(file) || !statSync(file).isFile()) return null;
  if (!realPathInside(docPath, file)) return null; // 符号链接指到文档目录外也不算资产
  return file;
}

/**
 * 发一个图资产。SVG 带 sandbox + script-src 'none' 的 CSP：即使被人单独在新标签打开，
 * 里面的 <script> 也不执行；在 <img> 里本来就不会执行，这一层是纵深防御。
 */
function serveAsset(response, file) {
  const type = imageMime(file) ?? 'application/octet-stream';
  const headers = {
    'content-type': type,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  };
  if (type === 'image/svg+xml') {
    headers['content-security-policy'] = "sandbox; script-src 'none'";
  }
  response.writeHead(200, headers);
  response.end(readFileSync(file));
}

export async function startDocWorkbench({
  docPath, port = 0, host = '127.0.0.1', onTask = null, faults = null,
} = {}) {
  if (!docPath) throw Error('需要一份文档路径');
  const file = realpathSync(resolve(docPath));
  if (!statSync(file).isFile()) throw Error(`不是文件：${file}`);
  // 会话负责 journal 恢复、补锚点、块级读写与锁；本地页与侧栏命令后端共用这一份。
  const session = await createDocSession({ docPath: file, faults });
  // 派发的唯一出口：有插件走唤醒，没有插件写本地收件箱；两条路径拿到同一条任务。
  const dispatch = session.readonly ? null : createTaskDispatcher({ docPath: file, onTask });

  /**
   * 派发失败只报错，不让已创建的任务消失（人还能在 /api/tasks 里看到它）。
   * 块级反馈与整批批注共用这一段：以前两条路由各抄一份逐字相同的 try/catch。
   */
  async function deliver(task) {
    try {
      return await dispatch(task);
    } catch (error) {
      console.error(`派发失败：${error?.message ?? error}`);
      return {
        channel: typeof onTask === 'function' ? 'wake' : 'inbox',
        task_id: task.id,
        status: task.status,
        error: error?.message ?? String(error),
      };
    }
  }

  const server = createServer(async (request, response) => {
    const url = new URL(request.url || '/', `http://${host}`);
    try {
      if (url.pathname === '/api/doc') {
        if (request.method !== 'GET') return json(response, 405, { ok: false, code: 'method', error: '用 GET 打开文档' });
        return json(response, 200, session.snapshot());
      }
      if (url.pathname === '/api/block') {
        if (request.method !== 'POST') return json(response, 405, { ok: false, code: 'method', error: '用 POST 保存块' });
        if (!allowWrite(request, response, server, host, 'block')) return;
        const payload = JSON.parse((await readBody(request)) || '{}');
        return json(response, 200, session.saveBlock(payload));
      }
      if (url.pathname === '/api/block/split') {
        if (request.method !== 'POST') return json(response, 405, { ok: false, code: 'method', error: '用 POST 拆分块' });
        if (!allowWrite(request, response, server, host, 'block')) return;
        const payload = JSON.parse((await readBody(request)) || '{}');
        return json(response, 200, session.splitBlock(payload));
      }
      if (url.pathname === '/api/block/merge') {
        if (request.method !== 'POST') return json(response, 405, { ok: false, code: 'method', error: '用 POST 合并块' });
        if (!allowWrite(request, response, server, host, 'block')) return;
        const payload = JSON.parse((await readBody(request)) || '{}');
        return json(response, 200, session.mergeBlocks(payload));
      }
      if (url.pathname === '/api/asset/replace') {
        if (request.method !== 'POST') return json(response, 405, { ok: false, code: 'method', error: '用 POST 换图' });
        if (!allowWrite(request, response, server, host, 'asset')) return;
        const payload = JSON.parse((await readBody(request, 20 * 1024 * 1024)) || '{}');
        return json(response, 200, session.replaceAsset(payload));
      }
      if (url.pathname === '/api/reorder') {
        if (request.method !== 'POST') return json(response, 405, { ok: false, code: 'method', error: '用 POST 重排' });
        if (!allowWrite(request, response, server, host, 'reorder')) return;
        const payload = JSON.parse((await readBody(request)) || '{}');
        return json(response, 200, session.reorder(payload));
      }
      if (url.pathname === '/api/structure') {
        if (request.method !== 'POST') return json(response, 405, { ok: false, code: 'method', error: '用 POST 改结构' });
        if (!allowWrite(request, response, server, host, 'structure')) return;
        const payload = JSON.parse((await readBody(request)) || '{}');
        return json(response, 200, session.structure(payload));
      }
      if (url.pathname === '/api/feedback') {
        if (request.method !== 'POST') return json(response, 405, { ok: false, code: 'method', error: '用 POST 提交反馈' });
        if (!allowWrite(request, response, server, host, 'feedback')) return;
        const payload = JSON.parse((await readBody(request)) || '{}');
        const receipt = session.submitFeedback(payload);
        // 派发出口只有一处：任务先建成同一个形状，再交给 deliver 选择唤醒或写收件箱。
        const delivery = await deliver(receipt.task);
        return json(response, 200, { ...receipt, dispatch: delivery });
      }
      if (url.pathname === '/api/notes') {
        if (request.method !== 'GET') return json(response, 405, { ok: false, code: 'method', error: '用 GET 读取批注' });
        return json(response, 200, session.notes());
      }
      if (url.pathname === '/api/note') {
        if (request.method !== 'POST') return json(response, 405, { ok: false, code: 'method', error: '用 POST 加一条批注' });
        if (!allowWrite(request, response, server, host, 'note')) return;
        const payload = JSON.parse((await readBody(request)) || '{}');
        return json(response, 200, session.addNote(payload));
      }
      if (url.pathname === '/api/note/delete') {
        if (request.method !== 'POST') return json(response, 405, { ok: false, code: 'method', error: '用 POST 删除批注' });
        if (!allowWrite(request, response, server, host, 'note')) return;
        const payload = JSON.parse((await readBody(request)) || '{}');
        return json(response, 200, session.deleteNote(payload));
      }
      if (url.pathname === '/api/note/submit') {
        if (request.method !== 'POST') return json(response, 405, { ok: false, code: 'method', error: '用 POST 提交整批批注' });
        if (!allowWrite(request, response, server, host, 'note')) return;
        const payload = JSON.parse((await readBody(request)) || '{}');
        const receipt = session.submitNotes(payload);
        // 派发出口与块级反馈同一个：先建任务，再交给 deliver。
        const delivery = await deliver(receipt.task);
        return json(response, 200, { ...receipt, dispatch: delivery });
      }
      if (url.pathname === '/api/note/reopen') {
        if (request.method !== 'POST') return json(response, 405, { ok: false, code: 'method', error: '用 POST 重新打开批注' });
        if (!allowWrite(request, response, server, host, 'note')) return;
        const payload = JSON.parse((await readBody(request)) || '{}');
        return json(response, 200, session.reopenNote(payload));
      }
      if (url.pathname === '/api/tasks') {
        if (request.method !== 'GET') return json(response, 405, { ok: false, code: 'method', error: '用 GET 读取任务' });
        return json(response, 200, session.tasks());
      }
      if (url.pathname === '/api/task/claim') {
        if (request.method !== 'POST') return json(response, 405, { ok: false, code: 'method', error: '用 POST 开始处理任务' });
        if (!allowWrite(request, response, server, host, 'task')) return;
        const payload = JSON.parse((await readBody(request)) || '{}');
        return json(response, 200, session.claim(payload));
      }
      if (url.pathname === '/api/task/complete') {
        if (request.method !== 'POST') return json(response, 405, { ok: false, code: 'method', error: '用 POST 完成任务' });
        if (!allowWrite(request, response, server, host, 'task')) return;
        const payload = JSON.parse((await readBody(request)) || '{}');
        return json(response, 200, session.complete(payload));
      }
      if (url.pathname === '/api/patch') {
        if (request.method !== 'POST') return json(response, 405, { ok: false, code: 'method', error: '用 POST 写回块 patch' });
        if (!allowWrite(request, response, server, host, 'patch')) return;
        const payload = JSON.parse((await readBody(request)) || '{}');
        return json(response, 200, session.patch(payload));
      }
      if (url.pathname === '/api/conflicts') {
        if (request.method !== 'GET') return json(response, 405, { ok: false, code: 'method', error: '用 GET 读取待核对' });
        return json(response, 200, session.conflicts());
      }
      if (url.pathname === '/api/conflict/decide') {
        if (request.method !== 'POST') return json(response, 405, { ok: false, code: 'method', error: '用 POST 裁决待核对' });
        if (!allowWrite(request, response, server, host, 'conflict')) return;
        const payload = JSON.parse((await readBody(request)) || '{}');
        return json(response, 200, session.decide(payload));
      }
      if (url.pathname === '/api/history') {
        if (request.method !== 'GET') return json(response, 405, { ok: false, code: 'method', error: '用 GET 读取历史版本' });
        return json(response, 200, session.history());
      }
      if (url.pathname === '/api/history/restore') {
        if (request.method !== 'POST') return json(response, 405, { ok: false, code: 'method', error: '用 POST 恢复历史版本' });
        if (!allowWrite(request, response, server, host, 'history')) return;
        const payload = JSON.parse((await readBody(request)) || '{}');
        return json(response, 200, session.restore(payload));
      }
      if (url.pathname === '/' || url.pathname === '/index.html') {
        return serveFile(response, join(ASSETS, 'doc-workbench.html'));
      }
      // 脚本清单唯一来源是页面模板（`lib/doc-scripts.mjs`）；清单外的脚本名一律 404。
      if (DOC_SCRIPT_SOURCES.has(url.pathname)) {
        return serveFile(response, docScriptFile(url.pathname));
      }
      if (url.pathname === '/doc-workbench.css') {
        return serveFile(response, join(ASSETS, 'doc-workbench.css'));
      }
      if (url.pathname === '/vendor/marked.js') {
        return serveFile(response, join(HERE, 'assets', 'content-review', 'marked.umd.js'));
      }
      if (url.pathname === '/asset') {
        const target = assetFile(file, request.url);
        if (!target) { response.writeHead(404); return response.end('not found'); }
        return serveAsset(response, target);
      }
      json(response, 404, { ok: false, code: 'not_found', error: '没有这个入口' });
    } catch (error) {
      const status = BAD_REQUEST_CODES.has(error?.code) ? 400 : 409;
      json(response, status, {
        ok: false,
        code: error?.code ?? 'workbench',
        error: error?.message ?? String(error),
        // 冲突时把两版一起带回去（不弹错，但不能让人没有可比的东西）。
        ...(error?.details ? { details: error.details } : {}),
      });
    }
  });

  await new Promise((done, reject) => {
    server.once('error', reject);
    server.listen(port, host, done);
  });
  const address = server.address();
  const url = `http://${host}:${address.port}`;
  return {
    url,
    port: address.port,
    path: file,
    repairs: session.repairs,
    recovery: session.recovery,
    journal: session.journal,
    readonly: session.readonly,
    tasks: session.boards.tasks,
    conflicts: session.boards.conflicts,
    close: () => new Promise((done) => server.close(() => done())),
  };
}

const isCli = (() => {
  try {
    return process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
  } catch {
    return false;
  }
})();

if (isCli) {
  const args = process.argv.slice(2);
  const flag = (name, fallback) => {
    const index = args.indexOf(name);
    return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
  };
  const docArg = args.find((arg) => !arg.startsWith('--') && !/^\d+$/.test(arg));
  if (!docArg) {
    console.error('用法：node doc-workbench.mjs <storyline.md|by-page.md> [--port 0] [--open]');
    process.exit(2);
  }
  startDocWorkbench({ docPath: docArg, port: Number(flag('--port', 0)) }).then((workbench) => {
    console.log(`\n工作台已打开：${workbench.url}`);
    console.log(`文档：${workbench.path}`);
    console.log('改完自动保存；Ctrl+C 退出。没有手动保存按钮。\n');
    if (args.includes('--open')) {
      const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
      spawn(opener, [workbench.url], { stdio: 'ignore', detached: true }).unref();
    }
  }).catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
