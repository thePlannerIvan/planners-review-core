#!/usr/bin/env node
/**
 * planners-doc/1 的唯一校验器。
 *
 * 用法：node validate-doc.mjs <storyline.md|by-page.md> [--text]
 *
 * 它挡的是**契约层面的结构漂移**：
 *   · 文档头缺字段、版本不对、doc 不认识
 *   · 页与章节的层级顺序不对（# 文档 / ## 章节 / ### 页 / #### 页内小节）
 *   · 锚点写法、位置、重复
 *   · 七种块之外的块（原始 HTML、分隔线、嵌套块……）
 *   · 图片不是相对路径、或相对路径指向的文件不存在
 *   · 页为空
 *
 * 它**不评价**内容：判断好不好、来源可不可信、表格排得好不好看，都不归它管。
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const VERSION = 'planners-doc/1';
const DOC_KINDS = ['storyline', 'by-page'];
const TYPE_NAMES = {
  paragraph: '段落',
  heading: '标题',
  list: '列表项',
  image: '图片',
  table: '表格',
  code: '代码',
  quote: '引用',
  html: '原始 HTML',
  rule: '分隔线',
};
const STANDALONE = new Set(['image', 'table', 'code']);
const BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'blockquote', 'canvas', 'details', 'div', 'dl', 'fieldset',
  'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header',
  'hr', 'iframe', 'img', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'script', 'section', 'style',
  'summary', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul', 'video',
]);

const ANCHOR_RE = /<!--\s*(b:[0-9a-f]{6,12})\s*-->/g;
const ANCHOR_AT_END_RE = /<!--\s*(b:[0-9a-f]{6,12})\s*-->\s*$/;
const ANCHOR_ONLY_RE = /^\s*<!--\s*(b:[0-9a-f]{6,12})\s*-->\s*$/;
const IMAGE_ONLY_RE = /^!\[[^\]]*\]\(\s*(?:<[^>\n]+>|[^\s)]+)(?:\s+["'][^"']*["'])?\s*\)$/;
const IMAGE_RE = /!\[[^\]]*\]\(\s*(?:<([^>\n]+)>|([^\s)]+))(?:\s+["'][^"']*["'])?\s*\)/g;
const HEADING_RE = /^(#{1,6})[ \t]+(.*)$/;
const EMPTY_HEADING_RE = /^(#{1,6})[ \t]*$/;
const LIST_RE = /^(\s*)([-*+]|\d+[.)])[ \t]+(.*)$/;
const HR_RE = /^(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const RAW_HTML_RE = /^<([a-zA-Z][a-zA-Z0-9-]*)(?:\s[^>]*)?\/?>/;
const TABLE_DELIMITER_RE = /^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)+\|?\s*$/;
/** 行内代码里的锚点 / 图片语法是示例文本，不当锚点用（替换成等长空白，索引不变） */
const stripInlineCode = (line) => line.replace(/`+[^`]*`+/g, (match) => ' '.repeat(match.length));

const errors = [];
const warnings = [];
const pushError = (code, message, context = {}) => errors.push({ code, message, ...context });
const pushWarning = (code, message, context = {}) => warnings.push({ code, message, ...context });

const args = process.argv.slice(2);
const textOutput = args.includes('--text');
const file = args.find((a) => !a.startsWith('--'));
if (!file) {
  console.error('用法：node validate-doc.mjs <storyline.md|by-page.md> [--text]');
  process.exit(2);
}
const docPath = resolve(file);
if (!existsSync(docPath) || !statSync(docPath).isFile()) {
  console.error(`找不到文档：${docPath}`);
  process.exit(2);
}

const raw = readFileSync(docPath, 'utf8').replace(/^\uFEFF/, '');
const lines = raw.split(/\r?\n/);
const docDir = dirname(docPath);

// ---------- 文档头 ----------
const front = {};
let bodyStart = 0;
let frontMatterClosed = false;

if (lines[0]?.trim() !== '---') {
  pushError('front_matter_missing', '文档头缺失：第一行必须是 ---', { line: 1 });
} else {
  let end = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trim() === '---') { end = i; break; }
  }
  if (end === -1) {
    pushError('front_matter_unclosed', '文档头没有闭合的 ---', { line: 1 });
  } else {
    frontMatterClosed = true;
    bodyStart = end + 1;
    for (let i = 1; i < end; i += 1) {
      const line = lines[i];
      if (line.trim() === '') continue;
      const match = line.match(/^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
      if (!match) {
        pushError('front_matter_syntax', `文档头只接受 key: value，实际是 ${JSON.stringify(line)}`, { line: i + 1 });
        continue;
      }
      const key = match[1];
      let value = match[2].trim();
      if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
        value = value.slice(1, -1);
      }
      if (Object.hasOwn(front, key)) {
        pushError('front_matter_duplicate', `文档头字段 ${key} 出现了两次`, { line: i + 1 });
      } else {
        front[key] = value;
      }
    }
  }
}

const KNOWN_FRONT_KEYS = ['contract', 'doc', 'project'];
for (const key of Object.keys(front)) {
  if (!KNOWN_FRONT_KEYS.includes(key)) {
    pushWarning('front_matter_unknown', `文档头有契约未定义的字段 ${key}；校验器会忽略它`, { line: 1 });
  }
}
if (frontMatterClosed) {
  if (front.contract !== VERSION) {
    pushError('contract_version', `contract 必须是 "${VERSION}"，实际 ${JSON.stringify(front.contract ?? null)}`, { line: 1 });
  }
  if (!DOC_KINDS.includes(front.doc)) {
    pushError('doc_kind', `doc 只能是 ${DOC_KINDS.join(' / ')}，实际 ${JSON.stringify(front.doc ?? null)}`, { line: 1 });
  }
  if (!front.project || front.project.trim() === '') {
    pushError('project_required', 'project 不能为空', { line: 1 });
  }
}

// ---------- 页与块 ----------
const state = {
  title: null,
  chapters: [],
  pages: [],
  blocks: [],
  chapter: null,
  page: null,
};
let open = null;
let lastStandalone = null;

const pageLabel = (page = state.page) => {
  if (!page) return null;
  const chapter = page.chapter ? `章节「${page.chapter.title}」` : '未命名章节';
  return `${chapter}第 ${page.index} 页「${page.title}」`;
};
const blockLabel = (block) => {
  if (!block) return null;
  if (block.anchor) return block.anchor;
  return `第 ${block.index} 块（${TYPE_NAMES[block.type] ?? block.type}）`;
};
const addBlock = (block) => {
  if (!block.index) block.index = state.page ? state.page.blocks.length + 1 : state.blocks.length + 1;
  block.page = state.page;
  state.blocks.push(block);
  if (state.page) state.page.blocks.push(block);
  else pushError('block_outside_page', `${typeName(block.type)}必须写在某个 ### 页里`, {
    line: block.startLine,
    block: blockLabel(block),
  });
  return block;
};
const typeName = (type) => TYPE_NAMES[type] ?? type;

