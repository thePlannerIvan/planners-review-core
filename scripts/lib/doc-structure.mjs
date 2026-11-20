/**
 * 结构编辑：改章节名 / 页名、在页尾加页、在章节尾加章、在页尾出处区加一条引用。
 *
 * 结构不是块：`#` 章节与 `##` 页没有锚点（契约第 2 节），所以这里不碰既有块 raw、
 * 不生成除「新块」以外的任何块身份。所有操作都是**对原文的行级补丁**：只替换标题行
 * 或在一个边界处插入新行，其余字节逐字保留（含 CRLF 与文件末尾换行）。
 *
 * 五个动作名与本地路由表 / 命令后端同名：`rename-chapter` / `rename-page` /
 * `add-page` / `add-chapter` / `add-source`。回执里给出新结构的 `{chapter, page}`
 * 或新块 `{source}`，页面据此定位并聚焦。
 */
import { generateAnchor, outsidePageCount, parseDocument } from './doc-blocks.mjs';
import DocIdentity from '../../assets/workbench/doc-identity.js';

const { pageKeyOf } = DocIdentity;

export const STRUCTURE_OPS = new Set([
  'rename-chapter', 'rename-page', 'add-page', 'add-chapter', 'add-source',
]);
export const NEW_CHAPTER_TITLE = '新章节';
export const NEW_PAGE_TITLE = '新页';
// 新页就是**真正的空页**：文件里只有 `## 标题`，没有任何占位正文、也没有块身份。
// 空页在编辑时合法（ADR 0006），交付校验器会报 `page_empty`，写不写由模型/人补。
// 页面上那句「在这里写这一页。」是渲染层的 pending 块，输入后才落成真正的第一块。
/** 新出处条目的占位文字：加完就能直接改，不用再点一次。 */
const NEW_SOURCE_BLOCK = '在这里写这条出处。';
/** 新块的身份：避开文档里已经存在的锚点。 */
const freshAnchor = (parsed) => generateAnchor(
  new Set((parsed.blocks ?? []).map((block) => block.anchor).filter(Boolean)),
);

const fail = (code, message) => { throw Object.assign(Error(message), { code }); };

/** 标题只占一行：换行折成空格；空标题与锚点注释不写进结构行。 */
function cleanTitle(value, fallback = null) {
  if (value === undefined || value === null) {
    if (fallback === null) fail('structure_title', '标题不能为空');
    return fallback;
  }
  if (typeof value !== 'string') fail('structure_title', '标题必须是文本');
  const title = value.replace(/\s+/g, ' ').trim();
  if (!title) fail('structure_title', '标题不能为空');
  if (title.includes('<!--')) fail('structure_title', '标题里不能写锚点注释');
  if (title.length > 200) fail('structure_title', '标题不要超过 200 个字');
  return title;
}

/** 行首偏移：与解析器同样把 CRLF 算一个换行，但不改写原文。 */
function lineStarts(text) {
  const starts = [];
  let cursor = 0;
  for (const line of text.split(/\r?\n/)) {
    starts.push(cursor);
    cursor += line.length;
    if (text.startsWith('\r\n', cursor)) cursor += 2;
    else if (text[cursor] === '\n') cursor += 1;
  }
  return starts;
}

const eolOf = (text) => (text.includes('\r\n') ? '\r\n' : '\n');

function chapterAt(parsed, value) {
  const index = Number(value);
  const chapter = Number.isInteger(index) ? parsed.chapters[index - 1] : null;
  if (!chapter) fail('chapter_missing', `找不到第 ${value} 章`);
  return chapter;
}

function pageAt(parsed, chapter, value) {
  const index = Number(value);
  const page = Number.isInteger(index) ? chapter.pages[index - 1] : null;
  if (!page) fail('page_missing', `找不到「${chapter.title}」的第 ${value} 页`);
  return page;
}

