'use strict';
/* 文字工作台的渲染与保存。只做一件事：块 raw 进、块 raw 出。
 * 块内就地编辑用 contenteditable；保存时只把被改的这一块 POST 回去。 */
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

// 右缘批注图标：与左缘抓手同一套笔画（1.7、圆头、muted 色、14px 高）。
const FEEDBACK_ICON = '<svg viewBox="0 0 14 14" width="14" height="14" fill="none" '
  + 'stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" '
  + 'aria-hidden="true" focusable="false">'
  + '<path d="M4 2.4h6a1.6 1.6 0 0 1 1.6 1.6v4A1.6 1.6 0 0 1 10 9.6H6.4L4 11.8V9.6h0A1.6 1.6 0 0 1 2.4 8V4A1.6 1.6 0 0 1 4 2.4Z"/>'
  + '</svg>';

const TOOLBAR_HTML = `
  <button type="button" data-inline="bold" title="加粗" aria-label="加粗"><strong>B</strong></button>
  <button type="button" data-inline="italic" title="斜体" aria-label="斜体"><em>I</em></button>
  <button type="button" data-inline="code" title="行内代码" aria-label="行内代码"><code>\`</code></button>
  <button type="button" data-inline="link" title="链接" aria-label="链接">↗</button>`;

let snapshot = null;
let transport = null; // 同一份页面两种宿主：本地 /api 或侧栏 command（doc-transport.js）
let layout = null; // 三档布局 + 折叠键 + 滚动毛玻璃（doc-layout.js）
let saveTimer = null;
let saveQueue = Promise.resolve();
const blockByAnchor = new Map();
// 页锚点 → 页标题所在的 divider（票 38）：批注跳转与气泡都按这条身份找页。
const pageAnchorNodes = new Map();
// 出处默认收起：只记展开过的页，重画后照样展开；收起是默认，不在集合里（契约第 5 节）。
const expandedSources = new Set();

// 反馈与锁：目标块随选区 / 入口变化；锁由任务同步而来，保存时服务端还会再拦一次。
let feedbackScope = 'blocks';
let feedbackTargets = [];
let lockedAnchors = new Set();
let selectionTimer = null;
let taskTimer = null;
// 保存请求在飞时不抢着重载正文；待核对记录留在内存里，重画正文后照样能锁回这一块。
let savesInFlight = 0;
let deferredRecords = new Map();

const blockNodes = () => $$('.doc-block');

const status = (text, failed = false) => {
  const node = $('#saveState');
  node.textContent = text;
  node.classList.toggle('failed', failed);
};

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[character]));

const renderInline = (markdown) => {
  try {
    if (typeof marked !== 'undefined' && typeof marked.parseInline === 'function') {
      return marked.parseInline(String(markdown ?? ''));
    }
  } catch { /* 退化到纯文本 */ }
  return escapeHtml(markdown);
};

/**
 * 页的分隔头：只有页名，没有「章节名 · 第 N 页」那一行——页号只活在左侧目录里。
 * 空页也画出来（否则结构清单「跳到那一页」无处可去）；页外块只留一段呼吸的位置。
 * `editable` 是结构稿：页名点进去改；只读主稿不给改名入口。
 */
function pageHeading(page, { editable = false, orphan = false } = {}) {
  const node = document.createElement('div');
  node.className = 'page-divider';
  if (orphan) {
    node.classList.add('is-orphan');
    // 页外块不给页眉；顶栏那个圆点的清单负责说出来。
    node.setAttribute('aria-hidden', 'true');
    return node;
  }
  if (page.empty) node.classList.add('is-empty');
  if (page.key) node.dataset.pageKey = page.key;
  const title = document.createElement('h2');
  title.className = 'page-title';
  title.textContent = page.title ?? '';
  if (editable) {
    wireStructureTitle(title, { op: 'rename-page', chapter: page.chapterIndex, index: page.index });
  }
  node.append(title);
  // 页标题右侧的批注气泡：与块尾那一枚同一套图标、同一套交互（点了直接落草稿进抽屉）。
  if (editable) attachPageFeedback(node, page);
  if (page.anchor) pageAnchorNodes.set(page.anchor, node);
  if (page.empty) {
    // 提示只在渲染层：真正的空页在文件里没有正文（加页不再塞占位文字）。
    const note = document.createElement('p');
    note.className = 'page-empty-note';
    note.textContent = '这一页还是空的；从上面写第一块，或把别处的块拖进来。';
    node.append(note);
  }
  return node;
}

/**
 * 章节是结构的一层，不是页眉里的装饰：正文里每个 `#` 章节有自己的可改标题，
 * 页排在它下面。页身份仍只挂在 page-divider 上，目录高亮只认页（见 doc-drag）。
 */
function chapterHeading(chapter) {
  const node = document.createElement('div');
  node.className = 'chapter-divider';
  node.dataset.chapterIndex = String(chapter.index ?? '');
  const title = document.createElement('h1');
  title.className = 'chapter-title';
  title.textContent = chapter.title ?? '未命名章节';
  title.dataset.chapterIndex = String(chapter.index ?? '');
  wireStructureTitle(title, { op: 'rename-chapter', chapter: chapter.index });
  node.append(title);
  return node;
}

// ── 结构改名：点进去就能改，失焦写回；与块保存共用同一条 structure 命令 ─────────
function wireStructureTitle(node, spec) {
  node.dataset.structureTitle = spec.op === 'rename-chapter' ? 'chapter' : 'page';
  node.title = '点击改名字';
  node.addEventListener('click', (event) => {
    if (event.target.closest('a')) return;
    beginStructureEdit(node, spec);
  });
}

function selectContents(node) {
  const range = document.createRange();
  range.selectNodeContents(node);
  const selection = getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}

/** 拖页标题仍走原生拖动；只有「点一下」才进入编辑，编辑期间先关掉 draggable。 */
function beginStructureEdit(node, spec) {
  if (node.getAttribute('contenteditable') === 'true' || snapshot?.readonly) return;
  const original = node.textContent;
  const wasDraggable = node.draggable;
  let finished = false;
  node.contentEditable = 'true';
  node.draggable = false;
  node.classList.add('is-editing-title');
  node.focus();
  selectContents(node);

  const finish = ({ commit }) => {
    if (finished) return;
    finished = true;
    node.removeEventListener('keydown', onKeydown);
    const title = String(node.textContent ?? '').replace(/\s+/g, ' ').trim();
    node.contentEditable = 'false';
    node.removeAttribute('contenteditable');
    node.draggable = wasDraggable;
    node.classList.remove('is-editing-title');
    if (!commit || title === original) {
      node.textContent = original;
      return;
    }
    if (!title) {
      node.textContent = original;
      status('改名失败 · 标题不能为空', true);
      return;
    }
    node.textContent = title;
    void renameStructure(node, spec, title, original);
  };

  const onKeydown = (event) => {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      node.blur();
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      finish({ commit: false });
      node.blur();
    }
  };
  node.addEventListener('keydown', onKeydown);
  node.addEventListener('blur', () => finish({ commit: true }), { once: true });
}

/**
 * 造章之后自动补的那一页（票 36）：页名切到可编辑、占位文字整个选中，
 * 人可以直接打字覆盖，不用再点一次。
 */
function focusAutoPage(retype) {
  const auto = retype?.auto_page;
  if (!auto || snapshot?.readonly) return false;
  const divider = auto.key ? document.querySelector(`.page-divider[data-page-key="${auto.key}"]`) : null;
  const title = divider?.querySelector('.page-title');
  if (!title) return false;
  beginStructureEdit(title, { op: 'rename-page', chapter: auto.chapter, index: auto.index });
  return true;
}

async function renameStructure(node, spec, title, original) {
  await flushSaves();
  status('保存中');
  let receipt;
  try {
    receipt = await transport.structure({ ...spec, title, base_sha256: snapshot.sha256 });
  } catch (error) {
    if (node.isConnected) node.textContent = original;
    status(`改名失败 · ${error.message}`, true);
    return;
  }
  if (!receipt.ok) {
    if (node.isConnected) node.textContent = original;
    status(`改名失败 · ${receipt.error ?? receipt.status ?? '未知错误'}`, true);
    return;
  }
  if (!receipt.changed) {
    status('名字没变');
    return;
  }
  applySnapshot(receipt);
  status('已自动保存 · 已改名');
}

function textBlock(block) {
  const node = document.createElement('div');
  node.className = 'doc-block';
  node.setAttribute('data-anchor', block.anchor);
  node.dataset.type = block.type;
  if (block.type === 'heading') node.classList.add('is-heading');
  if (block.type === 'quote') node.classList.add('is-quote');
  if (block.type === 'list') node.classList.add('is-list');

  if (block.prefix) {
    const prefix = document.createElement('span');
    prefix.className = 'block-prefix';
    prefix.setAttribute('aria-hidden', 'true');
    prefix.textContent = block.prefix;
    node.append(prefix);
  }
  const content = document.createElement('div');
  content.className = 'block-text';
  content.contentEditable = 'true';
  content.spellcheck = false;
  content.dataset.inline = '1';
  content.innerHTML = renderInline(block.inline);
  node.append(content);
  node.addEventListener('click', (event) => {
    if (event.target.closest('[contenteditable="true"]')) return;
    if (node.classList.contains('is-locked')) return; // 模型正在改这一段：点了也不聚焦
    content.focus();
  });

  content.addEventListener('click', (event) => {
    if (event.target.closest('a')) event.preventDefault(); // 编辑时链接只显示，不跳走
  });
  node.__compose = () => {
    const markdown = DocInline.serializeInline(content);
    if (block.type === 'heading') return block.prefix + markdown.replace(/\n+/g, ' ');
    if (block.type === 'list') return block.prefix + markdown;
    if (block.type === 'quote') {
      return markdown.split('\n').map((line) => (line ? block.prefix + line : block.prefix.trimEnd())).join('\n');
    }
    return markdown;
  };
  return node;
}

function tableBlock(block) {
  const node = document.createElement('div');
  node.className = 'doc-block';
  node.setAttribute('data-anchor', block.anchor);
  node.dataset.type = 'table';
  const table = document.createElement('table');
  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  block.table.header.forEach((cell, column) => {
    const th = document.createElement('th');
    th.contentEditable = 'true';
    th.spellcheck = false;
    th.dataset.row = '0';
    th.dataset.column = String(column);
    th.innerHTML = renderInline(cell);
    headRow.append(th);
  });
  thead.append(headRow);
  const tbody = document.createElement('tbody');
  block.table.rows.forEach((row, index) => {
    const tr = document.createElement('tr');
    row.forEach((cell, column) => {
      const td = document.createElement('td');
      td.contentEditable = 'true';
      td.spellcheck = false;
      td.dataset.row = String(index + 1);
      td.dataset.column = String(column);
      td.innerHTML = renderInline(cell);
      tr.append(td);
    });
    tbody.append(tr);
  });
  table.append(thead, tbody);
  node.append(table);

  node.__compose = () => {
    const rows = [...table.querySelectorAll('tr')].map((tr) => [...tr.querySelectorAll('th,td')]
      .map((cell) => DocInline.serializeInline(cell, { table: true })));
    const line = (cells) => '| ' + cells.join(' | ') + ' |';
    return [line(rows[0]), block.table.delimiterRaw, ...rows.slice(1).map(line)].join('\n');
  };
  return node;
}

