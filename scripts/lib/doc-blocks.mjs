/**
 * planners-doc/1 的块模型。
 *
 * 契约只有一份：`scripts/validate-doc.mjs` 用它校验，`scripts/doc-workbench.mjs`
 * 用它切块、补锚点、只回写被改块的 raw。两边各写一套切块规则是保真事故的源头，
 * 所以这里既是解析器，也是唯一实现。
 *
 * 解析结果里的每个 block 都带：
 *   · startOffset / endOffset —— 这一块在原文里的字符区间，用来做「只替换一块」；
 *   · raw —— 块 raw（不含锚点），编辑时进出的就是这个字串；
 *   · anchor / anchorStartOffset / anchorEndOffset —— 块身份与它在原文里的位置。
 */
import { existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const VERSION = 'planners-doc/1';
export const DOC_KINDS = ['storyline', 'by-page'];
export const TYPE_NAMES = {
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
export const STANDALONE = new Set(['image', 'table', 'code']);
export const BLOCK_TYPES = new Set(['paragraph', 'heading', 'list', 'image', 'table', 'code', 'quote']);
const BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'blockquote', 'canvas', 'details', 'div', 'dl', 'fieldset',
  'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header',
  'hr', 'iframe', 'img', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'script', 'section', 'style',
  'summary', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul', 'video',
]);