/**
 * 新增章节 / 新增页的定位：接受扁平 `{chapter, index}`，也接受「人正看着的这一页」
 * `{page: {chapter, index}}`。从页出发的请求只提供上下文 —— 新章节 / 新页永远落在
 * 结构边界之后，不会落在那一页的中间（票 34）。
 */
function targetOf(payload) {
  const page = payload?.page;
  if (page && typeof page === 'object' && !Array.isArray(page)) {
    return {
      chapter: page.chapter ?? payload?.chapter,
      index: page.index ?? payload?.index,
    };
  }
  return { chapter: payload?.chapter, index: payload?.index };
}

/** 页的边界：同一章下一页的标题行；没有下一页就退到下一章的标题行；都没有就是文件末尾。 */
function pageBoundaryLine(parsed, chapter, page) {
  return chapter.pages[page.index]?.line ?? parsed.chapters[chapter.index]?.line ?? null;
}

/** 章节的边界：下一章的标题行；最后一章没有下一章，落点是文件末尾。 */
function chapterBoundaryLine(parsed, chapter) {
  return parsed.chapters[chapter.index]?.line ?? null;
}

/**
 * 结构写回后的兜底检查（票 34）：新章节 / 页落下后，页里的块一个都不能掉到页外，
 * 已有块的 raw 一个字节都不能动，结构数量也正好只多出该多的那一个。
 * 落点算错时宁可报错不写，也不把同一个 page 的正文与出处推出页外。
 */
function verifyStructureWrite(before, output, expect) {
  const after = parseDocument(output, { checkImages: false });
  if (outsidePageCount(after) > outsidePageCount(before)) {
    fail('structure_boundary', '这次结构改动会把页里的块推出页外，已拒绝');
  }
  if (after.blocks.length !== before.blocks.length) {
    fail('structure_boundary', '这次结构改动动了块，已拒绝');
  }
  const raws = new Map(before.blocks.map((block) => [block.anchor, block.raw]));
  for (const block of after.blocks) {
    if (block.anchor && raws.has(block.anchor) && raws.get(block.anchor) !== block.raw) {
      fail('structure_boundary', '这次结构改动动了已有块的内容，已拒绝');
    }
  }
  if (after.chapters.length !== before.chapters.length + (expect.chapters ?? 0)
    || after.pages.length !== before.pages.length + (expect.pages ?? 0)) {
    fail('structure_boundary', '这次结构改动没有落在预期的结构边界上，已拒绝');
  }
}

/**
 * 对一份原文应用一个结构动作。调用方负责 baseline（`base_sha256`）与写锁；
 * 这里只保证「除了这一处结构，其余字节不动」，并回执新结构的位置。
 */