const closeOpen = () => {
  if (!open) return null;
  const block = open;
  open = null;
  block.index = state.page ? state.page.blocks.length + 1 : state.blocks.length + 1;
  if (block.type === 'code') {
    if (!block.closed) {
      pushError('code_unclosed', '代码围栏没有闭合', { line: block.startLine, page: pageLabel(), block: blockLabel(block) });
    }
  }
  finalizeInline(block);
  addBlock(block);
  lastStandalone = STANDALONE.has(block.type) ? block : null;
  return block;
};

const finalizeInline = (block) => {
  if (STANDALONE.has(block.type)) {
    // 代码围栏里的内容是原文，锚点示例不算锚点
    if (block.type === 'code') return;
    // 图片 / 表格的锚点在元素下一行，行内写在这里是不合规的
    block.lines.forEach((line, offset) => {
      if ([...stripInlineCode(line).matchAll(ANCHOR_RE)].length) {
        pushError('anchor_position', '独立块（图片 / 表格）的锚点必须单独写在元素的下一行', {
          line: block.startLine + offset,
          page: pageLabel(),
          block: blockLabel(block),
        });
      }
    });
    return;
  }
  const lastIndex = block.lines.length - 1;
  block.lines.forEach((line, offset) => {
    const probe = stripInlineCode(line);
    const matches = [...probe.matchAll(ANCHOR_RE)];
    if (!matches.length) {
      if (/<!--\s*b:/.test(probe)) {
        pushError('anchor_format', '锚点必须是 <!-- b:6–12 位小写十六进制 -->', {
          line: block.startLine + offset,
          page: pageLabel(),
          block: blockLabel(block),
        });
      }
      return;
    }
    const isLast = offset === lastIndex;
    const only = matches.length === 1 && ANCHOR_AT_END_RE.test(probe);
    if (!isLast || !only) {
      pushError('anchor_position', '行内锚点只能有一个，且必须紧贴块的最后一行末尾', {
        line: block.startLine + offset,
        page: pageLabel(),
        block: blockLabel(block),
      });
      return;
    }
    const match = matches[0];
    block.anchor = match[1];
    block.anchorLine = block.startLine + offset;
    block.lines[lastIndex] = line.slice(0, match.index).replace(/\s+$/, '');
  });
};

