/**
 * 布局：三档按**容器宽度**分，顶栏折叠键与滚动毛玻璃的状态也在这里。
 *
 * 为什么不是 CSS 一个 `@media`：工作台跑在 DSH 侧栏里，侧栏本身能被拖宽；视口一直
 * 是整块屏幕，决定「目录要不要折成图标条」的是工作台容器的宽度。三档断点**只在这个
 * 文件里定义一次**：布局状态用它算档位，`@container` 规则也由它生成后插进 `<head>`，
 * 所以 CSS 里没有第二份数字可漂移。这个文件还管两件 CSS 管不了的事：
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

  // 宽档 = 目录 240 + 纸 760 + 批注 300 + 两条 8px 间隔 = 1316。
  const LAYOUT_WIDE = 1316;
  const LAYOUT_MEDIUM = 900;
  const SCROLL_THRESHOLD = 8;

  /**
   * 三栏降级规则的唯一一份：断点与每档的尺寸都从这里出。
   * 值是 `container-type: inline-size` 的容器宽度；差 0.02px 用来表达「不到下一档」。
   */
  function containerCSS() {
    const below = (value) => value - 0.02;
    return `@container workbench (min-width: ${LAYOUT_WIDE}px) {
  .toc-panel { flex-basis: 240px; width: 240px; }
  .doc { flex-basis: 760px; width: 760px; }
  .notes-panel { flex-basis: 300px; width: 300px; }
}

@container workbench (max-width: ${below(LAYOUT_WIDE)}px) {
  .toc-panel { flex-basis: 48px; width: 48px; padding: 20px 6px 40px; }
  .toc-chapter {
    height: 1px; margin: 10px 6px; padding: 0;
    overflow: hidden; font-size: 0; background: var(--line);
  }
  .toc-page { width: 36px; margin: 0 auto; justify-content: center; padding: 6px 0; }
  .toc-number { min-width: 0; font-size: 12px; }
  .toc-title { display: none; }
  .doc { flex: 1 1 auto; width: auto; max-width: var(--paper-w); min-width: 520px; }
  .notes-panel { flex-basis: 280px; width: 280px; }
}

@container workbench (max-width: ${below(LAYOUT_MEDIUM)}px) {
  .notes-panel:not(.is-overlay) { display: none; }
  .doc { flex: 1 1 auto; width: auto; }
}
`;
  }

  /** 把生成的三栏规则挂进当前文档；Node 里（没有 document）什么也不做。 */
  function installContainerCSS(doc = typeof document === 'undefined' ? null : document) {
    if (!doc?.head || !doc.createElement) return null;
    const existing = doc.getElementById?.('doc-layout-container');
    if (existing) return existing;
    const style = doc.createElement('style');
    style.id = 'doc-layout-container';
    style.dataset.source = 'doc-layout';
    style.textContent = containerCSS();
    doc.head.append(style);
    return style;
  }

  if (typeof document !== 'undefined') installContainerCSS();

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

  return {
    LAYOUT_WIDE, LAYOUT_MEDIUM, SCROLL_THRESHOLD, containerCSS, installContainerCSS, layoutMode, createLayout,
  };
});
