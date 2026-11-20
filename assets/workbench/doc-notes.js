/**
 * 批注抽屉的排序规则：一张单子，顺序跟正文走。
 *
 * 浏览器里由 `doc-workbench.js` 调用；Node 侧只喂数组就能断言同一条规则
 * （见 test_doc_notes）。这里不碰 DOM，也不发命令 —— 它只回答「抽屉里出现哪几条、
 * 按什么顺序、每条带哪些字段」。
 *
 * 为什么不再按页分组：页名、章节名、页号在正文里已经有了，抽屉里再写一遍只是噪声。
 * 一条批注靠它引用的那句话定位（那句话由页面从块内容取，见 doc-workbench.js），
 * 抽屉自己不记位置。草稿与已提交分开两组，因为前者还能删、后者已在模型手里。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DocNotes = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const STATES = ['draft', 'committed', 'resolved'];

  /** 老文件里的批注没有 scope：按块级读，和契约的缺省语义一致。 */
  const scopeOf = (note) => (note.scope === 'doc' ? 'doc' : 'blocks');

  /** 条目只留抽屉要用的字段：没有页名、章节名、页号，页面也就没机会把它们画出来。 */
  const entryOf = (note) => ({
    id: note.id,
    scope: scopeOf(note),
    anchor: note.anchor,
    text: note.text,
    state: note.state,
    created_at: note.created_at,
  });

  /**
   * `order` 是锚点在正文里的位置（`Map<anchor, index>`）：整张单子按它排，
   * 同一块里的几条按写下时间排，而不是按人点开的先后。
   * 整份批注不属于任何一块（anchor 为 null），排在最前 —— 它说的事比任何一块都大，
   * 也正好让人一眼看出它不是某一块上的引用。
   */
  function positionOf(note, order) {
    if (scopeOf(note) === 'doc') return -1;
    return order.get(note.anchor) ?? Number.MAX_SAFE_INTEGER;
  }

  function sortByDocument(notes, order) {
    return [...notes].sort((left, right) => {
      const a = positionOf(left, order);
      const b = positionOf(right, order);
      if (a !== b) return a - b;
      return String(left.created_at).localeCompare(String(right.created_at));
    });
  }

  function stateGroup(notes, order) {
    const sorted = sortByDocument(notes, order);
    return { count: sorted.length, notes: sorted.map(entryOf) };
  }

  function drawer(notes, { order = new Map() } = {}) {
    const list = Array.isArray(notes) ? notes : [];
    const result = {};
    for (const state of STATES) {
      result[state] = stateGroup(list.filter((note) => note.state === state), order);
    }
    return result;
  }

  /**
   * 历史批注：只给人看「当初那句话 + 时间」。快照（改前 / 改后块 raw）故意不出现
   * 在这里 —— 它是给模型回查的，不进列表；页名与页号也不再重复一遍。
   *
   * 「模型没动这条」也在这里：抽屉只留正文 / 时间 / 删除三样，这条没归档的批注
   * 退回历史面板，仍可重新打开；`model_state` 让列表能如实标出来，不靠文本猜。
   */
  function history(notes) {
    const list = Array.isArray(notes) ? notes : [];
    return list
      .filter((note) => note.state === 'resolved'
        || (note.state === 'committed' && note.model_state === 'untouched'))
      .sort((left, right) => (
        String(right.resolved_at ?? right.created_at ?? '').localeCompare(String(left.resolved_at ?? left.created_at ?? ''))
        || String(right.created_at ?? '').localeCompare(String(left.created_at ?? ''))
      ))
      .map((note) => ({
        id: note.id,
        text: note.text,
        created_at: note.created_at,
        resolved_at: note.resolved_at ?? null,
        model_state: note.model_state ?? null,
      }));
  }

  return { drawer, history, STATES };
});
