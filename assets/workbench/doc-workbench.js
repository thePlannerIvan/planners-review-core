'use strict';
/* 文字工作台的渲染与保存。只做一件事：块 raw 进、块 raw 出。
 * 块内就地编辑用 contenteditable；保存时只把被改的这一块 POST 回去。 */
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const TOOLBAR_HTML = `
  <button type="button" data-inline="bold" title="加粗" aria-label="加粗"><strong>B</strong></button>
  <button type="button" data-inline="italic" title="斜体" aria-label="斜体"><em>I</em></button>
  <button type="button" data-inline="code" title="行内代码" aria-label="行内代码"><code>\`</code></button>
  <button type="button" data-inline="link" title="链接" aria-label="链接">↗</button>`;

let snapshot = null;
let transport = null; // 同一份页面两种宿主：本地 /api 或侧栏 command（doc-transport.js）
let saveTimer = null;
let saveQueue = Promise.resolve();
const blockByAnchor = new Map();

// 反馈与锁：目标块随选区 / 入口变化；锁由任务同步而来，保存时服务端还会再拦一次。
let feedbackScope = 'blocks';
let feedbackPage = null;
let feedbackTargets = [];
let lockedAnchors = new Set();
let selectionTimer = null;
let taskTimer = null;

const blockNodes = () => $$('.doc-block');
const blockEntry = (node) => blockByAnchor.get(node?.dataset?.anchor) ?? null;

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

