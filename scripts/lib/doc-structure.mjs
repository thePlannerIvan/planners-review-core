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
import { generateAnchor, parseDocument } from './doc-blocks.mjs';

export const STRUCTURE_OPS = new Set([
  'rename-chapter', 'rename-page', 'add-page', 'add-chapter', 'add-source',
]);
export const NEW_CHAPTER_TITLE = '新章节';
export const NEW_PAGE_TITLE = '新页';
/** 新页的第一块：空页在契约里是 `page_empty`，也不进目录，所以给它一个可写的起点。 */
const NEW_PAGE_BLOCK = '在这里写这一页。';
/** 新出处条目的占位文字：像新页一样，加完就能直接改，不用再点一次。 */
const NEW_SOURCE_BLOCK = '在这里写这条出处。';

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

/** 新块只在现有锚点之外生成，避开文档里已有的身份。 */
function freshAnchor(parsed) {
  const seen = new Set(parsed.blocks.map((block) => block.anchor).filter(Boolean));
  return generateAnchor(seen);
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
    const chapter = chapterAt(parsed, payload.chapter);
    const page = pageAt(parsed, chapter, payload.index);
    const title = cleanTitle(payload.title, NEW_PAGE_TITLE);
    const anchor = freshAnchor(parsed);
    const insert = `## ${title}${eol}${eol}${NEW_PAGE_BLOCK}<!-- ${anchor} -->${eol}${eol}`;
    // 落点：同一页之后。下一页 / 下一章的标题行就是边界；都没有就追加到文件末尾。
    const nextPage = chapter.pages[page.index]; // 1-based 页号，数组下标正好是下一页
    const nextChapter = parsed.chapters[chapter.index];
    const boundary = nextPage?.line ?? nextChapter?.line ?? null;
    const output = boundary ? insertBeforeLine(boundary, insert) : appendAtEnd(insert);
    return {
      raw: bom + output,
      changed: true,
      page: { chapter: chapter.index, index: page.index + 1, title, key: `${chapter.index}-${page.index + 1}`, anchor },
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
  const chapter = chapterAt(parsed, payload.chapter);
  const title = cleanTitle(payload.title, NEW_CHAPTER_TITLE);
  const pageTitle = cleanTitle(payload.page_title, NEW_PAGE_TITLE);
  const anchor = freshAnchor(parsed);
  const insert = `# ${title}${eol}${eol}## ${pageTitle}${eol}${eol}${NEW_PAGE_BLOCK}<!-- ${anchor} -->${eol}${eol}`;
  const nextChapter = parsed.chapters[chapter.index];
  const output = nextChapter ? insertBeforeLine(nextChapter.line, insert) : appendAtEnd(insert);
  return {
    raw: bom + output,
    changed: true,
    chapter: { index: chapter.index + 1, title },
    page: { chapter: chapter.index + 1, index: 1, title: pageTitle, key: `${chapter.index + 1}-1`, anchor },
  };
}

function pageView(chapter, page, title) {
  return { chapter: chapter.index, index: page.index, title, key: `${chapter.index}-${page.index}` };
}
