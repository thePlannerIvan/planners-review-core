/**
 * 结构 diff：模型上次取稿时看到的版本 → 人这次提交批次时的版本。
 *
 * 为什么基准在盘上（`.doc-workbench/state/baseline.json`）：模型取稿与人的提交
 * 不在同一个进程、也不一定在同一分钟。基准落盘之后，diff 才可能是「模型没猜」，
 * 而不是「工作台刚看到的那一版」。
 *
 * 基准由模型侧取稿刷新（`doc-command.mjs` 的 tasks / open，模型身份）；人提交批注时
 * 拿当前结构与基准比一次，结果随任务一起给模型（`planners-doc-diff/1`）。
 * 结构快照只存身份（章节号 + 标题、页的章节 / 页号 / 标题 / 块锚点、块锚点与所属页），
 * 不存正文：diff 只说「哪里动了」，正文由模型按 `doc.path` 自己读。
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { atomicWrite, stateDirFor } from './doc-io.mjs';
import DocIdentity from '../../assets/workbench/doc-identity.js';

const { pageKeyOf } = DocIdentity;

export const DIFF_CONTRACT = 'planners-doc-diff/1';
export const BASELINE_CONTRACT = 'planners-doc-baseline/1';

const fail = (code, message) => { throw Object.assign(Error(message), { code }); };

export function baselinePathFor(docPath) {
  return join(stateDirFor(docPath), 'state', 'baseline.json');
}

/** 结构快照：diff 需要的身份都在这里，正文一个字都不存。 */
export function structureOf(parsed) {
  return {
    chapters: parsed.chapters.map((chapter) => ({ index: chapter.index, title: chapter.title })),
    pages: parsed.pages.map((page) => ({
      chapter: page.chapter?.index ?? 0,
      index: page.index,
      title: page.title,
      // 页锚点（票 38）是页自己的身份；`anchors` 仍是页内块锚点，用于块层面的匹配。
      anchor: page.anchor ?? null,
      anchors: page.blocks.map((block) => block.anchor).filter(Boolean),
    })),
    blocks: parsed.blocks.filter((block) => block.anchor).map((block) => ({
      anchor: block.anchor,
      page: { chapter: block.page?.chapter?.index ?? 0, page: block.page?.index ?? 0 },
    })),
  };
}

/** 读基准；没有（模型还没取过稿）返回 null。坏文件不静默清空，宁可报错让人看见。 */
export function readBaseline(docPath) {
  const path = baselinePathFor(docPath);
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    fail('baseline_state', `结构 diff 的基准不是合法 JSON：${path}`);
  }
  if (!value || typeof value !== 'object' || value.contract !== BASELINE_CONTRACT
    || !Array.isArray(value.chapters) || !Array.isArray(value.pages) || !Array.isArray(value.blocks)) {
    fail('baseline_state', `结构 diff 的基准契约不对（需要 ${BASELINE_CONTRACT}）：${path}`);
  }
  return {
    sha256: typeof value.sha256 === 'string' ? value.sha256 : null,
    taken_at: value.taken_at ?? null,
    chapters: value.chapters,
    pages: value.pages,
    blocks: value.blocks,
  };
}

/** 模型取稿时刷新基准：记下「它这次看到的版本」。 */
export function writeBaseline(docPath, { sha256, parsed, now = () => new Date().toISOString() }) {
  const path = baselinePathFor(docPath);
  const snapshot = { contract: BASELINE_CONTRACT, sha256, taken_at: now(), ...structureOf(parsed) };
  mkdirSync(dirname(path), { recursive: true });
  atomicWrite(path, `${JSON.stringify(snapshot, null, 2)}\n`);
  return snapshot;
}