function pageHeading(page, { editable = false } = {}) {
  const node = document.createElement('div');
  node.className = 'page-divider';
  node.dataset.pageKey = page.key ?? '';
  const chapter = document.createElement('span');
  chapter.className = 'page-chapter';
  // 页号由顺序决定、不写进正文，所以这里按当前位置算出「第 N 页」。
  chapter.textContent = editable
    ? `第 ${page.index ?? 1} 页`
    : [page.chapter, `第 ${page.number ?? page.index ?? 1} 页`].filter(Boolean).join(' · ');
  const title = document.createElement('h2');
  title.className = 'page-title';
  title.textContent = page.title ?? '';
  if (editable) wireStructureTitle(title, { op: 'rename-page', chapter: page.chapterIndex, index: page.index });
  node.append(chapter, title);
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

async function renameStructure(node, spec, title, original) {
  await flushSaves();
  status('保存中', true);
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

// ── 加页 / 加章：页尾与章节尾各一个入口，回执带新结构位置，随即进入改名 ────────
function structureAddButton(kind, label, run) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = kind === 'page' ? 'page-add' : 'chapter-add';
  button.dataset.addKind = kind;
  button.textContent = label;
  button.addEventListener('mousedown', (event) => event.preventDefault()); // 不抢正文光标
  button.addEventListener('click', (event) => {
    event.preventDefault();
    void run();
  });
  return button;
}

function pageAddButton(page) {
  const button = structureAddButton('page', '＋ 新页', () => addStructure({ op: 'add-page', chapter: page.chapterIndex, index: page.index }));
  button.dataset.addPage = page.key;
  button.title = '在这一页后面加一页';
  return button;
}

function chapterAddButton(chapter) {
  const button = structureAddButton('chapter', '＋ 新章节', () => addStructure({ op: 'add-chapter', chapter: chapter.index }));
  button.dataset.addChapter = String(chapter.index ?? '');
  button.title = '在这一章后面加一章';
  return button;
}

async function addStructure(body) {
  if (snapshot?.readonly) return;
  await flushSaves();
  status('保存中', true);
  let receipt;
  try {
    receipt = await transport.structure({ ...body, base_sha256: snapshot.sha256 });
  } catch (error) {
    status(`加不了 · ${error.message}`, true);
    return;
  }
  if (!receipt.ok) {
    status(`加不了 · ${receipt.error ?? receipt.status ?? '未知错误'}`, true);
    return;
  }
  const chapter = body.op === 'add-chapter';
  applySnapshot(receipt);
  status(chapter ? '已加一章 · 点章节名可以改' : '已加一页 · 点页名可以改');
  focusNewStructure(receipt, chapter ? 'chapter' : 'page');
}

/** 新结构出现后滚到它、直接把名字选中：加完就能打字，不用再找一遍。 */
function focusNewStructure(receipt, kind) {
  const selector = kind === 'chapter'
    ? `.chapter-divider[data-chapter-index="${receipt.chapter?.index}"] .chapter-title`
    : `.page-divider[data-page-key="${receipt.page?.key}"] .page-title`;
  const node = document.querySelector(selector);
  if (!node) return;
  node.scrollIntoView({ block: 'center' });
  const spec = kind === 'chapter'
    ? { op: 'rename-chapter', chapter: receipt.chapter.index }
    : { op: 'rename-page', chapter: receipt.page.chapter, index: receipt.page.index };
  beginStructureEdit(node, spec);
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

/** 块尾反馈按钮：鼠标移到块上才露出来，点了就只针对这一块。 */
function attachBlockFeedback(node, block) {
  if (!block.anchor) return;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'block-feedback';
  button.setAttribute('data-feedback-block', block.anchor);
  button.title = '对这一块提反馈';
  button.setAttribute('aria-label', '对这一块提反馈');
  button.textContent = '反馈';
  button.addEventListener('mousedown', (event) => event.preventDefault());
  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    openComposer([block.anchor], { scope: 'blocks', label: '将改这一块' });
  });
  node.append(button);
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

/** 结构稿：章节 → 页 → 块；页尾「＋ 新页」、章节尾「＋ 新章节」。 */
function renderStructuredBlocks(root) {
  const blocks = snapshot.blocks ?? [];
  const pages = snapshot.pages ?? [];
  let cursor = 0;
  for (const chapter of chaptersOf(snapshot)) {
    root.append(chapterHeading(chapter));
    for (const page of pages.filter((item) => item.chapterIndex === chapter.index)) {
      root.append(pageHeading(page, { editable: true }));
      while (cursor < blocks.length && blocks[cursor].page?.key === page.key) {
        root.append(renderBlock(blocks[cursor]));
        cursor += 1;
      }
      root.append(pageAddButton(page));
    }
    root.append(chapterAddButton(chapter));
  }
  // 结构坏了也不能吞块：没落到页里的块按原文显示在末尾。
  while (cursor < blocks.length) {
    root.append(renderBlock(blocks[cursor]));
    cursor += 1;
  }
}

function renderDocument() {
  const root = $('#blocks');
  blockByAnchor.clear();
  root.replaceChildren();
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
  const broken = snapshot.errors ?? [];
  if (broken.length) {
    const note = $('#structureNotice');
    note.hidden = false;
    note.textContent = broken.slice(0, 3).map((error) => `行 ${error.line ?? '?'}：${error.message}`).join(' · ');
  }
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
  const feedback = $('#overallFeedback');
  feedback.disabled = true;
  feedback.hidden = true;
  $('#overallMenu').hidden = true;
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
    editable.addEventListener('input', () => {
      node.__dirty = true;
      status('待保存');
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => enqueueSave(node), 600);
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

// ── 反馈：选区吸附到块 → 标出将改的块 → 只把块身份与意见提交 ─────────────────
function setFeedbackTargets(anchors) {
  feedbackTargets = [...new Set(anchors ?? [])];
  for (const node of blockNodes()) {
    node.classList.toggle('is-feedback-target', feedbackTargets.includes(node.dataset.anchor));
  }
  const note = $('#feedbackTargetNote');
  if (note && !$('#feedbackComposer').hidden) note.textContent = `将改 ${feedbackTargets.length} 块`;
}

function firstTargetNode() {
  return blockByAnchor.get(feedbackTargets[0])?.node ?? null;
}

function openComposer(anchors, { scope = 'blocks', page = null, label = '' } = {}) {
  if (!anchors.length) return;
  if (snapshot?.readonly) { status('只读 · 旧 JSON 主稿不能派发反馈', true); return; }
  feedbackScope = scope;
  feedbackPage = page;
  setFeedbackTargets(anchors);
  const composer = $('#feedbackComposer');
  composer.hidden = false;
  const note = $('#feedbackTargetNote');
  note.textContent = label || `将改 ${feedbackTargets.length} 块`;
  const error = $('#feedbackError');
  error.hidden = true;
  error.textContent = '';
  const text = $('#feedbackText');
  text.value = '';
  const rect = firstTargetNode()?.getBoundingClientRect();
  const width = Math.min(360, window.innerWidth - 24);
  composer.style.width = `${width}px`;
  composer.style.left = `${Math.max(12, Math.min(rect?.left ?? 24, window.innerWidth - width - 12))}px`;
  composer.style.top = `${Math.max(64, Math.min((rect?.bottom ?? 120) + 10, window.innerHeight - 200))}px`;
  text.focus();
}

function closeComposer() {
  $('#feedbackComposer').hidden = true;
  $('#selectionFeedback').hidden = true;
  feedbackScope = 'blocks';
  feedbackPage = null;
  setFeedbackTargets([]);
}

const showFeedbackError = (message) => {
  const error = $('#feedbackError');
  error.textContent = message;
  error.hidden = false;
};

async function submitFeedback() {
  const text = $('#feedbackText').value.trim();
  if (snapshot?.readonly) { showFeedbackError(snapshot.readonly.message); return; }
  if (!text) { showFeedbackError('先写下要模型改什么。'); return; }
  if (!feedbackTargets.length) { showFeedbackError('没有选中的块；重新选一段再提交。'); return; }
  const payload = { scope: feedbackScope, text };
  if (feedbackScope === 'blocks') payload.anchors = [...feedbackTargets];
  if (feedbackScope === 'page') payload.page = { ...feedbackPage };
  await saveQueue; // 先把正在保存的块落盘，任务指纹才是人看到的版本
  const button = $('#feedbackSubmit');
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
  $('#feedbackCancel').addEventListener('click', closeComposer);
  $('#feedbackSubmit').addEventListener('click', () => { void submitFeedback(); });
  $('#feedbackText').addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { event.preventDefault(); closeComposer(); }
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void submitFeedback(); }
  });
}