export const ANCHOR_RE = /<!--\s*(b:[0-9a-f]{6,12})\s*-->/g;
export const ANCHOR_AT_END_RE = /<!--\s*(b:[0-9a-f]{6,12})\s*-->\s*$/;
export const ANCHOR_ONLY_RE = /^\s*<!--\s*(b:[0-9a-f]{6,12})\s*-->\s*$/;
const ANCHOR_ANY_RE = /<!--\s*b:[0-9a-f]{6,12}\s*-->/;
const IMAGE_ONLY_RE = /^!\[[^\]]*\]\(\s*(?:<[^>\n]+>|[^\s)]+)(?:\s+["'][^"']*["'])?\s*\)$/;
const IMAGE_RE = /!\[([^\]]*)\]\(\s*(?:<([^>\n]+)>|([^\s)]+))(?:\s+["']([^"']*)["'])?\s*\)/g;
const HEADING_RE = /^(#{1,6})[ \t]+(.*)$/;
const EMPTY_HEADING_RE = /^(#{1,6})[ \t]*$/;
const LIST_RE = /^(\s*)([-*+]|\d+[.)])[ \t]+(.*)$/;
const HR_RE = /^(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const RAW_HTML_RE = /^<([a-zA-Z][a-zA-Z0-9-]*)(?:\s[^>]*)?\/?>/;
export const TABLE_DELIMITER_RE = /^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)+\|?\s*$/;
/** 行内代码里的锚点 / 图片语法是示例文本，不当锚点用（替换成等长空白，索引不变） */
const stripInlineCode = (line) => line.replace(/`+[^`]*`+/g, (match) => ' '.repeat(match.length));

/**
 * 一段 Markdown 里的图片引用。行内代码里的示例不算。
 * 工作台的图块显示、资产清单、校验器都从这里取路径，避免三份解析漂移。
 *
 * @returns {Array<{alt:string, path:string, title:string}>}
 */
export function imageReferences(raw) {
  const probe = stripInlineCode(String(raw ?? ''));
  return [...probe.matchAll(IMAGE_RE)]
    .map((match) => ({ alt: match[1] ?? '', path: (match[2] ?? match[3] ?? '').trim(), title: match[4] ?? '' }))
    .filter((reference) => reference.path !== '');
}

/** 一个独立图块（整行只有图片）的引用；不是图片块就给 null。 */
export function imageReference(raw) {
  return imageReferences(raw)[0] ?? null;
}

/** 行首到行内容结束（去掉行尾空白）的长度 */
const trimmedLength = (line) => line.replace(/\s+$/, '').length;

/**
 * 解析一份 planners-doc/1 原文。
 *
 * @param {string} raw 文件原文
 * @param {{docDir?: string|null, checkImages?: boolean}} [options]
 *   docDir + checkImages 时同时检查图片路径（校验器需要；工作台打开时不需要，
 *   缺图不应让整份文档打不开）。
 */
export function parseDocument(raw, options = {}) {
  const { docDir = null, checkImages = docDir !== null } = options;
  const text = String(raw ?? '').replace(/^\uFEFF/, '');
  const lines = text.split(/\r?\n/);
  const errors = [];
  const warnings = [];
  const pushError = (code, message, context = {}) => errors.push({ code, message, ...context });
  const pushWarning = (code, message, context = {}) => warnings.push({ code, message, ...context });

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
  const state = { title: null, chapters: [], pages: [], blocks: [], chapter: null, page: null };
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
  const typeName = (type) => TYPE_NAMES[type] ?? type;
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
      block.inlineAnchor = true;
      block.anchorStartColumn = match.index;
      block.anchorEndColumn = match.index + match[0].length;
      block.lines[lastIndex] = line.slice(0, match.index).replace(/\s+$/, '');
      block.contentEndColumn = block.lines[lastIndex].length;
    });
  };

  const attachStandaloneAnchor = (block, anchor, line) => {
    if (block.anchor) {
      pushError('anchor_position', '一个块只能有一个锚点', { line, page: pageLabel(), block: blockLabel(block) });
      return;
    }
    block.anchor = anchor;
    block.anchorLine = line;
    block.inlineAnchor = false;
  };

  const heading = (level, rawLine, lineNo) => {
    const match = rawLine.match(HEADING_RE);
    let title = match[2].trim();
    let inlineAnchor = null;
    let anchorIndexInRaw = null;
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
        // title 已经 trim 过；换算出锚点在原始行里的列。
        const leftTrim = match[2].length - match[2].trimStart().length;
        anchorIndexInRaw = rawLine.length - match[2].length + leftTrim + anchorMatches[0].index;
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
      state.chapter = { title, line: lineNo, index: state.chapters.length + 1, pages: [] };
      state.chapters.push(state.chapter);
      state.page = null;
      return;
    }
    if (level === 3) {
      if (!state.chapter) pushError('page_without_chapter', '### 页必须写在 ## 章节里', { line: lineNo });
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
      const contentLine = inlineAnchor !== null
        ? rawLine.slice(0, anchorIndexInRaw).replace(/\s+$/, '')
        : rawLine;
      const block = {
        type: 'heading',
        level: 4,
        text: title,
        startLine: lineNo,
        endLine: lineNo,
        lines: [contentLine],
        anchor: inlineAnchor,
        anchorLine: inlineAnchor ? lineNo : null,
        inlineAnchor: inlineAnchor !== null,
        anchorStartColumn: inlineAnchor !== null ? anchorIndexInRaw : null,
        anchorEndColumn: inlineAnchor !== null ? anchorIndexInRaw + `<!-- b:${inlineAnchor} -->`.length : null,
        contentEndColumn: inlineAnchor !== null ? contentLine.length : null,
      };
      addBlock(block);
      return;
    }
    pushError('heading_level', '只支持到 ####；##### 及以下不在第一期契约里', { line: lineNo, page: pageLabel() });
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
    pushError('block_type', '原始 HTML 不在七种块里；需要排版就用 Markdown，需要自定义样式请另开页面', {
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

    const html = trimmed.match(RAW_HTML_RE);
    if (html && BLOCK_TAGS.has(html[1].toLowerCase())) {
      closeOpen();
      i = consumeRawHtml(i);
      lastStandalone = null;
      continue;
    }

    if (line.includes('|') && i + 1 < lines.length && TABLE_DELIMITER_RE.test(lines[i + 1])) {
      closeOpen();
      i = consumeTable(i);
      continue;
    }

    if (IMAGE_ONLY_RE.test(trimmed)) {
      closeOpen();
      const block = { type: 'image', startLine: lineNo, endLine: lineNo, lines: [line] };
      addBlock(block);
      lastStandalone = block;
      continue;
    }

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

  if (docDir && checkImages) {
    for (const block of state.blocks) {
      if (block.type === 'code') continue;
      const blockRaw = block.lines.join('\n');
      const probeRaw = stripInlineCode(blockRaw);
      const seenImages = new Set();
      for (const match of probeRaw.matchAll(IMAGE_RE)) {
        const target = (match[2] ?? match[3] ?? '').trim();
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
  }

  // ---------- 原文位置：只替换一块靠它 ----------
  const lineStarts = [];
  let cursor = 0;
  for (const line of lines) {
    lineStarts.push(cursor);
    cursor += line.length;
    if (text.slice(cursor, cursor + 2) === '\r\n') cursor += 2;
    else if (text[cursor] === '\n') cursor += 1;
  }
  const lineEnds = lines.map((line, index) => lineStarts[index] + line.length);
  for (const block of state.blocks) {
    block.startOffset = lineStarts[block.startLine - 1] ?? 0;
    const lastLine = block.endLine - 1;
    if (STANDALONE.has(block.type)) {
      block.contentEndOffset = lineEnds[lastLine] ?? block.startOffset;
    } else if (block.inlineAnchor && block.contentEndColumn !== null) {
      block.contentEndOffset = (lineStarts[lastLine] ?? block.startOffset) + block.contentEndColumn;
    } else {
      block.contentEndOffset = (lineStarts[lastLine] ?? block.startOffset) + trimmedLength(lines[lastLine] ?? '');
    }
    if (block.anchor) {
      if (block.inlineAnchor) {
        block.anchorStartOffset = (lineStarts[block.anchorLine - 1] ?? block.startOffset) + block.anchorStartColumn;
        block.anchorEndOffset = (lineStarts[block.anchorLine - 1] ?? block.startOffset) + block.anchorEndColumn;
      } else {
        block.anchorStartOffset = lineStarts[block.anchorLine - 1] ?? block.contentEndOffset;
        block.anchorEndOffset = lineEnds[block.anchorLine - 1] ?? block.contentEndOffset;
      }
      block.endOffset = Math.max(block.contentEndOffset, block.anchorEndOffset);
    } else {
      block.endOffset = block.contentEndOffset;
    }
    block.raw = block.lines.join('\n');
  }

  errors.sort((a, b) => (a.line ?? 0) - (b.line ?? 0) || a.code.localeCompare(b.code));
  return {
    front,
    title: state.title,
    chapters: state.chapters,
    pages: state.pages,
    blocks: state.blocks,
    errors,
    warnings,
    lines,
    lineStarts,
    bodyStart,
    text,
  };
}

/** 生成一个 6 位小写十六进制锚点，避开 already 里已有的身份。 */
export function generateAnchor(already = new Set()) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const anchor = `b:${randomBytes(3).toString('hex')}`;
    if (!already.has(anchor)) return anchor;
  }
  throw Error('无法生成唯一锚点');
}

const anchorText = (anchor) => `<!-- ${anchor} -->`;

/**
 * 打开文档时补齐缺失锚点、重建重复锚点。只动锚点本身，正文一个字节都不重写。
 *
 * @returns {{raw:string, changed:boolean, repairs:Array<{anchor:string,action:'added'|'rebuilt',line:number}>}}
 */
export function repairAnchors(raw, options = {}) {
  const { generate = generateAnchor } = options;
  const parsed = parseDocument(raw, { checkImages: false });
  const source = parsed.text;
  const bom = String(raw).startsWith('\uFEFF') ? '\uFEFF' : '';
  const seen = new Set(parsed.blocks.filter((block) => block.anchor).map((block) => block.anchor));
  const firstSeen = new Set();
  const repairs = [];
  const edits = [];
  const eol = source.includes('\r\n') ? '\r\n' : '\n';

  for (const block of parsed.blocks) {
    if (!BLOCK_TYPES.has(block.type)) continue; // 七种之外的块不伪造身份，原样显示
    if (block.type === 'code' && block.closed === false) {
      // 围栏没闭合，补在里面的锚点会被当成代码；它的身份也不能参与去重。
      if (block.anchor) firstSeen.add(block.anchor);
      continue;
    }
    if (!block.anchor) {
      const anchor = generate(seen);
      seen.add(anchor);
      if (STANDALONE.has(block.type)) {
        edits.push({ start: block.contentEndOffset, end: block.contentEndOffset, text: `${eol}${anchorText(anchor)}` });
      } else {
        edits.push({ start: block.contentEndOffset, end: block.contentEndOffset, text: anchorText(anchor) });
      }
      repairs.push({ anchor, action: 'added', line: block.startLine });
      continue;
    }
    if (!firstSeen.has(block.anchor)) {
      firstSeen.add(block.anchor);
      continue;
    }
    // 后出现的重复锚点重建；第一次出现的保留。
    const anchor = generate(seen);
    seen.add(anchor);
    edits.push({ start: block.anchorStartOffset, end: block.anchorEndOffset, text: anchorText(anchor) });
    repairs.push({ anchor, action: 'rebuilt', line: block.anchorLine ?? block.startLine });
  }

  if (!edits.length) return { raw: String(raw), changed: false, repairs: [] };
  edits.sort((a, b) => b.start - a.start || b.end - a.end);
  let next = source;
  let floor = Infinity;
  for (const edit of edits) {
    if (edit.end > floor) continue; // 重叠补偿：理论上不会发生
    next = next.slice(0, edit.start) + edit.text + next.slice(edit.end);
    floor = edit.start;
  }
  return { raw: bom + next, changed: true, repairs };
}

/** 把一段块 raw 按块类型重新拼成带锚点的原文（用于替换）。 */
export function encodeBlock(block, content, eol = '\n') {
  return STANDALONE.has(block.type)
    ? `${content}${eol}${anchorText(block.anchor)}`
    : `${content}${anchorText(block.anchor)}`;
}

/**
 * 只替换被编辑的那一块。返回的新原文里，这一块之外的所有字节都来自原文。
 * 替换前会重新解析候选全文，确认块的数量与身份没有变化——任何可能改变文档结构的
 * 内容（空行、标题、第二个锚点……）都被拒绝，而不是被静默吞掉。
 */
export function applyBlockContent(raw, anchor, content, options = {}) {
  const { eol = String(raw).includes('\r\n') ? '\r\n' : '\n' } = options;
  const fail = (code, message) => { throw Object.assign(Error(message), { code }); };
  const parsed = parseDocument(raw, { checkImages: false });
  const source = parsed.text;
  const bom = String(raw).startsWith('\uFEFF') ? '\uFEFF' : '';
  const block = parsed.blocks.find((item) => item.anchor === anchor);
  if (!block) fail('block_missing', `找不到锚点 ${anchor}；文档可能已被外部修改`);
  if (!block.anchor) fail('block_unanchored', '块还没有锚点，先打开一次补写');
  const evaluated = assessBlock(block);
  if (!evaluated.editable) fail('block_degraded', `这一块超出可编辑子集：${evaluated.reason}`);
  if (typeof content !== 'string') fail('block_content', '块内容必须是文本');
  const normalized = STANDALONE.has(block.type) ? content.replace(/\s+$/, '') : content
    .split(eol).join('\n').split('\n').map((line) => line.replace(/\s+$/, '')).join(eol).replace(/\s+$/, '');
  if (!normalized.trim()) fail('block_empty', '块内容不能为空；删除块不在本版编辑面内');
  if (ANCHOR_ANY_RE.test(normalized)) fail('block_content_anchor', '块内容里不能写锚点');
  const replacement = encodeBlock(block, normalized, eol);
  const next = source.slice(0, block.startOffset) + replacement + source.slice(block.endOffset);

  const after = parseDocument(next, { checkImages: false });
  // 只允许「同一块换内容」：块的数量、类型顺序、所属页都不能变。
  // 否则把「- 变成列表」粘进段落会静默换掉块类型，锚点还在但语义已经不同。
  const shape = (document) => document.blocks.map((item) => `${item.type}@${item.page?.line ?? '-'}`).join(',');
  const beforeAnchors = parsed.blocks.filter((item) => item.anchor).map((item) => item.anchor);
  const afterAnchors = after.blocks.filter((item) => item.anchor).map((item) => item.anchor);
  if (shape(after) !== shape(parsed)
    || beforeAnchors.join(',') !== afterAnchors.join(',')) {
    fail('block_structure', '这次修改会改变文档的块结构（块类型、空行、标题或多个锚点），已拒绝');
  }
  const written = after.blocks.find((item) => item.anchor === anchor);
  if (!written || written.raw !== normalized) fail('block_structure', '写入后无法按同一块读回，已拒绝');
  return { raw: bom + next, block: written };
}

// ───────────── 重排：只挪位置，不换内容 ─────────────
//
// 编辑面（applyBlockContent）刻意不允许块类型与顺序变化。拖动、页重排是另一件事，
// 所以走这里的两个显式操作：一次只挪一个块或一页，其余行原样保留，接缝处只补/并空行。
// 两个操作都按锚点定位，拒绝任何会让页或章节变空的移动，并重解析验证结果。

const reorderFail = (code, message) => { throw Object.assign(Error(message), { code }); };
const isBlankLine = (line) => (line ?? '').trim() === '';

/** 块占的最后一行（1 基）：独立块的锚点单独成行，写在元素下一行，也算块的一部分。 */
function blockEndLine(block) {
  return Math.max(block.endLine ?? block.startLine, block.anchorLine ?? block.endLine ?? block.startLine);
}

/** 页的行区间（0 基、半开）：`###` 标题行到最后一个块的最后一行（含独立锚点行）。 */
function pageLineRange(page) {
  let end = page.line;
  for (const block of page.blocks) end = Math.max(end, blockEndLine(block));
  return { start: page.line - 1, end };
}

/** 块的行区间（0 基、半开）；独立块的锚点行也算在块里。 */
function blockLineRange(block) {
  return { start: block.startLine - 1, end: blockEndLine(block) };
}

/**
 * 把 [cutStart, cutEnd) 这几行剪下来，插到「原文第 gap 行之前」。
 * 除了这段的位置，其他行一个字都不动；只在接缝处补一个空行或把两个空行并成一个。
 */
function spliceLines(lines, cutStart, cutEnd, gap) {
  if (gap > cutStart && gap < cutEnd) {
    reorderFail('reorder_target', '落点在被移动的那一段里，没有意义');
  }
  const chunk = lines.slice(cutStart, cutEnd);
  const rest = lines.slice(0, cutStart).concat(lines.slice(cutEnd));
  let at = gap >= cutEnd ? gap - (cutEnd - cutStart) : gap;
  // 切口两侧原本各有一个空行，剪掉中间那块后会剩下两个；并成一个。
  if (cutStart > 0 && cutStart < rest.length && isBlankLine(rest[cutStart - 1]) && isBlankLine(rest[cutStart])) {
    rest.splice(cutStart, 1);
    if (at > cutStart) at -= 1;
  }
  at = Math.max(0, Math.min(at, rest.length));
  const insert = [];
  if (at > 0 && !isBlankLine(rest[at - 1])) insert.push('');
  insert.push(...chunk);
  if (at < rest.length && !isBlankLine(rest[at])) insert.push('');
  rest.splice(at, 0, ...insert);
  return rest;
}

/** 按 `{chapter, index}`（都从 1 数）定位一页；页的「编号」由顺序决定，不写进正文。 */
function locatePage(parsed, ref) {
  if (!ref || typeof ref !== 'object') reorderFail('reorder_target', '目标页必须是 {chapter, index}');
  const chapterIndex = Number(ref.chapter);
  const pageIndex = Number(ref.index);
  const chapter = Number.isInteger(chapterIndex) ? parsed.chapters[chapterIndex - 1] : null;
  const page = Number.isInteger(pageIndex) ? chapter?.pages[pageIndex - 1] : null;
  if (!page) reorderFail('page_missing', `找不到第 ${chapterIndex} 章第 ${pageIndex} 页`);
  return page;
}

/** 把行数组拼回原文（保留 BOM 与 EOL 风格）。 */
function joinDocument(raw, lines) {
  const text = String(raw ?? '').replace(/^\uFEFF/, '');
  const bom = String(raw ?? '').startsWith('\uFEFF') ? '\uFEFF' : '';
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  return bom + lines.join(eol);
}

const pageSignature = (page) => page.blocks[0]?.anchor ?? `#${page.title}`;

/**
 * 重排之后必须仍然是一份「同样的文档，只是顺序变了」：块的身份与 raw 一个不少，
 * 页不再有空页，锚点不再重复。任何一条不成立就整体拒绝，不留半截写入。
 */
function verifyReorder(beforeParsed, raw, label) {
  const after = parseDocument(raw, { checkImages: false });
  if (after.blocks.length !== beforeParsed.blocks.length) {
    reorderFail('reorder_verify', `${label}后块数量变了（${beforeParsed.blocks.length} → ${after.blocks.length}）`);
  }
  const afterByAnchor = new Map(after.blocks.filter((block) => block.anchor).map((block) => [block.anchor, block]));
  const beforeByAnchor = new Map(beforeParsed.blocks.filter((block) => block.anchor).map((block) => [block.anchor, block]));
  for (const [anchor, block] of beforeByAnchor) {
    const other = afterByAnchor.get(anchor);
    if (!other) reorderFail('reorder_verify', `重排后块 ${anchor} 不见了`);
    if (other.raw !== block.raw) reorderFail('reorder_verify', `未参与重排的块 ${anchor} 的 raw 变了`);
  }
  for (const code of ['anchor_duplicate', 'anchor_orphan', 'page_empty', 'block_outside_page', 'block_nested']) {
    const count = (document) => document.errors.filter((error) => error.code === code).length;
    if (count(after) > count(beforeParsed)) reorderFail('reorder_verify', `重排引出了结构错误 ${code}`);
  }
  return after;
}

/**
 * 移动一个块：剪下它的行，插到目标页的「某块之前」（`before: null` 表示该页末尾）。
 *
 * @param {string} raw 原文
 * @param {{anchor:string, to:{chapter:number,index:number,before:string|null}}} move
 * @returns {{raw:string, changed:boolean, moved:string, page:string}}
 */
export function moveBlock(raw, { anchor, to } = {}) {
  if (typeof anchor !== 'string' || !anchor) reorderFail('reorder_anchor', '缺少要移动的块锚点');
  const parsed = parseDocument(raw, { checkImages: false });
  const block = parsed.blocks.find((item) => item.anchor === anchor);
  if (!block) reorderFail('block_missing', `找不到锚点 ${anchor}；文档可能已被外部修改`);
  if (!block.page) reorderFail('block_outside_page', '这一块不在任何页里，不能重排');
  const target = locatePage(parsed, to);
  let gap;
  if (to.before === null || to.before === undefined) {
    gap = pageLineRange(target).end;
  } else {
    const before = target.blocks.find((item) => item.anchor === to.before);
    if (!before) reorderFail('reorder_target', `目标页里没有块 ${to.before}`);
    gap = before.startLine - 1;
  }
  if (target === block.page) {
    const self = target.blocks.indexOf(block);
    const beforeIndex = to.before == null
      ? target.blocks.length
      : target.blocks.findIndex((item) => item.anchor === to.before);
    // 落回原位（插在自己前面 / 自己后面）不是错误，也不是一次修改。
    if (beforeIndex === self || beforeIndex === self + 1) {
      return { raw: String(raw), changed: false, moved: anchor, page: `${target.chapter.index}-${target.index}` };
    }
  }
  if (block.page.blocks.length === 1) {
    reorderFail('page_would_be_empty', `页「${block.page.title}」只有这一块；移走会让页变空`);
  }
  const lines = spliceLines(String(raw).replace(/^\uFEFF/, '').split(/\r?\n/), blockLineRange(block).start, blockLineRange(block).end, gap);
  const next = joinDocument(raw, lines);
  const after = verifyReorder(parsed, next, '移动块');
  const moved = after.blocks.find((item) => item.anchor === anchor);
  // 块移动不改页序，所以「目标页」的章节号 / 页号在重排前后是同一个位置。
  if (!moved?.page || moved.page.chapter?.index !== target.chapter.index || moved.page.index !== target.index) {
    reorderFail('reorder_verify', '移动后的块没有落在目标页里');
  }
  return {
    raw: next,
    changed: true,
    moved: anchor,
    page: `${moved.page.chapter.index}-${moved.page.index}`,
  };
}

/**
 * 移动一整页（`###` 标题连同其下所有块）到另一页之前 / 之后。
 * 页所属章节由落点决定：落在哪一章的页之间，就归哪一章。
 *
 * @param {string} raw 原文
 * @param {{page:{chapter:number,index:number}, to:{chapter:number,index:number,position:'before'|'after'}}} move
 */
export function movePage(raw, { page, to } = {}) {
  const parsed = parseDocument(raw, { checkImages: false });
  const sourcePage = locatePage(parsed, page);
  const targetPage = locatePage(parsed, to);
  if (to.position !== 'before' && to.position !== 'after') {
    reorderFail('reorder_position', '页的落点只接受 before / after');
  }
  if (!sourcePage.chapter) reorderFail('page_without_chapter', '这一页不在任何章节里，不能整页移动');
  if (sourcePage.chapter !== targetPage.chapter && sourcePage.chapter.pages.length === 1) {
    reorderFail('chapter_would_be_empty', `章节「${sourcePage.chapter.title}」只有这一页；移走会让章节变空`);
  }
  const from = parsed.pages.indexOf(sourcePage);
  const targetIndex = parsed.pages.indexOf(targetPage) + (to.position === 'after' ? 1 : 0);
  const insertAt = targetIndex > from ? targetIndex - 1 : targetIndex;
  // 顺序没变、章节也没变才是空操作。跨过 ## 章节标题落在同一个文档位置时，
  // 页序不变而归属变了——那是一次真实的移动（把页挪进相邻章节）。
  if (insertAt === from && sourcePage.chapter === targetPage.chapter) {
    return { raw: String(raw), changed: false, page: pageSignature(sourcePage) };
  }
  const cut = pageLineRange(sourcePage);
  const gap = to.position === 'before' ? targetPage.line - 1 : pageLineRange(targetPage).end;
  const lines = spliceLines(String(raw).replace(/^\uFEFF/, '').split(/\r?\n/), cut.start, cut.end, gap);
  const next = joinDocument(raw, lines);
  const after = verifyReorder(parsed, next, '移动页');
  if (after.pages.length !== parsed.pages.length) reorderFail('reorder_verify', '移动页后页数量变了');
  const expected = parsed.pages.map(pageSignature);
  const [movedSignature] = expected.splice(from, 1);
  expected.splice(insertAt, 0, movedSignature);
  if (after.pages.map(pageSignature).join('\n') !== expected.join('\n')) {
    reorderFail('reorder_verify', '移动页后的页序与落点不一致');
  }
  const movedPage = after.pages.find((item) => pageSignature(item) === movedSignature);
  if (!movedPage || movedPage.chapter?.index !== targetPage.chapter.index) {
    reorderFail('reorder_verify', '移动后的页没有归到目标章节');
  }
  return { raw: next, changed: true, page: movedSignature };
}

/** 读取块的编辑面：前缀（列表符号 / 引用符号 / 标题井号）与纯行内内容。 */
export function blockPrefix(block) {
  const raw = block.raw;
  if (block.type === 'heading') {
    const match = raw.match(/^(#{1,6}[ \t]+)/);
    return match ? match[1] : '';
  }
  if (block.type === 'list') {
    const match = raw.match(/^(\s*(?:[-*+]|\d+[.)])[ \t]+)/);
    return match ? match[1] : '';
  }
  if (block.type === 'quote') {
    const match = raw.match(/^(\s*>[ \t]?)/);
    return match ? match[1] : '> ';
  }
  return '';
}

/** 表格单元格切分：尊重 `\|` 转义，首尾管道可省。 */
export function splitTableRow(line) {
  let body = line.trim();
  if (body.startsWith('|')) body = body.slice(1);
  if (body.endsWith('|') && !body.endsWith('\\|')) body = body.slice(0, -1);
  const cells = [];
  let cell = '';
  let escaped = false;
  for (const character of body) {
    if (escaped) { cell += character; escaped = false; continue; }
    if (character === '\\') { cell += character; escaped = true; continue; }
    if (character === '|') { cells.push(cell.trim()); cell = ''; continue; }
    cell += character;
  }
  cells.push(cell.trim());
  return cells;
}

/** 对齐信息取分隔行；同时保留分隔行原文，编辑后原样写回，不把 `:---` 变成 `---`。 */
export function tableModel(block) {
  const rows = block.lines;
  if (rows.length < 2) return null;
  const header = splitTableRow(rows[0]);
  const align = splitTableRow(rows[1]).map((cell) => {
    const left = cell.startsWith(':');
    const right = cell.endsWith(':');
    if (left && right) return 'center';
    if (right) return 'right';
    if (left) return 'left';
    return null;
  });
  const body = rows.slice(2).map(splitTableRow);
  return { header, align, rows: body, delimiterRaw: rows[1], headerRaw: rows[0] };
}

/**
 * 判断一块是否在「行内编辑」的子集里。超出子集就退化为原文显示——不静默改写。
 * 只允许 marked 能识别且本工作台能无损序列化的行内语法：文本、加粗、斜体、
 * 行内代码、链接、转义、换行。
 */
export function assessBlock(block) {
  if (!BLOCK_TYPES.has(block.type)) {
    return { editable: false, degraded: true, reason: `${TYPE_NAMES[block.type] ?? block.type}不在七种块里` };
  }
  if (block.type === 'image') {
    return { editable: false, degraded: false, reason: '图片块只显示，改图请换文件' };
  }
  if (block.type === 'code') {
    if (block.closed === false) return { editable: false, degraded: true, reason: '代码围栏没有闭合' };
    return { editable: true, degraded: false, reason: null };
  }
  if (block.type === 'table') {
    const model = tableModel(block);
    if (!model) return { editable: false, degraded: true, reason: '表格缺少分隔行' };
    const width = model.header.length;
    if (!width || model.rows.some((row) => row.length !== width) || model.align.length !== width) {
      return { editable: false, degraded: true, reason: '表格列数不一致' };
    }
    for (const cell of [model.header, ...model.rows].flat()) {
      const check = checkInline(cell);
      if (!check.ok) return { editable: false, degraded: true, reason: `表格单元里有不支持的写法：${check.reason}` };
    }
    return { editable: true, degraded: false, reason: null };
  }
  const content = block.raw.slice(blockPrefix(block).length);
  const check = checkInline(content);
  if (!check.ok) return { editable: false, degraded: true, reason: check.reason };
  return { editable: true, degraded: false, reason: null };
}

/** 用 marked 的行内词法器判断一段内容是否在支持的子集内。 */
export function checkInline(markdown) {
  const { Lexer } = getMarked();
  if (!markdown.trim()) return { ok: true };
  const tokens = Lexer.lexInline(markdown);
  const allowed = new Set(['text', 'strong', 'em', 'codespan', 'link', 'escape', 'br']);
  for (const token of tokens) {
    if (!allowed.has(token.type)) {
      return { ok: false, reason: INLINE_REASONS[token.type] ?? `行内语法 ${token.type}` };
    }
    if (token.type === 'link' && token.tokens && !inlineTokensOk(token.tokens)) {
      return { ok: false, reason: '链接文字里有不支持的写法' };
    }
  }
  return { ok: true };
}

const INLINE_REASONS = {
  image: '段落里的图片',
  html: '行内 HTML',
  del: '删除线',
  table: '嵌套表格',
};
function inlineTokensOk(tokens) {
  return tokens.every((token) => {
    if (!['text', 'strong', 'em', 'codespan', 'escape', 'br', 'link'].includes(token.type)) return false;
    return !token.tokens || inlineTokensOk(token.tokens);
  });
}

let markedModule = null;
/** marked 是工作台与校验器共用的行内语法权威；浏览器里它由页面直接加载。 */
export function getMarked() {
  if (markedModule) return markedModule;
  // Node 侧：复用仓库里 vendored 的 marked（UMD），不额外引入依赖。
  const require = createRequire(import.meta.url);
  markedModule = require(fileURLToPath(new URL('../../assets/content-review/marked.umd.js', import.meta.url)));
  return markedModule;
}
