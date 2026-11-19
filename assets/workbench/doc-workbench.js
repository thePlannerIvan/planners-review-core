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

function pageHeading(block) {
  const node = document.createElement('div');
  node.className = 'page-divider';
  node.dataset.pageKey = block.page.key ?? '';
  const chapter = document.createElement('span');
  chapter.className = 'page-chapter';
  // 页号由顺序决定、不写进正文，所以这里按当前位置算出「第 N 页」。
  chapter.textContent = [block.page.chapter, `第 ${block.page.number ?? 1} 页`].filter(Boolean).join(' · ');
  const title = document.createElement('h2');
  title.className = 'page-title';
  title.textContent = block.page.title ?? '';
  node.append(chapter, title);
  return node;
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
  const version = (snapshot.assets ?? []).find((asset) => asset.path === image.path)?.sha256 ?? null;
  node.append(DocImages.render(image, { version }));
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

function renderDocument() {
  const root = $('#blocks');
  blockByAnchor.clear();
  root.replaceChildren();
  let pageKey = null;
  for (const block of snapshot.blocks) {
    const key = `${block.page.chapter ?? ''}\u0000${block.page.number ?? ''}\u0000${block.page.title ?? ''}`;
    if (key !== pageKey) {
      pageKey = key;
      root.append(pageHeading(block));
    }
    root.append(renderBlock(block));
  }
  DocDrag.render(root, {
    snapshot: () => snapshot,
    apply: (next) => { snapshot = next; renderAll(); },
    flush: flushSaves,
    save: (node) => enqueueSave(node),
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
}

function currentEditable() {
  const selection = getSelection();
  if (!selection || !selection.rangeCount) return null;
  const node = selection.anchorNode?.nodeType === 3 ? selection.anchorNode.parentElement : selection.anchorNode;
  return node?.closest?.('[contenteditable="true"]') ?? null;
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
      if (event.key === 'Enter' && !event.shiftKey) {
        if (block.type === 'heading') { event.preventDefault(); return; }
        event.preventDefault();
        document.execCommand('insertLineBreak');
      }
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
    const response = await fetch('/api/feedback', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const receipt = await response.json().catch(() => ({}));
    if (!response.ok || !receipt.ok) {
      showFeedbackError(receipt.error ?? `提交失败 · HTTP ${response.status}`);
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
}

async function syncTasks() {
  try {
    const response = await fetch('/api/tasks');
    if (response.ok) {
      const receipt = await response.json();
      applyLocks(processingLocks(receipt.tasks));
    }
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
    const response = await fetch('/api/conflicts');
    if (!response.ok) return;
    const receipt = await response.json();
    const byAnchor = new Map((receipt.conflicts ?? []).map((conflict) => [conflict.anchor, conflict]));
    for (const node of blockNodes()) {
      const conflict = byAnchor.get(node.dataset.anchor);
      if (conflict) renderDeferred(node, conflict);
      else clearDeferred(node);
    }
  } catch {
    // 待核对同步失败不打断编辑：保存路径仍会拒绝锁定块。
  }
}

async function decideConflict(anchor, decision) {
  const node = blockByAnchor.get(anchor)?.node;
  node?.querySelectorAll('.deferred-actions button').forEach((button) => { button.disabled = true; });
  try {
    const response = await fetch('/api/conflict/decide', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ anchor, decision }),
    });
    const receipt = await response.json().catch(() => ({}));
    if (!response.ok || !receipt.ok) {
      status(`裁决失败 · ${receipt.error ?? response.status}`, true);
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
  let response;
  try {
    response = await fetch('/api/block', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        anchor: node.dataset.anchor,
        content,
        base_sha256: snapshot.sha256,
        base_block_sha256: entry.block.sha256,
      }),
    });
  } catch (error) {
    status(`保存失败 · ${error.message}`, true);
    return;
  }
  const receipt = await response.json().catch(() => ({}));
  if (!response.ok || !receipt.ok) {
    status(`保存失败 · ${receipt.error ?? response.status}`, true);
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
  wireComposer();
  wireSelectionFeedback();
  wireOverallFeedback();
  try {
    const response = await fetch('/api/doc');
    const doc = await response.json();
    if (!response.ok) throw Error(doc.error ?? `HTTP ${response.status}`);
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