const inComposer = (node) => Boolean(node?.closest?.('#feedbackComposer'));

function scheduleSelectionTargets() {
  clearTimeout(selectionTimer);
  selectionTimer = setTimeout(updateSelectionTargets, 120);
}

function updateSelectionTargets() {
  if (!$('#feedbackComposer').hidden) return; // 写反馈时不跟着选区跑，目标已定
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

// ── 顶部整体反馈：整页按当前视野最近的块定页，整份绑定所有块 ───────────────────
function currentPage() {
  const nodes = blockNodes().filter((node) => blockEntry(node)?.block?.page);
  if (!nodes.length) return null;
  const middle = window.innerHeight / 2;
  let best = null;
  let distance = Infinity;
  for (const node of nodes) {
    const rect = node.getBoundingClientRect();
    const gap = Math.abs((rect.top + rect.bottom) / 2 - middle);
    if (gap < distance) { distance = gap; best = node; }
  }
  return best ? blockEntry(best).block.page : null;
}

const pageKeyOf = (page) => `${page?.chapter ?? ''}\u0000${page?.number ?? ''}\u0000${page?.title ?? ''}`;

function anchorsOfPage(page) {
  return snapshot.blocks
    .filter((block) => block.anchor && pageKeyOf(block.page) === pageKeyOf(page))
    .map((block) => block.anchor);
}

function wireOverallFeedback() {
  const button = $('#overallFeedback');
  const menu = $('#overallMenu');
  const close = () => {
    menu.hidden = true;
    button.setAttribute('aria-expanded', 'false');
  };
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    const open = menu.hidden;
    menu.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
  });
  menu.addEventListener('click', (event) => {
    const choice = event.target.closest('[data-overall]');
    if (!choice) return;
    close();
    if (!snapshot) return;
    if (choice.dataset.overall === 'doc') {
      const anchors = snapshot.blocks.filter((block) => block.anchor).map((block) => block.anchor);
      openComposer(anchors, { scope: 'doc', label: `将改整份 · ${anchors.length} 块` });
      return;
    }
    const page = currentPage();
    if (!page) return;
    const anchors = anchorsOfPage(page);
    openComposer(anchors, {
      scope: 'page',
      page: { chapter: page.chapter, number: page.number, title: page.title },
      label: `将改这一页 · ${page.title}`,
    });
  });
  document.addEventListener('click', (event) => {
    if (!menu.hidden && !event.target.closest('.top-actions')) close();
  });
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
    else unlockBlock(node);
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

/** 待核对块：显示两个版本与三个出口；裁决后重新载入，磁盘上只留一个版本。 */
function renderDeferred(node, conflict) {
  node.classList.add('is-deferred');
  let panel = node.querySelector('.block-deferred');
  if (!panel) {
    panel = document.createElement('div');
    panel.className = 'block-deferred';
    const note = document.createElement('p');
    note.className = 'deferred-note';
    note.textContent = '待核对 · 你改过这一段之后，模型也改了它';
    const details = document.createElement('details');
    details.className = 'deferred-model';
    const summary = document.createElement('summary');
    summary.textContent = '看模型版';
    const preview = document.createElement('pre');
    details.append(summary, preview);
    const actions = document.createElement('div');
    actions.className = 'deferred-actions';
    for (const decision of ['mine', 'model', 'discard']) {
      const button = document.createElement('button');
      button.type = 'button';
      button.setAttribute('data-decision', decision);
      button.textContent = DECISION_LABELS[decision];
      button.addEventListener('click', () => { void decideConflict(node.dataset.anchor, decision); });
      actions.append(button);
    }
    panel.append(note, details, actions);
    node.append(panel);
  }
  const preview = panel.querySelector('.deferred-model pre');
  if (preview) preview.textContent = conflict.model_content ?? '';
}

function clearDeferred(node) {
  if (!node.classList.contains('is-deferred')) return;
  node.classList.remove('is-deferred');
  node.querySelector('.block-deferred')?.remove();
}

