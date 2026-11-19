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
 *
 * 块怎么切、锚点怎么补只有一份实现：`scripts/lib/doc-blocks.mjs`，
 * 与 `scripts/validate-doc.mjs` 共用。
 */
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { applyBlockContent, assessBlock, blockPrefix, parseDocument, repairAnchors, tableModel } from './lib/doc-blocks.mjs';
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

function viewBlock(block) {
  const verdict = assessBlock(block);
  const prefix = blockPrefix(block);
  return {
    anchor: block.anchor ?? null,
    type: block.type,
    index: block.index,
    page: {
      chapter: block.page?.chapter?.title ?? null,
      number: block.page?.index ?? null,
      title: block.page?.title ?? null,
    },
    raw: block.raw,
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
    ...(block.type === 'table' ? { table: tableModel(block) } : {}),
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

function snapshotOf(docPath) {
  const document = readDocument(docPath);
  persistRepairs(docPath, document);
  const { raw, parsed, repairs } = document;
  return {
    path: docPath,
    contract: parsed.front.contract ?? null,
    doc: parsed.front.doc ?? null,
    project: parsed.front.project ?? null,
    sha256: sha256(raw),
    blocks: parsed.blocks.map(viewBlock),
    repairs,
    errors: parsed.errors.map(({ code, message, line, block }) => ({ code, message, line, block })),
  };
}

/** 保存一块：重新读盘，按 base_sha256 拒绝过期写入，再只替换这一块。 */
function saveBlock(docPath, payload) {
  if (!payload || typeof payload !== 'object') fail('block_request', '请求体必须是 JSON 对象');
  const { anchor, content, base_sha256: baseSha } = payload;
  if (typeof anchor !== 'string' || !/^b:[0-9a-f]{6,12}$/.test(anchor)) fail('block_anchor', '锚点形状不对');
  if (typeof content !== 'string') fail('block_content', '块内容必须是文本');
  const document = readDocument(docPath);
  if (typeof baseSha !== 'string' || baseSha !== sha256(document.raw)) {
    fail('stale_document', '文档已在别处被修改；请刷新工作台后再保存');
  }
  persistRepairs(docPath, document); // 只有基线对得上，才把这次打开补的锚点落盘
  const result = applyBlockContent(document.raw, anchor, content);
  atomicWrite(docPath, result.raw);
  return { ok: true, sha256: sha256(result.raw), block: viewBlock(result.block) };
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

/** 文档旁边的图片：只放行文档目录内的普通文件，不接受绝对路径与跨目录。 */
function assetFile(docPath, url) {
  const requested = new URL(url, 'http://127.0.0.1').searchParams.get('path') ?? '';
  if (!requested || /^(?:[a-zA-Z][a-zA-Z0-9+.-]*:|\/|~)/.test(requested)) return null;
  const root = resolve(docPath, '..');
  const file = resolve(root, requested);
  if (!file.startsWith(root + '/')) return null;
  if (!existsSync(file) || !statSync(file).isFile()) return null;
  return file;
}

export async function startDocWorkbench({ docPath, port = 0, host = '127.0.0.1' } = {}) {
  if (!docPath) throw Error('需要一份文档路径');
  const file = realpathSync(resolve(docPath));
  if (!statSync(file).isFile()) throw Error(`不是文件：${file}`);
  const startup = openDocument(file); // 打开就补锚点；补不了就让启动失败，而不是带着坏身份继续。

  const server = createServer(async (request, response) => {
    const url = new URL(request.url || '/', `http://${host}`);
    try {
      if (url.pathname === '/api/doc') {
        if (request.method !== 'GET') return json(response, 405, { ok: false, code: 'method', error: '用 GET 打开文档' });
        return json(response, 200, snapshotOf(file));
      }
      if (url.pathname === '/api/block') {
        if (request.method !== 'POST') return json(response, 405, { ok: false, code: 'method', error: '用 POST 保存块' });
        // 只接受工作台页面自己的同源 JSON 请求：别的网页不能借浏览器改本地文档。
        const allowedOrigin = `http://${host}:${server.address().port}`;
        if (request.headers.host !== `${host}:${server.address().port}`
          || (request.headers.origin !== undefined && request.headers.origin !== allowedOrigin)) {
          return json(response, 403, { ok: false, code: 'block_origin', error: '只接受工作台自己的保存请求' });
        }
        if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || '')) {
          return json(response, 415, { ok: false, code: 'block_content_type', error: '保存请求必须是 application/json' });
        }
        const payload = JSON.parse((await readBody(request)) || '{}');
        return json(response, 200, saveBlock(file, payload));
      }
      if (url.pathname === '/' || url.pathname === '/index.html') {
        return serveFile(response, join(ASSETS, 'doc-workbench.html'));
      }
      if (url.pathname === '/doc-workbench.js' || url.pathname === '/doc-inline.js' || url.pathname === '/doc-workbench.css') {
        return serveFile(response, join(ASSETS, url.pathname.slice(1)));
      }
      if (url.pathname === '/vendor/marked.js') {
        return serveFile(response, join(HERE, 'assets', 'content-review', 'marked.umd.js'));
      }
      if (url.pathname === '/asset') {
        const target = assetFile(file, request.url);
        if (!target) { response.writeHead(404); return response.end('not found'); }
        return serveFile(response, target);
      }
      json(response, 404, { ok: false, code: 'not_found', error: '没有这个入口' });
    } catch (error) {
      const status = error?.code === 'block_request' ? 400 : 409;
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
