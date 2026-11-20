/**
 * 布局：三档按**容器宽度**分，顶栏折叠键与滚动毛玻璃的状态也在这里。
 *
 * 为什么不是 CSS 一个 `@media`：工作台跑在 DSH 侧栏里，侧栏本身能被拖宽；视口一直
 * 是整块屏幕，决定「目录要不要折成图标条」的是工作台容器的宽度。视觉那一层仍由
 * `doc-workbench.css` 的 `@container` 决定（三档断点只有一份：1180 / 900）；这个文件
 * 只把同一个宽度换算成页面的状态，管两件 CSS 管不了的事：
 *
 *   · 折叠键按人点了没有——左栏收起 / 右栏收起是人的选择，不是宽度的函数；
 *   · 窄档下批注是**滑出层**，默认收起，点开才覆盖在纸上，而不是再挤一列。
 *
 * 纯的那一半（`layoutMode`）单独导出：几何不该靠读 DOM 才能测。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DocLayout = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const LAYOUT_WIDE = 1180;
  const LAYOUT_MEDIUM = 900;
  const SCROLL_THRESHOLD = 8;

  /** 容器宽度 → 档位。正好在断点上算宽的那一档，与 SPEC 的三栏表一致。 */
  function layoutMode(width) {
    const value = Number(width);
    if (!Number.isFinite(value) || value <= 0) return 'wide';
    if (value >= LAYOUT_WIDE) return 'wide';
    if (value >= LAYOUT_MEDIUM) return 'medium';
    return 'narrow';
  }

  function createLayout({ document: doc, body } = {}) {
    const host = doc ?? (typeof document === 'undefined' ? null : document);
    const root = body ?? host?.body ?? null;
    const state = {
      mode: 'wide',
      tocCollapsed: false,
      // 人点过折叠键之后，宽度怎么变都听人的；没点过就按档位给默认值。
      notesIntent: null,
      scrolled: false,
    };

    const notesOpen = () => state.notesIntent ?? state.mode !== 'narrow';

    // 窄档的滑出层要离开容器才躲得开 `container-type` 的 layout containment：
    // 留在容器里的 position: fixed 会相对工作台定位，页面一滚就跟着走。
    // 宽档原样放回原处——同一份面板、同一批监听，不复制第二份。
    let notesHome = null;
    function placeNotes() {
      const panel = host?.getElementById?.('notesPanel') ?? host?.querySelector?.('#notesPanel');
      if (!panel || !root) return;
      const overlay = state.mode === 'narrow';
      const inBody = panel.parentElement === root;
      if (overlay) {
        if (!inBody) {
          notesHome = notesHome ?? { parent: panel.parentElement, next: panel.nextSibling ?? null };
          if (panel.parentElement && typeof root.append === 'function') root.append(panel);
        }
        panel.classList?.add('is-overlay');
        panel.setAttribute?.('role', 'dialog');
      } else {
        if (notesHome?.parent) {
          notesHome.parent.insertBefore?.(panel, notesHome.next);
          notesHome = null;
        }
        panel.classList?.remove('is-overlay');
        panel.removeAttribute?.('role');
      }
    }

    function setClass(name, on) {
      if (!root?.classList) return;
      if (on) root.classList.add(name);
      else root.classList.remove(name);
    }

    function syncButtons() {
      for (const button of host?.querySelectorAll?.('[data-collapse]') ?? []) {
        const panel = button.dataset.collapse;
        const open = panel === 'toc' ? !state.tocCollapsed : notesOpen();
        button.setAttribute('aria-expanded', String(open));
        const label = panel === 'toc'
          ? (open ? '收起目录' : '展开目录')
          : (open ? '收起批注' : '展开批注');
        button.setAttribute('aria-label', label);
        button.setAttribute('title', label);
      }
    }

    function apply() {
      if (root) {
        setClass('is-toc-collapsed', state.tocCollapsed);
        setClass('is-notes-open', notesOpen());
        setClass('is-notes-collapsed', !notesOpen());
        setClass('is-scrolled', state.scrolled);
        if (root.dataset) root.dataset.layout = state.mode;
      }
      placeNotes();
      syncButtons();
      return state;
    }

    function measure(width) {
      state.mode = layoutMode(width);
      return apply();
    }

    function toggle(panel) {
      if (panel === 'toc') state.tocCollapsed = !state.tocCollapsed;
      else if (panel === 'notes') state.notesIntent = !notesOpen();
      return apply();
    }

    function scrolled(value) {
      state.scrolled = Boolean(value);
      return apply();
    }

    /** 容器宽度：优先量工作台本身（侧栏拖宽时它会变），量不到才退回文档宽度。 */
    function containerWidth() {
      const node = host?.querySelector?.('#workspace') ?? host?.querySelector?.('.workbench');
      const rect = node?.getBoundingClientRect?.();
      if (rect && Number.isFinite(rect.width)) return rect.width;
      return host?.documentElement?.clientWidth ?? 0;
    }

    /** 接上线：折叠键、滚动、容器尺寸。返回一个解绑函数，重画时不留两份监听。 */
    function bind() {
      if (!host) return () => {};
      const onClick = (event) => {
        const button = event?.target?.closest?.('[data-collapse]');
        if (!button) return;
        event.preventDefault?.();
        toggle(button.dataset.collapse);
      };
      host.addEventListener?.('click', onClick);

      const view = host.defaultView;
      const onScroll = () => scrolled((view?.scrollY ?? 0) > SCROLL_THRESHOLD);
      view?.addEventListener?.('scroll', onScroll, { passive: true });

      const target = host.querySelector?.('#workspace') ?? host.querySelector?.('.workbench');
      let observer = null;
      if (target && typeof ResizeObserver === 'function') {
        observer = new ResizeObserver((entries) => {
          const entry = entries?.[0];
          measure(entry?.contentRect?.width ?? containerWidth());
        });
        observer.observe(target);
      }
      measure(containerWidth());
      onScroll();

      return () => {
        host.removeEventListener?.('click', onClick);
        view?.removeEventListener?.('scroll', onScroll);
        observer?.disconnect();
      };
    }

    return {
      state,
      apply,
      bind,
      measure,
      toggle,
      scrolled,
      containerWidth,
      notesOpen,
    };
  }

  return { LAYOUT_WIDE, LAYOUT_MEDIUM, SCROLL_THRESHOLD, layoutMode, createLayout };
});