const attachStandaloneAnchor = (block, anchor, line) => {
  if (block.anchor) {
    pushError('anchor_position', '一个块只能有一个锚点', { line, page: pageLabel(), block: blockLabel(block) });
    return;
  }
  block.anchor = anchor;
  block.anchorLine = line;
};

const heading = (level, rawLine, lineNo) => {
  const match = rawLine.match(HEADING_RE);
  let title = match[2].trim();
  let inlineAnchor = null;
  const probe = stripInlineCode(title);
  const anchorMatches = [...probe.matchAll(ANCHOR_RE)];
  const anchorAtEnd = ANCHOR_AT_END_RE.exec(probe);

  if (anchorMatches.length) {
    if (level <= 3) {
      pushError('anchor_on_structure', '文档 / 章节 / 页的标题不是块，不能带锚点；锚点属于块', {
        line: lineNo,
        page: pageLabel(),
        block: anchorMatches[0][1],
      });
      title = title.replace(ANCHOR_RE, '').trim();
    } else if (anchorMatches.length === 1 && anchorAtEnd) {
      inlineAnchor = anchorMatches[0][1];
      title = title.slice(0, anchorMatches[0].index).trim();
    } else {
      pushError('anchor_position', '标题块的锚点只能有一个，且必须写在标题末尾', {
        line: lineNo,
        page: pageLabel(),
        block: anchorMatches[0][1],
      });
      title = title.replace(ANCHOR_RE, '').trim();
    }
  }
  if (title === '') {
    pushError('heading_empty', `${'#'.repeat(level)} 标题不能为空`, { line: lineNo, page: pageLabel() });
  }

  if (level === 1) {
    if (state.title !== null || state.chapter || state.page) {
      pushError('heading_order', '文档只能有一个 # 标题，且必须在最前面', { line: lineNo });
    }
    state.title = title;
    return;
  }
  if (level === 2) {
    if (state.title === null) pushError('heading_order', '## 章节必须写在 # 文档标题之后', { line: lineNo });
    state.chapter = { title, line: lineNo, pages: [] };
    state.chapters.push(state.chapter);
    state.page = null;
    return;
  }
  if (level === 3) {
    if (!state.chapter) {
      pushError('page_without_chapter', '### 页必须写在 ## 章节里', { line: lineNo });
    }
    const page = {
      index: state.chapter ? state.chapter.pages.length + 1 : state.pages.length + 1,
      title,
      line: lineNo,
      chapter: state.chapter,
      blocks: [],
    };
    if (state.chapter) state.chapter.pages.push(page);
    state.pages.push(page);
    state.page = page;
    return;
  }
  if (level === 4) {
    if (!state.page) {
      pushError('section_without_page', '#### 页内小节必须写在 ### 页里', { line: lineNo });
    }
    const block = {
      type: 'heading',
      level: 4,
      text: title,
      startLine: lineNo,
      endLine: lineNo,
      lines: [rawLine],
      anchor: inlineAnchor,
      anchorLine: inlineAnchor ? lineNo : null,
    };
    // 结构标题的锚点已在上面单独拒绝；这里只收 #### 的
    addBlock(block);
    return;
  }
  pushError('heading_level', `只支持到 ####；##### 及以下不在第一期契约里`, { line: lineNo, page: pageLabel() });
  addBlock({
    type: 'heading',
    level,
    text: title,
    startLine: lineNo,
    endLine: lineNo,
    lines: [rawLine],
  });
};

