/**
 * 文档身份的最后一道共享定义：页身份、页末落点、出处标记。
 *
 * 这三样都是**契约**，不是某一侧的排版细节：服务端（解析 / 重排 / 结构 diff / 快照）、
 * 页面（批注分组、拖动落点、出处渲染）必须给出同一个答案。以前 `chapter-index` 在
 * 七八个地方各拼一遍、「是不是页末」在客户端与服务端各判一遍，任何一处改标点都会让
 * 两条路对同一份文档说不同的话。这个文件是唯一一份，Node 与浏览器都从这里取。
 *
 * UMD：Node 侧 `require` / `import`，浏览器侧挂在 `window.DocIdentity`。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DocIdentity = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /**
   * 页身份 = 章节号 + 页内序号，写作 `"1-2"`。
   * 接受三种已有形状，因为它们就是同一件事的不同投影：
   *   · 解析器 / 视图页：`{ chapter: { index }, index }`；
   *   · 扁平页（diff 基准）：`{ chapter, index }`；
   *   · 块上记的页（diff 的 blocks）：`{ chapter, page }`。
   */
  function pageKeyOf(page) {
    if (!page) return null;
    const chapter = page.chapter && typeof page.chapter === 'object' ? page.chapter.index : page.chapter;
    const index = page.index ?? page.page;
    return `${chapter ?? 0}-${index ?? 0}`;
  }

  /** 页末落点：`before` 为空表示「这一页的末尾」。两处重排判据都读这一条。 */
  function isPageEnd(before) {
    return before === null || before === undefined;
  }

  /** 出处块：契约只有 `in_sources` 一种拼写，不再兼容第二种。 */
  function isSource(block) {
    return block?.in_sources === true;
  }

  return { pageKeyOf, isPageEnd, isSource };
});