/* ── 匹配：页锚点优先，其次才是页里的块 ────────────────────────────────────
 *
 * 页可以带一个隐藏的页锚点（票 38）：有锚点就先按锚点配，改名、移动、甚至同时改
 * 标题和内容都不会把同一页认丢。没有页锚点的旧页仍按「章节 + 顺序 + 标题」与
 * **页里有哪些块**来配（块锚点随内容走、不因移动而变）：同一批锚点还在，就是同一页。
 * 这一条同时把「改名」「移动」「合并」「拆分」区分开：
 *
 *   · 一页对一页，锚点集合没散 → 标题变了叫改名，位置变了叫移动；
 *   · 两页的锚点落进同一页      → 合并；
 *   · 一页的锚点分到两页里      → 拆分。
 */

const pageRef = (page) => ({ chapter: page.chapter, index: page.index, title: page.title });
const chapterRef = (chapter) => ({ index: chapter.index, title: chapter.title });
const pageKey = (page) => pageKeyOf(page);
/** 块上记的页是 `{chapter, page}`（与 diff 的块形状一致）；同一个 pageKeyOf 认得它。 */
const blockPageKey = (page) => pageKeyOf(page);

function chapterAnchorsOf(pages) {
  const map = new Map();
  for (const page of pages) {
    const set = map.get(page.chapter) ?? new Set();
    for (const anchor of page.anchors ?? []) set.add(anchor);
    map.set(page.chapter, set);
  }
  return map;
}

const overlapSize = (left, right) => {
  let count = 0;
  for (const value of left) if (right.has(value)) count += 1;
  return count;
};

/**
 * 页匹配：返回 after 页 → 它来自哪些 before 页（块移动判定要用），以及要报出去的条目。
 *
 * 顺序：标题相同的先配上（页身份含标题）；标题没了的看锚点整页落进哪一页
 * （落进已有一页 = 合并，落成一张新页 = 改名）；标题新出现的看锚点是不是整页
 * 从某一页里分出来的（拆分）；都不认得才是新增 / 删除。
 *
 * 为什么不能只看「锚点集合交叠」：块从一页挪到另一页时，两页的锚点也会互相交叠，
 * 那不是合并也不是拆分 —— 判据是「整页的锚点去了哪」，不是「有没有块串门」。
 */
