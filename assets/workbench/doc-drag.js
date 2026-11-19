/**
 * 拖动与目录：六点句柄拖块、拖页标题搬整页、左侧两级目录、`Alt+↑↓`。
 *
 * 落点计算（`blockGaps` / `pageGaps` / `nearestGap`）是纯函数：给定几何，算出
 * 「插到哪两块之间」。浏览器里只负责量 DOM 的矩形、画提示线，然后把落点交给
 * 页面的 transport（本地 `/api/reorder`，侧栏 `command({op:'reorder'})`）；
 * 这个文件不解析 Markdown，也不自己拼文档。
 *
 * 与服务端的契约：一次一个动作，`move-block` 或 `move-page`，带 `base_sha256`。
 * 服务端回整份快照，页面据此重画正文、目录与页号。走哪条传输由页面的 transport 决定
 * （本地页 `/api/reorder`，侧栏桥 `command({op:'reorder'})`），这个文件不关心宿主。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DocDrag = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ── 落点：纯几何 ─────────────────────────────────────────────────────────

  /** 最近的一条落点提示线。 */
  function nearestGap(gaps, y) {
    if (!gaps.length) return null;
    let best = gaps[0];
    for (const gap of gaps) {
      if (Math.abs(gap.y - y) < Math.abs(best.y - y)) best = gap;
    }
    return best;
  }

  /**
   * 块的落点：页首（第一块之前）、页内每两块之间、页尾（最后一块之后）。
   * items: [{anchor, page, top, bottom}]，按文档顺序。
   * `before: null` 表示「这一页的末尾」。
   */
  function blockGaps(items) {
    const gaps = [];
    let index = 0;
    while (index < items.length) {
      const page = items[index].page;
      const first = items[index];
      gaps.push({ y: first.top, page, before: first.anchor });
      let last = first;
      index += 1;
      while (index < items.length && items[index].page === page) {
        gaps.push({ y: (last.bottom + items[index].top) / 2, page, before: items[index].anchor });
        last = items[index];
        index += 1;
      }
      gaps.push({ y: last.bottom, page, before: null });
    }
    return gaps;
  }

  /**
   * 页的落点：每一页的「之前 / 之后」。
   * 同章相邻页的「之后」与下一页的「之前」落到同一个顺序上，但位置不同：
   * 章节标题夹在中间时，上面那个留在本章，下面那个进下一章。
   * pages: [{key, chapterIndex, top, bottom}]，按文档顺序。
   */
  function pageGaps(pages) {
    const gaps = [];
    for (const page of pages) {
      gaps.push({ y: page.top, page: page.key, position: 'before' });
      gaps.push({ y: page.bottom, page: page.key, position: 'after' });
    }
    return gaps;
  }

  /**
   * `Alt+↑↓` 的落点：把文档顺序里第 index 块往上 / 下挪一格。
   * 返回 `{page, before}`；已经在头 / 尾时返回 null（不装作动了）。
   */
  function stepGap(blocks, index, direction) {
    const up = direction === 'up';
    const neighbour = blocks[index + (up ? -1 : 1)];
    if (!neighbour) return null;
    const after = blocks[index + 2];
    return up
      ? { page: neighbour.page.key, before: neighbour.anchor }
      : { page: neighbour.page.key, before: after && after.page.key === neighbour.page.key ? after.anchor : null };
  }

  // ── 浏览器 ───────────────────────────────────────────────────────────────

  const HANDLE_SVG = '<svg viewBox="0 0 8 14" width="8" height="14" aria-hidden="true" focusable="false">'
    + '<circle cx="2" cy="2" r="1.1"/><circle cx="6" cy="2" r="1.1"/>'
    + '<circle cx="2" cy="7" r="1.1"/><circle cx="6" cy="7" r="1.1"/>'
    + '<circle cx="2" cy="12" r="1.1"/><circle cx="6" cy="12" r="1.1"/></svg>';

  const state = {
    hooks: null,
    root: null,
    toc: null,
    line: null,
    dragging: null,
    gap: null,
    bound: false,
    activeFrame: 0,
  };

  const isBrowser = typeof document !== 'undefined' && typeof window !== 'undefined';

  function render(root, hooks) {
    if (!isBrowser) return;
    state.root = root;
    state.hooks = hooks;
    state.toc = hooks.toc ?? document.getElementById('toc');
    const snapshot = hooks.snapshot();
    ensureDropLine();
    decorate(root, snapshot);
    renderToc(snapshot);
    updateActive();
    bindOnce();
  }

  function ensureDropLine() {
    if (state.line?.isConnected) return state.line;
    let line = document.getElementById('dropLine');
    if (!line) {
      line = document.createElement('div');
      line.id = 'dropLine';
      line.className = 'drop-line';
      line.hidden = true;
      const label = document.createElement('span');
      label.className = 'drop-label';
      line.append(label);
      document.body.append(line);
    }
    state.line = line;
    return line;
  }

  function decorate(root, snapshot) {
    if (snapshot.readonly) return; // 旧 JSON 主稿只读：目录照常，正文不给拖柄，也不接受重排
    const byAnchor = new Map(snapshot.blocks.map((block) => [block.anchor, block]));
    for (const node of root.querySelectorAll('.doc-block[data-anchor]')) {
      const entry = byAnchor.get(node.dataset.anchor);
      if (entry) node.dataset.pageKey = entry.page.key ?? '';
      if (node.querySelector(':scope > .block-handle')) continue;
      const handle = document.createElement('button');
      handle.type = 'button';
      handle.className = 'block-handle';
      handle.draggable = true;
      handle.setAttribute('aria-label', '拖动这一段');
      handle.title = '拖动这一段（Alt+↑↓ 也行）';
      handle.innerHTML = HANDLE_SVG;
      node.prepend(handle);
    }
    for (const divider of root.querySelectorAll('.page-divider[data-page-key]')) {
      const title = divider.querySelector('.page-title');
      if (title) {
        title.draggable = true;
        title.title = '拖动标题移动整页';
      }
      if (divider.querySelector(':scope > .page-handle')) continue;
      const handle = document.createElement('button');
      handle.type = 'button';
      handle.className = 'page-handle';
      handle.draggable = true;
      handle.setAttribute('aria-label', '拖动整页');
      handle.title = '拖动标题移动整页';
      handle.innerHTML = HANDLE_SVG;
      divider.prepend(handle);
    }
  }

  function renderToc(snapshot) {
    const toc = state.toc;
    if (!toc) return;
    const fragment = document.createDocumentFragment();
    let chapterIndex = null;
    for (const page of snapshot.pages ?? []) {
      if (page.chapterIndex !== chapterIndex) {
        chapterIndex = page.chapterIndex;
        const chapter = document.createElement('div');
        chapter.className = 'toc-chapter';
        chapter.textContent = page.chapter ?? '未命名章节';
        chapter.dataset.chapter = String(page.chapterIndex ?? '');
        fragment.append(chapter);
      }
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'toc-page';
      button.dataset.page = page.key;
      button.title = page.title ?? '';
      const number = document.createElement('span');
      number.className = 'toc-number';
      number.textContent = String(page.index ?? '');
      const title = document.createElement('span');
      title.className = 'toc-title';
      title.textContent = page.title ?? '';
      button.append(number, title);
      fragment.append(button);
    }
    if (!(snapshot.pages ?? []).length) {
      const empty = document.createElement('p');
      empty.className = 'toc-empty';
      empty.textContent = '这份文档还没有页';
      fragment.append(empty);
    }
    toc.replaceChildren(fragment);
  }

  function bindOnce() {
    if (state.bound) return;
    state.bound = true;
    document.addEventListener('dragstart', onDragStart);
    document.addEventListener('dragover', onDragOver);
    document.addEventListener('drop', onDrop);
    document.addEventListener('dragend', finishDrag);
    document.addEventListener('keydown', onKeydown);
    document.addEventListener('click', onTocClick);
    window.addEventListener('scroll', scheduleActive, { passive: true });
    window.addEventListener('resize', scheduleActive);
  }

  // ── 拖动 ────────────────────────────────────────────────────────────────

  function onDragStart(event) {
    const blockHandle = event.target.closest?.('.block-handle');
    const pageSource = event.target.closest?.('.page-title[draggable="true"], .page-handle');
    const divider = pageSource?.closest?.('.page-divider');
    let dragging = null;
    if (blockHandle) {
      const node = blockHandle.closest('.doc-block');
      if (node?.dataset.anchor) dragging = { kind: 'block', anchor: node.dataset.anchor, node };
    } else if (divider?.dataset.pageKey) {
      dragging = { kind: 'page', key: divider.dataset.pageKey, node: divider };
    }
    if (!dragging) return;
    state.dragging = dragging;
    state.gap = null;
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
      try { event.dataTransfer.setData('text/plain', dragging.anchor ?? dragging.key); } catch { /* 老浏览器 */ }
      try { event.dataTransfer.setDragImage(dragging.node, 16, 16); } catch { /* 设不了就算了 */ }
    }
    dragging.node.classList.add('is-dragging');
    document.body.classList.add('is-reordering');
  }

  function onDragOver(event) {
    if (!state.dragging) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    const gap = nearestGap(gapsFor(state.dragging), event.clientY);
    state.gap = gap;
    showDropLine(gap, state.dragging);
  }

  async function onDrop(event) {
    if (!state.dragging) return;
    event.preventDefault();
    const dragging = state.dragging;
    const gap = nearestGap(gapsFor(dragging), event.clientY) ?? state.gap;
    finishDrag();
    if (!gap) return;
    await submit(dragging, gap);
  }

  function finishDrag() {
    state.line && (state.line.hidden = true);
    state.dragging?.node?.classList.remove('is-dragging');
    document.body.classList.remove('is-reordering');
    state.dragging = null;
    state.gap = null;
  }

  /** 量出当前 DOM 的落点候选。每次拖动时现量，窗口缩放后也不会用旧矩形。 */
  function gapsFor(dragging) {
    const root = state.root;
    if (!root) return [];
    if (dragging.kind === 'page') {
      const blocks = [...root.querySelectorAll('.doc-block[data-anchor]')];
      const pages = [];
      for (const divider of root.querySelectorAll('.page-divider[data-page-key]')) {
        const key = divider.dataset.pageKey;
        const rect = divider.getBoundingClientRect();
        const own = blocks.filter((node) => node.dataset.pageKey === key);
        const last = own[own.length - 1];
        pages.push({
          key,
          chapterIndex: pageOf(key)?.chapterIndex ?? 0,
          top: rect.top,
          bottom: last ? last.getBoundingClientRect().bottom : rect.bottom,
        });
      }
      return pageGaps(pages);
    }
    const items = [...root.querySelectorAll('.doc-block[data-anchor]')].map((node) => {
      const rect = node.getBoundingClientRect();
      return { anchor: node.dataset.anchor, page: node.dataset.pageKey, top: rect.top, bottom: rect.bottom };
    });
    return blockGaps(items);
  }

  function showDropLine(gap, dragging) {
    const line = ensureDropLine();
    if (!gap) { line.hidden = true; return; }
    const rect = state.root.getBoundingClientRect();
    line.hidden = false;
    line.classList.toggle('is-page', dragging.kind === 'page');
    line.style.left = `${rect.left + window.scrollX}px`;
    line.style.width = `${rect.width}px`;
    line.style.top = `${gap.y + window.scrollY}px`;
    line.querySelector('.drop-label').textContent = gapLabel(gap, dragging);
  }

  function gapLabel(gap, dragging) {
    const page = pageOf(gap.page);
    if (dragging.kind === 'page') {
      const name = page ? `${page.chapter ?? ''} · ${page.title}` : gap.page;
      return `移到「${name}」${gap.position === 'after' ? '之后' : '之前'}`;
    }
    if (!gap.before) return `移到「${page?.title ?? ''}」末尾`;
    const target = state.hooks?.snapshot().blocks.find((block) => block.anchor === gap.before);
    const text = String(target?.inline ?? '').replace(/\s+/g, ' ').slice(0, 12);
    return text ? `插到「${text}」之前` : '插到这里';
  }

  // ── 提交重排 ────────────────────────────────────────────────────────────

  async function submit(dragging, gap) {
    const hooks = state.hooks;
    if (!hooks) return;
    await hooks.flush();
    const snapshot = hooks.snapshot();
    const landing = pageOf(gap.page);
    if (!landing) return;
    const body = dragging.kind === 'page'
      ? {
        op: 'move-page',
        base_sha256: snapshot.sha256,
        page: { chapter: pageOf(dragging.key)?.chapterIndex, index: pageOf(dragging.key)?.index },
        to: { chapter: landing.chapterIndex, index: landing.index, position: gap.position },
      }
      : {
        op: 'move-block',
        base_sha256: snapshot.sha256,
        anchor: dragging.anchor,
        to: { chapter: landing.chapterIndex, index: landing.index, before: gap.before },
      };
    const movedPage = dragging.kind === 'page' ? pageOf(dragging.key) : null;
    hooks.status('重排中');
    let receipt;
    try {
      receipt = await hooks.reorder(body);
    } catch (error) {
      hooks.status(`重排失败 · ${error.message}`, true);
      return;
    }
    if (!receipt.ok) {
      hooks.status(`重排失败 · ${receipt.error ?? receipt.status ?? '未知错误'}`, true);
      return;
    }
    hooks.apply(receipt);
    hooks.status(receipt.changed ? '已自动保存' : '位置没变');
    if (dragging.kind === 'block') {
      focusAnchor(dragging.anchor);
    } else if (movedPage) {
      const now = receipt.pages.find((page) => (movedPage.anchor && page.anchor === movedPage.anchor)
        || (!movedPage.anchor && page.title === movedPage.title));
      if (now) scrollToPage(now.key);
    }
  }

  // ── Alt+↑↓ ──────────────────────────────────────────────────────────────

  async function onKeydown(event) {
    if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey) return;
    const node = blockNodeFromSelection();
    const anchor = node?.dataset.anchor;
    if (!anchor) return;
    const snapshot = state.hooks?.snapshot();
    if (!snapshot) return;
    const index = snapshot.blocks.findIndex((block) => block.anchor === anchor);
    if (index < 0) return;
    // ↑ 插到上一块之前；↓ 插到「下一块的下一块」之前，下一块是本页最后一块时落到页末。
    // 直接把 ↓ 写成「插到下一块之前」就等于没动（那正是它现在的位置）。
    const gap = stepGap(snapshot.blocks, index, event.key === 'ArrowUp' ? 'up' : 'down');
    if (!gap) return;
    event.preventDefault();
    if (node.__dirty) await state.hooks.save(node);
    await submit({ kind: 'block', anchor }, gap);
  }

  function blockNodeFromSelection() {
    const selection = getSelection();
    const node = selection?.anchorNode;
    const element = node?.nodeType === 3 ? node.parentElement : node;
    const fromSelection = element?.closest?.('.doc-block');
    if (fromSelection) return fromSelection;
    return document.activeElement?.closest?.('.doc-block') ?? null;
  }

  // ── 目录：跳转与滚动高亮 ─────────────────────────────────────────────────

  function onTocClick(event) {
    const button = event.target.closest?.('#toc [data-page]');
    if (!button) return;
    scrollToPage(button.dataset.page);
  }

  function scrollToPage(key) {
    const node = state.root?.querySelector(`[data-page-key="${key}"]`);
    if (!node) return;
    const bar = document.querySelector('.topbar');
    const offset = (bar?.getBoundingClientRect().height ?? 0) + 16;
    const top = node.getBoundingClientRect().top + window.scrollY - offset;
    window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  }

  function scheduleActive() {
    if (state.activeFrame) return;
    state.activeFrame = window.requestAnimationFrame(() => {
      state.activeFrame = 0;
      updateActive();
    });
  }

  /** 当前页 = 最后一个已经滚过（标题在顶部留白之上）的页。 */
  function updateActive() {
    const root = state.root;
    const toc = state.toc;
    if (!root || !toc) return;
    const dividers = [...root.querySelectorAll('[data-page-key]')];
    if (!dividers.length) return;
    const bar = document.querySelector('.topbar');
    const offset = (bar?.getBoundingClientRect().height ?? 0) + 24;
    let active = dividers[0].dataset.pageKey;
    for (const divider of dividers) {
      if (divider.getBoundingClientRect().top - offset <= 0) active = divider.dataset.pageKey;
    }
    for (const button of toc.querySelectorAll('[data-page]')) {
      const current = button.dataset.page === active;
      button.classList.toggle('is-current', current);
      if (current) button.setAttribute('aria-current', 'true');
      else button.removeAttribute('aria-current');
    }
  }

  function focusAnchor(anchor) {
    const node = state.root?.querySelector(`[data-anchor="${anchor}"]`);
    if (!node) return;
    node.scrollIntoView({ block: 'nearest' });
    node.querySelector('.block-text[contenteditable="true"]')?.focus({ preventScroll: true });
  }

  function pageOf(key) {
    const snapshot = state.hooks?.snapshot();
    return snapshot?.pages.find((page) => page.key === key) ?? null;
  }

  return {
    render,
    mount: render,
    blockGaps,
    pageGaps,
    nearestGap,
    stepGap,
  };
});
