/**
 * 拖动与目录：六点句柄拖块、拖页标题搬整页、左侧两级目录、`Alt+↑↓`。
 *
 * 落点计算（`blockGaps` / `pageGaps` / `nearestGap`）是纯函数：给定几何，算出
 * 「插到哪两块之间」。浏览器里量 DOM 的矩形、收起原生快照、画一张跟手的幽灵和一条
 * 10px 软槽，再让落点以下的块用 transform 平移让位；落点交给页面的 transport
 * （`route: 'reorder'`）。这个文件不解析 Markdown，也不自己拼文档。
 * 视觉那一层做成 `createDragView`，几何由外面喂进来，所以「滞后一帧」「同一套槽」
 * 「只走 transform」都是能测的行为，不是只能靠眼睛看的样式。
 *
 * 与服务端的契约：一次一个动作，`move-block` 或 `move-page`，带 `base_sha256`。
 * 服务端回整份快照，页面据此重画正文、目录与页号。走哪条传输由页面的 transport 决定
 * （本地页 `/api/reorder`，侧栏桥转发 `{route: 'reorder', body}`），这个文件不关心宿主。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DocDrag = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ── 落点：纯几何 ─────────────────────────────────────────────────────────

  /** 最近的一个落点（软槽落下去的位置）。 */
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
   * `before: null` 表示「这一页的末尾」。页外块（page 为空）不产生页内落点，
   * 但它们本身仍可拖动、仍可落到下面这些落点上。
   */
  function blockGaps(items) {
    const gaps = [];
    let index = 0;
    while (index < items.length) {
      if (!items[index].page) { index += 1; continue; }
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
   * 页外落点：每一章标题下（本章第一页的页头位置）可以「先搬出页」。
   * 这是中间态，不是错误：搬出去以后还能再拖回任一页。
   * pages: [{key, chapterIndex, chapter}]，按文档顺序。
   */
  function outsideGaps(pages, topOf) {
    const gaps = [];
    const seen = new Set();
    for (const page of pages) {
      if (seen.has(page.chapterIndex)) continue;
      seen.add(page.chapterIndex);
      const top = topOf(page.key);
      if (top === null) continue;
      gaps.push({
        y: top + 10,
        page: page.key,
        before: null,
        outside: true,
        chapter: page.chapterIndex,
        chapterTitle: page.chapter,
      });
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
    if (!neighbour?.page?.key) return null;
    const after = blocks[index + 2];
    return up
      ? { page: neighbour.page.key, before: neighbour.anchor }
      : { page: neighbour.page.key, before: after?.page?.key === neighbour.page.key ? after.anchor : null };
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
    view: null,
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
    decorate(root, snapshot);
    renderToc(snapshot);
    updateActive();
    bindOnce();
  }

  /** 锁定（模型正在改）与待核对（等裁决）的块都不是可编辑块：不给拖柄，也不给整页拖柄。 */
  function blockedNode(node, entry) {
    return node.classList.contains('is-locked') || node.classList.contains('is-deferred')
      || Boolean(entry?.locked || entry?.deferred);
  }

  function decorate(root, snapshot) {
    if (snapshot.readonly) return; // 旧 JSON 主稿只读：目录照常，正文不给拖柄，也不接受重排
    const byAnchor = new Map(snapshot.blocks.map((block) => [block.anchor, block]));
    for (const node of root.querySelectorAll('.doc-block[data-anchor]')) {
      const entry = byAnchor.get(node.dataset.anchor);
      if (entry) node.dataset.pageKey = entry.page.key ?? '';
      if (blockedNode(node, entry)) {
        node.querySelector(':scope > .block-handle')?.remove();
        continue;
      }
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
      const key = divider.dataset.pageKey;
      const blocked = [...root.querySelectorAll('.doc-block[data-anchor]')]
        .some((node) => node.dataset.pageKey === key && blockedNode(node, byAnchor.get(node.dataset.anchor)));
      if (title) {
        title.draggable = !blocked;
        title.title = blocked ? '页内有块正被模型处理或待核对，不能拖整页' : '拖动标题移动整页';
      }
      if (blocked) {
        divider.querySelector(':scope > .page-handle')?.remove();
        continue;
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

  /** 锁 / 待核对变化后只重算拖柄：不重画正文，不丢光标与未保存的编辑。 */
  function refresh() {
    if (!isBrowser || !state.root || !state.hooks) return;
    decorate(state.root, state.hooks.snapshot());
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
    document.addEventListener('drag', onDrag);
    document.addEventListener('dragover', onDragOver);
    document.addEventListener('drop', onDrop);
    document.addEventListener('dragend', finishDrag);
    document.addEventListener('keydown', onKeydown);
    document.addEventListener('click', onTocClick);
    window.addEventListener('scroll', scheduleActive, { passive: true });
    window.addEventListener('resize', scheduleActive);
  }

  // ── 拖动表现：幽灵、软槽、让位 ────────────────────────────────────────────
  //
  // 这一层只碰 DOM：喂它拖动状态与量好的几何，它画出跟随的幽灵、落点软槽，
  // 并让落点以下的块平移让位。文档怎么变不归它管（那是 submit 的事）。
  // 浏览器里默认拿真 document / requestAnimationFrame；测试从参数塞进来。

  /** 1×1 透空 GIF。原生快照只能被一张图顶掉，于是给它一张看不见的。 */
  const TRANSPARENT_PIXEL = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

  /** 软槽的高度：块让位也让这么多。 */
  const SLOT_HEIGHT = 10;

  function suppressNativeSnapshot(dataTransfer, doc) {
    if (!dataTransfer?.setDragImage) return null;
    const image = doc.createElement('img');
    image.className = 'drag-shot';
    image.src = TRANSPARENT_PIXEL;
    image.width = 1;
    image.height = 1;
    image.setAttribute('alt', '');
    doc.body.append(image); // 少数浏览器只认已经挂在页面里的图
    try { dataTransfer.setDragImage(image, 0, 0); } catch { /* 藏不掉就退回系统快照，不假装 */ }
    return image;
  }

  /** 幽灵里放什么：块放这一段字，页放章节 · 标题。不克隆正文，免得把编辑器搬来搬去。 */
  const GHOST_META = { paragraph: '段落', heading: '标题', quote: '引用', list: '列表', table: '表格', code: '代码', image: '图片' };

  function ghostCopy(dragging) {
    if (dragging.kind === 'page') {
      const title = dragging.node.querySelector?.('.page-title')?.textContent?.trim() ?? '';
      const chapter = dragging.node.querySelector?.('.page-chapter')?.textContent?.trim() ?? '';
      return { meta: '整页', text: [chapter, title].filter(Boolean).join(' · ') || '这一页' };
    }
    const type = dragging.node.dataset?.type;
    return {
      meta: GHOST_META[type] ?? '段落',
      text: dragging.node.querySelector?.('.block-text')?.textContent?.trim().slice(0, 120) || '这一段',
    };
  }

  function buildGhost(doc, dragging) {
    const copy = ghostCopy(dragging);
    const ghost = doc.createElement('div');
    ghost.className = 'drag-ghost';
    ghost.setAttribute('aria-hidden', 'true');
    const card = doc.createElement('div');
    card.className = 'drag-ghost-card';
    const width = dragging.node.getBoundingClientRect?.().width;
    // 整页的幽灵不铺满整张纸：一条窄卡片跟手，看得见要放到哪，也不盖住落点。
    if (width) card.style.width = `${Math.round(dragging.kind === 'page' ? Math.min(width, 320) : width)}px`;
    const meta = doc.createElement('span');
    meta.className = 'drag-ghost-meta';
    meta.textContent = copy.meta;
    const text = doc.createElement('div');
    text.className = 'drag-ghost-text';
    text.textContent = copy.text;
    card.append(meta, text);
    ghost.append(card);
    return ghost;
  }

  /**
   * 落点以下的块各让开一条槽。返回 `[{anchor, dy}]`，不返回颜色——
   * 让位只走 transform，整行变色是另一套语言。
   */
  function shiftPlan(items, y, dy = SLOT_HEIGHT) {
    return (items ?? [])
      .filter((item) => item.top >= y - 0.5)
      .map((item) => ({ anchor: item.anchor, dy }));
  }

  /** 把让位落到 transform 上；位移记在 dataset.shift 里，下次量落点要减掉它。 */
  function applyShifts(nodes, plan, skip) {
    const wanted = new Map((plan ?? []).map((entry) => [entry.anchor, entry.dy]));
    for (const node of nodes ?? []) {
      if (node === skip) continue;
      const next = wanted.get(node.dataset.anchor) ?? 0;
      if (next === Number(node.dataset.shift || 0)) continue; // 位置没变就不重启动画
      node.dataset.shift = next ? String(next) : '';
      node.style.transform = next ? `translateY(${next}px)` : '';
    }
  }

  /**
   * 拖动视图。`ghost` / `line` / `label` 是它画出来的东西，拖动过程中只许读。
   * `frame` 可注入，是为了让「跟手滞后一帧」能被测：一帧里连动三次，第一帧只画第一次的位置。
   */
  function createDragView(env = {}) {
    const doc = env.document ?? (isBrowser ? document : null);
    if (!doc) throw new Error('拖动视图需要一个 document');
    const frame = env.frame ?? ((callback) => window.requestAnimationFrame(callback));
    const scroll = env.scroll ?? (() => ({ x: window.scrollX, y: window.scrollY }));
    const view = { ghost: null, shot: null, line: null, label: null, dragging: null, nodes: null, pendingFrame: 0, queued: null };

    function ensureLine() {
      if (view.line) return view.line;
      let line = doc.getElementById?.('dropLine') ?? null;
      if (!line) {
        line = doc.createElement('div');
        line.id = 'dropLine';
        line.className = 'drop-line is-slot';
        line.hidden = true;
        view.label = doc.createElement('span');
        view.label.className = 'drop-label';
        line.append(view.label);
        doc.body.append(line);
      } else {
        view.label = line.querySelector?.('.drop-label') ?? null;
      }
      view.line = line;
      return line;
    }

    function place(point) {
      if (!view.ghost || !point) return;
      view.ghost.style.transform = `translate3d(${Math.round(point.x)}px, ${Math.round(point.y)}px, 0)`;
    }

    function begin({ dragging, point, dataTransfer }) {
      end();
      view.dragging = dragging;
      view.shot = suppressNativeSnapshot(dataTransfer, doc);
      dragging.node.classList.add('is-dragging');
      doc.body.classList.add('is-reordering');
      view.ghost = buildGhost(doc, dragging);
      doc.body.append(view.ghost);
      place(point);
    }

    /** 跟手滞后一帧：这一帧画的是「排这一帧时」的鼠标位置，不是回调那一刻的。 */
    function move(point) {
      if (!view.ghost || !point) return;
      view.queued = point;
      if (view.pendingFrame) return;
      const scheduled = point;
      view.pendingFrame = frame(() => {
        view.pendingFrame = 0;
        place(scheduled);
        if (view.queued && view.queued !== scheduled) move(view.queued);
      });
    }

    function hover({ gap, dragging, label, items, nodes, origin }) {
      const line = ensureLine();
      view.nodes = nodes ?? view.nodes;
      if (!gap) {
        line.hidden = true;
        applyShifts(view.nodes, [], dragging?.node);
        return;
      }
      const offset = scroll();
      line.hidden = false;
      line.style.left = `${origin.left + offset.x}px`;
      line.style.width = `${origin.width}px`;
      line.style.top = `${gap.y + offset.y}px`;
      if (view.label) view.label.textContent = label ?? '';
      applyShifts(view.nodes, shiftPlan(items, gap.y), dragging?.node);
    }

    function end() {
      view.ghost?.remove?.();
      view.ghost = null;
      view.shot?.remove?.();
      view.shot = null;
      view.queued = null;
      applyShifts(view.nodes, [], null); // 落点没落成也要把让位收回去
      view.nodes = null;
      view.dragging?.node?.classList.remove('is-dragging');
      doc.body.classList.remove('is-reordering');
      if (view.line) view.line.hidden = true;
      view.dragging = null;
    }

    return {
      begin, move, hover, end,
      get ghost() { return view.ghost; },
      get line() { return view.line; },
      get label() { return view.label; },
    };
  }

  function dragView() {
    if (!state.view) state.view = createDragView();
    return state.view;
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
    }
    dragView().begin({
      dragging,
      point: { x: event.clientX, y: event.clientY },
      dataTransfer: event.dataTransfer,
    });
  }

  function onDrag(event) {
    if (!state.dragging) return;
    pushGhost(event.clientX, event.clientY);
  }

  function onDragOver(event) {
    if (!state.dragging) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    const layout = layoutFor(state.dragging);
    const gap = nearestGap(layout.gaps, event.clientY);
    state.gap = gap;
    dragView().hover({
      gap,
      dragging: state.dragging,
      label: gapLabel(gap, state.dragging, {
        page: (key) => pageOf(key),
        blockText: (anchor) => state.hooks?.snapshot().blocks.find((block) => block.anchor === anchor)?.inline,
      }),
      items: layout.items,
      nodes: layout.nodes,
      origin: layout.origin,
    });
    pushGhost(event.clientX, event.clientY);
  }

  /** 有些浏览器在 drag 里给 (0, 0)，那不是鼠标位置，别把幽灵甩到左上角。 */
  function pushGhost(x, y) {
    if (!x && !y) return;
    dragView().move({ x, y });
  }

  async function onDrop(event) {
    if (!state.dragging) return;
    event.preventDefault();
    const dragging = state.dragging;
    const gap = nearestGap(layoutFor(dragging).gaps, event.clientY) ?? state.gap;
    finishDrag();
    if (!gap) return;
    await submit(dragging, gap);
  }

  function finishDrag() {
    state.view?.end();
    state.dragging = null;
    state.gap = null;
  }

  /**
   * 量出当前 DOM 的落点与让位几何。让位用 transform 实现，量的时候要把已经让开的那点
   * 减回去（dataset.shift），否则块让开 → 落点前移 → 块收回 → 落点又回来的抖动。
   */
  function layoutFor(dragging) {
    const root = state.root;
    const origin = { left: 0, width: 0 };
    if (!root) return { gaps: [], items: [], nodes: [], origin };
    const rect = root.getBoundingClientRect();
    origin.left = rect.left;
    origin.width = rect.width;
    const nodes = [...root.querySelectorAll('.doc-block[data-anchor]')];
    const items = nodes.map((node) => {
      const box = node.getBoundingClientRect();
      const shift = Number(node.dataset.shift || 0);
      return { anchor: node.dataset.anchor, page: node.dataset.pageKey, top: box.top - shift, bottom: box.bottom - shift };
    });
    if (dragging.kind !== 'page') {
      const topOf = (key) => {
        const divider = root.querySelector(`.page-divider[data-page-key="${key}"]`);
        return divider ? divider.getBoundingClientRect().top : null;
      };
      // 每章多一个「搬到页外」的落点：块先出页（中间态），之后还能再拖回任一页。
      return {
        gaps: blockGaps(items).concat(outsideGaps(state.hooks?.snapshot().pages ?? [], topOf)),
        items,
        nodes,
        origin,
      };
    }
    const pages = [...root.querySelectorAll('.page-divider[data-page-key]')].map((divider) => {
      const box = divider.getBoundingClientRect();
      const shift = Number(divider.dataset.shift || 0);
      const own = items.filter((item) => item.page === divider.dataset.pageKey);
      const last = own[own.length - 1];
      return {
        key: divider.dataset.pageKey,
        chapterIndex: pageOf(divider.dataset.pageKey)?.chapterIndex ?? 0,
        top: box.top - shift,
        bottom: last ? last.bottom : box.bottom - shift,
      };
    });
    return { gaps: pageGaps(pages), items, nodes, origin };
  }

  /**
   * 落点标签。块说清插到哪一块；整页只说「整页移动」——整页拖动不换颜色，
   * 只换这几个字，落点还是同一条软槽。
   */
  function gapLabel(gap, dragging, lookup) {
    if (dragging.kind === 'page') return '整页移动';
    if (gap.outside) return `移到「${gap.chapterTitle ?? ''}」章节下的页外`;
    if (!gap.before) return `移到「${lookup?.page?.(gap.page)?.title ?? ''}」末尾`;
    const text = String(lookup?.blockText?.(gap.before) ?? '').replace(/\s+/g, ' ').slice(0, 12);
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
        // 页外落点：块先搬到章节标题下（不属于任何页），之后还能再拖回页里。
        to: gap.outside
          ? { chapter: gap.chapter, outside: true }
          : { chapter: landing.chapterIndex, index: landing.index, before: gap.before },
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
    if (node.classList.contains('is-locked') || node.classList.contains('is-deferred')) {
      state.hooks?.status?.('这一块正被模型处理或待核对，不能移动', true);
      return;
    }
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
    refresh,
    focusAnchor,
    scrollToPage,
    blockGaps,
    pageGaps,
    outsideGaps,
    nearestGap,
    stepGap,
    gapLabel,
    shiftPlan,
    applyShifts,
    createDragView,
    suppressNativeSnapshot,
    TRANSPARENT_PIXEL,
    SLOT_HEIGHT,
  };
});