function matchPages(beforePages, afterPages) {
  const entries = [];
  const origin = new Map(afterPages.map((_, ordinal) => [ordinal, new Set()]));
  const usedBefore = new Set();
  const usedAfter = new Set();
  const beforeAnchors = beforePages.map((page) => new Set(page.anchors ?? []));
  const afterAnchors = afterPages.map((page) => new Set(page.anchors ?? []));
  const covers = (source, target) => source.size > 0 && [...source].every((anchor) => target.has(anchor));

  // 0. 页锚点相同 = 同一页：这是页身份本身，比标题、位置、块集合都可靠。
  const pageAnchorBefore = new Map();
  beforePages.forEach((page, ordinal) => {
    if (page.anchor) pageAnchorBefore.set(page.anchor, ordinal);
  });
  const pairedBefore = new Map(); // after ordinal → before ordinal（页锚点 / 标题配上的）
  afterPages.forEach((page, afterOrdinal) => {
    if (!page.anchor) return;
    const beforeOrdinal = pageAnchorBefore.get(page.anchor);
    if (beforeOrdinal === undefined || usedBefore.has(beforeOrdinal) || usedAfter.has(afterOrdinal)) return;
    usedBefore.add(beforeOrdinal);
    usedAfter.add(afterOrdinal);
    pairedBefore.set(afterOrdinal, beforeOrdinal);
    origin.get(afterOrdinal).add(beforeOrdinal);
  });

  // 1. 标题相同 = 同一页：只剩位置可能变。
  const titleOfBefore = new Map();
  beforePages.forEach((page, ordinal) => {
    if (!titleOfBefore.has(page.title)) titleOfBefore.set(page.title, ordinal);
  });
  afterPages.forEach((page, afterOrdinal) => {
    const beforeOrdinal = titleOfBefore.get(page.title);
    if (beforeOrdinal === undefined || usedBefore.has(beforeOrdinal) || usedAfter.has(afterOrdinal)) return;
    usedBefore.add(beforeOrdinal);
    usedAfter.add(afterOrdinal);
    pairedBefore.set(afterOrdinal, beforeOrdinal);
    origin.get(afterOrdinal).add(beforeOrdinal);
  });

  // 1b. 锚点对上了、标题却变了：就是改名。位置变化留到第 5 步单独报。
  afterPages.forEach((page, afterOrdinal) => {
    const beforeOrdinal = pairedBefore.get(afterOrdinal);
    if (beforeOrdinal === undefined) return;
    const source = beforePages[beforeOrdinal];
    if (source.title === page.title) return;
    entries.push({ action: 'renamed', from: [pageRef(source)], to: pageRef(page) });
  });

  // 2. 标题没了的页：整页锚点落进同一页才算「并进去」，只挪走几块不算。
  const absorbedBy = new Map(); // before ordinal → after ordinal
  beforePages.forEach((page, beforeOrdinal) => {
    if (usedBefore.has(beforeOrdinal)) return;
    const targets = afterPages
      .map((_, ordinal) => ordinal)
      .filter((ordinal) => covers(beforeAnchors[beforeOrdinal], afterAnchors[ordinal]));
    if (targets.length !== 1) return;
    absorbedBy.set(beforeOrdinal, targets[0]);
    usedBefore.add(beforeOrdinal);
  });

  // 3. 标题新出现的页。
  afterPages.forEach((page, afterOrdinal) => {
    if (usedAfter.has(afterOrdinal)) return;
    const absorbed = [...absorbedBy].filter(([, target]) => target === afterOrdinal)
      .map(([source]) => source).sort((left, right) => left - right);
    // 3a. 整页锚点落在某一页里，而那一页已经配上标题 → 从它拆出来的一页。
    const splitSource = absorbed.length === 0
      ? [...pairedBefore].find(([, beforeOrdinal]) => covers(afterAnchors[afterOrdinal], beforeAnchors[beforeOrdinal]))
      : null;
    if (splitSource) {
      usedAfter.add(afterOrdinal);
      origin.get(afterOrdinal).add(splitSource[1]);
      entries.push({ action: 'split', from: [pageRef(beforePages[splitSource[1]])], to: pageRef(page) });
      return;
    }
    // 3b. 锚点整页落成一张新页：换了个标题，还是同一页。
    if (absorbed.length === 1) {
      usedAfter.add(afterOrdinal);
      origin.get(afterOrdinal).add(absorbed[0]);
      entries.push({ action: 'renamed', from: [pageRef(beforePages[absorbed[0]])], to: pageRef(page) });
      return;
    }
    // 3c. 多页的锚点并进一张新页。
    if (absorbed.length > 1) {
      usedAfter.add(afterOrdinal);
      for (const beforeOrdinal of absorbed) origin.get(afterOrdinal).add(beforeOrdinal);
      entries.push({
        action: 'merged',
        from: absorbed.map((ordinal) => pageRef(beforePages[ordinal])),
        to: pageRef(page),
      });
      return;
    }
    // 3d. 改名时块也改了几个：整页锚点对不上，但一页对一页还有明显重合。
    const candidate = beforePages
      .map((item, beforeOrdinal) => ({ beforeOrdinal, score: overlapSize(afterAnchors[afterOrdinal], beforeAnchors[beforeOrdinal]) }))
      .filter((item) => !usedBefore.has(item.beforeOrdinal) && item.score > 0)
      .sort((left, right) => right.score - left.score)[0];
    const claimedElsewhere = candidate && afterPages.some((other, ordinal) => ordinal !== afterOrdinal
      && !usedAfter.has(ordinal)
      && overlapSize(afterAnchors[ordinal], beforeAnchors[candidate.beforeOrdinal]) > 0);
    if (candidate && !claimedElsewhere) {
      usedAfter.add(afterOrdinal);
      usedBefore.add(candidate.beforeOrdinal);
      origin.get(afterOrdinal).add(candidate.beforeOrdinal);
      entries.push({ action: 'renamed', from: [pageRef(beforePages[candidate.beforeOrdinal])], to: pageRef(page) });
      return;
    }
    usedAfter.add(afterOrdinal);
    entries.push({ action: 'added', from: [], to: pageRef(page) });
  });

  // 4. 配上的页里有没有「吞掉」了别的页：那是合并，不是删除。
  afterPages.forEach((page, afterOrdinal) => {
    const beforeOrdinal = pairedBefore.get(afterOrdinal);
    if (beforeOrdinal === undefined) return;
    const absorbed = [...absorbedBy].filter(([, target]) => target === afterOrdinal)
      .map(([source]) => source).sort((left, right) => left - right);
    if (!absorbed.length) return;
    for (const source of absorbed) origin.get(afterOrdinal).add(source);
    entries.push({
      action: 'merged',
      from: [pageRef(beforePages[beforeOrdinal]), ...absorbed.map((source) => pageRef(beforePages[source]))],
      to: pageRef(page),
    });
  });

  // 5. 位置变了：标题还在，只是章节 / 页号不同。
  afterPages.forEach((page, afterOrdinal) => {
    const beforeOrdinal = pairedBefore.get(afterOrdinal);
    if (beforeOrdinal === undefined) return;
    const source = beforePages[beforeOrdinal];
    if (page.chapter === source.chapter && page.index === source.index) return;
    entries.push({ action: 'moved', from: [pageRef(source)], to: pageRef(page) });
  });

  // 6. 剩下没被认领的 before 页：整页删掉。
  beforePages.forEach((page, beforeOrdinal) => {
    if (usedBefore.has(beforeOrdinal)) return;
    entries.push({ action: 'removed', from: [pageRef(page)], to: null });
  });

  const sortKey = (entry) => {
    if (entry.to) return [entry.to.index, entry.from[0]?.index ?? 0];
    return [entry.from[0]?.index ?? 0, 0];
  };
  entries.sort((left, right) => {
    const [leftIndex, leftSource] = sortKey(left);
    const [rightIndex, rightSource] = sortKey(right);
    return leftIndex - rightIndex || leftSource - rightSource;
  });
  return { entries, origin };
}