async function syncConflicts() {
  try {
    const receipt = await transport.conflicts();
    if (!receipt.ok) return;
    const byAnchor = new Map((receipt.conflicts ?? []).map((conflict) => [conflict.anchor, conflict]));
    for (const node of blockNodes()) {
      const conflict = byAnchor.get(node.dataset.anchor);
      if (conflict) renderDeferred(node, conflict);
      else clearDeferred(node);
    }
    DocDrag.refresh();
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
  const content = node.__compose();
  if (!content || !content.trim()) {
    status('保存失败 · 块不能为空', true);
    return;
  }
  if (content === entry.block.raw && !node.__dirty) return;
  status('保存中', true);
  let receipt;
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
  }
  if (!receipt.ok) {
    status(`保存失败 · ${receipt.error ?? receipt.status ?? '未知错误'}`, true);
    return;
  }
  snapshot.sha256 = receipt.sha256;
  entry.block.raw = receipt.block?.raw ?? content;
  if (receipt.block?.sha256) entry.block.sha256 = receipt.block.sha256;
  node.__dirty = false;
  status(receipt.merged ? '已自动保存 · 合并了别处的改动' : '已自动保存');
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
    if (committing || isEmptyInline(inlineOf(editable))) return;
    clearTimer();
    committing = true;
    editable.contentEditable = 'false';
    void commitPendingBlock(node, editable).finally(() => {
      committing = false;
      if (editable.isConnected && editable.contentEditable === 'false') editable.contentEditable = 'true';
    });
  };
  editable.addEventListener('input', (event) => {
    // 输入法组合中间态不提交：第一次 input 常常只是一个拼音串。
    if (committing || event.isComposing) return;
    clearTimer();
    if (isEmptyInline(inlineOf(editable))) return;
    timer = setTimeout(commit, 400);
  });
  editable.addEventListener('blur', () => {
    // 第一次输入会先把内容交给服务端，再重画；这时节点被换掉不该算「放弃」。
    if (committing) return;
    if (isEmptyInline(inlineOf(editable))) drop(node.dataset.pendingSide === 'after' ? 'end' : 'start');
    else commit();
  });
  editable.addEventListener('keydown', (event) => {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      // 已经输入了内容就不算「放弃」：按回车/失焦同一条路提交，不静默丢字。
      if (isEmptyInline(inlineOf(editable))) drop(node.dataset.pendingSide === 'after' ? 'end' : 'start');
      else commit();
      return;
    }
    if (event.key === 'Backspace' && isEmptyInline(inlineOf(editable))) {
      event.preventDefault();
      drop(node.dataset.pendingSide === 'after' ? 'end' : 'start');
      return;
    }
    if (event.key !== 'Enter') return;
    event.preventDefault();
    if (event.shiftKey) return;
    commit();
  });
}

/** 待定块有内容了：连同原块的内容一次性 split，锚点由服务端分配。 */
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
      });
    } catch (error) {
      status(`分块失败 · ${error.message}`, true);
      return;
    }
    if (!receipt.ok) {
      status(`分块失败 · ${receipt.error ?? receipt.status ?? '未知错误'}`, true);
      return;
    }
    applySnapshot(receipt);
    status('已自动保存 · 已分块');
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
      });
    } catch (error) {
      if (editable.isConnected) editable.contentEditable = 'true';
      status(`分块失败 · ${error.message}`, true);
      return;
    }
    if (!receipt.ok) {
      if (editable.isConnected) editable.contentEditable = 'true';
      status(`分块失败 · ${receipt.error ?? receipt.status ?? '未知错误'}`, true);
      return;
    }
    applySnapshot(receipt);
    status('已自动保存 · 已分块');
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
      });
    } catch (error) {
      if (editable.isConnected) editable.contentEditable = 'true';
      status(`合并失败 · ${error.message}`, true);
      return;
    }
    if (!receipt.ok) {
      if (editable.isConnected) editable.contentEditable = 'true';
      status(`合并失败 · ${receipt.error ?? receipt.status ?? '未知错误'}`, true);
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
  // 重画会换掉节点，锁的样式跟着丢；有块在模型手里时重新拉一次任务面补回来。
  if (lockedAnchors.size) void syncTasks();
}

async function boot() {
  wireToolbar();
  wireHistory();
  wireComposer();
  wireSelectionFeedback();
  wireOverallFeedback();
  try {
    transport = await DocTransport.connect();
    const doc = await transport.open();
    if (!doc.ok) throw Error(doc.error ?? `打开失败 · ${doc.status ?? '未知错误'}`);
    snapshot = doc;
    renderAll();
    if (snapshot.readonly) {
      // 只读挂载不轮询任务、不接编辑：它只是一份能看的旧主稿。
      status('只读 · 旧 JSON 主稿（保存会被拒绝）');
      return;
    }
    await syncTasks();
    pollTasks();
    const broken = snapshot.errors ?? [];
    status(broken.length ? `已载入 · ${broken.length} 处结构问题按原文显示` : '已载入', broken.length > 0);
  } catch (error) {
    status(`打开失败 · ${error.message}`, true);
  }
}

void boot();
