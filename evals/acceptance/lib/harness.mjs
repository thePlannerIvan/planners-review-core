/**
 * 验收用例的公共工具：临时沙箱、工作台进程、块级对比。
 *
 * 只走公开的缝：工作台的 HTTP 命令面（GET /api/doc、POST /api/block、…）与磁盘上的文本。
 * 不 import 工作台内部的块实现去「算标准答案」——块怎么切是契约的事，
 * 这里用同一个合同一实现 `lib/doc-blocks.mjs` 只是为了把磁盘文本读回块，
 * 对比的仍然是磁盘字节。
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { parseDocument } from '../../../scripts/lib/doc-blocks.mjs';

export const HERE = dirname(fileURLToPath(import.meta.url));
export const ACCEPTANCE = resolve(HERE, '..');
export const ROOT = resolve(ACCEPTANCE, '..', '..');
export const CORPUS = join(ACCEPTANCE, 'corpus');

export const sha256 = (value) => createHash('sha256').update(value).digest('hex');

/** 每个用例一个临时目录，避免污染仓库里的语料。 */
export function sandboxCorpus(prefix = 'acceptance-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cpSync(CORPUS, dir, { recursive: true });
  return {
    dir,
    path: (file) => join(dir, file),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

export async function openWorkbench(docPath, options = {}) {
  const { startDocWorkbench } = await import('../../../scripts/doc-workbench.mjs');
  return startDocWorkbench({ docPath, port: 0, ...options });
}

export const getJson = async (url) => {
  const response = await fetch(url);
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
};

export const postJson = async (url, payload) => {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
};

/** 打开一次、立刻关掉：不碰文档内容。返回启动回执里补了多少个锚点。 */
export async function openClose(docPath) {
  const server = await openWorkbench(docPath);
  try {
    const opened = await getJson(`${server.url}/api/doc`);
    if (opened.status !== 200) throw Error(`GET /api/doc 失败：${opened.status} ${JSON.stringify(opened.body)}`);
    return { repairs: server.repairs?.length ?? 0, doc: opened.body };
  } finally {
    await server.close();
  }
}

export function readDoc(docPath) {
  const raw = readFileSync(docPath, 'utf8');
  const parsed = parseDocument(raw, { checkImages: true });
  return { raw, parsed };
}

/** 块在磁盘原文里的片段：内容 + 锚点，按字符区间取，用来做「只有这块变了」的字节级断言。 */
export function blockSegments(raw, parsed) {
  return parsed.blocks.map((block) => ({
    anchor: block.anchor ?? null,
    type: block.type,
    start: block.startOffset,
    end: block.endOffset,
    segment: raw.slice(block.startOffset, block.endOffset),
    raw: block.raw,
  }));
}

/** 两次读盘之间，块序列的差异摘要。调用方断言 untouched 为空、changed 恰好是目标块。 */
export function compareBlocks(before, after) {
  const a = blockSegments(before.raw, before.parsed);
  const b = blockSegments(after.raw, after.parsed);
  const changed = [];
  const untouched = [];
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i += 1) {
    const left = a[i];
    const right = b[i];
    if (!left || !right || left.anchor !== right.anchor || left.segment !== right.segment) {
      changed.push({
        index: i,
        anchor_before: left?.anchor ?? null,
        anchor_after: right?.anchor ?? null,
        type_before: left?.type ?? null,
        type_after: right?.type ?? null,
      });
    } else {
      untouched.push(left.anchor);
    }
  }
  return { changed, untouched, before_count: a.length, after_count: b.length };
}

/** 字节级差异区间：返回公共前缀/后缀的字节数与差异区间（闭区间）。 */
export function diffSpan(beforeBuffer, afterBuffer) {
  const before = Buffer.from(beforeBuffer);
  const after = Buffer.from(afterBuffer);
  const max = Math.min(before.length, after.length);
  let prefix = 0;
  while (prefix < max && before[prefix] === after[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < max - prefix
    && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix += 1;
  return {
    prefix_bytes: prefix,
    suffix_bytes: suffix,
    start: prefix,
    end: after.length - suffix,
    before_bytes: before.length,
    after_bytes: after.length,
  };
}

/** 字符区间 → UTF-8 字节区间。块偏移是 JS 字符串下标；磁盘对比要按字节算。 */
export function charRangeToBytes(raw, start, end) {
  return {
    start: Buffer.byteLength(raw.slice(0, start), 'utf8'),
    end: Buffer.byteLength(raw.slice(0, end), 'utf8'),
  };
}

/** 找一个适合做「改一块」的块：可编辑的段落或列表项，且带锚点。 */
export function pickEditableBlock(blocks, { prefer = ['paragraph', 'list', 'quote', 'heading'], singleLine = false } = {}) {
  const fits = (block, type) => block.type === type
    && block.anchor && block.editable !== false
    && (!singleLine || !String(block.raw).includes('\n'));
  for (const type of prefer) {
    const found = blocks.find((block) => fits(block, type));
    if (found) return found;
  }
  return blocks.find((block) => block.anchor && block.editable !== false) ?? null;
}

/** 语料清单（build-corpus.mjs 生成）。 */
export function loadCorpus() {
  return JSON.parse(readFileSync(join(CORPUS, 'manifest.json'), 'utf8'));
}

export function gitInfo() {
  const run = (...args) => spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' }).stdout.trim();
  let head = null; let branch = null; let dirty = null;
  try {
    head = run('rev-parse', 'HEAD');
    branch = run('rev-parse', '--abbrev-ref', 'HEAD');
    dirty = run('status', '--porcelain') !== '';
  } catch { /* 不在 git 里也能跑验收，只是报告里没有 sha */ }
  return { head, branch, dirty };
}


/** 找 Playwright：先按本仓解析，再退到全局 npm 根。找不到/起不来时由调用方记「无法验证」。 */
export async function loadPlaywright() {
  const require = createRequire(import.meta.url);
  let playwright = null;
  let resolvedFrom = null;
  try {
    playwright = require('playwright');
    resolvedFrom = 'local';
  } catch {
    const root = spawnSync('npm', ['root', '-g'], { encoding: 'utf8' }).stdout.trim();
    if (root) {
      try {
        playwright = createRequire(join(root, 'noop.js'))('playwright');
        resolvedFrom = 'global';
      } catch { /* below */ }
    }
  }
  if (!playwright) return { available: false, reason: '没有找到 Playwright（本仓 node_modules 与全局 npm 根都没有）' };
  const executable = playwright.chromium.executablePath();
  if (!executable) return { available: false, reason: 'Playwright 没有 Chromium 可执行文件（未安装浏览器）' };
  return { available: true, playwright, resolvedFrom, executable };
}
