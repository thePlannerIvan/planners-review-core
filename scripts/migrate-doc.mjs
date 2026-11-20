#!/usr/bin/env node
/**
 * 把一份 planners-doc/1 文档迁到 planners-doc/2 —— 层级整体上移一位，正文不再有文档标题行。
 *
 * 用法：
 *   node scripts/migrate-doc.mjs 1 2 <file.md> [--sources-to-quote] [--out <path>] [--dry-run]
 *
 * 做什么：
 *   · `#`（文档标题）移除；frontmatter 的 `project` 才是文档名，缺了才用标题补上
 *   · `##` → `#`（章节）、`###` → `##`（页）、`####`–`######` → `###`–`#####`（标题块）
 *   · 块锚点一个不动；非标题块的 raw 逐字不动（标题块只换行首井号个数）
 *   · 代码围栏里的 `#` 是原文，不碰
 *
 * `--sources-to-quote`：把页末「依据与边界 / Sources」小节删掉标题、条目逐条转成引用，
 * 让页末连续的引用成为出处区（契约第 5 节）。这是可选的一步：不做，出处就只是普通列表。
 *
 * 迁移后跑一次校验，把错误列在回执里但**不阻断**——越界由模型在取稿时补（契约第 10 节）。
 * 退出码：0 已迁移（可能有校验错误）、1 这份文件不是 planners-doc/1、2 用法错误。
 */
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { VERSION, blockEndLine, parseDocument } from './lib/doc-blocks.mjs';

const SOURCE_SECTION_TITLES = new Set(['sources', 'source', '依据与边界']);

const usage = () => {
  console.error('用法：node migrate-doc.mjs 1 2 <file.md> [--sources-to-quote] [--out <path>] [--dry-run]');
  process.exit(2);
};

const args = process.argv.slice(2);
const flags = new Set(args.filter((arg) => arg.startsWith('--')));
const positional = args.filter((arg) => !arg.startsWith('--'));
const flagValue = (name) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : null;
};
const outPath = flagValue('--out');
if (positional.length !== 3) usage();
const [fromVersion, toVersion, file] = positional;
if (fromVersion !== '1' || toVersion !== '2') {
  console.error(`只支持 1 → 2，实际是 ${fromVersion} → ${toVersion}`);
  process.exit(2);
}
const docPath = resolve(file);
if (!existsSync(docPath) || !statSync(docPath).isFile()) {
  console.error(`找不到文档：${docPath}`);
  process.exit(2);
}

const raw = readFileSync(docPath, 'utf8');
const source = raw.replace(/^\uFEFF/, '');
const eol = source.includes('\r\n') ? '\r\n' : '\n';
const parsed = parseDocument(source, { checkImages: false });
if (parsed.front.contract !== 'planners-doc/1') {
  console.error(`这份文档不是 planners-doc/1（contract = ${JSON.stringify(parsed.front.contract ?? null)}），没有可迁移的层级`);
  process.exit(1);
}

