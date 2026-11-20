/**
 * 批注抽屉的分组规则：按页组织，同一块的多条收成一个计数气泡。
 *
 * 浏览器里由 `doc-workbench.js` 调用；Node 侧只喂数组就能断言同一条规则
 * （见 test_doc_notes）。这里不碰 DOM，也不发命令 —— 它只回答「抽屉里该出现
 * 哪几页、每页哪几块、每块几条」。
 *
 * 为什么按块收：同一块上人可能连着提三条，摊开会把抽屉撑散；计数气泡点开才展开
 * 该块的全部批注。草稿与已提交分开两组，因为前者还能删、后者已在模型手里。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./doc-identity.js'));
  else root.DocNotes = factory(root.DocIdentity);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Identity) {
  'use strict';

  const STATES = ['draft', 'committed', 'resolved'];

  // 页身份只有一处定义：契约里的 chapter-index 由 doc-identity.js 统一拼。
  const { pageKeyOf } = Identity;

  /** 页的显示信息以快照为准；快照里找不到（页被删了）时至少给一个能读的标题。 */
  function pageInfo(note, pages) {
    const key = pageKeyOf(note.page);
    const found = pages.find((page) => page.key === key) ?? null;
    return {
      key,
      chapter: note.page?.chapter ?? 0,
      index: note.page?.index ?? 0,
      chapterTitle: found?.chapter ?? '未归章',
      title: found?.title ?? '页已被删掉',
    };
  }

  function stateGroup(notes, { pages, order }) {
    const pageMap = new Map();
    for (const note of [...notes].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))) {
      const info = pageInfo(note, pages);
      if (!pageMap.has(info.key)) pageMap.set(info.key, { ...info, count: 0, blocks: new Map() });
      const page = pageMap.get(info.key);
      if (!page.blocks.has(note.anchor)) {
        page.blocks.set(note.anchor, { anchor: note.anchor, count: 0, notes: [] });
      }
      const block = page.blocks.get(note.anchor);
      block.notes.push(note);
      block.count += 1;
      page.count += 1;
    }
    const pagesOut = [...pageMap.values()]
      .sort((a, b) => (a.chapter - b.chapter) || (a.index - b.index))
      .map((page) => ({
        ...page,
        blocks: [...page.blocks.values()].sort((a, b) => (
          (order.get(a.anchor) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.anchor) ?? Number.MAX_SAFE_INTEGER)
        )),
      }));
    return { count: notes.length, pages: pagesOut };
  }

  /**
   * `order` 是锚点在正文里的位置（`Map<anchor, index>`），用来让同一页里的几块
   * 按正文顺序出现，而不是按人点开的先后。
   */
  function drawer(notes, { pages = [], order = new Map() } = {}) {
    const list = Array.isArray(notes) ? notes : [];
    const result = {};
    for (const state of STATES) {
      result[state] = stateGroup(list.filter((note) => note.state === state), { pages, order });
    }
    return result;
  }

  /**
   * 历史批注：只给人看「当初那句话 + 时间 + 所在页」。
   * 快照（改前 / 改后块 raw）故意不出现在这里 —— 它是给模型回查的，不进列表。
   *
   * 「模型没动这条」也在这里：抽屉只留正文 / 时间 / 删除三样，这条没归档的批注
   * 退回历史面板，仍可重新打开；`model_state` 让列表能如实标出来，不靠文本猜。
   */
  function history(notes, { pages = [] } = {}) {
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
        page: pageInfo(note, pages),
      }));
  }

  return { drawer, history, STATES };
});
