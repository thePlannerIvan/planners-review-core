#!/usr/bin/env node
/**
 * 生成验收语料：把真实项目 Markdown 机械改写成 planners-doc/1，原文文字逐行保留、只改结构。
 *
 * 用法：
 *   node evals/acceptance/corpus/build-corpus.mjs \
 *     [--source-root <CodexProject 根>] [--out <语料目录>] [--check]
 *
 * 为什么需要改写：工作台只认 planners-doc/1（文档头 + 章节/页层级 + 七种块），
 * 项目里的真实 Markdown 是自由格式。这里只做结构适配，不改写句子：
 *   · 补文档头；# 作文档标题，## 作章节，### 作页，#### 原样作标题块
 *   · 丢掉 `---` 分隔线（契约不认）；把 5–6 级标题降为段落
 *   · 嵌套列表项去掉缩进（契约不做嵌套）；行首原始 HTML 转义成普通文字
 *   · 章节下没有页时补一个「概览」页，文档开头没有章节时补「概述 / 原文开头」页
 * 生成的文件不带锚点：首次打开时由工作台按契约补写（见 evals/acceptance/README.md）。
 *
 * --check 不写盘，只校验生成结果是否与磁盘上的语料一致（防止手改语料后来源失真）。
 */
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument, repairAnchors } from '../../../scripts/lib/doc-blocks.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..', '..');
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

const flag = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] !== undefined ? process.argv[index + 1] : fallback;
};
const sourceRoot = resolve(flag('--source-root', resolve(ROOT, '..', '..', '..')));
const outDir = resolve(flag('--out', HERE));
const checkOnly = process.argv.includes('--check');