function codeBlock(block) {
  const node = document.createElement('div');
  node.className = 'doc-block';
  node.setAttribute('data-anchor', block.anchor);
  node.dataset.type = 'code';
  const lines = block.raw.split('\n');
  const close = lines.length > 1 ? lines[lines.length - 1] : '';
  const inner = lines.length > 1 ? lines.slice(1, -1).join('\n') : block.raw;
  const pre = document.createElement('pre');
  pre.className = 'block-code';
  const code = document.createElement('code');
  code.contentEditable = 'true';
  code.spellcheck = false;
  code.textContent = inner;
  pre.append(code);
  node.append(pre);
  node.__compose = () => {
    const opening = lines[0] ?? '```';
    const closing = /^\s*(`{3,}|~{3,})\s*$/.test(close) ? close : close.slice(0, 3);
    const innerNow = code.textContent.replace(/\n$/, '');
    return innerNow ? [opening, innerNow, closing].join('\n') : [opening, closing].join('\n');
  };
  return node;
}

function imageBlock(block) {
  const node = document.createElement('div');
  node.className = 'doc-block';
  node.setAttribute('data-anchor', block.anchor);
  node.dataset.type = 'image';
  const image = block.image ?? null;
  if (!image) {
    node.setAttribute('data-degraded', '1');
    const raw = document.createElement('pre');
    raw.className = 'block-raw';
    raw.textContent = block.raw;
    node.append(raw);
    return node;
  }
  // 清单里的指纹当缓存版本：模型换掉文件后重开工作台，地址跟着变，不会被旧内存缓存骗。
  // 侧栏里的图由桥递字节（不透明帧取不到 /asset），本地页直接走同源；由 transport 决定。
  const version = (snapshot.assets ?? []).find((asset) => asset.path === image.path)?.sha256 ?? null;
  node.append(DocImages.render(image, {
    version,
    // 本地页同源取图，保持同步地址；侧栏里才需要桥异步换 blob。
    ...(transport.mode === 'sidebar'
      ? { resolve: (path, stamp, attempt) => transport.imageUrl(path, attempt ? `${stamp ?? ''}-r${attempt}` : stamp) }
      : {}),
  }));
  return node;
}

function degradedBlock(block) {
  const node = document.createElement('div');
  node.className = 'doc-block is-degraded';
  node.setAttribute('data-anchor', block.anchor);
  node.dataset.type = block.type;
  node.setAttribute('data-degraded', '1');
  node.title = block.reason ?? '超出可编辑子集';
  const note = document.createElement('div');
  note.className = 'degraded-note';
  note.textContent = `原文显示 · ${block.reason ?? '超出可编辑子集'}`;
  const raw = document.createElement('pre');
  raw.className = 'block-raw';
  raw.textContent = block.raw;
  node.append(note, raw);
  return node;
}

/** 旧 JSON 主稿的块：只排版，不给编辑面、不给锚点、不给反馈按钮。 */
function readonlyBlock(block) {
  const node = document.createElement('div');
  node.className = 'doc-block is-readonly';
  node.dataset.type = block.type;
  node.setAttribute('data-readonly', '1');
  const body = document.createElement('div');
  body.className = 'block-text';
  body.innerHTML = renderInline(block.inline);
  node.append(body);
  if (block.legacy?.page_job) {
    const job = document.createElement('p');
    job.className = 'legacy-page-job';
    job.textContent = block.legacy.page_job;
    node.append(job);
  }
  if (block.legacy?.content_blocks?.length) {
    const list = document.createElement('ul');
    list.className = 'legacy-block-list';
    for (const item of block.legacy.content_blocks) {
      if (!item.title && !item.requirement) continue;
      const entry = document.createElement('li');
      entry.textContent = item.title || item.requirement;
      if (item.title && item.requirement) entry.title = item.requirement;
      list.append(entry);
    }
    if (list.children.length) node.append(list);
  }
  return node;
}

function renderBlock(block) {
  let node;
  if (block.readonly) node = readonlyBlock(block);
  else if (block.degraded) node = degradedBlock(block);
  else if (block.type === 'image') node = imageBlock(block);
  else if (block.type === 'table') node = tableBlock(block);
  else if (block.type === 'code') node = codeBlock(block);
  else node = textBlock(block);
  if (!block.readonly) attachBlockFeedback(node, block);
  if (block.anchor) blockByAnchor.set(block.anchor, { block, node });
  return node;
}

/** 块尾批注按钮：鼠标移到块上才露出来，点了直接在这块旁边落一条空草稿。 */
function attachBlockFeedback(node, block) {
  if (!block.anchor) return;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'block-feedback';
  button.setAttribute('data-feedback-block', block.anchor);
  button.title = '对这一块写批注';
  button.setAttribute('aria-label', '对这一块写批注');
  button.innerHTML = FEEDBACK_ICON;
  button.addEventListener('mousedown', (event) => event.preventDefault());
  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    startNoteDraft(block.anchor);
  });
  node.append(button);
}

/** 页标题右侧的批注气泡：和块尾那枚一样只在悬停时显形，点了直接落草稿进抽屉。 */
function attachPageFeedback(node, page) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'page-feedback';
  button.setAttribute('data-feedback-page', page.anchor ?? page.key ?? '');
  button.title = '对这一页写批注';
  button.setAttribute('aria-label', '对这一页写批注');
  button.innerHTML = FEEDBACK_ICON;
  button.addEventListener('mousedown', (event) => event.preventDefault());
  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    void startPageNoteDraft(page);
  });
  node.append(button);
}

/**
 * 点页气泡：页已经有锚点就直接开草稿；旧页没有就先按需补一个隐藏页锚点（只改标题行），
 * 再开草稿。页锚点一旦落盘，改名 / 移动都会跟着这一页走。
 */
async function startPageNoteDraft(page) {
  if (!snapshot || snapshot.readonly) return;
  if (page.anchor) {
    startNoteDraft(page.anchor);
    return;
  }
  await flushSaves();
  status('保存中', true);
  let receipt;
  try {
    receipt = await transport.structure({
      op: 'add-page-anchor',
      chapter: page.chapterIndex,
      index: page.index,
      base_sha256: snapshot.sha256,
    });
  } catch (error) {
    status(`批注入口打不开 · ${error.message}`, true);
    return;
  }
  if (!receipt.ok) {
    status(`批注入口打不开 · ${receipt.error ?? receipt.status ?? '未知错误'}`, true);
    return;
  }
  const anchor = receipt.page?.anchor ?? null;
  if (!anchor) {
    status('批注入口打不开 · 页锚点没有落盘', true);
    return;
  }
  applySnapshot(receipt);
  status('已自动保存');
  startNoteDraft(anchor);
}

function chaptersOf(snapshot) {
  if (Array.isArray(snapshot.chapters) && snapshot.chapters.length) return snapshot.chapters;
  // 旧快照 / 坏结构没有 chapters 字段时按页反推：章节名仍然从页视图来，不另造一份。
  const seen = new Map();
  for (const page of snapshot.pages ?? []) {
    if (!seen.has(page.chapterIndex)) {
      seen.set(page.chapterIndex, { index: page.chapterIndex, title: page.chapter, pages: 0 });
    }
  }
  return [...seen.values()];
}

/** 旧 JSON 主稿：只有页与块，不给结构编辑入口，也不画章节分隔。 */
function renderFlatBlocks(root) {
  let pageKey = null;
  for (const block of snapshot.blocks) {
    if (block.page.key !== pageKey) {
      pageKey = block.page.key;
      root.append(pageHeading(block.page));
    }
    root.append(renderBlock(block));
  }
}

/** 页外块的一段：它们不属于任何页，但仍在文档里，单独给一段位置（黄条要能跳到）。 */
function renderOrphanRun(root, blocks, cursor, chapterIndex) {
  if (cursor >= blocks.length) return cursor;
  const at = blocks[cursor];
  if (at.page?.key || (at.page?.chapterIndex ?? null) !== chapterIndex) return cursor;
  root.append(pageHeading({ orphan: true }, { orphan: true }));
  while (cursor < blocks.length && !blocks[cursor].page?.key
    && (blocks[cursor].page?.chapterIndex ?? null) === chapterIndex) {
    root.append(renderBlock(blocks[cursor]));
    cursor += 1;
  }
  return cursor;
}

/** 结构稿：章节 → 页 → 块。结构只由行首前缀产生，正文里没有加页 / 加章的按钮。 */
function renderStructuredBlocks(root) {
  const blocks = snapshot.blocks ?? [];
  const pages = snapshot.pages ?? [];
  let cursor = 0;
  // 第一个 # 之前的页外块（文档头之后）：它们不属于任何章。
  cursor = renderOrphanRun(root, blocks, cursor, null);
  for (const chapter of chaptersOf(snapshot)) {
    root.append(chapterHeading(chapter));
    // 章节标题下的页外块：先于本章的页出现。
    cursor = renderOrphanRun(root, blocks, cursor, chapter.index);
    for (const page of pages.filter((item) => item.chapterIndex === chapter.index)) {
      const empty = page.blocks === 0;
      root.append(pageHeading({ ...page, empty }, { editable: true }));
      const pageBlocks = [];
      while (cursor < blocks.length && blocks[cursor].page?.key === page.key) {
        pageBlocks.push(blocks[cursor]);
        cursor += 1;
      }
      // 空页没有块，也就没有出处区：只补一个渲染层的可写第一块。
      // 27 的写法会先渲染出处条再把第一块接在后面，空页的第一段会掉到出处下方。
      if (empty) root.append(pendingFirstBlock(page));
      else renderPageBlocks(root, page, pageBlocks);
    }
  }
  // 兜底：不吞块（章节结构坏了 / 页没有章节时，页外块仍然按原文显示）。
  if (cursor < blocks.length) {
    cursor = renderOrphanRun(root, blocks, cursor, blocks[cursor].page?.chapterIndex ?? null);
  }
  while (cursor < blocks.length) {
    root.append(renderBlock(blocks[cursor]));
    cursor += 1;
  }
}

/**
 * 一页的正文：照 `DocSources.layoutPage` 的摆法造节点。
 * 收起时出处只出一条 32px 的条；展开后每条引用与正文块同一种渲染（可编辑、可拖、
 * 可反馈），组尾一个「＋ 出处」。页中段的引用不在出处区里，照常按普通块摆。
 */
function renderPageBlocks(root, page, blocks) {
  const expanded = expandedSources.has(page.key);
  for (const entry of DocSources.layoutPage(blocks, { expanded })) {
    if (entry.kind === 'block') root.append(renderBlock(entry.block));
    else if (entry.kind === 'sources' || entry.kind === 'sources-head') root.append(sourcesBar(page, entry));
    else if (entry.kind === 'add-source') root.append(sourcesAddButton(page));
  }
}

/** 出处条：整条是一个按钮 —— 点击区是这一条，不是标签那几个字。 */
function sourcesBar(page, entry) {
  const button = document.createElement('button');
  button.type = 'button';
  // 收起的那条带 `.doc-sources`（上下留白大于段距）；展开的头只占组首，不撑开正文。
  button.classList.add('doc-sources-bar', entry.expanded ? 'doc-sources-head' : 'doc-sources');
  button.dataset.sources = page.key;
  button.dataset.expanded = entry.expanded ? 'true' : 'false';
  button.setAttribute('aria-expanded', entry.expanded ? 'true' : 'false');
  button.title = entry.expanded ? '收起出处' : `展开 ${entry.count} 条出处`;
  const marks = DocSources.marksOf(Boolean(entry.expanded));
  const lead = document.createElement('span');
  lead.className = 'doc-sources-mark';
  lead.textContent = marks.lead;
  lead.setAttribute('aria-hidden', 'true');
  const label = document.createElement('span');
  label.className = 'doc-sources-label';
  label.textContent = entry.label;
  const leftRule = document.createElement('span');
  leftRule.className = 'doc-sources-rule';
  const rightRule = document.createElement('span');
  rightRule.className = 'doc-sources-rule';
  const trail = document.createElement('span');
  trail.className = 'doc-sources-mark';
  trail.textContent = marks.trail;
  trail.setAttribute('aria-hidden', 'true');
  button.append(lead, leftRule, label, rightRule, trail);
  button.addEventListener('click', () => toggleSources(page.key));
  return button;
}

/** 组尾「＋ 出处」：走已有的 structure 命令，服务端把新引用接在页尾出处区后面。 */
function sourcesAddButton(page) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'doc-sources-add';
  button.dataset.addSource = page.key;
  button.title = '在页尾加一条出处';
  button.textContent = '＋ 出处';
  button.addEventListener('click', () => addSource(page));
  return button;
}

function toggleSources(pageKey) {
  if (expandedSources.has(pageKey)) expandedSources.delete(pageKey);
  else expandedSources.add(pageKey);
  renderAll();
}

/** 加一条出处：加完保持展开并选中占位文字，接着就能改成真正的那一条。 */
async function addSource(page) {
  if (snapshot?.readonly) return;
  await flushSaves();
  status('保存中', true);
  let receipt;
  try {
    receipt = await transport.structure({
      op: 'add-source',
      chapter: page.chapterIndex,
      index: page.index,
      base_sha256: snapshot.sha256,
    });
  } catch (error) {
    status(`加不了 · ${error.message}`, true);
    return;
  }
  if (!receipt.ok) {
    status(`加不了 · ${receipt.error ?? receipt.status ?? '未知错误'}`, true);
    return;
  }
  expandedSources.add(page.key);
  applySnapshot(receipt);
  status('已加一条出处 · 直接改就行');
  const anchor = receipt.source?.anchor;
  const editable = blockByAnchor.get(anchor)?.node?.querySelector('[contenteditable="true"]');
  if (editable) {
    editable.focus();
    selectContents(editable);
  }
}

function renderDocument() {
  const root = $('#blocks');
  const tools = $('#paperTools');
  blockByAnchor.clear();
  pageAnchorNodes.clear();
  root.replaceChildren();
  // 纸左上角的字号控件不属于正文快照：重画时原样留着，别把人刚调好的按钮删掉。
  if (tools) root.append(tools);
  if (snapshot.readonly) renderFlatBlocks(root);
  else renderStructuredBlocks(root);
  DocDrag.render(root, {
    snapshot: () => snapshot,
    apply: (next) => { snapshot = next; renderAll(); },
    flush: flushSaves,
    save: (node) => enqueueSave(node),
    reorder: (payload) => transport.reorder(payload),
    status,
  });
  $('#projectName').textContent = snapshot.project ?? '未命名项目';
  $('#docKind').textContent = snapshot.doc === 'by-page' ? '逐页文案' : '主线';
  document.title = `${snapshot.project ?? '文字工作台'} · ${snapshot.doc === 'by-page' ? '逐页文案' : '主线'}`;
  renderReadonlyState();
  renderStructureNotice();
}

const excerptOf = (value, size = 18) => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > size ? `${text.slice(0, size)}…` : text;
};

/** 同一块两边都改过时，把磁盘上那一版也说出来：停下来问人，但人要看得见两版。 */
const conflictHint = (receipt) => {
  const disk = receipt?.details?.disk_raw;
  return typeof disk === 'string' && disk ? ` · 磁盘上这一块是「${excerptOf(disk, 24)}」` : '';
};

/**
 * 结构问题只剩保存态旁一个没有文字的极小圆点（ADR 0006：只提示、不拦人）。
 *
 * 有问题才出现；点开才列两组可跳的条目：页外块跳到那一块，空页跳到那一页。
 * 正文里不再解释结构，也不在顶栏下面摆一条黄条——判断交给模型。
 */
function structureProblems() {
  const readonly = Boolean(snapshot?.readonly);
  const broken = snapshot?.errors ?? [];
  const orphans = readonly ? [] : (snapshot?.blocks ?? []).filter((block) => !block.page?.key);
  const emptyPages = readonly ? [] : (snapshot?.pages ?? []).filter((page) => page.blocks === 0);
  const others = broken.filter((error) => error.code !== 'block_outside_page' && error.code !== 'page_empty');
  return { readonly, orphans, emptyPages, others };
}

function renderStructureNotice() {
  const dot = $('#structureDot');
  const panel = $('#structurePanel');
  const list = $('#structureList');
  if (!dot || !panel || !list) return;
  const { readonly, orphans, emptyPages, others } = structureProblems();
  const any = !readonly && (orphans.length > 0 || emptyPages.length > 0 || others.length > 0);
  dot.hidden = !any;
  if (!any) {
    dot.setAttribute('aria-expanded', 'false');
    panel.hidden = true;
    list.replaceChildren();
    return;
  }
  list.replaceChildren();
  const group = (label, entries) => {
    if (!entries.length) return;
    const name = document.createElement('span');
    name.className = 'structure-group';
    name.textContent = label;
    list.append(name, ...entries);
  };
  group('不在任何页里', orphans.map((block) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'structure-jump';
    button.dataset.jumpAnchor = block.anchor;
    button.title = '跳到这一块';
    button.textContent = excerptOf(block.inline) || '空块';
    return button;
  }));
  group('空页', emptyPages.map((page) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'structure-jump';
    button.dataset.jumpPage = page.key;
    button.title = '跳到这一页';
    button.textContent = page.title || '未命名页';
    return button;
  }));
  if (others.length) {
    const extra = document.createElement('p');
    extra.className = 'structure-extra';
    extra.textContent = `另有 ${others.length} 处：${others.slice(0, 3).map((error) => error.message).join(' · ')}`;
    list.append(extra);
  }
}

/** 圆点的清单：点一下开、再点一下关；跳过去以后收起；点别处也收起。 */
function closeStructurePanel() {
  const dot = $('#structureDot');
  const panel = $('#structurePanel');
  if (!panel || panel.hidden) return;
  panel.hidden = true;
  dot?.setAttribute('aria-expanded', 'false');
}

function wireStructureNotice() {
  const dot = $('#structureDot');
  const panel = $('#structurePanel');
  if (!dot || !panel) return;
  dot.addEventListener('click', (event) => {
    event.stopPropagation();
    const open = panel.hidden;
    panel.hidden = !open;
    dot.setAttribute('aria-expanded', String(open));
  });
  panel.addEventListener('click', (event) => {
    const block = event.target.closest?.('[data-jump-anchor]');
    if (block) {
      closeStructurePanel();
      DocDrag.focusAnchor(block.dataset.jumpAnchor);
      return;
    }
    const page = event.target.closest?.('[data-jump-page]');
    if (page) {
      closeStructurePanel();
      DocDrag.scrollToPage(page.dataset.jumpPage);
    }
  });
  document.addEventListener('click', (event) => {
    if (event.target.closest?.('#structureDot') || event.target.closest?.('#structurePanel')) return;
    closeStructurePanel();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeStructurePanel();
  });
}

/**
 * 旧 JSON 主稿的只读状态：顶部一条能读懂的说明，反馈入口收起，正文没有编辑面。
 * 只读不是「先灰一下」——保存、派发、拖动都由服务端拒绝，界面只是把这件事说清楚。
 */
function renderReadonlyState() {
  const readonly = snapshot?.readonly ?? null;
  document.body.classList.toggle('is-readonly', Boolean(readonly));
  const notice = $('#readonlyNotice');
  if (!readonly) {
    notice.hidden = true;
    notice.textContent = '';
    return;
  }
  const legacy = snapshot.legacy ?? {};
  const contract = legacy.contract_version ? `当前文件：旧契约 ${legacy.contract_version}。` : '';
  notice.hidden = false;
  notice.textContent = `${readonly.message}${contract}`;
  $('#docKind').textContent = '旧项目 · 只读';
  document.title = `${snapshot.project ?? '旧 JSON 主稿'} · 只读`;
  // 只读主稿没有编辑面：结构提醒（页外块 / 空页）对它没有意义。
  const structure = $('#structureDot');
  if (structure) structure.hidden = true;
  closeStructurePanel();
  const whole = $('#notesOverallDoc');
  if (whole) whole.disabled = true;
  $('#selectionFeedback').hidden = true;
  $('#historyOpen').hidden = true;
  $('#historyPanel').hidden = true;
}

function currentEditable() {
  const selection = getSelection();
  if (!selection || !selection.rangeCount) return null;
  const node = selection.anchorNode?.nodeType === 3 ? selection.anchorNode.parentElement : selection.anchorNode;
  const editable = node?.closest?.('[contenteditable="true"]') ?? null;
  // 结构标题也是 contenteditable，但不是块：不给它弹块内格式工具条。
  if (editable?.closest?.('[data-structure-title]')) return null;
  return editable;
}

function positionToolbar() {
  const toolbar = $('#inlineToolbar');
  const selection = getSelection();
  const editable = currentEditable();
  if (!toolbar || !editable || !selection || !selection.rangeCount || selection.isCollapsed) {
    if (toolbar) toolbar.hidden = true;
    return;
  }
  const rect = selection.getRangeAt(0).getBoundingClientRect();
  toolbar.hidden = false;
  toolbar.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 200))}px`;
  toolbar.style.top = `${Math.max(8, rect.top + window.scrollY - 46)}px`;
}

function wrapCode() {
  const selection = getSelection();
  if (!selection || !selection.rangeCount || selection.isCollapsed) return;
  const range = selection.getRangeAt(0);
  const code = document.createElement('code');
  if (range.startContainer === range.endContainer) {
    code.append(range.extractContents());
    range.insertNode(code);
  } else {
    try {
      range.surroundContents(code);
    } catch {
      code.append(range.extractContents());
      range.insertNode(code);
    }
  }
  selection.removeAllRanges();
  const after = document.createRange();
  after.selectNodeContents(code);
  after.collapse(false);
  selection.addRange(after);
}

function applyInline(command) {
  const editable = currentEditable();
  if (!editable) return;
  editable.focus();
  if (command === 'bold') document.execCommand('bold');
  else if (command === 'italic') document.execCommand('italic');
  else if (command === 'code') wrapCode();
  else if (command === 'link') {
    const url = window.prompt('链接地址（相对路径或 http(s)）', 'https://');
    if (url) document.execCommand('createLink', false, url);
  }
  editable.dispatchEvent(new Event('input', { bubbles: true }));
}

function wireToolbar() {
  const toolbar = $('#inlineToolbar');
  toolbar.innerHTML = TOOLBAR_HTML;
  try { document.execCommand('styleWithCSS', false, false); } catch { /* 老浏览器不支持就算了 */ }
  toolbar.addEventListener('mousedown', (event) => event.preventDefault());
  toolbar.addEventListener('click', (event) => {
    const button = event.target.closest('[data-inline]');
    if (!button) return;
    event.preventDefault();
    applyInline(button.dataset.inline);
  });
  document.addEventListener('selectionchange', positionToolbar);
}

function wireEditable(node, block) {
  for (const editable of node.querySelectorAll('[contenteditable="true"]')) {
    // 输入法组字期间不排保存：前缀只在提交后才会被认成块类型，半截拼音不会被转换。
    // 用 compositionstart / compositionend 记状态，比只看 input 的 isComposing 稳：
    // 有些浏览器把提交后的那一次 input 仍标成组合中间态。
    const schedule = () => {
      node.__dirty = true;
      status('待保存');
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => enqueueSave(node), 600);
    };
    editable.addEventListener('compositionstart', () => { editable.__composing = true; });
    editable.addEventListener('compositionend', () => {
      editable.__composing = false;
      schedule();
    });
    editable.addEventListener('input', (event) => {
      if (event.isComposing || editable.__composing) {
        node.__dirty = true;
        return;
      }
      schedule();
    });
    editable.addEventListener('blur', () => {
      if (node.__dirty) enqueueSave(node);
    });
    editable.addEventListener('click', (event) => {
      if (event.target.closest('a')) event.preventDefault();
    });
    editable.addEventListener('paste', (event) => {
      event.preventDefault();
      const text = event.clipboardData?.getData('text/plain') ?? '';
      document.execCommand('insertText', false, text);
    });
    editable.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') { editable.blur(); return; }
      // 中文输入法选词时的 Enter / Backspace 属于 IME，不当作分块或合并。
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === 'Backspace' && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey) {
        const selection = getSelection();
        const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
        // 删空合并：块里已经没内容、光标又在块首，Backspace 并进前一块。
        // 还有内容时 Backspace 照常删字，不抢。
        if (range && selection.isCollapsed
          && editable.contains(range.startContainer)
          && caretAtBlockStart(editable, range)
          && isEmptyInline(inlineOf(editable))
          && isSplittable(block)) {
          event.preventDefault();
          mergeIntoPrevious(node, editable);
        }
        return;
      }
      if (event.key !== 'Enter') return;
      if (!isSplittable(block)) return; // 代码块回车换行、表格回车留在单元格，都走默认
      if (event.shiftKey) {
        // 块内换行交给浏览器插 <br>（Chromium 默认），序列化时写成 `\` + 换行；
        // 自己挪光标插 <br> 会把随后输入的文字插到换行前面。标题在契约里是一行，不换。
        if (block.type === 'heading') { event.preventDefault(); return; }
        // 兜底：即使浏览器没为这次按键发 input，也在默认行为之后再排一次保存。
        setTimeout(() => {
          if (!editable.isConnected) return;
          node.__dirty = true;
          status('待保存');
          clearTimeout(saveTimer);
          saveTimer = setTimeout(() => enqueueSave(node), 600);
        }, 0);
        return;
      }
      event.preventDefault();
      splitAtCaret(node, editable);
    });
  }
}

