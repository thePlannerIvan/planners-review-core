/**
 * 出处：页末连续的引用默认收起成一条，点开才见（契约第 5 节，票 22）。
 *
 * 解析器已经把页末连续的引用认成出处区（`page.sources`，块上 `in_sources`）；
 * 这个文件只管**怎么摆**，不重新判定谁算出处：
 *   · 收起：正文照常逐块，出处只出一条 32px 的「出处 · N」条；
 *   · 展开：正文之后，每条引用按普通块摆出来，组尾一个「＋ 出处」；
 *   · 页中段的引用 `in_sources` 是 false，永远按普通块摆。
 *
 * 摆法是纯数据（见 `layoutPage`），浏览器里由 `doc-workbench.js` 照着造 DOM，
 * Node 侧用同一份数据断言「收起时只摆一条」这类行为，不依赖像素。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DocSources = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SOURCE_LABEL = '出处';

  /** 「出处 · 3」：条数是数据，标签只是它的一种写法。 */
  function labelOf(count) {
    return `${SOURCE_LABEL} · ${count}`;
  }

  /**
   * 两端的记号：收起时 `› … ‹` 表示「点开」；展开后同一位置反过来，
   * 表示「收起」。记号是整条按钮的装饰，不单独可点。
   */
  function marksOf(expanded) {
    return expanded ? { lead: '‹', trail: '›' } : { lead: '›', trail: '‹' };
  }

  const isSource = (block) => block?.in_sources === true || block?.inSources === true;

  /**
   * 切出一页的正文与出处区。只从页末往前收：遇到第一个不是出处的块就停，
   * 所以页中段的引用（`in_sources` 为 false）留在正文，不会被误收。
   */
  function splitSources(blocks) {
    const all = Array.isArray(blocks) ? blocks : [];
    let start = all.length;
    while (start > 0 && isSource(all[start - 1])) start -= 1;
    return { body: all.slice(0, start), sources: all.slice(start) };
  }

  /**
   * 一页的摆法。正文永远逐块；出处区按展开状态二选一：
   *   · 收起 → 一条 `{kind:'sources', collapsed:true, count, label}`；
   *   · 展开 → 一条 `{kind:'sources-head'}`，每条引用一条 `{kind:'block'}`
   *     （与正文块同一种，所以同样可编辑），组尾再一条 `{kind:'add-source'}`。
   */
  function layoutPage(blocks, { expanded = false } = {}) {
    const { body, sources } = splitSources(blocks);
    const plan = body.map((block) => ({ kind: 'block', block }));
    if (!sources.length) return plan;
    if (!expanded) {
      plan.push({
        kind: 'sources', collapsed: true, count: sources.length, label: labelOf(sources.length), blocks: sources,
      });
      return plan;
    }
    plan.push({
      kind: 'sources-head', expanded: true, count: sources.length, label: labelOf(sources.length),
    });
    for (const block of sources) plan.push({ kind: 'block', block });
    plan.push({ kind: 'add-source', count: sources.length, label: labelOf(sources.length) });
    return plan;
  }

  return { labelOf, marksOf, splitSources, layoutPage, isSource, SOURCE_LABEL };
});
