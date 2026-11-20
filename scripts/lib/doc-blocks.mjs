/**
 * planners-doc/2 的块模型。
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
import DocIdentity from '../../assets/workbench/doc-identity.js';

const { pageKeyOf, isPageEnd, isSource } = DocIdentity;

export const VERSION = 'planners-doc/2';
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

/** 锚点身份的形状只写这一次：注释外壳、裸身份与「块里不许写锚点」都从这里生成。 */
const ANCHOR_ID_PATTERN = 'b:[0-9a-f]{6,12}';
export const ANCHOR_RE = new RegExp(`<!--\\s*(${ANCHOR_ID_PATTERN})\\s*-->`, 'g');
export const ANCHOR_AT_END_RE = new RegExp(`<!--\\s*(${ANCHOR_ID_PATTERN})\\s*-->\\s*$`);
export const ANCHOR_ONLY_RE = new RegExp(`^\\s*<!--\\s*(${ANCHOR_ID_PATTERN})\\s*-->\\s*$`);
/** 裸块身份（不带注释外壳）：命令面校验锚点时只认这一种形状。 */
export const BLOCK_ANCHOR_RE = new RegExp(`^${ANCHOR_ID_PATTERN}$`);
const ANCHOR_ANY_RE = new RegExp(`<!--\\s*${ANCHOR_ID_PATTERN}\\s*-->`);
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
 * 解析一份 planners-doc/2 原文。
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
  const state = { chapters: [], pages: [], blocks: [], chapter: null, page: null };
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
    // 块所在的章节：页内块的章节从页出，页外块只能从这里知道自己在哪一章下（渲染与提示要用）。
    block.chapter = state.chapter;
    state.blocks.push(block);
    if (state.page) state.page.blocks.push(block);
    else pushError('block_outside_page', `${typeName(block.type)}必须写在某个 ## 页里`, {
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
      if (level <= 2) {
        pushError('anchor_on_structure', '章节 / 页的标题不是块，不能带锚点；锚点属于块', {
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

    // `/2`：`#` 是章节、`##` 是页，`###`–`######` 回到普通标题块（任意层级都合法）。
    if (level === 1) {
      state.chapter = { title, line: lineNo, index: state.chapters.length + 1, pages: [] };
      state.chapters.push(state.chapter);
      state.page = null;
      return;
    }
    if (level === 2) {
      if (!state.chapter) pushError('page_without_chapter', '## 页必须写在 # 章节里', { line: lineNo });
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
    const contentLine = inlineAnchor !== null
      ? rawLine.slice(0, anchorIndexInRaw).replace(/\s+$/, '')
      : rawLine;
    const block = {
      type: 'heading',
      level,
      text: title,
      startLine: lineNo,
      endLine: lineNo,
      lines: [contentLine],
      anchor: inlineAnchor,
      anchorLine: inlineAnchor ? lineNo : null,
      inlineAnchor: inlineAnchor !== null,
      anchorStartColumn: inlineAnchor !== null ? anchorIndexInRaw : null,
      // inlineAnchor 已经是 `b:xxxxxx`（match[1] 带前缀），这里不能再拼一个 `b:`，
      // 否则锚点末端会多算两个字符，替换区间会吃掉下一行的开头。
      anchorEndColumn: inlineAnchor !== null ? anchorIndexInRaw + `<!-- ${inlineAnchor} -->`.length : null,
      contentEndColumn: inlineAnchor !== null ? contentLine.length : null,
    };
    addBlock(block);
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

  // 出处区：位置就是语义。页内最后一个块是引用，则从它向前连续的一串引用构成出处区；
  // 页中段的引用照常是普通引用。条数不设限，没有出处的页合法 —— 缺不缺由 Skill 判断，
  // 校验器只认这条位置规则，不评价出处够不够（契约第 5 节）。
  for (const page of state.pages) {
    const sources = [];
    for (let i = page.blocks.length - 1; i >= 0; i -= 1) {
      const block = page.blocks[i];
      if (block.type !== 'quote') break;
      sources.unshift(block);
    }
    page.sources = sources;
    for (const block of sources) block.inSources = true;
  }

  if (state.pages.length === 0) {
    pushWarning('document_without_pages', '文档里没有 ## 页；目录会是空的', { line: 1 });
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

// ───────────── 行首 Markdown 前缀 → 块类型（SPEC 第 7 节） ─────────────
//
// 块的类型由**行首前缀**产生：`# ` / `## ` 改变结构（章节 / 页），`### `–`###### `
// 是标题块，`- ` / `1. ` 列表，`> ` 引用，围栏代码，`|` 起表格。判据有两条：
//
//   · 前缀必须在这一块的第一行开头（行首）；
//   · 除围栏与表格外，前缀后面必须紧跟空格（`##标题` 还是段落文字）。
//
// 写入后前缀从正文隐去、只留排版：块的 raw 就是元素本身，页 / 章节就是真标题行。
// 不是前缀能解释的内容一律当普通段落——该转义的行首标记在这里补反斜杠，保证它
// 下一次打开还是同一个段落，而不是悄悄变成另一种块。

const HEADING_MARK_RE = /^(#{1,6})([ \t]+)([\s\S]*)$/;
const EMPTY_HEADING_MARK_RE = /^#{1,6}[ \t]*$/;
const ORDERED_MARK_RE = /^(\d+)([.)])([ \t]+)/;
const LIST_MARK_RE = /^([-*+])([ \t]+)/;
const QUOTE_MARK_RE = /^([ \t]*>[ \t]+)/;
const FENCE_OPEN_RE = /^(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE_RE = /^\s*(`{3,}|~{3,})\s*$/;
const SETEXT_UNDERLINE_RE = /^=+[ \t]*$/;

/** 逐行去掉行尾空白；代码例外（围栏里的空格是内容）。 */
function normalizeTypedLines(text, { code = false } = {}) {
  const trimmed = String(text ?? '').replace(/\r\n?/g, '\n').replace(/\s+$/, '');
  return code ? trimmed : trimmed.split('\n').map((line) => line.replace(/[ \t]+$/, '')).join('\n');
}

/**
 * 普通段落里「不是前缀」的行首标记要转义，否则下一次解析会把它切成另一种块。
 * 只处理真正会改变这一行解析结果的标记；`#标签` 这种没有空格的写法不算。
 */
function escapeLiteralLine(line, nextLine) {
  if (!line || line.startsWith('\\')) return line;
  if (HEADING_MARK_RE.test(line) || EMPTY_HEADING_MARK_RE.test(line)) return `\\${line}`;
  if (ORDERED_MARK_RE.test(line)) return line.replace(/^(\d+)([.)])/, '$1\\$2');
  if (LIST_MARK_RE.test(line)) return `\\${line}`;
  if (/^[ \t]*>/.test(line)) return `\\${line}`;
  if (FENCE_OPEN_RE.test(line)) return `\\${line}`;
  if (SETEXT_UNDERLINE_RE.test(line.trim()) || HR_RE.test(line.trim())) return `\\${line}`;
  // 只有下一行是分隔行时，这一行才会被当成表头。
  if (nextLine !== undefined && line.includes('|') && TABLE_DELIMITER_RE.test(nextLine)) return `\\${line}`;
  return line;
}

/** 整段落字面量化：每一行都按「会不会被当成另一种块」决定要不要加反斜杠。 */
function escapeLiteralParagraph(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  return lines.map((line, index) => escapeLiteralLine(line, lines[index + 1])).join('\n');
}

/** 把候选 raw 放进一份最小文档里解析，确认它就是「一种块」且字节能读回。 */
function probeSingleBlock(raw, type) {
  const probe = parseDocument(
    `---\ncontract: planners-doc/2\ndoc: storyline\nproject: 前缀探针\n---\n\n# 章\n\n## 页\n\n${raw}\n`,
    { checkImages: false },
  );
  return probe.blocks.length === 1
    && probe.blocks[0].type === type
    && probe.blocks[0].raw === raw
    && probe.errors.length === 0;
}

/** 字面计划：整段当普通段落，该转义的行首标记补反斜杠。 */
function literalPlan(text, options = {}) {
  const { literal = null } = options;
  const normalized = normalizeTypedLines(text);
  return {
    type: 'paragraph',
    structural: false,
    prefix: '',
    literal: literal ?? (normalized.trim() && !normalized.includes('\n') ? normalized.trim() : null),
    raw: escapeLiteralParagraph(normalized),
  };
}

/**
 * 把一块的编辑内容翻译成「这一块应该长成什么」。
 *
 * 入参 `content` 是**整块 raw**：标题 / 列表 / 引用由页面在行内内容前补回前缀，
 * 段落就是它自己。模型写回时可能只给行内内容，所以当前类型有前缀而内容没有时先补回。
 *
 * @returns {{type:string, raw:string, prefix:string, literal:string|null,
 *   structural:boolean, level?:number, title?:string, rest?:string}}
 */
export function planTypedBlock(content, options = {}) {
  const { currentType = 'paragraph', currentPrefix = '' } = options;
  let text = String(content ?? '').replace(/\r\n?/g, '\n').replace(/\s+$/, '');
  // 「反悔」：标题 / 列表的文字被删空时，内容只剩它自己的前缀。前缀退回正文，
  // 这一块变回段落——不再是一个空标题（列表清空也走同一条路）。
  if (currentPrefix && text === currentPrefix.trim() && ['heading', 'list'].includes(currentType)) {
    return literalPlan(text, { literal: text });
  }
  if (currentPrefix && !/^(#{1,6}[ \t]|[-*+][ \t]|\d+[.)][ \t]|>[ \t]|`{3,}|~{3,})/.test(text)) {
    text = `${currentPrefix}${text}`;
  }
  const lines = text.split('\n');
  const first = lines[0] ?? '';
  const restLines = lines.slice(1);
  // 围栏与表格是「独立块」：页面里的块内换行会序列化成 `\\` + 换行（CommonMark 硬换行），
  // 那只是编辑器对多行段落的写法；落到代码 / 表格里应当是真正的换行。
  const hardBreakFree = text.replace(/\\\n/g, '\n');
  const plainLines = hardBreakFree.split('\n');
  const plainFirst = plainLines[0] ?? '';

  const heading = first.match(HEADING_MARK_RE);
  if (heading) {
    const level = heading[1].length;
    const prefix = heading[1] + heading[2];
    const title = heading[3].trim();
    if (!title) return literalPlan(text);
    if (level <= 2) {
      return {
        type: level === 1 ? 'chapter' : 'page',
        structural: true,
        level,
        title,
        prefix,
        literal: null,
        raw: `${'#'.repeat(level)} ${title}`,
        rest: restLines.join('\n').trim(),
      };
    }
    const raw = normalizeTypedLines(`${'#'.repeat(level)} ${title.replace(/\n+/g, ' ')}`);
    if (probeSingleBlock(raw, 'heading')) {
      return { type: 'heading', structural: false, level, prefix, literal: null, raw, rest: '' };
    }
    return literalPlan(text);
  }

  const ordered = first.match(ORDERED_MARK_RE);
  const list = first.match(LIST_MARK_RE);
  if ((ordered || list) && !HR_RE.test(first.trim())) {
    const raw = normalizeTypedLines(text);
    if (probeSingleBlock(raw, 'list')) {
      return {
        type: 'list', structural: false, prefix: ordered ? ordered[0] : list[0], literal: null, raw, rest: '',
      };
    }
    return literalPlan(text);
  }

  const quote = first.match(QUOTE_MARK_RE);
  if (quote) {
    const raw = normalizeTypedLines(text);
    if (probeSingleBlock(raw, 'quote')) {
      return { type: 'quote', structural: false, prefix: quote[1], literal: null, raw, rest: '' };
    }
    return literalPlan(text);
  }

  const fence = plainFirst.match(FENCE_OPEN_RE);
  if (fence) {
    // 围栏必须闭合：没闭合的代码块会把后面的页与块全吞进去。
    const closed = plainLines.slice(1).some((line) => {
      const match = line.match(FENCE_CLOSE_RE);
      return match && match[1][0] === fence[1][0] && match[1].length >= fence[1].length;
    });
    const raw = normalizeTypedLines(hardBreakFree, { code: true });
    if (closed && probeSingleBlock(raw, 'code')) {
      return { type: 'code', structural: false, prefix: '', literal: null, raw, rest: '' };
    }
    return literalPlan(text);
  }

  // 表格：首行有 `|`、第二行是分隔行、之后每行都有 `|`——与解析器的认定一致。
  if (plainFirst.includes('|') && plainLines.length >= 2 && TABLE_DELIMITER_RE.test(plainLines[1])
    && plainLines.slice(1).every((line) => line.includes('|'))) {
    const raw = normalizeTypedLines(hardBreakFree);
    if (probeSingleBlock(raw, 'table')) {
      return { type: 'table', structural: false, prefix: '', literal: null, raw, rest: '' };
    }
    return literalPlan(text);
  }

  return literalPlan(text);
}

/** 按计划拼出这一块的新 raw（锚点按类型摆：独立块的锚点单独一行）。 */
function typedReplacement(plan, anchor, eol) {
  const anchorText = `<!-- ${anchor} -->`;
  if (plan.structural) {
    const line = `${'#'.repeat(plan.level)} ${plan.title}`;
    const rest = plan.rest ? escapeLiteralParagraph(plan.rest) : '';
    return rest ? `${line}${eol}${eol}${rest}${anchorText}` : line;
  }
  return STANDALONE.has(plan.type) ? `${plan.raw}${eol}${anchorText}` : `${plan.raw}${anchorText}`;
}

const pageIdentity = (block) => pageKeyOf(block.page) ?? '-';
const titlesOf = (items, title) => items.filter((item) => item.title === title).length;

/**
 * 校验「前缀转换」写出来的结果：
 *   · 普通类型（标题 / 列表 / 引用 / 代码 / 表格）：只换这一块的类型，块数、锚点顺序、
 *     所属页都不变，其余块 raw 逐字不动；
 *   · `# ` / `## `：这一块变成结构行，锚点随这一块消失（有剩余文字时留给那段正文），
 *     其余块的位置与 raw 逐字不动，章节 / 页真的多了一个并且就在这一行。
 */
function verifyTypedWrite(parsed, after, block, plan, anchor, fail) {
  const targetIndex = parsed.blocks.indexOf(block);
  const others = parsed.blocks.filter((item) => item !== block);

  if (!plan.structural) {
    if (after.blocks.length !== parsed.blocks.length) fail('block_structure', '写回后块的数量变了，已拒绝');
    if (after.blocks.map((item) => item.anchor).join(',') !== parsed.blocks.map((item) => item.anchor).join(',')) {
      fail('block_structure', '写回后块的锚点顺序变了，已拒绝');
    }
    for (let index = 0; index < parsed.blocks.length; index += 1) {
      if (index === targetIndex) continue;
      const prior = parsed.blocks[index];
      const next = after.blocks[index];
      if (next.raw !== prior.raw || next.type !== prior.type || pageIdentity(next) !== pageIdentity(prior)) {
        fail('block_structure', '写回动到了别的块，已拒绝');
      }
    }
    const written = after.blocks[targetIndex];
    if (!written || written.anchor !== anchor || written.type !== plan.type || written.raw !== plan.raw) {
      fail('block_structure', '写入后无法按同一块读回，已拒绝');
    }
    if (pageIdentity(written) !== pageIdentity(block)) fail('block_structure', '写回把这一块挪出了原来那一页，已拒绝');
    return written;
  }

  const rest = plan.rest ? escapeLiteralParagraph(plan.rest) : null;
  const remainder = rest ? after.blocks[targetIndex] : null;
  if (rest) {
    if (after.blocks.length !== others.length + 1 || !remainder
      || remainder.anchor !== anchor || remainder.type !== 'paragraph' || remainder.raw !== rest) {
      fail('block_structure', '前缀后面的正文没有干净地落在新结构下，已拒绝');
    }
  } else if (after.blocks.length !== others.length || after.blocks.some((item) => item.anchor === anchor)) {
    fail('block_structure', '结构行不能带锚点，已拒绝');
  }
  const remaining = rest ? after.blocks.filter((_, index) => index !== targetIndex) : after.blocks;
  if (remaining.map((item) => item.anchor).join(',') !== others.map((item) => item.anchor).join(',')
    || remaining.some((item, index) => item.raw !== others[index].raw || item.type !== others[index].type)) {
    fail('block_structure', '结构变化动到了别的块，已拒绝');
  }

  // 新结构必须就在被替换的那一行上：`## 标题` / `# 标题` 真的成了页 / 章节。
  const line = block.startLine;
  const scope = plan.type === 'page' ? after.pages : after.chapters;
  const prior = plan.type === 'page' ? parsed.pages : parsed.chapters;
  if (scope.length !== prior.length + 1) fail('block_structure', `这次修改没有干净地加出一${plan.type === 'page' ? '页' : '章'}，已拒绝`);
  const created = scope.find((item) => item.line === line && item.title === plan.title);
  if (!created || titlesOf(scope, plan.title) !== titlesOf(prior, plan.title) + 1) {
    fail('block_structure', `写入后找不到标题为「${plan.title}」的${plan.type === 'page' ? '页' : '章节'}，已拒绝`);
  }
  if (plan.type === 'page' && rest) {
    if (remainder.page?.title !== plan.title) fail('block_structure', '前缀后面的正文没有落在新页里，已拒绝');
  }
  if (plan.type === 'chapter' && rest) {
    if (remainder.chapter?.title !== plan.title) fail('block_structure', '前缀后面的正文没有落在新章节下，已拒绝');
  }
  return null;
}

/**
 * 只替换被编辑的那一块。返回的新原文里，这一块之外的所有字节都来自原文。
 *
 * 块类型由行首前缀产生（SPEC 第 7 节）：`## ` 变成一页、`### ` 变成标题块、`- ` 变成
 * 列表……写盘时前缀隐去。前缀解释不了的内容按普通段落写回，行首标记补反斜杠。
 *
 * 除「前缀产生的类型变化」之外，任何会改变文档结构的内容（空行、第二个锚点、多出来的
 * 块）仍被拒绝，而不是被静默吞掉。
 */
export function applyBlockContent(raw, anchor, content, options = {}) {
  const { eol = String(raw).includes('\r\n') ? '\r\n' : '\n', allowStructure = true } = options;
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
  const overall = content.replace(/\r\n?/g, '\n').replace(/\s+$/, '');
  if (!overall.trim()) fail('block_empty', '块内容不能为空；删除块不在本版编辑面内');
  if (ANCHOR_ANY_RE.test(overall)) fail('block_content_anchor', '块内容里不能写锚点');

  const planned = planTypedBlock(overall, { currentType: block.type, currentPrefix: blockPrefix(block) });
  // 模型写回与待核对裁决只换内容：结构行由显式的结构 / 重排命令产生，不从一个 patch 里长出来。
  const plan = planned.structural && !allowStructure
    ? literalPlan(overall)
    : planned;
  const replacement = typedReplacement(plan, anchor, eol);
  const next = source.slice(0, block.startOffset) + replacement + source.slice(block.endOffset);
  const after = parseDocument(next, { checkImages: false });
  let written;
  try {
    written = verifyTypedWrite(parsed, after, block, plan, anchor, fail);
  } catch (error) {
    if (error.code !== 'block_structure' || plan.type === 'paragraph') throw error;
    // 前缀能认出来、但在这一份文档里落不干净（例如多行列表会变成两块）：退回字面段落，
    // 保存不失败，前缀也不会丢。
    const fallback = literalPlan(overall);
    const fallbackNext = source.slice(0, block.startOffset) + typedReplacement(fallback, anchor, eol) + source.slice(block.endOffset);
    const fallbackAfter = parseDocument(fallbackNext, { checkImages: false });
    written = verifyTypedWrite(parsed, fallbackAfter, block, fallback, anchor, fail);
    return {
      raw: bom + fallbackNext,
      block: written,
      retype: block.type === fallback.type ? null : {
        from: block.type, to: fallback.type, prefix: '', literal: fallback.literal, structure: null,
      },
    };
  }
  return {
    raw: bom + next,
    block: written,
    retype: block.type === plan.type && !plan.structural ? null : {
      from: block.type,
      to: plan.type,
      prefix: plan.prefix,
      literal: plan.literal,
      structure: plan.structural ? plan.type : null,
    },
  };
}

// ───────────── 分块与合并：块的数量这两种操作会变，所以各有显式命令 ─────────────
//
// 编辑面只换一块的内容，不许增删块；但「回车分块、删空合并」本身就是会改变块数量的
// 编辑动作（SPEC 第 4 节）。所以分成两条显式命令：都按锚点定位、都重解析验证结果、
// 都只写目标块所在的那几行。分块时新块换新锚点；合并时保留前一块锚点、删掉后一块的
// 锚点——块身份随内容走，不迁移（契约第 4 节：删除锚点等同删除块身份）。

/** 能拆成两块的块类型：段落、标题、列表项、引用。表格 / 图片 / 代码不拆。 */
export const SPLITTABLE_TYPES = new Set(['paragraph', 'heading', 'list', 'quote']);
/** 能互相合并的块类型：同上，都是「一行内容 + 行内格式」的块。 */
export const MERGEABLE_TYPES = SPLITTABLE_TYPES;

/** 行内内容规范化：行尾空白去掉（与 applyBlockContent 一致），保留行首。 */
function normalizeInline(content) {
  return String(content)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .join('\n')
    .replace(/\s+$/, '');
}

/** 把一段行内 Markdown 按块类型拼回块 raw（不含锚点）。 */
function formatBlockContent(type, prefix, content) {
  if (type === 'heading') return `${prefix}${content.replace(/\n+/g, ' ')}`;
  if (type === 'quote') {
    return content.split('\n').map((line) => (line ? `${prefix}${line}` : prefix.trimEnd())).join('\n');
  }
  if (type === 'list') return `${prefix}${content}`;
  return content;
}

// 编辑时不再跑校验器（ADR 0006）：拆开、合并、拖动都可能把文档暂时留在不合法结构里
// （页空、章节空、块落在页外），它们照样落盘。结构问题由快照带回、由交付口的
// `validate-doc` 与 CI 判定；这里只验证「这次操作本身做对了」（块身份、数量、顺序）。

/** 这一段是以块前缀开头的整块 raw（而不是块内行内内容）。 */
const TYPED_MARKER_START_RE = /^(?:#{1,6}[ \t]|[-*+][ \t]|\d+[.)][ \t]|>[ \t]|`{3,}|~{3,}|\|)/;
const startsWithTypedMarker = (text) => TYPED_MARKER_START_RE.test(String(text ?? ''));

/** 按原块类型把行内内容拼回块 raw 的计划（不带锚点）。 */
function inlinePlan(type, prefix, content) {
  const raw = formatBlockContent(type, prefix, content);
  return { type, structural: false, prefix, literal: null, raw, rest: '' };
}

/**
 * 在光标处把一块拆成两块：前半留在原锚点，后半拿一个新锚点，紧跟在原块之后。
 *
 * 入参的 before / after 默认是**块内行内 Markdown**（不含 `- ` / `> ` / `### ` 这些块前缀），
 * 块前缀由这里按原块类型补。但一段如果自己以块前缀开头（页面里的待定块第一次输入就是这样），
 * 它就按前缀决定类型：`### ` 得到标题块，`## ` 得到一页（这一半没有块身份，锚点留给另一半）。
 *
 * @returns {{raw:string, block:object, newBlock:object|null}}
 */
export function splitBlockContent(raw, { anchor, before, after, keep = 'before' } = {}, options = {}) {
  const { eol = String(raw).includes('\r\n') ? '\r\n' : '\n', generate = generateAnchor } = options;
  const parsed = parseDocument(raw, { checkImages: false });
  const source = parsed.text;
  const bom = String(raw).startsWith('\uFEFF') ? '\uFEFF' : '';
  const block = parsed.blocks.find((item) => item.anchor === anchor);
  if (!block) reorderFail('block_missing', `找不到锚点 ${anchor}；文档可能已被外部修改`);
  if (keep !== 'before' && keep !== 'after') {
    reorderFail('block_content', '拆分只接受 keep: before / after —— 原锚点留给哪一半');
  }
  if (!SPLITTABLE_TYPES.has(block.type)) {
    reorderFail('block_split_type', `${TYPE_NAMES[block.type] ?? block.type}不能拆成两块；只有段落 / 标题 / 列表项 / 引用可以`);
  }
  const verdict = assessBlock(block);
  if (!verdict.editable) reorderFail('block_degraded', `这一块超出可编辑子集：${verdict.reason}`);
  if (typeof before !== 'string' || typeof after !== 'string') {
    reorderFail('block_content', '拆分的前后两半都必须是文本');
  }
  const first = normalizeInline(before);
  const second = normalizeInline(after);
  if (!first.trim()) reorderFail('block_empty', '拆分后前半为空：回车应当在光标处把内容分成两段');
  if (!second.trim()) reorderFail('block_empty', '拆分后后半为空：空块没有锚点可落，不能写进文档');

  const prefix = blockPrefix(block);
  // 前半守住原锚点，所以它只能在这四类块里变；后半是新块，标题 / 列表 / 引用 / 代码 / 表格都行。
  const firstPlan = startsWithTypedMarker(first)
    ? planTypedBlock(first, { currentType: block.type, currentPrefix: '' })
    : inlinePlan(block.type, prefix, first);
  if (firstPlan.structural) {
    reorderFail('block_structure', '前半是页 / 章节标题时没有块身份可留；先把标题写完再分块');
  }
  if (!SPLITTABLE_TYPES.has(firstPlan.type)) {
    reorderFail('block_split_type', `拆分出的${TYPE_NAMES[firstPlan.type] ?? firstPlan.type}不能带着原锚点；只有段落 / 标题 / 列表项 / 引用可以`);
  }
  // 标题回车后的后半是正文：再写一个同级别标题会把页内小节越拆越深。
  const secondType = block.type === 'heading' ? 'paragraph' : block.type;
  const secondPlan = startsWithTypedMarker(second)
    ? planTypedBlock(second, { currentType: secondType, currentPrefix: '' })
    : inlinePlan(secondType, secondType === 'heading' ? '' : prefix, second);
  if (secondPlan.structural && keep === 'after') {
    reorderFail('block_structure', '后半变成页 / 章节标题时，原锚点不能跟着这一半；请用 keep: before');
  }

  const seen = new Set(parsed.blocks.map((item) => item.anchor).filter(Boolean));
  const newAnchor = generate(seen);
  // 块首回车时新块在前半，原锚点要跟着原来的内容留到后半；两种落法都只换这一处。
  const firstAnchor = keep === 'after' ? newAnchor : anchor;
  const secondAnchor = keep === 'after' ? anchor : newAnchor;
  const firstRaw = typedReplacement(firstPlan, firstAnchor, eol);
  const secondRaw = typedReplacement(secondPlan, secondAnchor, eol);
  const replacement = `${firstRaw}${eol}${eol}${secondRaw}`;
  const next = source.slice(0, block.startOffset) + replacement + source.slice(block.endOffset);

  const afterDocument = parseDocument(next, { checkImages: false });
  const position = parsed.blocks.indexOf(block);
  const firstBlock = afterDocument.blocks[position];
  const secondBlock = secondPlan.structural ? null : afterDocument.blocks[position + 1];
  const expectedCount = parsed.blocks.length + (secondPlan.structural ? 0 : 1);
  if (afterDocument.blocks.length !== expectedCount
    || firstBlock?.anchor !== firstAnchor || firstBlock.raw !== firstPlan.raw || firstBlock.type !== firstPlan.type
    || (!secondPlan.structural
      && (secondBlock?.anchor !== secondAnchor || secondBlock.raw !== secondPlan.raw || secondBlock.type !== secondPlan.type))) {
    reorderFail('block_structure', '拆分后的块序列与预期不一致，已拒绝');
  }
  const pageOf = (item) => pageKeyOf(item.page) ?? '0-0';
  if (pageOf(firstBlock) !== pageOf(block) || (secondBlock && pageOf(secondBlock) !== pageOf(block))) {
    reorderFail('block_structure', '拆分把块挪出了原来那一页，已拒绝');
  }
  if (secondPlan.structural) {
    const scope = secondPlan.type === 'page' ? afterDocument.pages : afterDocument.chapters;
    const prior = secondPlan.type === 'page' ? parsed.pages : parsed.chapters;
    if (scope.length !== prior.length + 1 || !scope.some((item) => item.title === secondPlan.title)) {
      reorderFail('block_structure', `拆分没有干净地加出一${secondPlan.type === 'page' ? '页' : '章'}，已拒绝`);
    }
  }
  for (const piece of [firstBlock, secondBlock].filter(Boolean)) {
    const check = assessBlock(piece);
    if (!check.editable) reorderFail('block_degraded', `拆分出的${TYPE_NAMES[piece.type] ?? piece.type}超出可编辑子集：${check.reason}`);
  }
  // 回执里 block 永远是「守住原锚点的那一块」，newBlock 是这次新生成的块：
  // 块首回车时新块在前、原块在后，但身份跟着内容走，不能按前后位置命名。
  const kept = keep === 'after' ? secondBlock : firstBlock;
  const created = keep === 'after' ? firstBlock : secondBlock;
  return { raw: bom + next, block: kept, newBlock: created };
}

/**
 * 把一个已经清空的块并进紧挨着的前一块：前一块的锚点与 raw 逐字不动，后一块连同锚点删除。
 *
 * 只接受 content 为空（行内序列化后只剩空白 / 硬换行）的请求：还有内容的块不能被
 * 「合并」静默丢掉，那要走保存。块身份不迁移——被删块的评论与任务留在原锚点上，
 * 旧任务 claim 时会明确报 stale，而不是悄悄改到前一块（契约第 4 节）。
 *
 * @returns {{raw:string, block:object, removed:string}}
 */
export function mergeBlockContent(raw, { anchor, previous, content } = {}, options = {}) {
  const { eol = String(raw).includes('\r\n') ? '\r\n' : '\n' } = options;
  const parsed = parseDocument(raw, { checkImages: false });
  const source = parsed.text;
  const bom = String(raw).startsWith('\uFEFF') ? '\uFEFF' : '';
  if (typeof content !== 'string') reorderFail('block_content', '合并请求要带上这一块现在的内容');
  const residue = content.replace(/\\\r?\n/g, '').replace(/\s+/g, '');
  if (residue !== '') reorderFail('merge_not_empty', '这一块还有内容；先清空再按 Backspace 合并');
  const block = parsed.blocks.find((item) => item.anchor === anchor);
  if (!block) reorderFail('block_missing', `找不到锚点 ${anchor}；文档可能已被外部修改`);
  const target = parsed.blocks.find((item) => item.anchor === previous);
  if (typeof previous !== 'string' || !previous) {
    reorderFail('merge_previous_missing', '这一块前面没有可并入的块');
  }
  if (!target) reorderFail('merge_target', `找不到上一块 ${previous}；文档可能已被外部修改`);
  if (!MERGEABLE_TYPES.has(block.type) || !MERGEABLE_TYPES.has(target.type)) {
    reorderFail('block_merge_type', '只有段落 / 标题 / 列表项 / 引用可以互相合并');
  }
  const position = parsed.blocks.indexOf(block);
  if (parsed.blocks.indexOf(target) !== position - 1) {
    reorderFail('merge_target', '只能并入紧挨着的前一块');
  }
  const pageOf = (item) => pageKeyOf(item.page) ?? '0-0';
  if (pageOf(target) !== pageOf(block)) reorderFail('merge_target', '只能并入同一页的前一块');
  // 合并会把后一块删掉，页可能因此变空——那是编辑的中间态，不拦（ADR 0006）。

  const lines = source.split(/\r?\n/);
  const previousEndIndex = blockEndLine(target) - 1;
  const end = blockEndLine(block);
  let start = block.startLine - 1;
  // 吞掉前一块与本块之间的空行；接缝处只留一个空行。
  while (start - 1 > previousEndIndex && isBlankLine(lines[start - 1])) start -= 1;
  if (end < lines.length && !isBlankLine(lines[end])) lines.splice(end, 0, '');
  lines.splice(start, end - start);
  const next = bom + lines.join(eol);

  const afterDocument = parseDocument(next, { checkImages: false });
  const kept = afterDocument.blocks.find((item) => item.anchor === previous);
  if (afterDocument.blocks.length !== parsed.blocks.length - 1
    || !kept || kept.raw !== target.raw
    || afterDocument.blocks.some((item) => item.anchor === anchor)) {
    reorderFail('block_structure', '合并后的块序列与预期不一致，已拒绝');
  }
  if (pageOf(kept) !== pageOf(target)) reorderFail('block_structure', '合并把前一块挪出了原来那一页，已拒绝');
  return { raw: next, block: kept, removed: anchor };
}

/**
 * 给一个**空页**写第一块：空页在文件里只有 `## 标题`，没有正文可写；页面在渲染层给一个
 * 待定块，人一输入就调这里把第一个真正的块落盘。
 *
 * 只对空页生效（页里已经有块就拒绝，追加请用拖入或拆分）：插入位置紧跟页标题，
 * 生成一个新锚点，其余字节逐字不动。插入后重解析，确认只多出这一个块、页与章节数量不变 ——
 * 这样 `#` / `##` 开头的正文不会把一页偷偷变成一章。
 *
 * @returns {{raw:string, block:object}}
 */
export function createBlockInPage(raw, { chapter, index, content } = {}, options = {}) {
  const { eol = String(raw).includes('\r\n') ? '\r\n' : '\n', generate = generateAnchor } = options;
  const parsed = parseDocument(raw, { checkImages: false });
  const page = locatePage(parsed, { chapter, index });
  if (page.blocks.length) reorderFail('page_not_empty', `页「${page.title}」已经有块；新块请用拆分或拖入`);
  if (typeof content !== 'string') reorderFail('block_content', '块内容必须是文本');
  const overall = content.replace(/\r\n?/g, '\n').replace(/\s+$/, '');
  if (!overall.trim()) reorderFail('block_empty', '第一块不能为空');
  if (ANCHOR_ANY_RE.test(overall)) reorderFail('block_content_anchor', '块内容里不能写锚点');
  const seen = new Set(parsed.blocks.map((item) => item.anchor).filter(Boolean));
  const anchor = generate(seen);
  // 空页的第一块同样由行首前缀决定类型：`### ` 落成标题块而不是把锚点写进标题行。
  const plan = planTypedBlock(overall, { currentType: 'paragraph', currentPrefix: '' });
  const headingEnd = parsed.lineStarts[page.line - 1] + (parsed.lines[page.line - 1] ?? '').length;
  const insert = `${eol}${eol}${typedReplacement(plan, anchor, eol)}`;
  const next = parsed.text.slice(0, headingEnd) + insert + parsed.text.slice(headingEnd);
  const after = parseDocument(next, { checkImages: false });
  const written = after.blocks.find((item) => item.anchor === anchor) ?? null;
  const expectedChapters = plan.structural && plan.type === 'chapter'
    ? parsed.chapters.length + 1 : parsed.chapters.length;
  const expectedPages = plan.structural && plan.type === 'page'
    ? parsed.pages.length + 1 : parsed.pages.length;
  if (after.chapters.length !== expectedChapters
    || after.pages.length !== expectedPages
    || after.blocks.length !== parsed.blocks.length + (plan.structural && !plan.rest ? 0 : 1)) {
    reorderFail('block_structure', '第一块没有干净地落在这一页里，已拒绝');
  }
  if (plan.structural) {
    const scope = plan.type === 'page' ? after.pages : after.chapters;
    const prior = plan.type === 'page' ? parsed.pages : parsed.chapters;
    if (scope.length !== prior.length + 1 || !scope.some((item) => item.title === plan.title)) {
      reorderFail('block_structure', '第一块没有干净地变成页 / 章节，已拒绝');
    }
    if (plan.rest && (!written || written.raw !== escapeLiteralParagraph(plan.rest))) {
      reorderFail('block_structure', '第一块前缀后面的正文没有干净地落盘，已拒绝');
    }
  } else if (!written || written.raw !== plan.raw
    || written.type !== plan.type
    || written.page?.chapter?.index !== page.chapter.index
    || written.page.index !== page.index) {
    reorderFail('block_structure', '第一块没有干净地落在这一页里，已拒绝');
  }
  return {
    raw: raw.startsWith('\uFEFF') ? `\uFEFF${next}` : next,
    block: written,
    ...(plan.structural ? {
      retype: { from: 'paragraph', to: plan.type, prefix: plan.prefix, literal: null, structure: plan.type },
    } : {}),
  };
}

// ───────────── 重排：只挪位置，不换内容 ─────────────
//
// 编辑面（applyBlockContent）刻意不允许块类型与顺序变化。拖动、页重排是另一件事，
// 所以走这里的两个显式操作：一次只挪一个块或一页，其余行原样保留，接缝处只补/并空行。
// 两个操作都按锚点定位，拒绝任何会让页或章节变空的移动，并重解析验证结果。

const reorderFail = (code, message) => { throw Object.assign(Error(message), { code }); };
const isBlankLine = (line) => (line ?? '').trim() === '';

/** 块占的最后一行（1 基）：独立块的锚点单独成行，写在元素下一行，也算块的一部分。 */
export function blockEndLine(block) {
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
 * 重排之后必须仍然是一份「同样的文档，只是顺序变了」：块的身份与 raw 一个不少。
 * 页面是否变空、块是否落到页外不在这里判——那是交付校验器的职责（ADR 0006）。
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
  return after;
}

/** 章节的末尾（0 基插入位置）：下一章标题之前；最后一章到文件末尾。 */
function chapterEnd(parsed, chapter) {
  const next = parsed.chapters[chapter.index];
  return next ? next.line - 1 : parsed.lines.length;
}

/**
 * 移动一个块：剪下它的行，插到目标页的「某块之前」（`before: null` 表示该页末尾），
 * 或者插到某一章标题下的「页外」（`to.outside: true`）。
 *
 * 块可以搬到页外，也可以从页外搬回页里；搬走一页的最后一块不拦（页变空是中间态）。
 * 页外块也允许再次移动：它没有页身份，但仍有块身份。
 *
 * @param {string} raw 原文
 * @param {{anchor:string, to:{chapter:number,index?:number,before?:string|null,outside?:boolean}}} move
 * @returns {{raw:string, changed:boolean, moved:string, page:string|null, outside?:boolean, chapter?:number}}
 */
export function moveBlock(raw, { anchor, to } = {}) {
  if (typeof anchor !== 'string' || !anchor) reorderFail('reorder_anchor', '缺少要移动的块锚点');
  const parsed = parseDocument(raw, { checkImages: false });
  const block = parsed.blocks.find((item) => item.anchor === anchor);
  if (!block) reorderFail('block_missing', `找不到锚点 ${anchor}；文档可能已被外部修改`);
  const outside = to?.outside === true;
  let target = null;
  let chapter = null;
  let gap;
  if (outside) {
    chapter = parsed.chapters[Number(to.chapter) - 1] ?? null;
    if (!chapter) reorderFail('chapter_missing', `找不到第 ${to.chapter} 章`);
    // 页外落点 = 章节标题正下方：本章第一页之前；本章没有页就到章末。
    gap = chapter.pages.length ? chapter.pages[0].line - 1 : chapterEnd(parsed, chapter);
  } else {
    target = locatePage(parsed, to);
    // 页末落点（`before: null`）：页末连续的引用是出处区，位置就是语义（契约第 5 节）。
    // 正文块落到「页末」= 落到出处区**之前**；否则它会把出处区拆散（页末不再是引用，
    // 整串出处退化成正文引用）。出处块自己落到页末时仍留在出处区末尾，顺序不乱。
    const sourcesHead = !isSource(block) && target.sources?.length ? target.sources[0] : null;
    const endBefore = sourcesHead?.anchor ?? null;
    if (isPageEnd(to.before)) {
      gap = sourcesHead ? sourcesHead.startLine - 1 : pageLineRange(target).end;
    } else {
      const before = target.blocks.find((item) => item.anchor === to.before);
      if (!before) reorderFail('reorder_target', `目标页里没有块 ${to.before}`);
      gap = before.startLine - 1;
    }
    if (target === block.page) {
      const self = target.blocks.indexOf(block);
      const beforeIndex = isPageEnd(to.before)
        ? (endBefore ? target.blocks.findIndex((item) => item.anchor === endBefore) : target.blocks.length)
        : target.blocks.findIndex((item) => item.anchor === to.before);
      // 落回原位（插在自己前面 / 自己后面）不是错误，也不是一次修改。
      if (beforeIndex === self || beforeIndex === self + 1) {
        return { raw: String(raw), changed: false, moved: anchor, page: pageKeyOf(target) };
      }
    }
  }
  const cut = blockLineRange(block);
  // 落在自己原来的位置不是一次修改：不要因为补空行把文件写一遍。
  if (gap === cut.start) {
    return {
      raw: String(raw),
      changed: false,
      moved: anchor,
      page: block.page ? pageKeyOf(block.page) : null,
    };
  }
  const lines = spliceLines(String(raw).replace(/^\uFEFF/, '').split(/\r?\n/), cut.start, cut.end, gap);
  const next = joinDocument(raw, lines);
  const after = verifyReorder(parsed, next, '移动块');
  const moved = after.blocks.find((item) => item.anchor === anchor);
  if (outside) {
    if (moved?.page) reorderFail('reorder_verify', '移动后的块仍然落在某一页里');
    return { raw: next, changed: true, moved: anchor, page: null, outside: true, chapter: chapter.index };
  }
  // 块移动不改页序，所以「目标页」的章节号 / 页号在重排前后是同一个位置。
  if (!moved?.page || moved.page.chapter?.index !== target.chapter.index || moved.page.index !== target.index) {
    reorderFail('reorder_verify', '移动后的块没有落在目标页里');
  }
  return {
    raw: next,
    changed: true,
    moved: anchor,
    page: pageKeyOf(moved.page),
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
  // 章节可能因此变空——那是编辑的中间态，不拦（ADR 0006）。
  const from = parsed.pages.indexOf(sourcePage);
  const targetIndex = parsed.pages.indexOf(targetPage) + (to.position === 'after' ? 1 : 0);
  const insertAt = targetIndex > from ? targetIndex - 1 : targetIndex;
  // 顺序没变、章节也没变才是空操作。跨过 # 章节标题落在同一个文档位置时，
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