// ── 反馈：选区 / 整页 / 整份 → 抽屉里就地写，只把块身份与意见提交 ───────────────
function setFeedbackTargets(anchors) {
  feedbackTargets = [...new Set(anchors ?? [])];
  for (const node of blockNodes()) {
    node.classList.toggle('is-feedback-target', feedbackTargets.includes(node.dataset.anchor));
  }
}

/** 写反馈的地方就在抽屉里：收起时先打开它，窄档则把滑出层滑出来。 */
function ensureNotesOpen() {
  if (layout && !layout.notesOpen()) layout.toggle('notes');
}

/** 打开抽屉底部的反馈输入：不再有任何浮层，也没有「将改 N 块」这类说明。 */
function openComposer(anchors, { scope = 'blocks' } = {}) {
  if (!anchors.length) return;
  if (snapshot?.readonly) { status('只读 · 旧 JSON 主稿不能派发反馈', true); return; }
  const compose = $('#notesCompose');
  if (!compose) return;
  feedbackScope = scope;
  setFeedbackTargets(anchors);
  ensureNotesOpen();
  compose.hidden = false;
  const error = $('#notesComposeError');
  error.hidden = true;
  error.textContent = '';
  const text = $('#notesComposeText');
  text.value = '';
  text.focus();
}

function closeComposer() {
  const compose = $('#notesCompose');
  if (compose) compose.hidden = true;
  $('#selectionFeedback').hidden = true;
  feedbackScope = 'blocks';
  setFeedbackTargets([]);
}

