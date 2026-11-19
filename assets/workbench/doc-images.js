/**
 * 图块显示：按正文里的 Markdown 引用就地显示、点开放大、取不到就说明白。
 *
 * 三条边界：
 *   · 只认正文给的相对路径 —— 图片地址一律走工作台的 `/asset`，不把它拼进 DOM 当 HTML；
 *   · SVG 只进 `<img>` —— 不内联、不用 object / iframe，里面的脚本没有执行机会；
 *   · 放大是只读的 —— 这个文件不发任何写请求，也不参与块保存，锁定的图块照样能看。
 *
 * 纯函数（路径 / 失败文案 / 缩放档位）在 Node 侧直接可测；DOM 部分只负责接线。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DocImages = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const FAILURE_LABEL = '未能加载';
  const ZOOM_MIN = 0.25;
  const ZOOM_MAX = 8;
  const ZOOM_STEP = 1.25;
  const round = (value) => Math.round(value * 100) / 100;

  function clampZoom(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return 1;
    return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, round(number)));
  }

  function zoomStep(value, direction) {
    const current = clampZoom(value);
    return clampZoom(direction >= 0 ? current * ZOOM_STEP : current / ZOOM_STEP);
  }

  /** 图片一律从 `/asset` 取；`v` 是清单里的指纹前缀，换文件后地址跟着变，不吃旧缓存。 */
  function assetUrl(path, version) {
    const base = `/asset?path=${encodeURIComponent(path)}`;
    const stamp = typeof version === 'string' ? version.slice(0, 12) : '';
    return stamp ? `${base}&v=${encodeURIComponent(stamp)}` : base;
  }

  function failureText(image) {
    return `${FAILURE_LABEL} · ${image?.path ?? ''}`;
  }

  // ── 浏览器侧：图块与放大浮层 ─────────────────────────────────────────────

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function render(image, options = {}) {
    const figure = element('figure', 'image-figure');
    const button = element('button', 'image-open');
    button.type = 'button';
    button.setAttribute('aria-label', `放大查看：${image.alt || image.path}`);
    const img = document.createElement('img');
    img.src = assetUrl(image.path, options.version);
    img.alt = image.alt || '';
    img.loading = 'lazy';
    img.draggable = false;
    button.append(img);

    const failed = element('div', 'image-failed');
    failed.hidden = true;
    const reason = element('span', 'image-failed-text', failureText(image));
    const retry = element('button', 'image-retry', '重试');
    retry.type = 'button';
    retry.addEventListener('click', () => {
      failed.hidden = true;
      button.hidden = false;
      img.src = `${assetUrl(image.path, options.version)}&retry=${Date.now()}`;
    });
    failed.append(reason, retry);

    img.addEventListener('error', () => {
      figure.classList.add('is-failed');
      button.hidden = true;
      failed.hidden = false;
    });
    img.addEventListener('load', () => {
      figure.classList.remove('is-failed');
      failed.hidden = true;
      button.hidden = false;
    });
    button.addEventListener('click', () => {
      openViewer({
        src: img.currentSrc || img.src,
        alt: image.alt,
        path: image.path,
      });
    });

    const caption = element('figcaption', 'image-caption', image.alt || '');
    if (!image.alt) caption.hidden = true;
    figure.append(button, failed, caption);
    return figure;
  }

  let viewer = null;
  let state = null;
  let lastFocus = null;

  function ensureViewer() {
    if (viewer) return viewer;
    viewer = element('div', 'image-viewer');
    viewer.hidden = true;
    viewer.setAttribute('role', 'dialog');
    viewer.setAttribute('aria-modal', 'true');
    viewer.setAttribute('aria-label', '图片放大');

    const bar = element('div', 'image-viewer-bar');
    const name = element('span', 'image-viewer-name');
    const scale = element('span', 'image-viewer-scale');
    const actions = element('div', 'image-viewer-actions');
    const buttons = [
      ['out', '−', '缩小'],
      ['fit', '适应', '适应窗口'],
      ['actual', '1:1', '原始大小'],
      ['in', '+', '放大'],
      ['close', '关闭', '关闭'],
    ];
    for (const [action, label, aria] of buttons) {
      const control = element('button', 'image-viewer-button', label);
      control.type = 'button';
      control.dataset.imageZoom = action;
      control.setAttribute('aria-label', aria);
      control.addEventListener('click', () => applyZoomAction(action));
      actions.append(control);
    }
    bar.append(name, scale, actions);

    const stage = element('div', 'image-viewer-stage');
    stage.tabIndex = -1;
    const img = element('img', 'image-viewer-image');
    img.alt = '';
    img.draggable = false;
    img.addEventListener('load', () => {
      if (!state) return;
      state.naturalWidth = img.naturalWidth || 0;
      state.naturalHeight = img.naturalHeight || 0;
      applyZoom();
    });
    img.addEventListener('click', () => {
      if (!state) return;
      if (state.mode === 'fit') {
        state.mode = 'actual';
        state.scale = 1;
      } else {
        state.mode = 'fit';
        state.scale = 1;
      }
      applyZoom();
    });
    stage.append(img);

    viewer.append(bar, stage);
    viewer.addEventListener('click', (event) => {
      if (event.target === viewer || event.target === stage) closeViewer();
    });
    stage.addEventListener('wheel', onViewerWheel, { passive: false });
    document.addEventListener('keydown', onViewerKeydown);
    document.body.append(viewer);
    return viewer;
  }

  function applyZoom() {
    if (!viewer || !state) return;
    const img = viewer.querySelector('.image-viewer-image');
    const label = viewer.querySelector('.image-viewer-scale');
    if (!img || !label) return;
    if (state.mode === 'fit') {
      img.style.width = '';
      img.style.height = '';
      img.classList.add('is-fit');
      label.textContent = '适应窗口';
      return;
    }
    img.classList.remove('is-fit');
    const width = state.naturalWidth ? Math.max(1, Math.round(state.naturalWidth * state.scale)) : 0;
    if (width) img.style.width = `${width}px`;
    img.style.height = 'auto';
    label.textContent = `${Math.round(state.scale * 100)}%`;
  }

  function applyZoomAction(action) {
    if (!state) return;
    if (action === 'close') { closeViewer(); return; }
    if (action === 'fit') {
      state.mode = 'fit';
      state.scale = 1;
    } else if (action === 'actual') {
      state.mode = 'actual';
      state.scale = 1;
    } else if (action === 'in' || action === 'out') {
      // 从「适应窗口」起放大时，以**当前显示宽度**为基准，而不是图片的 intrinsic 宽度：
      // 只有 viewBox 的 SVG intrinsic 往往很小，按它算会让「+」反而缩小。
      const img = viewer.querySelector('.image-viewer-image');
      const current = state.mode === 'fit' && state.naturalWidth && img
        ? img.getBoundingClientRect().width / state.naturalWidth
        : state.scale;
      state.scale = zoomStep(current, action === 'in' ? 1 : -1);
      state.mode = 'actual';
    }
    applyZoom();
  }

  function onViewerKeydown(event) {
    if (!viewer || viewer.hidden) return;
    if (event.key === 'Escape') { event.preventDefault(); closeViewer(); return; }
    if (event.key === '+' || event.key === '=') { event.preventDefault(); applyZoomAction('in'); return; }
    if (event.key === '-' || event.key === '_') { event.preventDefault(); applyZoomAction('out'); return; }
    if (event.key === '0') { event.preventDefault(); applyZoomAction('fit'); }
  }

  function onViewerWheel(event) {
    if (!event.ctrlKey && !event.metaKey) return; // 普通滚轮留给滚动，方便看裁切
    event.preventDefault();
    applyZoomAction(event.deltaY < 0 ? 'in' : 'out');
  }

  function openViewer({ src, alt, path }) {
    ensureViewer();
    lastFocus = document.activeElement instanceof Element ? document.activeElement : null;
    state = { mode: 'fit', scale: 1, naturalWidth: 0, naturalHeight: 0 };
    const img = viewer.querySelector('.image-viewer-image');
    img.src = src;
    img.alt = alt || '';
    viewer.querySelector('.image-viewer-name').textContent = [alt, path].filter(Boolean).join(' · ');
    viewer.hidden = false;
    document.body.classList.add('has-image-viewer');
    applyZoom();
    viewer.querySelector('.image-viewer-stage').focus({ preventScroll: true });
  }

  function closeViewer() {
    if (!viewer || viewer.hidden) return;
    viewer.hidden = true;
    document.body.classList.remove('has-image-viewer');
    state = null;
    if (lastFocus && typeof lastFocus.focus === 'function') lastFocus.focus({ preventScroll: true });
    lastFocus = null;
  }

  return {
    FAILURE_LABEL,
    assetUrl,
    failureText,
    clampZoom,
    zoomStep,
    render,
    openViewer,
    closeViewer,
  };
});