/** 章节匹配：先按标题，认不出再按「这一章里有哪些块」，最后才按位置。 */
function matchChapters(before, after) {
  const beforeAnchors = chapterAnchorsOf(before.pages);
  const afterAnchors = chapterAnchorsOf(after.pages);
  const matched = [];
  const consumedBefore = new Set();
  const consumedAfter = new Set();
  const entries = [];

  const pair = (left, right) => {
    consumedBefore.add(left.index);
    consumedAfter.add(right.index);
    matched.push({ before: left, after: right });
  };

  for (const chapter of after.chapters) {
    const same = before.chapters.find((item) => !consumedBefore.has(item.index) && item.title === chapter.title);
    if (same) pair(same, chapter);
  }
  // 剩下的按块的重合度配：改名的章节里块还在，锚点会指认同一个位置。
  for (const chapter of after.chapters) {
    if (consumedAfter.has(chapter.index)) continue;
    const anchors = afterAnchors.get(chapter.index) ?? new Set();
    let best = null;
    for (const candidate of before.chapters) {
      if (consumedBefore.has(candidate.index)) continue;
      const score = overlapSize(anchors, beforeAnchors.get(candidate.index) ?? new Set());
      if (score > 0 && (!best || score > best.score)) best = { chapter: candidate, score };
    }
    if (best) pair(best.chapter, chapter);
  }
  // 一章一块都没有（空章节改名）时只能按位置兜底：只配「同一个位置、两边都空」的章节，
  // 否则「删一章 + 加一章」会被误说成改名。
  for (const chapter of after.chapters) {
    if (consumedAfter.has(chapter.index)) continue;
    if ((afterAnchors.get(chapter.index) ?? new Set()).size > 0) continue;
    const same = before.chapters.find((item) => !consumedBefore.has(item.index)
      && item.index === chapter.index
      && (beforeAnchors.get(item.index) ?? new Set()).size === 0);
    if (same) pair(same, chapter);
  }

  for (const { before: source, after: target } of matched) {
    if (source.title === target.title) continue;
    entries.push({ action: 'renamed', from: chapterRef(source), to: chapterRef(target) });
  }

  // 章节移动看的是「还活着的这几章之间的前后顺序」；插一章、删一章不该算移动。
  const order = matched.slice().sort((left, right) => left.before.index - right.before.index);
  const rankBefore = new Map(order.map((item, offset) => [item.before.index, offset]));
  const rankAfter = new Map(matched.slice().sort((left, right) => left.after.index - right.after.index)
    .map((item, offset) => [item.after.index, offset]));
  for (const { before: source, after: target } of matched) {
    if (source.title !== target.title) continue;
    if (rankBefore.get(source.index) === rankAfter.get(target.index)) continue;
    entries.push({ action: 'moved', from: chapterRef(source), to: chapterRef(target) });
  }

  for (const chapter of after.chapters) {
    if (consumedAfter.has(chapter.index)) continue;
    entries.push({ action: 'added', from: null, to: chapterRef(chapter) });
  }
  for (const chapter of before.chapters) {
    if (consumedBefore.has(chapter.index)) continue;
    entries.push({ action: 'removed', from: chapterRef(chapter), to: null });
  }

  const sortKey = (entry) => entry.to?.index ?? entry.from?.index ?? 0;
  entries.sort((left, right) => sortKey(left) - sortKey(right));
  return entries;
}