const showFeedbackError = (message) => {
  const error = $('#notesComposeError');
  error.textContent = message;
  error.hidden = false;
};

async function submitFeedback() {
  const text = $('#notesComposeText').value.trim();
  if (snapshot?.readonly) { showFeedbackError(snapshot.readonly.message); return; }
  if (!text) { showFeedbackError('先写下要模型改什么。'); return; }
  if (!feedbackTargets.length) { showFeedbackError('没有选中的块；重新选一段再提交。'); return; }
  const payload = { scope: feedbackScope, text };
  if (feedbackScope === 'blocks') payload.anchors = [...feedbackTargets];
  await saveQueue; // 先把正在保存的块落盘，任务指纹才是人看到的版本
  const button = $('#notesComposeSubmit');
  button.disabled = true;
  try {
    const receipt = await transport.feedback(payload);
    if (!receipt.ok) {
      showFeedbackError(receipt.error ?? `提交失败 · ${receipt.status ?? '未知错误'}`);
      return;
    }
    closeComposer();
    await syncTasks();
    // 派发不等于保存，也不等于批准：回执只说「交给谁、原文没动」，页面不把它显示成保存或批准。
    const count = receipt.task.blocks.length;
    if (receipt.dispatch?.error) {
      status(`已建任务 · 派发失败（${receipt.dispatch.error}）· 原文未改`, true);
    } else if (receipt.dispatch?.channel === 'inbox') {
      status(`已派发 ${count} 块 · 已写入收件箱 · 原文未改，不算批准`);
    } else if (receipt.dispatch?.channel === 'wake') {
      status(`已派发 ${count} 块 · 已唤醒模型 · 原文未改，不算批准`);
    } else {
      status(`已派发 ${count} 块 · 原文未改，不算批准`);
    }
  } catch (error) {
    showFeedbackError(error.message);
  } finally {
    button.disabled = false;
  }
}

function wireComposer() {
  $('#notesComposeCancel').addEventListener('click', closeComposer);
  $('#notesComposeSubmit').addEventListener('click', () => { void submitFeedback(); });
  $('#notesComposeText').addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { event.preventDefault(); closeComposer(); }
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void submitFeedback(); }
  });
}

const inComposer = (node) => Boolean(node?.closest?.('#notesCompose'));

function scheduleSelectionTargets() {
  clearTimeout(selectionTimer);
  selectionTimer = setTimeout(updateSelectionTargets, 120);
}

