#!/usr/bin/env node
/**
 * 文字工作台：打开一份 planners-doc/1 文档，按块渲染，点进任意块就地改，
 * 保存时只替换被改块的 raw。
 *
 * 用法：node scripts/doc-workbench.mjs <storyline.md|by-page.md> [--port 0] [--open]
 *
 * 命令面（页面与 eval 共用同一个入口）：
 *   GET  /api/doc             打开文档（补齐缺失锚点、重建重复锚点）并返回块
 *   POST /api/block           改一块：{anchor, content, base_sha256}
 *   POST /api/asset/replace   换掉图块引用的文件：{anchor, content_base64, base_sha256}
 *                             —— 正文引用路径不变；锁定块不可换；清单同步新指纹
 *   POST /api/reorder         重排（一次一个动作），返回重排后的整份快照：
 *                             {op:'move-block', anchor, to:{chapter,index,before}, base_sha256}
 *                             {op:'move-page', page:{chapter,index},
 *                              to:{chapter,index,position:'before'|'after'}, base_sha256}
 *
 * 块怎么切、锚点怎么补只有一份实现：`scripts/lib/doc-blocks.mjs`，
 * 与 `scripts/validate-doc.mjs` 共用。改内容与改顺序是两个显式操作，互不放宽。
 */
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { basename, extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import {
  BLOCK_TYPES, applyBlockContent, assessBlock, blockPrefix, imageReference, moveBlock, movePage,
  parseDocument, repairAnchors, tableModel,
} from './lib/doc-blocks.mjs';
import {
  assertImageBytes, buildManifest, imageMime, manifestPathFor, realPathInside, resolveInside, syncManifest,
  writeAtomicFile,
} from './lib/doc-assets.mjs';
import { TASK_CONTRACT, createTaskBoard } from './lib/doc-tasks.mjs';
import { sha256 } from './content-review-contract.mjs';

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

const fail = (code, message) => { throw Object.assign(Error(message), { code }); };

function atomicWrite(path, text) {
  const mode = statSync(path).mode & 0o777;
  const temp = `${path}.doc-workbench.tmp`;
  if (existsSync(temp)) unlinkSync(temp);
  const fd = openSync(temp, 'wx', mode);
  try {
    writeFileSync(fd, text, 'utf8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, path);
}

function viewBlock(block, lockOf = () => null) {
  const verdict = assessBlock(block);
  const prefix = blockPrefix(block);
  const lockedBy = block.anchor ? lockOf(block.anchor) : null;
  const image = block.type === 'image' ? imageReference(block.raw) : null;
  return {
    anchor: block.anchor ?? null,
    type: block.type,
    index: block.index,
    page: {
      key: block.page ? `${block.page.chapter?.index ?? 0}-${block.page.index}` : null,
      chapter: block.page?.chapter?.title ?? null,
      chapterIndex: block.page?.chapter?.index ?? null,
      number: block.page?.index ?? null,
      title: block.page?.title ?? null,
    },
    raw: block.raw,
    sha256: sha256(block.raw),
    inline: block.type === 'heading' || block.type === 'list'
      ? block.raw.slice(prefix.length)
      : block.type === 'quote'
        ? block.raw.split('\n').map((line) => line.replace(/^\s*>\s?/, '')).join('\n')
        : block.raw,
    prefix,
    start: block.startOffset,
    end: block.endOffset,
    editable: verdict.editable,
    degraded: verdict.degraded,
    reason: verdict.reason,
    locked: lockedBy !== null,
    locked_by: lockedBy,
    ...(image ? { image } : {}),
    ...(block.type === 'table' ? { table: tableModel(block) } : {}),
  };
}

/** 目录用的页视图：页没有锚点，身份是「章节号 + 页号」，编号由顺序决定。 */
function viewPage(page) {
  return {
    key: `${page.chapter?.index ?? 0}-${page.index}`,
    chapter: page.chapter?.title ?? null,
    chapterIndex: page.chapter?.index ?? null,
    index: page.index,
    title: page.title,
    anchor: page.blocks[0]?.anchor ?? null,
  };
}

/** 读盘 → 补锚点（只在内存里，写不写由调用方决定）→ 切块。 */
function readDocument(docPath) {
  const before = readFileSync(docPath, 'utf8');
  const repaired = repairAnchors(before);
  return {
    raw: repaired.raw,
    changed: repaired.changed,
    repairs: repaired.repairs,
    parsed: parseDocument(repaired.raw, { checkImages: false }),
  };
}

function persistRepairs(docPath, document) {
  if (document.changed) atomicWrite(docPath, document.raw);
}

/** 打开 = 补锚点并落盘（只有真有修补时才写）。 */
function openDocument(docPath) {
  const document = readDocument(docPath);
  persistRepairs(docPath, document);
  return document;
}

function snapshotOf(docPath, board) {
  const document = readDocument(docPath);
  persistRepairs(docPath, document);
  const { raw, parsed, repairs } = document;
  // 图资产清单是派生索引：每次打开按正文重建，没变化就不写盘。写不进去也不该让文档打不开，
  // 只把原因如实带回去（清单是辅助，正文才是真源）。
  let assets = { path: manifestPathFor(docPath), manifest: { contract: 'doc-assets/1', doc: basename(docPath), assets: [] }, changed: false };
  let assetsError = null;
  try {
    assets = syncManifest(docPath, parsed);
  } catch (error) {
    assetsError = error?.message ?? String(error);
  }
  return {
    path: docPath,
    contract: parsed.front.contract ?? null,
    doc: parsed.front.doc ?? null,
    project: parsed.front.project ?? null,
    sha256: sha256(raw),
    pages: parsed.pages.map(viewPage),
    blocks: parsed.blocks.map((block) => viewBlock(block, (anchor) => board.lockOf(anchor))),
    assets: assets.manifest.assets,
    assets_manifest: basename(assets.path),
    ...(assetsError ? { assets_error: assetsError } : {}),
    repairs,
    errors: parsed.errors.map(({ code, message, line, block }) => ({ code, message, line, block })),
  };
}

/** 保存一块：先拒绝锁定块，再重新读盘、按 base_sha256 拒绝过期写入，最后只替换这一块。 */
function saveBlock(docPath, payload, board) {
  if (!payload || typeof payload !== 'object') fail('block_request', '请求体必须是 JSON 对象');
  const { anchor, content, base_sha256: baseSha } = payload;
  if (typeof anchor !== 'string' || !/^b:[0-9a-f]{6,12}$/.test(anchor)) fail('block_anchor', '锚点形状不对');
  if (typeof content !== 'string') fail('block_content', '块内容必须是文本');
  const owner = board.lockOf(anchor);
  if (owner) fail('block_locked', '模型正在改这一段，等它完成后再编辑');
  const document = readDocument(docPath);
  if (typeof baseSha !== 'string' || baseSha !== sha256(document.raw)) {
    fail('stale_document', '文档已在别处被修改；请刷新工作台后再保存');
  }
  persistRepairs(docPath, document); // 只有基线对得上，才把这次打开补的锚点落盘
  const result = applyBlockContent(document.raw, anchor, content);
  atomicWrite(docPath, result.raw);
  return { ok: true, sha256: sha256(result.raw), block: viewBlock(result.block, (anchor) => board.lockOf(anchor)) };
}

/** 一块的页身份：章节 + 页内序号 + 标题；整页反馈按它换算范围。 */
function samePage(block, page) {
  return Boolean(block.page)
    && block.page.chapter?.title === page.chapter
    && block.page.index === page.number
    && block.page.title === page.title;
}

/**
 * 把「人点的反馈」换算成要绑定的块：块级用提交上来的锚点，整页 / 整份由服务端按当前文档算，
 * 不信任客户端传来的整页块列表。超出七种块的块没有稳定身份，不参与任务。
 */
function feedbackTargets(document, payload) {
  const blocks = document.parsed.blocks.filter((block) => block.anchor && BLOCK_TYPES.has(block.type));
  const scope = payload.scope ?? 'blocks';
  if (!['blocks', 'page', 'doc'].includes(scope)) fail('feedback_scope', '反馈范围只能是 blocks / page / doc');

  if (scope === 'doc') return { scope, page: null, blocks };

  if (scope === 'page') {
    const page = payload.page;
    if (!page || typeof page !== 'object'
      || typeof page.chapter !== 'string' || !Number.isInteger(page.number) || typeof page.title !== 'string') {
      fail('feedback_page', '整页反馈需要章节、页号与页标题');
    }
    const targets = blocks.filter((block) => samePage(block, page));
    if (!targets.length) fail('feedback_page', `找不到页「${page.title}」；请刷新工作台后再提交`);
    return { scope, page: { chapter: page.chapter, number: page.number, title: page.title }, blocks: targets };
  }

  const anchors = Array.isArray(payload.anchors) ? payload.anchors : [];
  if (!anchors.length) fail('feedback_anchor', '请先选中要改的块');
  if (anchors.some((anchor) => typeof anchor !== 'string' || !/^b:[0-9a-f]{6,12}$/.test(anchor))) {
    fail('feedback_anchor', '块身份形状不对');
  }
  if (new Set(anchors).size !== anchors.length) fail('feedback_anchor', '同一块被选了两次');
  const byAnchor = new Map(blocks.map((block) => [block.anchor, block]));
  return {
    scope,
    page: null,
    blocks: anchors.map((anchor) => byAnchor.get(anchor)
      ?? fail('feedback_anchor', `找不到块 ${anchor}；文档可能已被修改，请刷新工作台`)),
  };
}

/** 提交一条块级反馈任务：只带块身份与 sha256(block.raw)，不把正文抄进任务。 */
function submitFeedback(docPath, payload, board) {
  if (!payload || typeof payload !== 'object') fail('feedback_request', '请求体必须是 JSON 对象');
  const text = typeof payload.text === 'string' ? payload.text.trim() : '';
  if (!text) fail('feedback_text', '请先写下要模型改什么');
  if (text.length > 4000) fail('feedback_text', '一条反馈不要超过 4000 字');
  const document = readDocument(docPath);
  const { scope, page, blocks } = feedbackTargets(document, payload);
  const locked = blocks.filter((block) => board.lockOf(block.anchor));
  if (locked.length) {
    fail('block_locked', `这些块正由模型处理，等它完成再派发：${locked.map((block) => block.anchor).join('、')}`);
  }
  persistRepairs(docPath, document); // 任务绑定的锚点必须是磁盘上也认的身份
  const task = board.submit({
    scope,
    page,
    text,
    doc: {
      path: docPath,
      contract: document.parsed.front.contract ?? null,
      doc: document.parsed.front.doc ?? null,
      project: document.parsed.front.project ?? null,
    },
    blocks: blocks.map((block) => ({ anchor: block.anchor, sha256: sha256(block.raw) })),
  });
  return { ok: true, task };
}

/** 模型开始处理：确认任务绑定的块还在，才锁块。 */
function claimTask(docPath, payload, board) {
  if (!payload || typeof payload !== 'object') fail('task_request', '请求体必须是 JSON 对象');
  const id = payload.task_id ?? payload.id;
  if (typeof id !== 'string' || !id) fail('task_id', '需要任务 id');
  const task = board.get(id);
  if (!task) fail('task_missing', `找不到任务 ${id}；可能已被清理`);
  const document = readDocument(docPath);
  const present = new Set(document.parsed.blocks.map((block) => block.anchor).filter(Boolean));
  const missing = task.blocks.filter(({ anchor }) => !present.has(anchor));
  if (missing.length) {
    fail('task_stale', `任务里的块已不存在：${missing.map(({ anchor }) => anchor).join('、')}；请重新提交反馈`);
  }
  return { ok: true, task: board.claim(id) };
}

/** 模型处理完：解锁。已完成的重复调用是幂等的，方便网络重试。 */
function completeTask(payload, board) {
  if (!payload || typeof payload !== 'object') fail('task_request', '请求体必须是 JSON 对象');
  const id = payload.task_id ?? payload.id;
  return { ok: true, task: board.complete(id) };
}

const BAD_REQUEST_CODES = new Set([
  'block_request', 'feedback_request', 'feedback_text', 'feedback_scope',
  'task_request', 'task_id', 'task_scope', 'task_blocks',
  'reorder_request', 'reorder_op',
  'asset_request', 'asset_type', 'asset_content',
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

/**
 * 保存一次重排：只接受显式的 move-block / move-page，一次一个动作。
 * 与改内容一样按 base_sha256 拒绝过期写入；成功后回整份快照，页面据此重画目录与正文。
 */
function reorderDocument(docPath, payload, board) {
  if (!payload || typeof payload !== 'object') fail('reorder_request', '请求体必须是 JSON 对象');
  const { op, base_sha256: baseSha } = payload;
  if (op !== 'move-block' && op !== 'move-page') {
    fail('reorder_op', '重排只接受 move-block（移块）或 move-page（移页）');
  }
  const document = readDocument(docPath);
  if (typeof baseSha !== 'string' || baseSha !== sha256(document.raw)) {
    fail('stale_document', '文档已在别处被修改；请刷新工作台后再拖动');
  }
  persistRepairs(docPath, document); // 基线对得上才把这次打开补的锚点落盘
  const result = op === 'move-page'
    ? movePage(document.raw, { page: payload.page, to: payload.to })
    : moveBlock(document.raw, { anchor: payload.anchor, to: payload.to });
  if (result.changed) atomicWrite(docPath, result.raw);
  return { ok: true, changed: result.changed, ...snapshotOf(docPath, board) };
}

/**
 * 换掉一个图块引用的文件。
 *
 * 请求里只有块身份与图字节，**没有路径**：用哪张图由正文的 Markdown 引用决定，
 * 所以换文件在结构上就不可能改掉正文引用。锁定的块先拒，再按 base_sha256 拒过期写入。
 * 清单跟着新指纹同步（`replaced_from_sha256` 记下上一版），正文一个字节都不写。
 */
function replaceImageAsset(docPath, payload, board) {
  if (!payload || typeof payload !== 'object') fail('asset_request', '请求体必须是 JSON 对象');
  const { anchor, content_base64: encoded, base_sha256: baseSha } = payload;
  if (typeof anchor !== 'string' || !/^b:[0-9a-f]{6,12}$/.test(anchor)) fail('asset_request', '锚点形状不对');
  if (typeof encoded !== 'string' || !encoded.trim()) fail('asset_request', '需要 content_base64（图文件字节）');
  const compact = encoded.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact) || compact.length % 4 !== 0) {
    fail('asset_request', 'content_base64 不是合法的 base64');
  }
  const bytes = Buffer.from(compact, 'base64');
  if (bytes.length > 12 * 1024 * 1024) fail('asset_request', '一张图不要超过 12MB');

  const owner = board.lockOf(anchor);
  if (owner) fail('block_locked', '模型正在改这一块，等它完成后再换图');
  const document = readDocument(docPath);
  if (typeof baseSha !== 'string' || baseSha !== sha256(document.raw)) {
    fail('stale_document', '文档已在别处被修改；请刷新工作台后再换图');
  }
  const block = document.parsed.blocks.find((item) => item.anchor === anchor);
  if (!block) fail('asset_anchor', `找不到图块 ${anchor}；文档可能已被修改`);
  if (block.type !== 'image') fail('asset_anchor', '只有图块可以换文件；文字块请用块编辑');
  const image = imageReference(block.raw);
  if (!image) fail('asset_reference', '这一块的 Markdown 图片引用解析不出来');
  const target = resolveInside(docPath, image.path);
  if (!target) fail('asset_path', `图片必须落在文档目录内：${image.path}`);
  if (!existsSync(target) || !statSync(target).isFile()) fail('asset_path', `图文件不存在：${image.path}`);
  if (!realPathInside(docPath, target)) fail('asset_path', `图片指向文档目录之外：${image.path}`);
  assertImageBytes(image.path, bytes);
  writeAtomicFile(target, bytes);
  // 文件已经换好；清单同步失败不该把这次替换说成失败，但要如实带出原因。
  const manifestPath = manifestPathFor(docPath);
  let manifest = buildManifest(docPath, document.parsed);
  let assetsError = null;
  try {
    manifest = syncManifest(docPath, document.parsed).manifest;
  } catch (error) {
    assetsError = error?.message ?? String(error);
  }
  return {
    ok: true,
    asset: manifest.assets.find((asset) => asset.path === image.path) ?? null,
    doc_sha256: sha256(document.raw),
    assets_manifest: basename(manifestPath),
    ...(assetsError ? { assets_error: assetsError } : {}),
  };
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
  if (!requested || /^(?:[a-zA-Z][a-zA-Z0-9+.-]*:|\/|~)/.test(requested)) return null;
  const root = resolve(docPath, '..');
  const file = resolve(root, requested);
  if (!file.startsWith(root + '/')) return null;
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

export async function startDocWorkbench({ docPath, port = 0, host = '127.0.0.1', onTask = null } = {}) {
  if (!docPath) throw Error('需要一份文档路径');
  const file = realpathSync(resolve(docPath));
  if (!statSync(file).isFile()) throw Error(`不是文件：${file}`);
  const startup = openDocument(file); // 打开就补锚点；补不了就让启动失败，而不是带着坏身份继续。
  const board = createTaskBoard(); // 任务与锁只在工作台运行期间存在；落盘派发由 07 接。

  const server = createServer(async (request, response) => {
    const url = new URL(request.url || '/', `http://${host}`);
    try {
      if (url.pathname === '/api/doc') {
        if (request.method !== 'GET') return json(response, 405, { ok: false, code: 'method', error: '用 GET 打开文档' });
        return json(response, 200, snapshotOf(file, board));
      }
      if (url.pathname === '/api/block') {
        if (request.method !== 'POST') return json(response, 405, { ok: false, code: 'method', error: '用 POST 保存块' });
        if (!allowWrite(request, response, server, host, 'block')) return;
        const payload = JSON.parse((await readBody(request)) || '{}');
        return json(response, 200, saveBlock(file, payload, board));
      }
      if (url.pathname === '/api/asset/replace') {
        if (request.method !== 'POST') return json(response, 405, { ok: false, code: 'method', error: '用 POST 换图' });
        if (!allowWrite(request, response, server, host, 'asset')) return;
        const payload = JSON.parse((await readBody(request, 20 * 1024 * 1024)) || '{}');
        return json(response, 200, replaceImageAsset(file, payload, board));
      }
      if (url.pathname === '/api/reorder') {
        if (request.method !== 'POST') return json(response, 405, { ok: false, code: 'method', error: '用 POST 重排' });
        if (!allowWrite(request, response, server, host, 'reorder')) return;
        const payload = JSON.parse((await readBody(request)) || '{}');
        return json(response, 200, reorderDocument(file, payload, board));
      }
      if (url.pathname === '/api/feedback') {
        if (request.method !== 'POST') return json(response, 405, { ok: false, code: 'method', error: '用 POST 提交反馈' });
        if (!allowWrite(request, response, server, host, 'feedback')) return;
        const payload = JSON.parse((await readBody(request)) || '{}');
        const receipt = submitFeedback(file, payload, board);
        // 07：把任务写进本地收件箱 / 唤醒模型。这里只报事件，不让派发失败吞掉已创建的任务。
        if (typeof onTask === 'function') {
          try {
            await onTask(receipt.task);
          } catch (error) {
            console.error(`派发钩子失败：${error?.message ?? error}`);
          }
        }
        return json(response, 200, receipt);
      }
      if (url.pathname === '/api/tasks') {
        if (request.method !== 'GET') return json(response, 405, { ok: false, code: 'method', error: '用 GET 读取任务' });
        return json(response, 200, { ok: true, contract: TASK_CONTRACT, tasks: board.list() });
      }
      if (url.pathname === '/api/task/claim') {
        if (request.method !== 'POST') return json(response, 405, { ok: false, code: 'method', error: '用 POST 开始处理任务' });
        if (!allowWrite(request, response, server, host, 'task')) return;
        const payload = JSON.parse((await readBody(request)) || '{}');
        return json(response, 200, claimTask(file, payload, board));
      }
      if (url.pathname === '/api/task/complete') {
        if (request.method !== 'POST') return json(response, 405, { ok: false, code: 'method', error: '用 POST 完成任务' });
        if (!allowWrite(request, response, server, host, 'task')) return;
        const payload = JSON.parse((await readBody(request)) || '{}');
        return json(response, 200, completeTask(payload, board));
      }
      if (url.pathname === '/' || url.pathname === '/index.html') {
        return serveFile(response, join(ASSETS, 'doc-workbench.html'));
      }
      if (url.pathname === '/doc-workbench.js' || url.pathname === '/doc-inline.js'
        || url.pathname === '/doc-drag.js' || url.pathname === '/doc-feedback.js'
        || url.pathname === '/doc-images.js' || url.pathname === '/doc-workbench.css') {
        return serveFile(response, join(ASSETS, url.pathname.slice(1)));
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
      json(response, status, { ok: false, code: error?.code ?? 'workbench', error: error?.message ?? String(error) });
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
    repairs: startup.repairs,
    tasks: board,
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