// ---------- 1. 逐行上移一位 ----------
const lines = source.split(/\r?\n/);
// 文档头原样保留（只换 contract 版本），逐行改写从正文开始。
const out = lines.slice(0, parsed.bodyStart);
let inFence = false;
let droppedTitle = null;
let headings = 0;
for (let i = parsed.bodyStart; i < lines.length; i += 1) {
  const line = lines[i];
  if (/^\s*(`{3,}|~{3,})/.test(line)) {
    inFence = !inFence;
    out.push(line);
    continue;
  }
  if (inFence) {
    out.push(line);
    continue;
  }
  const heading = line.match(/^(#{1,6})([ \t]*)(.*)$/);
  if (!heading) {
    out.push(line);
    continue;
  }
  const level = heading[1].length;
  headings += 1;
  if (level === 1) {
    // 文档标题退出正文；它的文字只在 project 缺失时用来补文档名。
    droppedTitle = heading[3].replace(/<!--[\s\S]*?-->/g, '').trim();
    // 删掉标题行后如果两侧都成了空行，少留一个，避免凭空多出一段空白。
    if (out.length && out[out.length - 1].trim() === '' && lines[i + 1]?.trim() === '') {
      out.pop();
    }
    continue;
  }
  out.push(`${'#'.repeat(level - 1)}${heading[2]}${heading[3]}`);
}

// frontmatter：换契约版本；project 缺了才用被删掉的文档标题补。
const frontEnd = (() => {
  for (let i = 1; i < out.length; i += 1) if (out[i].trim() === '---') return i;
  return -1;
})();
if (frontEnd === -1) {
  console.error('文档头没有闭合的 ---，无法迁移');
  process.exit(1);
}
let hasProject = false;
for (let i = 1; i < frontEnd; i += 1) {
  if (/^contract\s*:/.test(out[i])) out[i] = out[i].replace(/^contract\s*:\s*.*$/, `contract: ${VERSION}`);
  if (/^project\s*:\s*\S/.test(out[i])) hasProject = true;
}
if (!hasProject && droppedTitle) out.splice(frontEnd, 0, `project: ${droppedTitle}`);

let migrated = out.join(eol);

// ---------- 2. 可选：页末 Sources / 依据与边界 转成引用 ----------
const warnings = [];
let convertedSections = 0;
let convertedBlocks = 0;
if (flags.has('--sources-to-quote')) {
  const current = parseDocument(migrated, { checkImages: false });
  const edits = [];
  for (const page of current.pages) {
    const section = sourceSectionOf(page);
    if (!section) continue;
    const region = rebuildAsQuotes(section, eol, warnings);
    if (!region) continue;
    // 位置就是语义：出处前面紧挨着的引用块，转完之后会和出处连成一串。
    const previous = page.blocks[page.blocks.indexOf(section.heading) - 1];
    if (previous?.type === 'quote') {
      warnings.push(`页「${page.title}」：出处前面紧挨着一个引用块，转换后它会和出处连成一串（位置就是语义）`);
    }
    const startLine = section.heading.startLine;
    const endLine = blockEndLine(section.blocks[section.blocks.length - 1]);
    edits.push({ startLine, endLine, lines: region, count: section.blocks.length });
  }
  // 从后往前改，前面的行号不会漂。
  edits.sort((a, b) => b.startLine - a.startLine);
  const migratedLines = migrated.split(eol);
  for (const edit of edits) {
    const startIndex = edit.startLine - 1;
    const count = edit.endLine - startIndex;
    const block = [...edit.lines];
    // 块与块之间靠空行分隔：与前后邻居各留一行。
    if (startIndex > 0 && migratedLines[startIndex - 1].trim() !== '') block.unshift('');
    const afterIndex = startIndex + count;
    if (migratedLines[afterIndex] !== undefined && migratedLines[afterIndex].trim() !== '') block.push('');
    migratedLines.splice(startIndex, count, ...block);
    convertedSections += 1;
    convertedBlocks += edit.count;
  }
  migrated = migratedLines.join(eol);
}

/**
 * 页末的「依据与边界 / Sources」小节：页内最后一个标题块标题对上，且其后还有块。
 * 不是这个形状就返回 null —— 迁移只处理自己认得的那一种，不猜。
 */
function sourceSectionOf(page) {
  const blocks = page.blocks;
  if (!blocks.length) return null;
  let heading = null;
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    if (blocks[i].type === 'heading') { heading = blocks[i]; break; }
  }
  if (!heading) return null;
  if (!SOURCE_SECTION_TITLES.has(heading.text.trim().toLowerCase())) return null;
  const position = blocks.indexOf(heading);
  const sectionBlocks = blocks.slice(position + 1);
  if (!sectionBlocks.length) return null;
  return { heading, blocks: sectionBlocks };
}

/** 小节里的块逐条转成引用；遇到转不了的块（表格 / 图片 / 代码 / 嵌套标题）整节不动。 */
function rebuildAsQuotes(section, lineEnding, notes) {
  const lines = migrated.split(lineEnding);
  const chunks = [];
  for (const block of section.blocks) {
    if (!['list', 'paragraph', 'quote'].includes(block.type)) {
      notes.push(`页「${section.heading.page?.title ?? ''}」的出处小节里有${block.type}，整节保持原样`);
      return null;
    }
    const rawLines = lines.slice(block.startLine - 1, blockEndLine(block));
    const quoted = [];
    rawLines.forEach((line, offset) => {
      if (block.type === 'list' && offset === 0) {
        // `- 条目` / `1. 条目` → `> 条目`，行尾锚点原样带过来。
        quoted.push(`> ${line.replace(/^\s*(?:[-*+]|\d+[.)])[ \t]+/, '')}`);
      } else if (line.trim() === '') {
        quoted.push('>');
      } else {
        quoted.push(`> ${line}`);
      }
    });
    chunks.push(quoted.join(lineEnding));
  }
  // 每一段之间留一个空行：连续几行 `>` 会被读成同一个引用块。
  const merged = [];
  chunks.forEach((chunk, index) => {
    if (index) merged.push('');
    merged.push(...chunk.split(lineEnding));
  });
  return merged;
}

for (const warning of warnings) console.error(`WARN ${warning}`);

if (flags.has('--dry-run')) {
  console.log(migrated);
  process.exit(0);
}

const target = outPath ? resolve(outPath) : docPath;
writeFileSync(target, migrated, 'utf8');

// ---------- 3. 迁移后校验：报错列出，但不阻断 ----------
const after = parseDocument(migrated, { docDir: dirname(target), checkImages: true });
console.log(JSON.stringify({
  ok: true,
  contract: VERSION,
  file: target,
  dropped_title: droppedTitle,
  headings,
  // sections 既是转换的小节数，也是被删掉的小节标题数。
  sources_to_quotes: flags.has('--sources-to-quote')
    ? { sections: convertedSections, blocks: convertedBlocks }
    : null,
  warnings,
  valid: after.errors.length === 0,
  errors: after.errors.map(({ code, message, line }) => ({ code, message, line })),
  checked: {
    file: basename(target),
    chapters: after.chapters.length,
    pages: after.pages.length,
    blocks: after.blocks.length,
    sources: after.pages.reduce((total, page) => total + page.sources.length, 0),
  },
}, null, 2));