function updateSelectionTargets() {
  if (!$('#notesCompose').hidden) return; // 写反馈时不跟着选区跑，目标已定
  const button = $('#selectionFeedback');
  if (!button) return;
  if (snapshot?.readonly) { button.hidden = true; setFeedbackTargets([]); return; }
  const selection = getSelection();
  if (!selection || !selection.rangeCount || selection.isCollapsed || inComposer(selection.anchorNode)) {
    button.hidden = true;
    setFeedbackTargets([]);
    return;
  }
  const anchors = DocFeedback.anchorsForRange(selection.getRangeAt(0), blockNodes());
  if (!anchors.length) {
    button.hidden = true;
    setFeedbackTargets([]);
    return;
  }
  setFeedbackTargets(anchors);
  const rect = selection.getRangeAt(0).getBoundingClientRect();
  button.hidden = false;
  button.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 76))}px`;
  button.style.top = `${rect.bottom + window.scrollY + 8}px`;
}

function wireSelectionFeedback() {
  const button = $('[data-feedback-selection]');
  button.addEventListener('mousedown', (event) => event.preventDefault());
  button.addEventListener('click', (event) => {
    event.preventDefault();
    if (!feedbackTargets.length) return;
    openComposer([...feedbackTargets], { scope: 'blocks' });
  });
  document.addEventListener('selectionchange', scheduleSelectionTargets);
}

// ── 整篇反馈（批注抽屉）：对整份稿子提一条意见，草稿就写在抽屉里 ─────────────
// 「按页」这个范围概念删掉了：人会在具体的位置批注，不必先选一页再说话。
/** 整篇反馈也落回抽屉里的同一个输入：不新开浮层，顶栏也不多一项。 */
function wireOverallFeedback() {
  const docButton = $('#notesOverallDoc');
  docButton?.addEventListener('click', () => {
    if (!snapshot) return;
    const anchors = snapshot.blocks.filter((block) => block.anchor).map((block) => block.anchor);
    if (!anchors.length) { status('这份稿还没有可反馈的块', true); return; }
    openComposer(anchors, { scope: 'doc' });
  });
  if (docButton) docButton.disabled = Boolean(snapshot?.readonly);
}

// ── 批注：草稿攒在右侧抽屉里，底部一次提交整批 ────────────────────────────────
//
// 批注与「直接派发」是两条路：写进抽屉的草稿不唤醒任何人，可以跨页跨天接着提；
// 底部「提交模型」把整批装成一条任务。排序规则在 doc-notes.js 里（Node 侧直接测
// 同一份），这里只负责把条目画出来、把动作接到同一条 route 词汇上。
//
// 抽屉里只有「被引用的那句话」：页名、章节名、页号在正文里已经有了，这里再写一遍
// 只是噪声。位置靠点一条跳回正文，不靠抽屉里的文字。
let notesState = [];
let notesLoaded = false;
let notesError = null;
// 点块尾气泡后先在这里攒一条空草稿：只在页面里，第一次失焦 / 提交时才落盘。
// 空的不留（服务端也不收空批注）；落盘后回到 notesState，和别的草稿一样可删可提交。
let pendingDraft = null;
let draftSave = Promise.resolve();
let renderingNotes = false;
// 模型看了任务却没动这一块：不进抽屉（那里只剩三样），在历史面板里如实标出来。
const NOTE_UNTOUCHED_TEXT = '模型没动这条';

const blockOrder = () => {
  // 批注可能是挂在块上的，也可能是挂在页标题上的（票 38）：页锚点排在它第一块之前。
  const order = new Map();
  const pageByKey = new Map((snapshot?.pages ?? []).map((page) => [page.key, page]));
  const seenPages = new Set();
  let position = 0;
  for (const block of snapshot?.blocks ?? []) {
    const key = block.page?.key ?? null;
    if (key && !seenPages.has(key)) {
      seenPages.add(key);
      const anchor = pageByKey.get(key)?.anchor;
      if (anchor) order.set(anchor, position);
      position += 1;
    }
    if (block.anchor) order.set(block.anchor, position);
    position += 1;
  }
  for (const page of snapshot?.pages ?? []) {
    if (page.anchor && !order.has(page.anchor)) order.set(page.anchor, position);
    position += 1;
  }
  return order;
};

/**
 * 这一处的那句话：抽屉里唯一用来认出「这条批注说的是哪儿」的东西。
 * 块取内联内容（不含 `- ` / `> ` 前缀），页取页标题；空白收成一行，没有字就留空。
 */
function blockQuote(anchor) {
  const block = snapshot?.blocks?.find((item) => item.anchor === anchor);
  const raw = block ? block.inline : (snapshot?.pages?.find((page) => page.anchor === anchor)?.title ?? '');
  return String(raw).replace(/\s+/g, ' ').trim();
}

const noteTime = (value) => (value ? new Date(value).toLocaleString() : '');

/**
 * 一条批注：它引用的那句话（一行，放不下就省略）、你写的那句话、时间与删除。
 * 页名 / 章节名 / 页号都不进来 —— 那句话自己就说清了位置。删除只给草稿：
 * 已提交的在模型手里。上半可点，点了跳回正文里那一块。
 */
function noteRow(note, state) {
  const item = document.createElement('li');
  item.className = 'note-row';
  const jump = document.createElement('button');
  jump.type = 'button';
  jump.className = 'note-jump';
  jump.dataset.anchor = note.anchor ?? '';
  jump.title = '跳到正文里的这一块';
  const quote = blockQuote(note.anchor);
  if (quote) {
    const line = document.createElement('span');
    line.className = 'note-quote';
    line.textContent = quote;
    jump.append(line);
  }
  const text = document.createElement('span');
  text.className = 'note-text';
  text.textContent = note.text;
  jump.append(text);
  jump.addEventListener('click', () => revealNoteTarget(note.anchor));
  const meta = document.createElement('div');
  meta.className = 'note-meta';
  const time = document.createElement('time');
  time.className = 'note-time';
  time.dateTime = note.created_at ?? '';
  time.textContent = noteTime(note.created_at);
  meta.append(time);
  if (state === 'draft') {
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'note-delete';
    remove.textContent = '删除';
    remove.dataset.noteId = note.id;
    remove.addEventListener('click', () => { void deleteNote(note.id, remove); });
    meta.append(remove);
  }
  item.append(jump, meta);
  return item;
}

/** 正在写的那一条：抽屉里就地一个输入框，光标进来就能打字；上面同样挂着那句话。 */
function draftRow() {
  const item = document.createElement('li');
  item.className = 'note-row note-draft';
  // 这一行只代表它创建时的那条草稿：重画后别去动后来新开的那一条。
  const draft = pendingDraft;
  const quote = blockQuote(draft?.anchor);
  if (quote) {
    const line = document.createElement('span');
    line.className = 'note-quote';
    line.textContent = quote;
    item.append(line);
  }
  const textarea = document.createElement('textarea');
  textarea.className = 'note-draft-text';
  textarea.rows = 2;
  textarea.placeholder = '写批注…';
  textarea.value = draft?.text ?? '';
  textarea.addEventListener('input', () => {
    if (draft) draft.text = textarea.value;
  });
  textarea.addEventListener('blur', () => {
    // 重画抽屉时这个输入框会被换掉，那不是人在离开草稿：别把还没写完的字当成空稿丢掉。
    if (renderingNotes || !textarea.isConnected) return;
    if (pendingDraft === draft) void saveDraft(draft);
  });
  textarea.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { textarea.blur(); return; }
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      if (pendingDraft === draft) void saveDraft(draft);
      return;
    }
    event.stopPropagation();
  });
  const meta = document.createElement('div');
  meta.className = 'note-meta';
  const time = document.createElement('time');
  time.className = 'note-time';
  time.textContent = noteTime(new Date().toISOString());
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'note-delete';
  remove.textContent = '删除';
  remove.addEventListener('click', () => {
    pendingDraft = null;
    renderNotes();
  });
  meta.append(time, remove);
  item.append(textarea, meta);
  return item;
}

/**
 * 抽屉里的单子：草稿与已提交并成一条线，顺序跟正文走；正在写的那条也占它的位置。
 * 每条自带它引用的那句话，所以这里不再有页分组、也不再有块预览与计数气泡。
 */
function drawerEntries(drawer) {
  const order = blockOrder();
  const rows = [];
  for (const state of ['draft', 'committed']) {
    for (const note of drawer[state].notes) rows.push({ kind: 'note', state, note });
  }
  if (pendingDraft) rows.push({ kind: 'draft', anchor: pendingDraft.anchor });
  const position = (row) => order.get(row.anchor ?? row.note.anchor) ?? Number.MAX_SAFE_INTEGER;
  const createdAt = (row) => (row.kind === 'draft' ? '\uffff' : String(row.note.created_at ?? ''));
  return rows.sort((left, right) => (position(left) - position(right))
    || createdAt(left).localeCompare(createdAt(right)));
}

/** 点一条批注：正文滚到那一块、光标放进可编辑块、短暂高亮；抽屉保持打开。 */
let noteFlashTimer = 0;

function flashBlock(node) {
  if (!node) return;
  node.classList.remove('is-note-flash');
  void node.offsetWidth; // 重新触发同一条动画
  node.classList.add('is-note-flash');
  clearTimeout(noteFlashTimer);
  noteFlashTimer = setTimeout(() => node.classList.remove('is-note-flash'), 1200);
}

function revealNoteTarget(anchor) {
  if (!anchor) return;
  const block = blockByAnchor.get(anchor)?.node ?? null;
  const page = block ? null : pageAnchorNodes.get(anchor) ?? null;
  const node = block ?? page;
  if (!node) { status('这块已经不在正文里了', true); return; }
  ensureNotesOpen();
  // 定位与聚焦复用拖拽模块那套（结构清单的跳转走同一条路）；再让这一处落到顶栏下面。
  if (block) DocDrag.focusAnchor(anchor);
  const bar = document.querySelector('.topbar');
  const offset = (bar?.getBoundingClientRect().height ?? 0) + 24;
  const top = node.getBoundingClientRect().top + window.scrollY - offset;
  window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  if (block) focusBlock(anchor); // 可编辑块把光标放到块首；页锚点只滚过去并高亮
  flashBlock(node);
}

function draftCount() {
  const saved = notesState.filter((note) => note.state === 'draft').length;
  return saved + (pendingDraft && pendingDraft.text.trim() ? 1 : 0);
}

function renderNotes() {
  const list = $('#notesList');
  if (!list) return;
  const hint = $('#notesHint');
  const notesSubmit = $('#notesSubmit');
  const drawer = DocNotes.drawer(notesState, { order: blockOrder() });
  // 正在写草稿时重画（别的批注存上了）：把光标还回同一条草稿的同一个位置。
  const focused = document.activeElement;
  const wasEditing = Boolean(focused?.classList?.contains('note-draft-text'));
  const caret = wasEditing ? focused.selectionStart : null;
  renderingNotes = true;
  list.replaceChildren();
  renderingNotes = false;
  if (notesError) {
    const failed = document.createElement('p');
    failed.className = 'notes-empty is-error';
    failed.textContent = `读不到批注 · ${notesError}`;
    list.append(failed);
  } else if (!notesLoaded) {
    const loading = document.createElement('p');
    loading.className = 'notes-empty';
    loading.textContent = '正在读取批注…';
    list.append(loading);
  } else if (!drawer.draft.count && !drawer.committed.count && !pendingDraft) {
    const empty = document.createElement('p');
    empty.className = 'notes-empty';
    empty.textContent = '还没有批注。';
    list.append(empty);
  } else {
    const rows = document.createElement('ul');
    rows.className = 'note-list';
    for (const row of drawerEntries(drawer)) {
      rows.append(row.kind === 'draft' ? draftRow() : noteRow(row.note, row.state));
    }
    list.append(rows);
  }

  if (wasEditing && pendingDraft) {
    const next = list.querySelector('.note-draft textarea');
    if (next) {
      next.focus();
      try { next.setSelectionRange(caret ?? next.value.length, caret ?? next.value.length); } catch { /* 光标还不了就只聚焦 */ }
    }
  }

  const readonly = Boolean(snapshot?.readonly);
  const drafts = draftCount();
  notesSubmit.disabled = readonly || Boolean(notesError) || drafts === 0;
  notesSubmit.textContent = `提交模型 · ${drafts}`;
  if (hint) {
    hint.hidden = !readonly;
    hint.textContent = readonly ? '只读 · 旧 JSON 主稿不能提批注' : '';
  }
  renderHistoryNotes();
}

async function loadNotes() {
  try {
    const receipt = await transport.notes();
    if (receipt.ok) {
      notesState = receipt.notes ?? [];
      notesError = null;
    } else {
      // 坏文件不能显示成「还没有批注」：那会让人以为草稿丢了，还会用空草稿覆盖它。
      notesError = receipt.error ?? `读不到批注（${receipt.status ?? '未知错误'}）`;
    }
  } catch (error) {
    notesError = error.message;
  }
  notesLoaded = true;
  renderNotes();
}

/** 点块尾气泡：当场落一条空草稿进抽屉，光标进去；正文上一个字都不弹。 */
function startNoteDraft(anchor) {
  if (!snapshot || snapshot.readonly || !anchor) return;
  if (pendingDraft?.anchor === anchor) {
    // 同一块再点一次：把光标送回那条草稿，别把已经写了一半的字清掉。
    ensureNotesOpen();
    renderNotes();
    $('#notesList .note-draft textarea')?.focus();
    return;
  }
  if (pendingDraft) void saveDraft(pendingDraft);
  pendingDraft = { anchor, text: '' };
  ensureNotesOpen();
  renderNotes();
  $('#notesList .note-draft textarea')?.focus();
}

/** 把一条草稿落盘：空的就丢掉，有字才发 addNote；串行执行，不重复建条。 */
function saveDraft(draft) {
  draftSave = draftSave.then(async () => {
    if (!draft || draft.saved) return true;
    const text = String(draft.text ?? '').trim();
    if (!text) {
      if (pendingDraft === draft) pendingDraft = null;
      renderNotes();
      return true;
    }
    await saveQueue; // 批注目标要指向人看到的版本
    let receipt;
    try {
      receipt = await transport.addNote({ anchors: [draft.anchor], text });
    } catch (error) {
      status(`批注没存上 · ${error.message}`, true);
      return false;
    }
    if (!receipt.ok) {
      status(`批注没存上 · ${receipt.error ?? receipt.status ?? '未知错误'}`, true);
      return false;
    }
    draft.saved = true;
    notesState = receipt.notes ?? notesState;
    notesLoaded = true;
    if (pendingDraft === draft) pendingDraft = null;
    renderNotes();
    return true;
  }).catch(() => false);
  return draftSave;
}

function flushPendingDraft() {
  return saveDraft(pendingDraft);
}

async function deleteNote(id, button) {
  if (button) button.disabled = true;
  try {
    const receipt = await transport.deleteNote({ id });
    if (!receipt.ok) {
      status(`删除失败 · ${receipt.error ?? receipt.status ?? '未知错误'}`, true);
      if (button) button.disabled = false;
      return;
    }
    notesState = receipt.notes ?? [];
    renderNotes();
    status('已删除这条批注');
  } catch (error) {
    status(`删除失败 · ${error.message}`, true);
    if (button) button.disabled = false;
  }
}

/** 底部一次提交整批：所有草稿进同一批、同一份任务；正在写的那条先落盘。 */
async function submitNotes() {
  if (snapshot?.readonly) { status('只读 · 旧 JSON 主稿不能提批注', true); return; }
  await flushPendingDraft();
  const drawer = DocNotes.drawer(notesState, { order: blockOrder() });
  if (!drawer.draft.count) { status('没有草稿可提交', true); return; }
  await flushSaves();
  const button = $('#notesSubmit');
  button.disabled = true;
  try {
    const receipt = await transport.submitNotes({});
    if (!receipt.ok) {
      status(`提交失败 · ${receipt.error ?? receipt.status ?? '未知错误'}`, true);
      return;
    }
    notesState = receipt.notes ?? [];
    const count = (receipt.committed ?? []).length;
    const dispatch = receipt.dispatch ?? {};
    if (dispatch.error) status(`已提交 ${count} 条批注 · 派发失败（${dispatch.error}）· 原文未改`, true);
    else if (dispatch.channel === 'inbox') status(`已提交 ${count} 条批注 · 已写入收件箱 · 原文未改，不算批准`);
    else if (dispatch.channel === 'wake') status(`已提交 ${count} 条批注 · 已唤醒模型 · 原文未改，不算批准`);
    else status(`已提交 ${count} 条批注 · 原文未改，不算批准`);
    if ((receipt.orphaned ?? []).length) {
      status(`已提交 ${count} 条 · ${receipt.orphaned.length} 条的目标块已被删，留在草稿里`, true);
    }
  } catch (error) {
    status(`提交失败 · ${error.message}`, true);
  } finally {
    renderNotes();
  }
}

function wireNotes() {
  // 折叠键在顶栏，状态与窄档滑出层都归 DocLayout；这里只接整批提交。
  $('#notesSubmit').addEventListener('click', () => { void submitNotes(); });
}

// ── 历史：每次写盘前存上一版；恢复当一次新编辑保存，旧记录不删 ────────────────
const OPERATION_LABELS = {
  block: '人改块',
  split: '回车分块',
  merge: '删空合并',
  reorder: '重排',
  structure: '改结构',
  patch: '模型写回',
  conflict: '裁决待核对',
  repair: '补锚点',
  restore: '恢复旧版',
  recover: '崩溃恢复',
};

// ── 历史批注：模型改到的自动归档；与版本历史同一个面板的两个页签，默认停在批注 ──

/** 历史条目只有人当初那句话与时间；快照是给模型回查的，页名 / 页号也不再重复。 */
function historyNoteRow(note) {
  const item = document.createElement('li');
  item.className = 'history-note-item';
  const text = document.createElement('p');
  text.className = 'history-note-text';
  text.textContent = note.text;
  const meta = document.createElement('div');
  meta.className = 'history-note-meta';
  const time = document.createElement('time');
  time.className = 'history-note-time';
  time.dateTime = note.created_at ?? '';
  time.textContent = noteTime(note.created_at);
  meta.append(time);
  if (note.model_state === 'untouched') {
    const badge = document.createElement('span');
    badge.className = 'history-note-badge';
    badge.textContent = NOTE_UNTOUCHED_TEXT;
    meta.append(badge);
  }
  const reopen = document.createElement('button');
  reopen.type = 'button';
  reopen.className = 'history-reopen';
  reopen.textContent = '重新打开';
  reopen.addEventListener('click', () => { void reopenNote(note.id, reopen); });
  item.append(text, meta, reopen);
  return item;
}

function renderHistoryNotes() {
  const list = $('#historyNotesList');
  if (!list) return;
  const note = $('#historyNotesNote');
  list.replaceChildren();
  const items = DocNotes.history(notesState);
  if (note) {
    note.textContent = items.length
      ? `共 ${items.length} 条 · 新的在前；模型改到的与没动的那条都在这里。`
      : '还没有历史批注：模型改到的批注会自动归档到这里。';
  }
  for (const item of items) list.append(historyNoteRow(item));
}

/** 重新打开：归档错了或模型没动，这条退回草稿，回到右侧继续提。 */
async function reopenNote(id, button) {
  if (button) button.disabled = true;
  try {
    const receipt = await transport.reopenNote({ id });
    if (!receipt.ok) {
      status(`重新打开失败 · ${receipt.error ?? receipt.status ?? '未知错误'}`, true);
      if (button) button.disabled = false;
      return;
    }
    notesState = receipt.notes ?? notesState;
    notesLoaded = true;
    renderNotes();
    renderHistoryNotes();
    status('已重新打开 · 这条回到草稿，可再提交给模型');
  } catch (error) {
    status(`重新打开失败 · ${error.message}`, true);
    if (button) button.disabled = false;
  }
}

/** 打开面板默认停在批注页签，版本历史还在旁边，不丢入口。 */
function setHistoryTab(tab) {
  const notesPanel = $('#historyNotesPanel');
  const versionsPanel = $('#historyVersionsPanel');
  const showNotes = tab !== 'versions';
  for (const button of $$('#historyTabs [data-history-tab]')) {
    const active = button.dataset.historyTab === (showNotes ? 'notes' : 'versions');
    button.setAttribute('aria-selected', String(active));
    button.classList.toggle('is-active', active);
  }
  if (notesPanel) notesPanel.hidden = !showNotes;
  if (versionsPanel) versionsPanel.hidden = showNotes;
}

function historyItem(version) {
  const item = document.createElement('li');
  item.className = 'history-item';
  const head = document.createElement('div');
  head.className = 'history-meta';
  const time = document.createElement('span');
  time.textContent = new Date(version.archived_at).toLocaleString();
  const label = document.createElement('span');
  label.textContent = OPERATION_LABELS[version.operation] ?? version.operation;
  const size = document.createElement('span');
  size.textContent = `${Math.max(1, Math.round(version.bytes / 1024))} KB`;
  head.append(time, label, size);
  const preview = document.createElement('p');
  preview.className = 'history-preview';
  preview.textContent = version.preview || '（空内容）';
  const restore = document.createElement('button');
  restore.type = 'button';
  restore.className = 'history-restore';
  restore.textContent = '恢复这一版';
  restore.addEventListener('click', () => { void restoreHistory(version.id, restore); });
  item.append(head, preview, restore);
  return item;
}

async function loadHistory() {
  const list = $('#historyList');
  const note = $('#historyNote');
  list.replaceChildren();
  note.textContent = '正在读取历史…';
  let receipt;
  try {
    receipt = await transport.history();
  } catch (error) {
    note.textContent = `读不到历史：${error.message}`;
    return;
  }
  if (!receipt.ok) {
    note.textContent = `读不到历史：${receipt.error ?? receipt.status ?? '未知错误'}`;
    return;
  }
  const versions = receipt.versions ?? [];
  if (!versions.length) {
    note.textContent = '还没有历史版本：第一次保存后，上一版会出现在这里。';
    return;
  }
  note.textContent = `共 ${versions.length} 版 · 新的在前；恢复会作为一次新编辑保存，旧版本不删。`;
  if (receipt.errors?.length) note.textContent += ` · ${receipt.errors.length} 个条目读不出来`;
  for (const version of versions) list.append(historyItem(version));
}

async function openHistory() {
  if (snapshot?.readonly) { status('只读 · 旧 JSON 主稿没有历史可恢复', true); return; }
  $('#historyPanel').hidden = false;
  setHistoryTab('notes');
  if (notesLoaded) renderHistoryNotes();
  else await loadNotes();
  await loadHistory();
}

async function restoreHistory(id, button) {
  button.disabled = true;
  await flushSaves();
  try {
    const receipt = await transport.restore({ id, base_sha256: snapshot.sha256 });
    if (!receipt.ok) {
      status(`恢复失败 · ${receipt.error ?? receipt.status ?? '未知错误'}`, true);
      button.disabled = false;
      return;
    }
    applySnapshot(receipt);
    $('#historyPanel').hidden = true;
    status(receipt.changed ? '已恢复旧版 · 这是一次新的编辑，旧版本仍在历史里' : '这一版与当前内容相同');
  } catch (error) {
    status(`恢复失败 · ${error.message}`, true);
    button.disabled = false;
  }
}

function wireHistory() {
  $('#historyOpen').addEventListener('click', () => { void openHistory(); });
  $('#historyClose').addEventListener('click', () => { $('#historyPanel').hidden = true; });
  for (const button of $$('#historyTabs [data-history-tab]')) {
    button.addEventListener('click', () => setHistoryTab(button.dataset.historyTab));
  }
}

// ── 锁与待核对：处理中的块不可编辑；待核对块继续锁着，等人裁决 ────────────────
const LOCKED_TASK_STATES = new Set(['processing', 'review']);

function processingLocks(tasks) {
  const locks = new Map();
  for (const task of tasks ?? []) {
    if (!LOCKED_TASK_STATES.has(task.status)) continue;
    const anchors = Array.isArray(task.locked_blocks)
      ? task.locked_blocks
      : (task.blocks ?? []).map((block) => block.anchor);
    for (const anchor of anchors) locks.set(anchor, task.id);
  }
  return locks;
}

function lockBlock(node, owner) {
  node.classList.add('is-locked');
  node.dataset.lockedBy = owner;
  for (const editable of node.querySelectorAll('[contenteditable="true"]')) {
    if (editable === document.activeElement) editable.blur();
    editable.contentEditable = 'false';
  }
  if (!node.querySelector('.block-lock')) {
    const note = document.createElement('div');
    note.className = 'block-lock';
    note.textContent = '模型正在改这一段';
    node.append(note);
  }
}

function unlockBlock(node) {
  if (!node.classList.contains('is-locked')) return;
  node.classList.remove('is-locked');
  delete node.dataset.lockedBy;
  for (const editable of node.querySelectorAll('[contenteditable="false"]')) editable.contentEditable = 'true';
  node.querySelector('.block-lock')?.remove();
}

function applyLocks(locks) {
  lockedAnchors = new Set(locks.keys());
  for (const node of blockNodes()) {
    const owner = locks.get(node.dataset.anchor);
    if (owner) lockBlock(node, owner);
    // 待核对块由 syncConflicts 管：这里只解任务锁，别把它顺手解锁。
    else if (node.dataset.lockedReason !== 'conflict') unlockBlock(node);
  }
  // 锁定 / 解锁都改变「能不能拖」：只重算句柄，不重画正文。
  DocDrag.refresh();
}

async function syncTasks() {
  try {
    const receipt = await transport.tasks();
    if (receipt.ok) applyLocks(processingLocks(receipt.tasks));
  } catch {
    // 锁同步失败不打断编辑：保存时服务端仍会按锁拒绝。
  }
  await syncConflicts();
}

const DECISION_LABELS = { mine: '保留我的', model: '用模型版', discard: '放弃该块' };
/** 人与人的两版只有两个出口：磁盘上先落盘的那一版，或后保存那个标签页的版本。 */
const HUMAN_DECISION_LABELS = { mine: '保留磁盘版', theirs: '用我这一版' };

/** 出口由记录来源决定；动作名仍走同一条 transport.decide，不另造一套裁决。 */
function deferredActions(conflict, minePending) {
  if (conflict.source === 'human') {
    return ['mine', 'theirs'].map((decision) => ({
      decision,
      label: decision === 'theirs' && !minePending ? '用另一版' : HUMAN_DECISION_LABELS[decision],
    }));
  }
  return ['mine', 'model', 'discard'].map((decision) => ({ decision, label: DECISION_LABELS[decision] }));
}

function versionPane(side) {
  const pane = document.createElement('div');
  pane.className = 'deferred-version';
  pane.dataset.side = side;
  const label = document.createElement('span');
  label.className = 'deferred-version-label';
  const body = document.createElement('pre');
  pane.append(label, body);
  return pane;
}

/**
 * 待核对块：同一个面板，两版并排 + 出口；裁决后重新载入，磁盘上只留一个版本。
 * 模型 vs 人与人 vs 人共用这套 DOM 与交互，只有文案、来源和出口不同。
 */
function renderDeferred(node, conflict) {
  node.classList.add('is-deferred');
  let panel = node.querySelector('.block-deferred');
  if (!panel) {
    panel = document.createElement('div');
    panel.className = 'block-deferred';
    const note = document.createElement('p');
    note.className = 'deferred-note';
    const versions = document.createElement('div');
    versions.className = 'deferred-versions';
    versions.append(versionPane('disk'), versionPane('other'));
    const actions = document.createElement('div');
    actions.className = 'deferred-actions';
    panel.append(note, versions, actions);
    node.append(panel);
  }
  const human = conflict.source === 'human';
  panel.dataset.source = human ? 'human' : 'model';
  panel.querySelector('.deferred-note').textContent = human
    ? '待核对 · 另一个标签页也改了这一段；选一版落盘'
    : '待核对 · 你改过这一段之后，模型也改了它';
  // 后保存的一方在自己的标签页里看到的是「我这一版」；别的标签页看到的是「另一版」。
  const minePending = human && typeof node.__compose === 'function' && node.__compose() === conflict.your_content;
  const panes = panel.querySelectorAll('.deferred-version');
  panes[0].querySelector('.deferred-version-label').textContent = '磁盘版';
  panes[0].querySelector('pre').textContent = conflict.disk_raw ?? '';
  panes[1].querySelector('.deferred-version-label').textContent = human
    ? (minePending ? '我这一版' : '另一版')
    : '模型版';
  panes[1].querySelector('pre').textContent = human ? (conflict.your_content ?? '') : (conflict.model_content ?? '');
  // 出口只在来源 / 身份变化时重画，轮询不会把正按下的按钮换掉。
  const signature = `${human ? 'human' : 'model'}:${conflict.anchor}:${minePending ? 'mine' : 'other'}`;
  if (panel.dataset.signature !== signature) {
    panel.dataset.signature = signature;
    const actions = panel.querySelector('.deferred-actions');
    actions.replaceChildren();
    for (const { decision, label } of deferredActions(conflict, minePending)) {
      const button = document.createElement('button');
      button.type = 'button';
      button.setAttribute('data-decision', decision);
      button.textContent = label;
      button.addEventListener('click', () => { void decideConflict(node.dataset.anchor, decision); });
      actions.append(button);
    }
  }
}

function clearDeferred(node) {
  if (!node.classList.contains('is-deferred')) return;
  node.classList.remove('is-deferred');
  node.querySelector('.block-deferred')?.remove();
  unlockDeferredBlock(node);
}

/** 待核对的块也不可编辑：两版没选之前再存一次只会重演同一次撞车。 */
function lockDeferredBlock(node) {
  node.dataset.lockedReason = 'conflict';
  for (const editable of node.querySelectorAll('[contenteditable="true"]')) {
    if (editable === document.activeElement) editable.blur();
    editable.contentEditable = 'false';
  }
}

function unlockDeferredBlock(node) {
  if (node.dataset.lockedReason !== 'conflict') return;
  delete node.dataset.lockedReason;
  if (node.classList.contains('is-locked')) return; // 还有任务锁：由 applyLocks 解
  for (const editable of node.querySelectorAll('[contenteditable="false"]')) editable.contentEditable = 'true';
}

/**
 * 别处改过 / 裁决过：没有本地未保存的编辑时重新载入，两个标签页看到同一份结果。
 * 正在打字、或还有没落盘的块时不抢：下一次轮询再说。
 */
async function adoptDisk() {
  if (!snapshot || snapshot.readonly || savesInFlight) return;
  // 只看有没有没落盘的编辑：光标停在块里不算——不然人一走神，另一个标签页的裁决就永远到不了。
  if (blockNodes().some((node) => node.__dirty)) return;
  // 空页的待定第一块还没有锚点：正在里面写的字不能被一次重画抹掉。
  if ($$('[data-pending-anchor]').some((node) => !isEmptyInline(inlineOf(node.querySelector('[contenteditable="true"]') ?? node)))) return;
  let doc;
  try {
    doc = await transport.open();
  } catch {
    return;
  }
  if (!doc.ok || doc.sha256 === snapshot.sha256) return;
  applySnapshot(doc);
  status('已同步别处的改动');
}

async function syncConflicts() {
  try {
    const receipt = await transport.conflicts();
    if (!receipt.ok) return;
    const list = receipt.conflicts ?? [];
    const byAnchor = new Map(list.map((conflict) => [conflict.anchor, conflict]));
    // 上一轮还挂着、这一轮没了：另一边已经裁决过了。
    const settled = [...deferredRecords.keys()].some((anchor) => !byAnchor.has(anchor));
    for (const node of blockNodes()) {
      const conflict = byAnchor.get(node.dataset.anchor);
      if (conflict) {
        renderDeferred(node, conflict);
        lockDeferredBlock(node);
      } else {
        clearDeferred(node);
      }
    }
    deferredRecords = byAnchor;
    DocDrag.refresh();
    // 两版没选之前不覆盖人眼前的正文；选完之后（或模型写回之后）按指纹对齐。
    const changed = typeof receipt.sha256 === 'string' && snapshot?.sha256 && receipt.sha256 !== snapshot.sha256;
    if (!list.length && (settled || changed)) await adoptDisk();
  } catch {
    // 待核对同步失败不打断编辑：保存路径仍会拒绝锁定块。
  }
}

async function decideConflict(anchor, decision) {
  const node = blockByAnchor.get(anchor)?.node;
  node?.querySelectorAll('.deferred-actions button').forEach((button) => { button.disabled = true; });
  try {
    const receipt = await transport.decide({ anchor, decision });
    if (!receipt.ok) {
      status(`裁决失败 · ${receipt.error ?? receipt.status ?? '未知错误'}`, true);
      node?.querySelectorAll('.deferred-actions button').forEach((button) => { button.disabled = false; });
      return;
    }
    status('已裁决 · 重新载入文档');
    window.location.reload();
  } catch (error) {
    status(`裁决失败 · ${error.message}`, true);
    node?.querySelectorAll('.deferred-actions button').forEach((button) => { button.disabled = false; });
  }
}

function pollTasks() {
  clearInterval(taskTimer);
  taskTimer = setInterval(syncTasks, 3000);
}

// ── 行首前缀 → 块类型（票 30） ─────────────────────────────────────────────
//
// 类型转换在保存路径上发生（服务端按 `## ` / `### ` / `- ` / `> ` / 围栏 / `|` 判定）。
// 页面只做两件事：输入法组字期间不排保存；回执说类型变了，就把前缀从正文里隐去、
// 把排版换成新块的排版。`## ` / `# ` 会让这一块变成页 / 章节，页面按回执快照重画。