/** 块：跨页移动与删除。位置用「章节 + 页号」，全用 1 起数的顺序号，与页身份一致。 */
function matchBlocks(before, after, origin) {
  const entries = [];
  const beforePageOrdinal = new Map(before.pages.map((page, ordinal) => [blockPageKey(page), ordinal]));
  const afterPageOrdinal = new Map(after.pages.map((page, ordinal) => [blockPageKey(page), ordinal]));
  const beforeAnchors = new Map(before.blocks.map((block) => [block.anchor, block]));
  const afterAnchors = new Map(after.blocks.map((block) => [block.anchor, block]));

  for (const [anchor, block] of afterAnchors) {
    const source = beforeAnchors.get(anchor);
    if (!source) {
      entries.push({ anchor, action: 'added', from: null, to: block.page });
      continue;
    }
    const beforeOrdinal = beforePageOrdinal.get(blockPageKey(source.page));
    const afterOrdinal = afterPageOrdinal.get(blockPageKey(block.page));
    // 页本身的对应关系（改名 / 合并 / 拆分）不算块移动：块跟着它那一页走。
    const samePage = beforeOrdinal !== undefined && afterOrdinal !== undefined
      && origin.get(afterOrdinal)?.has(beforeOrdinal);
    if (!samePage) entries.push({ anchor, action: 'moved', from: source.page, to: block.page });
  }
  for (const [anchor, block] of beforeAnchors) {
    if (afterAnchors.has(anchor)) continue;
    entries.push({ anchor, action: 'removed', from: block.page, to: null });
  }
  return entries;
}

/**
 * 一次提交批次的结构 diff。
 *
 * `before` 为 null（模型还没取过稿）时无从对比，四个列表都为空：
 * 不能把「没有基准」说成「所有章节、所有块都是新加的」。
 */
export function buildDiff({ batch, before = null, after, orphanNotes = [] }) {
  if (!before) {
    return { contract: DIFF_CONTRACT, batch, baseline_sha256: null, chapters: [], pages: [], blocks: [], orphan_notes: orphanNotes };
  }
  const { entries: pages, origin } = matchPages(before.pages, after.pages);
  return {
    contract: DIFF_CONTRACT,
    batch,
    baseline_sha256: before.sha256,
    chapters: matchChapters(before, after),
    pages,
    blocks: matchBlocks(before, after, origin),
    orphan_notes: orphanNotes,
  };
}