const consumeTable = (start) => {
  let end = start + 1;
  // 行里只要有 | 就还是这张表的一行；空行才是边界（GFM 表格的行必须有管道）
  while (end < lines.length && lines[end].includes('|') && lines[end].trim() !== '') end += 1;
  const block = {
    type: 'table',
    startLine: start + 1,
    endLine: end,
    lines: lines.slice(start, end),
  };
  addBlock(block);
  lastStandalone = block;
  return end - 1;
};

const consumeRawHtml = (start) => {
  let end = start + 1;
  while (end < lines.length && lines[end].trim() !== '') end += 1;
  const block = { type: 'html', startLine: start + 1, endLine: end, lines: lines.slice(start, end) };
  addBlock(block);
  pushError('block_type', `原始 HTML 不在七种块里；需要排版就用 Markdown，需要自定义样式请另开页面`, {
    line: start + 1,
    page: pageLabel(),
    block: blockLabel(block),
  });
  return end - 1;
};

for (let i = bodyStart; i < lines.length; i += 1) {
  const line = lines[i];
  const lineNo = i + 1;
  const trimmed = line.trim();

  // 代码围栏里的内容原样属于这个块
  if (open?.type === 'code') {
    const fence = line.match(/^\s*(`{3,}|~{3,})\s*$/);
    if (fence && fence[1][0] === open.fenceChar && fence[1].length >= open.fenceLen) {
      open.closed = true;
      open.endLine = lineNo;
      open.lines.push(line);
      closeOpen();
      continue;
    }
    open.lines.push(line);
    open.endLine = lineNo;
    continue;
  }

  if (trimmed === '') {
    closeOpen();
    lastStandalone = null;
    continue;
  }

  // 写成锚点、但不符合锚点格式：宁可报错，也别把它当普通段落吞掉
  if (/^\s*<!--\s*b:/.test(line) && ![...line.matchAll(ANCHOR_RE)].length) {
    closeOpen();
    pushError('anchor_format', `锚点必须是 <!-- b:6–12 位小写十六进制 -->，实际是 ${JSON.stringify(trimmed)}`, {
      line: lineNo,
      page: pageLabel(),
      block: '锚点行',
    });
    lastStandalone = null;
    continue;
  }

  // 独立块的锚点：必须紧跟在元素下一行
  const anchorOnly = line.match(ANCHOR_ONLY_RE);
  if (anchorOnly) {
    closeOpen();
    if (lastStandalone && lastStandalone.endLine === lineNo - 1) {
      attachStandaloneAnchor(lastStandalone, anchorOnly[1], lineNo);
    } else {
      pushError('anchor_orphan', '这一行只有一个锚点，但它上面不是图片 / 表格 / 代码块', {
        line: lineNo,
        page: pageLabel(),
        block: anchorOnly[1],
      });
    }
    lastStandalone = null;
    continue;
  }

  // 围栏开始
  const fenceStart = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
  if (fenceStart) {
    closeOpen();
    open = {
      type: 'code',
      fenceChar: fenceStart[1][0],
      fenceLen: fenceStart[1].length,
      startLine: lineNo,
      endLine: lineNo,
      lines: [line],
      closed: false,
    };
    lastStandalone = null;
    continue;
  }

  // 标题
  if (HEADING_RE.test(line) || EMPTY_HEADING_RE.test(line)) {
    closeOpen();
    lastStandalone = null;
    const empty = line.match(EMPTY_HEADING_RE);
    if (empty) {
      pushError('heading_empty', `${'#'.repeat(empty[1].length)} 标题不能为空`, { line: lineNo, page: pageLabel() });
    } else {
      const match = line.match(HEADING_RE);
      heading(match[1].length, line, lineNo);
    }
    continue;
  }

  // Setext 标题：契约只认 ATX（#），别让 `===` 在渲染时偷偷变成标题
  if (/^=+\s*$/.test(trimmed)) {
    closeOpen();
    const block = { type: 'heading', startLine: lineNo, endLine: lineNo, lines: [line] };
    addBlock(block);
    pushError('heading_syntax', '标题只用 # 写法；Setext 的下划线（===）不在契约里', {
      line: lineNo,
      page: pageLabel(),
      block: blockLabel(block),
    });
    lastStandalone = null;
    continue;
  }

  // 分隔线不在白名单里
  if (HR_RE.test(trimmed)) {
    closeOpen();
    const block = { type: 'rule', startLine: lineNo, endLine: lineNo, lines: [line] };
    addBlock(block);
    pushError('block_type', '分隔线不在七种块里；页与块之间靠空行与标题分隔', {
      line: lineNo,
      page: pageLabel(),
      block: blockLabel(block),
    });
    lastStandalone = null;
    continue;
  }

  // 原始 HTML 块
  const html = trimmed.match(RAW_HTML_RE);
  if (html && BLOCK_TAGS.has(html[1].toLowerCase())) {
    closeOpen();
    i = consumeRawHtml(i);
    lastStandalone = null;
    continue;
  }

  // 表格：表头行 + 分隔行。首尾管道可省，但分隔行必须真的是一行表头分隔。
  if (line.includes('|') && i + 1 < lines.length && TABLE_DELIMITER_RE.test(lines[i + 1])) {
    closeOpen();
    i = consumeTable(i);
    continue;
  }

  // 整行只有一张图 = 图片块
  if (IMAGE_ONLY_RE.test(trimmed)) {
    closeOpen();
    const block = { type: 'image', startLine: lineNo, endLine: lineNo, lines: [line] };
    addBlock(block);
    lastStandalone = block;
    continue;
  }

  // 列表项
  const list = line.match(LIST_RE);
  if (list) {
    closeOpen();
    if (list[1].length > 0) {
      const block = { type: 'list', startLine: lineNo, endLine: lineNo, lines: [line] };
      addBlock(block);
      pushError('block_nested', '不做嵌套块：列表项必须顶格写', {
        line: lineNo,
        page: pageLabel(),
        block: blockLabel(block),
      });
      lastStandalone = null;
    } else {
      open = { type: 'list', startLine: lineNo, endLine: lineNo, lines: [line] };
      lastStandalone = null;
    }
    continue;
  }

  // 引用：连续的 > 行是同一个引用块
  if (/^\s*>/.test(line)) {
    if (open?.type !== 'quote') {
      closeOpen();
      open = { type: 'quote', startLine: lineNo, endLine: lineNo, lines: [line] };
    } else {
      open.lines.push(line);
      open.endLine = lineNo;
    }
    if (LIST_RE.test(line.replace(/^\s*>\s?/, ''))) {
      pushError('block_nested', '引用里不再嵌列表；一个引用块就是一段引文', {
        line: lineNo,
        page: pageLabel(),
        block: blockLabel(open),
      });
    }
    lastStandalone = null;
    continue;
  }

  // 段落（多行合并成一个块）
  if (!open) {
    open = { type: 'paragraph', startLine: lineNo, endLine: lineNo, lines: [line] };
  } else {
    open.lines.push(line);
    open.endLine = lineNo;
  }
  lastStandalone = null;
}
closeOpen();

// ---------- 段后判据：页为空 / 锚点重复 / 图片可解析 ----------
for (const page of state.pages) {
  if (page.blocks.length === 0) {
    pushError('page_empty', `页「${page.title}」没有任何块；空页不进入目录`, {
      line: page.line,
      page: pageLabel(page),
      block: `页「${page.title}」`,
    });
  }
}

if (state.pages.length === 0) {
  pushWarning('document_without_pages', '文档里没有 ### 页；目录会是空的', { line: 1 });
}

const seenAnchors = new Map();
for (const block of state.blocks) {
  if (!block.anchor) continue;
  const line = block.anchorLine ?? block.startLine;
  if (seenAnchors.has(block.anchor)) {
    const first = seenAnchors.get(block.anchor);
    pushError('anchor_duplicate', `锚点 ${block.anchor} 与第 ${first.anchorLine ?? first.startLine} 行重复；锚点必须全局唯一`, {
      line,
      page: pageLabel(block.page),
      block: block.anchor,
    });
  } else {
    seenAnchors.set(block.anchor, block);
  }
}

for (const block of state.blocks) {
  if (block.type === 'code') continue;
  const blockRaw = block.lines.join('\n');
  const probeRaw = stripInlineCode(blockRaw);
  const seenImages = new Set();
  for (const match of probeRaw.matchAll(IMAGE_RE)) {
    const target = (match[1] ?? match[2] ?? '').trim();
    if (!target || seenImages.has(target)) continue;
    seenImages.add(target);
    const lineOffset = (probeRaw.slice(0, match.index).match(/\n/g) ?? []).length;
    const line = block.startLine + lineOffset;
    if (/^(?:[a-zA-Z][a-zA-Z0-9+.-]*:|\/\/|\/)/.test(target)) {
      pushError('image_not_relative', `图片必须用相对路径，实际是 ${JSON.stringify(target)}`, {
        line,
        page: pageLabel(block.page),
        block: blockLabel(block),
      });
      continue;
    }
    const absolute = resolve(docDir, target);
    if (!existsSync(absolute)) {
      pushError('image_missing', `图片不存在：${target}（解析为 ${absolute}）`, {
        line,
        page: pageLabel(block.page),
        block: blockLabel(block),
      });
    } else if (!statSync(absolute).isFile()) {
      pushError('image_not_file', `图片路径不是文件：${target}（解析为 ${absolute}）`, {
        line,
        page: pageLabel(block.page),
        block: blockLabel(block),
      });
    }
  }
}

// ---------- 输出 ----------
errors.sort((a, b) => (a.line ?? 0) - (b.line ?? 0) || a.code.localeCompare(b.code));
const valid = errors.length === 0;
const checked = {
  path: docPath,
  contract: front.contract ?? null,
  doc: front.doc ?? null,
  project: front.project ?? null,
  chapters: state.chapters.length,
  pages: state.pages.length,
  blocks: state.blocks.length,
  anchors: state.blocks.filter((block) => block.anchor).length,
};

if (textOutput) {
  for (const warning of warnings) {
    const where = [warning.line ? `行 ${warning.line}` : null, warning.page, warning.block].filter(Boolean).join(' · ');
    console.log(`WARN  [${warning.code}] ${where ? `${where}：` : ''}${warning.message}`);
  }
  for (const error of errors) {
    const where = [error.line ? `行 ${error.line}` : null, error.page, error.block].filter(Boolean).join(' · ');
    console.log(`ERROR [${error.code}] ${where ? `${where}：` : ''}${error.message}`);
  }
  console.log(valid ? `\n合规：${warnings.length} 个警告` : `\n不合规：${errors.length} 个错误、${warnings.length} 个警告`);
} else {
  console.log(JSON.stringify({ contract: VERSION, valid, errors, warnings, checked }, null, 2));
}
process.exit(valid ? 0 : 1);