/** 刚敲了前缀、还没写内容：先不落盘，等标题出来一次转换（否则会先转义成字面量）。 */
const PREFIX_ONLY_RE = /^(?:#{1,6}|[-*+]|\d+[.)]|>|`{1,2}|~{1,2})[ \t]*$/;
const isPrefixOnly = (content) => PREFIX_ONLY_RE.test(String(content ?? ''));
/** 待定块什么时候才算「有内容」：不是空白，也不是半截前缀。 */
const pendingReady = (content) => !isEmptyInline(content) && !isPrefixOnly(content);
/** 行首前缀：与 doc-blocks 的判定同一组形状（页面只用来移除刚敲进去的那几个字符）。 */
const TYPED_PREFIX = (content) => {
  const match = content.match(/^(#{1,6}[ \t]+|[-*+][ \t]+|\d+[.)][ \t]+|>[ \t]+)/);
  return match ? match[1] : '';
};

/** 把编辑面开头 length 个字符删掉（前缀刚敲进去时就是普通文本）。 */
function removeLeadingText(editable, length) {
  if (length <= 0) return;
  const walker = document.createTreeWalker(editable, NodeFilter.SHOW_TEXT);
  let remaining = length;
  while (remaining > 0) {
    const node = walker.nextNode();
    if (!node) break;
    const text = node.nodeValue ?? '';
    if (text.length <= remaining) {
      remaining -= text.length;
      node.nodeValue = '';
    } else {
      node.nodeValue = text.slice(remaining);
      remaining = 0;
    }
  }
}

function placeCaretAtEnd(editable) {
  editable.focus({ preventScroll: true });
  const range = document.createRange();
  range.selectNodeContents(editable);
  range.collapse(false);
  const selection = getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}

/**
 * 类型变了但不是结构：就地换排版，不重画整份文档（重画会把光标和正在敲的字弄丢）。
 * `retype.literal` 是「标题删空退回段落」——前缀从只读 span 回到正文里。
 */
function patchRetypedBlock(node, entry, next, retype) {
  const editable = node.querySelector('[contenteditable="true"]');
  if (!editable) return false;
  if (retype.literal) {
    // 标题删空：编辑面里只剩浏览器留下的换行，清掉后把前缀作为正文写回去。
    node.querySelector('.block-prefix')?.remove();
    editable.replaceChildren(document.createTextNode(retype.literal));
  } else {
    const typedPrefix = retype.prefix || TYPED_PREFIX(editable.textContent ?? '');
    removeLeadingText(editable, typedPrefix.length);
    node.querySelector('.block-prefix')?.remove();
    if (next.prefix) {
      const prefix = document.createElement('span');
      prefix.className = 'block-prefix';
      prefix.setAttribute('aria-hidden', 'true');
      prefix.textContent = next.prefix;
      node.prepend(prefix);
    }
  }
  node.dataset.type = next.type;
  node.classList.toggle('is-heading', next.type === 'heading');
  node.classList.toggle('is-quote', next.type === 'quote');
  node.classList.toggle('is-list', next.type === 'list');
  // 回执里的块对象就是 __compose 闭包用的那个：就地改，前缀与类型立刻生效。
  Object.assign(entry.block, next);
  placeCaretAtEnd(editable);
  return true;
}

/** 换成代码 / 表格这种完全不同的 DOM：只能换节点。 */
function replaceRetypedBlock(node, entry) {
  const fresh = renderBlock(entry.block);
  node.replaceWith(fresh);
  for (const editable of fresh.querySelectorAll('[contenteditable="true"]')) {
    wireEditable(fresh, entry.block);
    editable.focus({ preventScroll: true });
    break;
  }
  focusNode(fresh, 'end');
}

/**
 * 回执说这一块的类型变了：把前缀从正文隐去、换成新块的排版。
 * 只有「刚敲进去的前缀」或「退回正文的字面前缀」能就地改；代码 / 表格这种整个 DOM
 * 都不一样的块只能换节点。
 */
function applyRetype(node, entry, receipt) {
  const retype = receipt.retype;
  if (!retype || !node) return;
  if (retype.prefix || retype.literal) {
    patchRetypedBlock(node, entry, receipt.block, retype);
    return;
  }
  Object.assign(entry.block, receipt.block);
  replaceRetypedBlock(node, entry);
}

function enqueueSave(node) {
  clearTimeout(saveTimer);
  saveTimer = null;
  saveQueue = saveQueue.then(() => persist(node)).catch(() => {});
  return saveQueue;
}

async function persist(node) {
  const entry = blockByAnchor.get(node.dataset.anchor);
  if (!entry || !node.__compose) return;
  if (snapshot?.readonly) {
    status(`保存失败 · ${snapshot.readonly.message}`, true);
    return;
  }
  if (lockedAnchors.has(node.dataset.anchor)) {
    status('保存失败 · 模型正在改这一段', true);
    return;
  }
  let content = node.__compose();
  // 删空块时，浏览器常在编辑面里留一个 <br>，序列化后成了硬换行（`\`）。这种「只剩
  // 浏览器残渣」的内容不能当成正文：标题 / 列表 / 引用退回前缀（反悔），段落照旧报空。
  const editable = node.querySelector('[contenteditable="true"]');
  const emptyInline = editable ? isEmptyInline(inlineOf(editable)) : false;
  if (emptyInline && ['heading', 'list', 'quote'].includes(entry.block.type) && entry.block.prefix) {
    content = entry.block.prefix.trimEnd();
  }
  if (!content || !content.trim() || (emptyInline && entry.block.type === 'paragraph')) {
    status('保存失败 · 块不能为空', true);
    return;
  }
  // 段落里刚敲了前缀、后面还没内容：先不落盘。等服务端看到标题 / 正文再一次转换，
  // 避免「敲到 `### ` 就停一下」先把这一行写成转义过的普通段落。
  if (entry.block.type === 'paragraph' && PREFIX_ONLY_RE.test(content)) {
    node.__dirty = true;
    status('待保存');
    return;
  }
  if (content === entry.block.raw && !node.__dirty) return;
  status('保存中');
  let receipt;
  savesInFlight += 1;
  try {
    receipt = await transport.saveBlock({
      anchor: node.dataset.anchor,
      content,
      base_sha256: snapshot.sha256,
      base_block_sha256: entry.block.sha256,
    });
  } catch (error) {
    status(`保存失败 · ${error.message}`, true);
    return;
  } finally {
    savesInFlight -= 1;
  }
  if (!receipt.ok) {
    // 同一块在别处也被改过：不弹错、不丢编辑，立刻把两版并排摆出来让人选（票 32）。
    if (receipt.code === 'block_conflict') {
      status('这一段在别处也被改过 · 下面两版选一版落盘', true);
      await syncConflicts();
      return;
    }
    status(`保存失败 · ${receipt.error ?? receipt.status ?? '未知错误'}${conflictHint(receipt)}`, true);
    return;
  }
  if (receipt.retype?.structure) {
    // `# ` / `## `：这一块变成了章节 / 页，目录与正文一起重画（回执带整份快照）。
    node.__dirty = false;
    if (receipt.blocks && receipt.pages) applySnapshot(receipt);
    // 造章补了占位页：新页标题直接切到可编辑、占位文字已选中，人接着打字就是改名。
    focusAutoPage(receipt.retype);
    status(receipt.retype.structure === 'page' ? '已自动保存 · 已变成一页' : '已自动保存 · 已变成一章');
    return;
  }
  if (receipt.retype && receipt.block) {
    applyRetype(node, entry, receipt);
  }
  snapshot.sha256 = receipt.sha256;
  entry.block.raw = receipt.block?.raw ?? content;
  if (receipt.block?.sha256) entry.block.sha256 = receipt.block.sha256;
  node.__dirty = false;
  const changed = receipt.retype ? ' · 块类型已转换' : '';
  status(`${receipt.merged ? '已自动保存 · 合并了别处的改动' : '已自动保存'}${changed}`);
}

/** 先把还没落盘的编辑排进队列，再等队列跑完；重排前必须先做这一步。 */
async function flushSaves() {
  clearTimeout(saveTimer);
  saveTimer = null;
  for (const node of $$('.doc-block')) {
    if (node.__dirty) enqueueSave(node);
  }
  await saveQueue;
}

// ── 回车分块 / Shift+Enter 块内换行 / 空块 Backspace 合并 ─────────────────────
//
// 三种动作（SPEC 第 4 节）：回车在光标处切成两块（新块新锚点）；Shift+Enter 在块内
// 换行（写 \\ + 换行，仍是同一块）；空块开头 Backspace 并进前一块（前块锚点保留，
// 后块锚点删除）。分块与合并会改变块数量，所以走显式命令，不混进「保存一块」。
//
// 空块在契约里没有锚点可落（锚点必须贴内容），所以「回车时后半为空」「块首回车时
// 前半为空」先在页面里放一个待定块，第一次输入才带着内容调一次 split。空块永远不落盘。
const SPLIT_TYPES = new Set(['paragraph', 'heading', 'list', 'quote']);
const isSplittable = (block) => SPLIT_TYPES.has(block?.type);
let pendingSeq = 0;

/** 块内行内内容（不含 `- ` / `> ` / `### ` 这些块前缀）。 */
const inlineOf = (editable) => DocInline.serializeInline(editable);
/** 只剩空白或硬换行的块算空块（浏览器删光文字后常留一个 <br>）。 */
const isEmptyInline = (markdown) => String(markdown ?? '').replace(/\\\r?\n/g, '').trim() === '';

function enqueueOperation(run) {
  clearTimeout(saveTimer);
  saveTimer = null;
  saveQueue = saveQueue.then(run).catch(() => {});
  return saveQueue;
}

function applySnapshot(next) {
  snapshot = next;
  renderAll();
}

function focusNode(node, where = 'start') {
  const editable = node?.querySelector?.('[contenteditable="true"]');
  if (!editable) return;
  editable.focus();
  const range = document.createRange();
  range.selectNodeContents(editable);
  range.collapse(where !== 'end');
  const selection = getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}

function focusBlock(anchor, where = 'start') {
  focusNode(blockByAnchor.get(anchor)?.node, where);
}

/** 同页里紧挨着的前一块；越过页边界（上一页的块）不算「前一块」。 */
function previousBlockNode(node) {
  let prev = node.previousElementSibling;
  while (prev && !prev.classList.contains('doc-block')) {
    if (prev.classList.contains('page-divider')) return null;
    prev = prev.previousElementSibling;
  }
  return prev?.dataset?.anchor ? prev : null;
}

/** 光标处切成两半；选中的文字先删掉再分。返回块内 Markdown（不含块前缀）。 */
function splitInlineAtCaret(editable) {
  const selection = getSelection();
  if (!selection || !selection.rangeCount) return null;
  const range = selection.getRangeAt(0);
  if (!editable.contains(range.commonAncestorContainer)) return null;
  if (!selection.isCollapsed) {
    range.deleteContents();
    range.collapse(true);
  }
  const before = document.createRange();
  before.selectNodeContents(editable);
  before.setEnd(range.startContainer, range.startOffset);
  const after = document.createRange();
  after.selectNodeContents(editable);
  after.setStart(range.endContainer, range.endOffset);
  const markdownOf = (source) => {
    const holder = document.createElement('div');
    holder.append(source.cloneContents());
    return DocInline.serializeInline(holder);
  };
  return {
    before: markdownOf(before),
    after: markdownOf(after),
    collapsedAtStart: before.toString() === '',
  };
}

/** 只在这几秒里存在、还没落盘的空块：给它输入内容后才生成锚点。 */
function createPendingBlock(anchor, side) {
  const node = document.createElement('div');
  node.className = 'doc-block is-pending';
  node.dataset.type = 'paragraph';
  node.dataset.pendingAnchor = anchor;
  node.dataset.pendingSide = side;
  node.dataset.pendingSeq = String((pendingSeq += 1));
  const editable = document.createElement('div');
  editable.className = 'block-text';
  editable.contentEditable = 'true';
  editable.spellcheck = false;
  editable.dataset.inline = '1';
  editable.dataset.placeholder = side === 'before' ? '在上方输入' : '在下方输入';
  node.append(editable);
  wirePendingBlock(node, editable);
  return node;
}

function wirePendingBlock(node, editable) {
  let committing = false;
  let timer = null;
  const clearTimer = () => { clearTimeout(timer); timer = null; };
  const drop = (where) => {
    clearTimer();
    const source = blockByAnchor.get(node.dataset.pendingAnchor)?.node;
    node.remove();
    focusNode(source, where);
  };
  /**
   * 把待定块的内容交给服务端之前先冻结编辑面：回执回来会重画，这期间敲下的字
   * 既没进这次请求、也不属于任何块，静默丢掉比慢一点更糟。
   */
  const commit = () => {
    if (committing || !pendingReady(inlineOf(editable))) return;
    clearTimer();
    committing = true;
    editable.contentEditable = 'false';
    void commitPendingBlock(node, editable).finally(() => {
      committing = false;
      if (editable.isConnected && editable.contentEditable === 'false') editable.contentEditable = 'true';
    });
  };
  const schedule = () => {
    clearTimer();
    if (!pendingReady(inlineOf(editable))) return;
    timer = setTimeout(commit, 400);
  };
  editable.addEventListener('compositionstart', () => { editable.__composing = true; });
  editable.addEventListener('compositionend', () => {
    editable.__composing = false;
    if (!committing) schedule();
  });
  editable.addEventListener('input', (event) => {
    // 输入法组合中间态不提交：第一次 input 常常只是一个拼音串。
    if (committing || event.isComposing || editable.__composing) return;
    schedule();
  });
  editable.addEventListener('blur', () => {
    // 第一次输入会先把内容交给服务端，再重画；这时节点被换掉不该算「放弃」。
    if (committing) return;
    if (!pendingReady(inlineOf(editable))) drop(node.dataset.pendingSide === 'after' ? 'end' : 'start');
    else commit();
  });
  editable.addEventListener('keydown', (event) => {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      // 已经输入了内容就不算「放弃」：按回车/失焦同一条路提交，不静默丢字。
      if (!pendingReady(inlineOf(editable))) drop(node.dataset.pendingSide === 'after' ? 'end' : 'start');
      else commit();
      return;
    }
    if (event.key === 'Backspace' && isEmptyInline(inlineOf(editable))) {
      event.preventDefault();
      drop(node.dataset.pendingSide === 'after' ? 'end' : 'start');
      return;
    }
    if (event.key !== 'Enter') return;
    // Shift+Enter 在待定块里也照常换行：围栏代码 / 表格要先有多行才能成形。
    if (event.shiftKey) return;
    event.preventDefault();
    commit();
  });
}

/** 待定块有内容了：连同原块的内容一次性 split，锚点由服务端分配。 */
/**
 * 空页的第一块：文件里没有正文，页面上先放一个「待定块」。
 * 输入前它只是渲染层的一段提示（`.is-pending .block-text:empty::before`），
 * 第一次输入 / 回车 / 失焦才按页身份落成真正的第一块（`POST /api/block {new:true, page}`）。
 */
function pendingFirstBlock(page) {
  const node = document.createElement('div');
  node.className = 'doc-block is-pending';
  node.dataset.type = 'paragraph';
  node.dataset.newPage = page.key;
  const editable = document.createElement('div');
  editable.className = 'block-text';
  editable.contentEditable = 'true';
  editable.spellcheck = false;
  editable.dataset.inline = '1';
  editable.dataset.placeholder = '在这里写这一页。';
  node.append(editable);
  wireFirstBlock(node, editable, page);
  return node;
}

function wireFirstBlock(node, editable, page) {
  let committing = false;
  let timer = null;
  const clearTimer = () => { clearTimeout(timer); timer = null; };
  const commit = async () => {
    clearTimer();
    if (committing || snapshot?.readonly) return;
    const content = inlineOf(editable);
    if (!pendingReady(content)) return; // 空页保持空页：不往文件里写占位正文或半截前缀
    committing = true;
    // 落盘前冻结这一块：回执回来会重画，这期间敲的字不能静默丢掉。
    editable.contentEditable = 'false';
    await enqueueOperation(async () => {
      let receipt;
      try {
        receipt = await transport.saveBlock({
          new: true,
          page: { chapter: page.chapterIndex, index: page.index },
          content,
          base_sha256: snapshot.sha256,
        });
      } catch (error) {
        if (editable.isConnected) editable.contentEditable = 'true';
        committing = false;
        status(`写第一块失败 · ${error.message}`, true);
        return;
      }
      if (!receipt.ok) {
        if (editable.isConnected) editable.contentEditable = 'true';
        committing = false;
        status(`写第一块失败 · ${receipt.error ?? receipt.status ?? '未知错误'}${conflictHint(receipt)}`, true);
        return;
      }
      applySnapshot(receipt);
      status('已自动保存');
      if (focusAutoPage(receipt.retype)) return;
      focusBlock(receipt.block?.anchor, 'end');
    });
  };
  const schedule = () => {
    clearTimer();
    if (!pendingReady(inlineOf(editable))) return;
    timer = setTimeout(commit, 400);
  };
  editable.addEventListener('compositionstart', () => { editable.__composing = true; });
  editable.addEventListener('compositionend', () => {
    editable.__composing = false;
    if (!committing) schedule();
  });
  editable.addEventListener('input', (event) => {
    if (committing || event.isComposing || editable.__composing) return;
    schedule();
  });
  editable.addEventListener('blur', () => { if (!committing) void commit(); });
  editable.addEventListener('keydown', (event) => {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key !== 'Enter' || event.shiftKey) return;
    event.preventDefault();
    void commit();
  });
}

async function commitPendingBlock(pending, editable) {
  const anchor = pending.dataset.pendingAnchor;
  const side = pending.dataset.pendingSide;
  const sourceNode = blockByAnchor.get(anchor)?.node;
  const sourceEditable = sourceNode?.querySelector('[contenteditable="true"]');
  if (!sourceEditable) return;
  const content = inlineOf(editable);
  if (isEmptyInline(content)) return;
  const sourceInline = inlineOf(sourceEditable);
  if (isEmptyInline(sourceInline)) return;
  await enqueueOperation(async () => {
    // 队列里可能刚有别的保存落盘，基线要在真正发请求时取。
    let receipt;
    try {
      receipt = await transport.splitBlock({
        anchor,
        before: side === 'after' ? sourceInline : content,
        after: side === 'after' ? content : sourceInline,
        keep: side === 'after' ? 'before' : 'after',
        base_sha256: snapshot.sha256,
        // 这一块的基线指纹：文件在别处变了也能安全重放；只有这一块自己变了才停下来问人。
        base_block_sha256: blockByAnchor.get(anchor)?.block?.sha256,
      });
    } catch (error) {
      status(`分块失败 · ${error.message}`, true);
      return;
    }
    if (!receipt.ok) {
      status(`分块失败 · ${receipt.error ?? receipt.status ?? '未知错误'}${conflictHint(receipt)}`, true);
      return;
    }
    applySnapshot(receipt);
    status('已自动保存 · 已分块');
    if (focusAutoPage(receipt.retype)) return;
    focusBlock(receipt.new_block?.anchor, 'end');
  });
}

/** 回车：把当前块在光标处拆成两块；空的一半先在页面里等输入。 */
function splitAtCaret(node, editable) {
  const pieces = splitInlineAtCaret(editable);
  if (!pieces) return;
  const beforeEmpty = isEmptyInline(pieces.before);
  const afterEmpty = isEmptyInline(pieces.after);
  if (beforeEmpty || afterEmpty) {
    const side = beforeEmpty ? 'before' : 'after';
    const pending = createPendingBlock(node.dataset.anchor, side);
    if (side === 'before') node.before(pending);
    else node.after(pending);
    pending.querySelector('[contenteditable="true"]').focus();
    return;
  }
  const anchor = node.dataset.anchor;
  node.__dirty = false;
  status('分块中');
  // 冻结到回执回来：拆分请求带的是按下回车那一刻的两半，之后敲的字不能静默消失。
  editable.contentEditable = 'false';
  void enqueueOperation(async () => {
    let receipt;
    try {
      receipt = await transport.splitBlock({
        anchor,
        before: pieces.before,
        after: pieces.after,
        keep: 'before',
        base_sha256: snapshot.sha256,
        base_block_sha256: blockByAnchor.get(anchor)?.block?.sha256,
      });
    } catch (error) {
      if (editable.isConnected) editable.contentEditable = 'true';
      status(`分块失败 · ${error.message}`, true);
      return;
    }
    if (!receipt.ok) {
      if (editable.isConnected) editable.contentEditable = 'true';
      status(`分块失败 · ${receipt.error ?? receipt.status ?? '未知错误'}${conflictHint(receipt)}`, true);
      return;
    }
    applySnapshot(receipt);
    status('已自动保存 · 已分块');
    if (focusAutoPage(receipt.retype)) return;
    focusBlock(receipt.new_block?.anchor, 'start');
  });
}

/** 空块开头按 Backspace：并进紧挨着的前一块（前块锚点保留，本块锚点删除）。 */
function mergeIntoPrevious(node, editable) {
  const previous = previousBlockNode(node);
  if (!previous) {
    status('前面没有可合并的块', true);
    return;
  }
  const anchor = node.dataset.anchor;
  status('合并中');
  editable.contentEditable = 'false';
  void enqueueOperation(async () => {
    let receipt;
    try {
      receipt = await transport.mergeBlock({
        anchor,
        previous: previous.dataset.anchor,
        content: '',
        base_sha256: snapshot.sha256,
        base_block_sha256: blockByAnchor.get(anchor)?.block?.sha256,
      });
    } catch (error) {
      if (editable.isConnected) editable.contentEditable = 'true';
      status(`合并失败 · ${error.message}`, true);
      return;
    }
    if (!receipt.ok) {
      if (editable.isConnected) editable.contentEditable = 'true';
      status(`合并失败 · ${receipt.error ?? receipt.status ?? '未知错误'}${conflictHint(receipt)}`, true);
      return;
    }
    applySnapshot(receipt);
    status('已自动保存 · 已合并');
    focusBlock(receipt.block?.anchor ?? previous.dataset.anchor, 'end');
  });
}

/** 光标在块首（前面没有任何字符）时返回 true。 */
function caretAtBlockStart(editable, range) {
  const before = document.createRange();
  before.selectNodeContents(editable);
  before.setEnd(range.startContainer, range.startOffset);
  return before.toString() === '';
}

/** 重画正文、目录与句柄：块内编辑的接线每次重画后都要重来。 */
function renderAll() {
  renderDocument();
  for (const node of $$('.doc-block')) {
    const entry = blockByAnchor.get(node.dataset.anchor);
    if (entry && node.querySelector('[contenteditable="true"]')) wireEditable(node, entry.block);
  }
  // 重画会换掉节点，锁与待核对面板跟着丢：任务锁拉回来，待核对用内存里的记录直接补回。
  if (lockedAnchors.size) void syncTasks();
  for (const node of blockNodes()) {
    const conflict = deferredRecords.get(node.dataset.anchor);
    if (!conflict) continue;
    renderDeferred(node, conflict);
    lockDeferredBlock(node);
  }
  // 抽屉里「被引用的那句话」来自快照：正文重画后跟着刷新。
  renderNotes();
}

function wireLayout() {
  if (typeof DocLayout === 'undefined') return;
  layout = DocLayout.createLayout({ document });
  layout.bind();
}

/** 纸左上角的字号缩放：只改 --doc-fs，选择存在浏览器本地。 */
function wireFontSize() {
  if (typeof DocLayout === 'undefined') return;
  DocLayout.createFontSize({ document }).bind();
}

async function boot() {
  wireLayout();
  wireFontSize();
  wireToolbar();
  wireHistory();
  wireComposer();
  wireSelectionFeedback();
  wireOverallFeedback();
  wireStructureNotice();
  wireNotes();
  try {
    transport = await DocTransport.connect();
    const doc = await transport.open();
    if (!doc.ok) throw Error(doc.error ?? `打开失败 · ${doc.status ?? '未知错误'}`);
    snapshot = doc;
    renderAll();
    await loadNotes();
    if (snapshot.readonly) {
      // 只读挂载不轮询任务、不接编辑：它只是一份能看的旧主稿。
      status('只读 · 旧 JSON 主稿（保存会被拒绝）');
      return;
    }
    await syncTasks();
    pollTasks();
    // 结构问题只在保存态旁亮一个圆点：保存态只说「载入了」，不报红，也不解释结构。
    status('已载入');
  } catch (error) {
    status(`打开失败 · ${error.message}`, true);
  }
}

void boot();