/** 结构适配：返回原始文本（不含锚点）与改了几处。 */
function adaptDocument(source, meta) {
  const counts = { hr: 0, headings: 0, nestedLists: 0, htmlEscaped: 0, insertedPages: 0 };
  const lines = source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let inFence = false;
  let titleUsed = false;
  for (let line of lines) {
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; out.push(line); continue; }
    if (inFence) { out.push(line); continue; }
    if (/^\s*$/.test(line)) { out.push(''); continue; }
    if (/^(---+|\*\*\*+|___+)$/.test(line.trim())) { counts.hr += 1; out.push(''); continue; }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const text = heading[2].replace(/^\*\*(.+)\*\*$/, '$1').trim();
      const level = heading[1].length;
      counts.headings += 1;
      if (level === 1 && !titleUsed) { titleUsed = true; out.push(`# ${text}`); continue; }
      if (level === 1 || level === 2) { out.push(`## ${text}`); continue; }
      if (level === 3) { out.push(`### ${text}`); continue; }
      if (level === 4) { out.push(`#### ${text}`); continue; }
      out.push(`**${text}**`); continue;
    }
    if (/^\s+(-|\*|\+|\d+[.)])\s+/.test(line)) { counts.nestedLists += 1; line = line.replace(/^\s+/, ''); }
    if (/^\s*</.test(line)) { counts.htmlEscaped += 1; line = line.replace(/^(\s*)</, '$1\\<'); }
    out.push(line);
  }

  let raw = out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
  raw = `---\ncontract: planners-doc/1\ndoc: ${meta.doc}\nproject: ${meta.project}\n---\n\n${raw}`;

  // 每一块都必须落在某个 ### 页里：章节直接跟块时补「概览」页。
  const withPages = [];
  let needPage = false;
  for (const line of raw.split('\n')) {
    if (/^##\s+/.test(line)) {
      if (needPage) { withPages.push('### 概览', ''); counts.insertedPages += 1; }
      withPages.push(line); needPage = true; continue;
    }
    if (/^###\s+/.test(line)) { needPage = false; withPages.push(line); continue; }
    if (needPage && line.trim() !== '') {
      withPages.push('### 概览', ''); counts.insertedPages += 1; needPage = false;
    }
    withPages.push(line);
  }
  raw = withPages.join('\n');

  // 文档标题后、第一个 ## 之前如果有块，补一节「概述 / 原文开头」。
  const front = raw.match(/^(---\n[\s\S]*?\n---\n\n)(# .*\n)([\s\S]*)$/);
  if (front) {
    const rest = front[3];
    const firstChapter = rest.search(/^## /m);
    const head = firstChapter === -1 ? rest : rest.slice(0, firstChapter);
    if (head.trim()) {
      const tail = firstChapter === -1 ? '' : rest.slice(firstChapter);
      raw = `${front[1]}${front[2]}\n## 概述\n\n### 原文开头\n\n${head.replace(/^\n+/, '')}${tail ? `\n${tail}` : ''}`;
      counts.insertedPages += 2;
    }
  }

  // 有 ### 却没有 ## 时补一个章节（有些文档直接以三级标题分页）。
  const lines2 = raw.split('\n');
  if (!lines2.some((line) => /^##\s+/.test(line))) {
    const index = lines2.findIndex((line) => /^###\s+/.test(line));
    if (index >= 0) { lines2.splice(index, 0, '## 正文', ''); counts.insertedPages += 1; }
  }
  return { raw: lines2.join('\n').replace(/\n{3,}/g, '\n\n'), counts };
}

function statsOf(raw) {
  const parsed = parseDocument(repairAnchors(raw).raw, { checkImages: false });
  const types = {};
  for (const block of parsed.blocks) types[block.type] = (types[block.type] ?? 0) + 1;
  return {
    bytes: Buffer.byteLength(raw, 'utf8'),
    chapters: parsed.chapters.length,
    pages: parsed.pages.length,
    blocks: parsed.blocks.length,
    block_types: types,
    tables: types.table ?? 0,
    images: types.image ?? 0,
    quotes: types.quote ?? 0,
    code: types.code ?? 0,
    headings: types.heading ?? 0,
    lists: types.list ?? 0,
  };
}

const spec = JSON.parse(readFileSync(join(HERE, 'sources.json'), 'utf8'));
const entries = [];
for (const item of spec.sources) {
  const fromRepo = item.source.startsWith('contracts/');
  const sourcePath = fromRepo ? join(ROOT, item.source) : join(sourceRoot, item.source);
  if (!existsSync(sourcePath)) throw Error(`找不到来源：${sourcePath}`);
  const source = readFileSync(sourcePath, 'utf8');
  const alreadyContract = /^---\n[\s\S]*?contract: planners-doc\/1[\s\S]*?\n---\n/.test(source);
  let raw;
  let counts = null;
  if (alreadyContract) {
    raw = source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  } else {
    const adapted = adaptDocument(source, item);
    raw = adapted.raw;
    counts = adapted.counts;
  }
  const target = join(outDir, item.out);
  const previous = existsSync(target) ? readFileSync(target, 'utf8') : null;
  if (!checkOnly) writeFileSync(target, raw, 'utf8');
  if (checkOnly && previous !== raw) throw Error(`语料与来源不一致：${item.out}（重跑 build-corpus 或改 sources.json）`);
  entries.push({
    id: item.out.replace(/\.md$/, ''),
    file: item.out,
    source: {
      path: item.source,
      scope: fromRepo ? 'repo' : 'project',
      sha256: sha256(source),
      bytes: Buffer.byteLength(source, 'utf8'),
      lines: source.split('\n').length,
    },
    handling: alreadyContract ? 'verbatim' : 'structural-adaptation',
    transformations: counts,
    output: { sha256: sha256(raw), ...statsOf(raw) },
  });
}

// 契约样例用的图片资产也复制进来（语料要覆盖图片语法）。
const assetsFrom = [[join(ROOT, 'contracts/examples/assets'), join(outDir, 'assets')]];
for (const [from, to] of assetsFrom) {
  if (!existsSync(from)) continue;
  if (!checkOnly) {
    mkdirSync(to, { recursive: true });
    for (const name of readdirSync(from)) cpSync(join(from, name), join(to, name));
  }
}

const manifest = {
  contract: 'acceptance-corpus/1',
  note: spec.note,
  generated_by: 'evals/acceptance/corpus/build-corpus.mjs',
  documents: entries,
};
if (!checkOnly) writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
console.log(JSON.stringify({
  ok: true,
  check: checkOnly,
  source_root: sourceRoot,
  documents: entries.length,
  tables: entries.reduce((sum, entry) => sum + entry.output.tables, 0),
  images: entries.reduce((sum, entry) => sum + entry.output.images, 0),
  quotes: entries.reduce((sum, entry) => sum + entry.output.quotes, 0),
  code: entries.reduce((sum, entry) => sum + entry.output.code, 0),
}, null, 2));