export function applyStructure(raw, payload) {
  const op = payload?.op;
  if (!STRUCTURE_OPS.has(op)) {
    fail('structure_op', '结构操作只接受 rename-chapter / rename-page / add-page / add-chapter / add-source');
  }
  const source = String(raw ?? '');
  const bom = source.startsWith('\uFEFF') ? '\uFEFF' : '';
  const text = source.slice(bom.length);
  const parsed = parseDocument(text, { checkImages: false });
  const eol = eolOf(text);
  const starts = lineStarts(text);
  const lineEnd = (line) => starts[line - 1] + (parsed.lines[line - 1] ?? '').length;
  const insertBeforeLine = (line, insert) => text.slice(0, starts[line - 1]) + insert + text.slice(starts[line - 1]);
  const appendAtEnd = (insert) => {
    const padding = text === '' || text.endsWith(eol + eol) ? '' : text.endsWith(eol) ? eol : eol + eol;
    return text + padding + insert;
  };

  if (op === 'rename-chapter') {
    const chapter = chapterAt(parsed, payload.chapter);
    const title = cleanTitle(payload.title);
    if (title === chapter.title) {
      return { raw: bom + text, changed: false, chapter: { index: chapter.index, title } };
    }
    const line = chapter.line;
    const next = `# ${title}`;
    const output = text.slice(0, starts[line - 1]) + next + text.slice(lineEnd(line));
    return { raw: bom + output, changed: true, chapter: { index: chapter.index, title } };
  }

  if (op === 'rename-page') {
    const chapter = chapterAt(parsed, payload.chapter);
    const page = pageAt(parsed, chapter, payload.index);
    const title = cleanTitle(payload.title);
    if (title === page.title) {
      return { raw: bom + text, changed: false, page: pageView(chapter, page, title) };
    }
    const line = page.line;
    const next = `## ${title}`;
    const output = text.slice(0, starts[line - 1]) + next + text.slice(lineEnd(line));
    return { raw: bom + output, changed: true, page: pageView(chapter, page, title) };
  }

  if (op === 'add-page') {
    const target = targetOf(payload);
    const chapter = chapterAt(parsed, target.chapter);
    const page = pageAt(parsed, chapter, target.index);
    const title = cleanTitle(payload.title, NEW_PAGE_TITLE);
    const insert = `## ${title}${eol}`;
    // 落点：这一页的边界之后。下一页 / 下一章的标题行就是边界；都没有就追加到文件末尾。
    const boundary = pageBoundaryLine(parsed, chapter, page);
    const output = boundary ? insertBeforeLine(boundary, `## ${title}${eol}${eol}`) : appendAtEnd(insert);
    verifyStructureWrite(parsed, output, { pages: 1 });
    return {
      raw: bom + output,
      changed: true,
      page: { chapter: chapter.index, index: page.index + 1, title, key: pageKeyOf({ chapter: chapter.index, index: page.index + 1 }) },
    };
  }

  // add-source：页尾加一条引用。页末的引用就是出处区（契约第 5 节），所以这一条
  // 并进已有出处区的末尾；没有出处区的页由此得到一条。
  if (op === 'add-source') {
    const chapter = chapterAt(parsed, payload.chapter);
    const page = pageAt(parsed, chapter, payload.index);
    const last = page.blocks[page.blocks.length - 1];
    if (!last) fail('page_empty', `页「${page.title}」没有任何块，加不了出处；先写正文`);
    const anchor = freshAnchor(parsed);
    const insert = `${eol}${eol}> ${NEW_SOURCE_BLOCK}<!-- ${anchor} -->`;
    const output = text.slice(0, last.endOffset) + insert + text.slice(last.endOffset);
    return {
      raw: bom + output,
      changed: true,
      source: { anchor, page: { chapter: chapter.index, index: page.index, title: page.title } },
    };
  }

  // add-chapter：章节尾加一章，同时给它第一页；空章节在目录里没有意义。
  // 从页出发的请求（「我在这一页点＋新章节」）也落在这里：新章永远在章节边界之后，
  // 不落在页中间 —— 否则该页剩下的块会全被推出页外（票 34）。
  const target = targetOf(payload);
  const chapter = chapterAt(parsed, target.chapter);
  const title = cleanTitle(payload.title, NEW_CHAPTER_TITLE);
  const pageTitle = cleanTitle(payload.page_title, NEW_PAGE_TITLE);
  const insert = `# ${title}${eol}${eol}## ${pageTitle}${eol}`;
  const boundary = chapterBoundaryLine(parsed, chapter);
  const output = boundary ? insertBeforeLine(boundary, `${insert}${eol}`) : appendAtEnd(insert);
  verifyStructureWrite(parsed, output, { chapters: 1, pages: 1 });
  return {
    raw: bom + output,
    changed: true,
    chapter: { index: chapter.index + 1, title },
    page: { chapter: chapter.index + 1, index: 1, title: pageTitle, key: pageKeyOf({ chapter: chapter.index + 1, index: 1 }) },
  };
}

function pageView(chapter, page, title) {
  return { chapter: chapter.index, index: page.index, title, key: pageKeyOf({ chapter: chapter.index, index: page.index }) };
}
