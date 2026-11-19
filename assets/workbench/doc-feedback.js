/**
 * 选区 → 块的吸附：选区碰到哪个块，就整块算进反馈目标；半句也吸成整块。
 *
 * 浏览器里由 `doc-workbench.js` 调用；Node 侧用最小的 Range / 块节点形状跑同一份规则
 * （见 test_doc_feedback）。只依赖 `range.intersectsNode(node)` 与块节点上的
 * `data-anchor`，不碰编辑器内部结构。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DocFeedback = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function anchorsForRange(range, nodes) {
    if (!range || typeof range.intersectsNode !== 'function' || !nodes) return [];
    const anchors = [];
    const seen = new Set();
    for (const node of nodes) {
      const anchor = typeof node?.getAttribute === 'function' ? node.getAttribute('data-anchor') : null;
      if (!anchor || seen.has(anchor)) continue;
      if (range.intersectsNode(node)) {
        anchors.push(anchor);
        seen.add(anchor);
      }
    }
    return anchors;
  }

  return { anchorsForRange };
});
