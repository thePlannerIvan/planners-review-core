/**
 * 块级工作台的共享内核：解析、块级写、journal、锁与待核对都在这里。
 *
 * 两个入口共用这一份：
 *   · 本地页 —— `scripts/doc-workbench.mjs` 的 HTTP 命令面；
 *   · DSH 侧栏 —— `scripts/lib/doc-command.mjs` 的 `doc-workbench/1` 命令后端。
 * 入口只负责「怎么把一次操作送进来、怎么把回执送回去」；写盘与判定没有第二份。
 *
 * 任务、锁与待核对落在文档同目录的 `.doc-workbench/state/`（`doc-boards.mjs`），
 * 所以本地页、侧栏命令后端与模型侧的 `doc-command.mjs` CLI 即使不在同一个进程里，
 * 看到的也是同一组锁与同一条待核对。块内容本身仍只走 journal（一次写盘一份全文）。
 */
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import {
  BLOCK_ANCHOR_RE, BLOCK_TYPES, applyBlockContent, assessBlock, blockPrefix, imageReference, mergeBlockContent,
  moveBlock, movePage, parseDocument, repairAnchors, splitBlockContent, tableModel,
} from './doc-blocks.mjs';
import {
  assertImageBytes, buildManifest, imageMime, manifestPathFor, realPathInside, resolveInside,
  syncManifest,
} from './doc-assets.mjs';
import { TASK_CONTRACT, TASK_SCOPES, createTaskBoard } from './doc-tasks.mjs';
import { CONFLICT_CONTRACT, CONFLICT_DECISIONS, createConflictBoard } from './doc-conflicts.mjs';
import { commitDocument, journalPathFor, recoverJournal, withWriteLock } from './doc-journal.mjs';
import { createFileBoardStores } from './doc-boards.mjs';
import { HISTORY_CONTRACT, listVersions, readVersion } from './doc-history.mjs';
import {
  MAX_NOTE_TEXT, NOTES_CONTRACT, commitDrafts as markDraftsCommitted, createNoteStore, draftNote, draftsOf,
  newBatchId, removeNote as dropNote,
} from './doc-notes.mjs';
import { atomicWrite } from './doc-io.mjs';
import { LEGACY_READONLY_MESSAGE, legacySnapshot, readLegacyMaster } from './doc-legacy.mjs';
import { sha256 } from '../content-review-contract.mjs';

const fail = (code, message) => { throw Object.assign(Error(message), { code }); };
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

export function viewBlock(block, lockOf = () => null, conflictOf = () => null) {
  const verdict = assessBlock(block);
  const prefix = blockPrefix(block);
  const lockedBy = block.anchor ? lockOf(block.anchor) : null;
  const image = block.type === 'image' ? imageReference(block.raw) : null;
  const conflict = block.anchor ? conflictOf(block.anchor) : null;
  return {
    anchor: block.anchor ?? null,
    type: block.type,
    index: block.index,
    page: {
      key: block.page ? `${block.page.chapter?.index ?? 0}-${block.page.index}` : null,
      chapter: block.page?.chapter?.title ?? null,
      chapterIndex: block.page?.chapter?.index ?? null,
      number: block.page?.index ?? null,
      title: block.page?.title ?? null,
    },
    raw: block.raw,
    sha256: sha256(block.raw),
    inline: block.type === 'heading' || block.type === 'list'
      ? block.raw.slice(prefix.length)
      : block.type === 'quote'
        ? block.raw.split('\n').map((line) => line.replace(/^\s*>\s?/, '')).join('\n')
        : block.raw,
    prefix,
    start: block.startOffset,
    end: block.endOffset,
    editable: verdict.editable,
    degraded: verdict.degraded,
    reason: verdict.reason,
    locked: lockedBy !== null || conflict !== null,
    locked_by: lockedBy,
    // 出处区：页末连续的引用（契约第 5 节）。位置就是语义，渲染收起成一条是工作台的事。
    in_sources: block.inSources === true,
    ...(image ? { image } : {}),
    deferred: conflict ? { task_id: conflict.task_id, reason: conflict.reason } : null,
    ...(block.type === 'table' ? { table: tableModel(block) } : {}),
  };
}

/** 目录用的页视图：页没有锚点，身份是「章节号 + 页号」，编号由顺序决定。 */
export function viewPage(page) {
  return {
    key: `${page.chapter?.index ?? 0}-${page.index}`,
    chapter: page.chapter?.title ?? null,
    chapterIndex: page.chapter?.index ?? null,
    index: page.index,
    title: page.title,
    anchor: page.blocks[0]?.anchor ?? null,
    // 出处条数：页内最后一个块是引用时，从它向前连续的引用都算出处；0 表示这页没有出处。
    sources: (page.sources ?? []).length,
  };
}

/** 读盘 → 补锚点（只在内存里，写不写由调用方决定）→ 切块。 */
export function readDocument(docPath) {
  const before = readFileSync(docPath, 'utf8');
  const repaired = repairAnchors(before);
  return {
    source: before,
    hash: sha256(before),
    raw: repaired.raw,
    changed: repaired.changed,
    repairs: repaired.repairs,
    parsed: parseDocument(repaired.raw, { checkImages: false }),
  };
}

/** 补锚点落盘；只有真有修补时才写，且走 journal。调用方负责持有写锁。 */
function persistRepairs(docPath, document, faults) {
  if (!document.changed) return document;
  const receipt = commitDocument(docPath, {
    oldRaw: document.source,
    raw: document.raw,
    operation: 'repair',
    faults,
  });
  return { ...document, source: document.raw, hash: receipt.sha256, changed: false };
}

/** 打开 = 补锚点并落盘（只有真有修补时才写）。调用方负责持有写锁。 */
function openDocument(docPath, faults) {
  return persistRepairs(docPath, readDocument(docPath), faults);
}

/** 读取：写锁被别的进程占着时退回只读，不因为补锚点把页面卡死。 */
function readForView(docPath) {
  try {
    return withWriteLock(docPath, () => openDocument(docPath));
  } catch (error) {
    if (error?.code !== 'locked') throw error;
    return readDocument(docPath);
  }
}

function snapshotFrom(document, docPath, board, conflicts, journalState = null) {
  const { raw, parsed, repairs } = document;
  // 图资产清单是派生索引：每次打开按正文重建，没变化就不写盘。写不进去也不该让文档打不开，
  // 只把原因如实带回去（清单是辅助，正文才是真源）。
  let assets = { path: manifestPathFor(docPath), manifest: { contract: 'doc-assets/1', doc: basename(docPath), assets: [] }, changed: false };
  let assetsError = null;
  try {
    assets = syncManifest(docPath, parsed);
  } catch (error) {
    assetsError = error?.message ?? String(error);
  }
  return {
    path: docPath,
    contract: parsed.front.contract ?? null,
    doc: parsed.front.doc ?? null,
    project: parsed.front.project ?? null,
    sha256: sha256(raw),
    pages: parsed.pages.map(viewPage),
    blocks: parsed.blocks.map((block) => viewBlock(
      block,
      (anchor) => board.lockOf(anchor),
      (anchor) => conflicts.get(anchor),
    )),
    deferred_blocks: conflicts.list().map(({ anchor, task_id, reason }) => ({ anchor, task_id, reason })),
    journal: journalState,
    assets: assets.manifest.assets,
    assets_manifest: basename(assets.path),
    ...(assetsError ? { assets_error: assetsError } : {}),
    repairs,
    errors: parsed.errors.map(({ code, message, line, block }) => ({ code, message, line, block })),
  };
}

function blockAt(document, anchor) {
  return document.parsed.blocks.find((block) => block.anchor === anchor) ?? null;
}

/**
 * 人保存一块：块级合并。
 *
 * `base_sha256` 是整份基线，`base_block_sha256` 是这一块加载时的指纹。
 * 整份基线已过期、但这一块本身没变时，把这次修改打在磁盘当前的全文上——
 * 另一进程刚改过的别的块因此不会被这次保存覆盖。同一块被改过则拒绝（`block_conflict`）。
 */
function saveBlock(docPath, payload, board, faults) {
  if (!payload || typeof payload !== 'object') fail('block_request', '请求体必须是 JSON 对象');
  const { anchor, content, base_sha256: baseSha, base_block_sha256: baseBlockSha } = payload;
  if (typeof anchor !== 'string' || !BLOCK_ANCHOR_RE.test(anchor)) fail('block_anchor', '锚点形状不对');
  if (typeof content !== 'string') fail('block_content', '块内容必须是文本');
  return withWriteLock(docPath, () => {
    // 锁可能来自另一个进程（模型 CLI / 另一个工作台）：以磁盘上的任务板为准再判一次。
    board.refresh();
    if (board.lockOf(anchor)) fail('block_locked', '模型正在改这一段，等它完成后再编辑');
    const document = readDocument(docPath);
    const block = blockAt(document, anchor);
    if (!block) fail('block_anchor', `找不到块 ${anchor}；文档可能已被修改，请刷新工作台`);
    const documentMatches = typeof baseSha === 'string' && baseSha === document.hash;
    const blockMatches = typeof baseBlockSha === 'string' && baseBlockSha === sha256(block.raw);
    if (!documentMatches && !blockMatches) {
      if (typeof baseBlockSha === 'string') {
        fail('block_conflict', '这一块在别处也被改过；你的编辑已保留，请刷新工作台后核对');
      }
      fail('stale_document', '文档已在别处被修改；请刷新工作台后再保存');
    }
    const repaired = persistRepairs(docPath, document, faults);
    const result = applyBlockContent(repaired.raw, anchor, content);
    const receipt = commitDocument(docPath, {
      oldRaw: repaired.raw,
      raw: result.raw,
      applied: [anchor],
      operation: 'block',
      faults,
    });
    return {
      ok: true,
      sha256: receipt.sha256,
      merged: !documentMatches && blockMatches,
      block: viewBlock(result.block, (value) => board.lockOf(value)),
    };
  });
}

/**
 * 回车分块：一次命令同时改前半块、插入后半块（新锚点）。
 * 与保存一块同一把写锁、同一个过期判定；锁定的块先拒，写盘仍走 journal。
 */
function splitBlock(docPath, payload, board, conflicts, faults) {
  if (!payload || typeof payload !== 'object') fail('block_request', '请求体必须是 JSON 对象');
  const { anchor, before, after, keep, base_sha256: baseSha } = payload;
  if (typeof anchor !== 'string' || !BLOCK_ANCHOR_RE.test(anchor)) fail('block_anchor', '锚点形状不对');
  if (typeof before !== 'string' || typeof after !== 'string') fail('block_content', '拆分的前后两半都必须是文本');
  return withWriteLock(docPath, () => {
    board.refresh();
    conflicts.refresh();
    if (board.lockOf(anchor)) fail('block_locked', '模型正在改这一段，等它完成后再编辑');
    if (conflicts.get(anchor)) fail('block_locked', '这一块正在待核对，先裁决再编辑');
    const document = readDocument(docPath);
    if (typeof baseSha !== 'string' || baseSha !== document.hash) {
      fail('stale_document', '文档已在别处被修改；请刷新工作台后再拆分');
    }
    const repaired = persistRepairs(docPath, document, faults);
    const result = splitBlockContent(repaired.raw, { anchor, before, after, keep });
    const receipt = commitDocument(docPath, {
      oldRaw: repaired.raw,
      raw: result.raw,
      applied: [anchor, result.newBlock.anchor],
      operation: 'split',
      faults,
    });
    return {
      ok: true,
      sha256: receipt.sha256,
      block: viewBlock(result.block, (value) => board.lockOf(value)),
      new_block: viewBlock(result.newBlock, (value) => board.lockOf(value)),
      ...snapshotFrom(readDocument(docPath), docPath, board, conflicts),
    };
  });
}

/**
 * 删空合并：后一块（已清空）并进紧挨着的前一块。锚点随内容走——前一块的锚点保留，
 * 后一块的锚点删除；旧任务不迁移，claim 时会明确报 stale。
 */
function mergeBlocks(docPath, payload, board, conflicts, faults) {
  if (!payload || typeof payload !== 'object') fail('block_request', '请求体必须是 JSON 对象');
  const { anchor, previous, content, base_sha256: baseSha } = payload;
  if (typeof anchor !== 'string' || !BLOCK_ANCHOR_RE.test(anchor)) fail('block_anchor', '锚点形状不对');
  return withWriteLock(docPath, () => {
    board.refresh();
    conflicts.refresh();
    if (board.lockOf(anchor)) fail('block_locked', '模型正在改这一段，等它完成后再编辑');
    if (conflicts.get(anchor)) fail('block_locked', '这一块正在待核对，先裁决再编辑');
    const document = readDocument(docPath);
    if (typeof baseSha !== 'string' || baseSha !== document.hash) {
      fail('stale_document', '文档已在别处被修改；请刷新工作台后再合并');
    }
    const repaired = persistRepairs(docPath, document, faults);
    const result = mergeBlockContent(repaired.raw, { anchor, previous, content });
    const receipt = commitDocument(docPath, {
      oldRaw: repaired.raw,
      raw: result.raw,
      applied: [result.block.anchor],
      operation: 'merge',
      faults,
    });
    return {
      ok: true,
      sha256: receipt.sha256,
      block: viewBlock(result.block, (value) => board.lockOf(value)),
      removed: result.removed,
      ...snapshotFrom(readDocument(docPath), docPath, board, conflicts),
    };
  });
}

/** 一块的页身份：章节 + 页内序号 + 标题；整页反馈按它换算范围。 */
function samePage(block, page) {
  return Boolean(block.page)
    && block.page.chapter?.title === page.chapter
    && block.page.index === page.number
    && block.page.title === page.title;
}

/**
 * 把「人点的反馈」换算成要绑定的块：块级用提交上来的锚点，整页 / 整份由服务端按当前文档算，
 * 不信任客户端传来的整页块列表。超出七种块的块没有稳定身份，不参与任务。
 */
function feedbackTargets(document, payload) {
  const blocks = document.parsed.blocks.filter((block) => block.anchor && BLOCK_TYPES.has(block.type));
  const scope = payload.scope ?? 'blocks';
  if (!TASK_SCOPES.includes(scope)) fail('feedback_scope', `反馈范围只能是 ${TASK_SCOPES.join(' / ')}`);

  if (scope === 'doc') return { scope, page: null, blocks };

  if (scope === 'page') {
    const page = payload.page;
    if (!page || typeof page !== 'object'
      || typeof page.chapter !== 'string' || !Number.isInteger(page.number) || typeof page.title !== 'string') {
      fail('feedback_page', '整页反馈需要章节、页号与页标题');
    }
    const targets = blocks.filter((block) => samePage(block, page));
    if (!targets.length) fail('feedback_page', `找不到页「${page.title}」；请刷新工作台后再提交`);
    return { scope, page: { chapter: page.chapter, number: page.number, title: page.title }, blocks: targets };
  }

  const anchors = Array.isArray(payload.anchors) ? payload.anchors : [];
  if (!anchors.length) fail('feedback_anchor', '请先选中要改的块');
  if (anchors.some((anchor) => typeof anchor !== 'string' || !BLOCK_ANCHOR_RE.test(anchor))) {
    fail('feedback_anchor', '块身份形状不对');
  }
  if (new Set(anchors).size !== anchors.length) fail('feedback_anchor', '同一块被选了两次');
  const byAnchor = new Map(blocks.map((block) => [block.anchor, block]));
  return {
    scope,
    page: null,
    blocks: anchors.map((anchor) => byAnchor.get(anchor)
      ?? fail('feedback_anchor', `找不到块 ${anchor}；文档可能已被修改，请刷新工作台`)),
  };
}

/** 提交一条块级反馈任务：只带块身份与 sha256(block.raw)，不把正文抄进任务。 */
function submitFeedback(docPath, payload, board) {
  if (!payload || typeof payload !== 'object') fail('feedback_request', '请求体必须是 JSON 对象');
  const text = typeof payload.text === 'string' ? payload.text.trim() : '';
  if (!text) fail('feedback_text', '请先写下要模型改什么');
  if (text.length > 4000) fail('feedback_text', '一条反馈不要超过 4000 字');
  return withWriteLock(docPath, () => {
    board.refresh();
    const read = readDocument(docPath);
    const { scope, page, blocks } = feedbackTargets(read, payload);
    const locked = blocks.filter((block) => board.lockOf(block.anchor));
    if (locked.length) {
      fail('block_locked', `这些块正由模型处理，等它完成再派发：${locked.map((block) => block.anchor).join('、')}`);
    }
    // 任务绑定的锚点必须是磁盘上也认的身份；被拒的派发不写盘。
    const document = persistRepairs(docPath, read);
    const task = board.submit({
      scope,
      page,
      text,
      doc: {
        path: docPath,
        contract: document.parsed.front.contract ?? null,
        doc: document.parsed.front.doc ?? null,
        project: document.parsed.front.project ?? null,
      },
      blocks: blocks.map((block) => ({ anchor: block.anchor, sha256: sha256(block.raw) })),
    });
    return { ok: true, task };
  });
}

/** 模型开始处理：确认任务绑定的块还在，才锁块。 */
function claimTask(docPath, payload, board) {
  if (!payload || typeof payload !== 'object') fail('task_request', '请求体必须是 JSON 对象');
  const id = payload.task_id ?? payload.id;
  if (typeof id !== 'string' || !id) fail('task_id', '需要任务 id');
  return withWriteLock(docPath, () => {
    board.refresh();
    const task = board.get(id);
    if (!task) fail('task_missing', `找不到任务 ${id}；可能已被清理`);
    const document = readDocument(docPath);
    const present = new Set(document.parsed.blocks.map((block) => block.anchor).filter(Boolean));
    const missing = task.blocks.filter(({ anchor }) => !present.has(anchor));
    if (missing.length) {
      fail('task_stale', `任务里的块已不存在：${missing.map(({ anchor }) => anchor).join('、')}；请重新提交反馈`);
    }
    return { ok: true, task: board.claim(id) };
  });
}

/** 模型处理完：解锁。已完成的重复调用是幂等的，方便网络重试。 */
function completeTask(docPath, payload, board) {
  if (!payload || typeof payload !== 'object') fail('task_request', '请求体必须是 JSON 对象');
  const id = payload.task_id ?? payload.id;
  return withWriteLock(docPath, () => {
    board.refresh();
    return { ok: true, task: board.complete(id) };
  });
}

/**
 * 模型写回：一次提交多块 patch，按块比对「任务提交时的基线与当前磁盘」。
 * 基线一致 → 应用并解锁；不一致 → 只这一块进待核对、保持锁定、磁盘不动；
 * 其余块照常落盘。写回是任务进入 processing 之后的终态动作，再次写回会被状态机拦住。
 */
function patchTask(docPath, payload, board, conflicts, faults) {
  if (!payload || typeof payload !== 'object') fail('patch_request', '请求体必须是 JSON 对象');
  const id = payload.task_id ?? payload.id;
  if (typeof id !== 'string' || !id) fail('task_id', '需要任务 id');
  return withWriteLock(docPath, () => {
    board.refresh();
    conflicts.refresh();
    const task = board.get(id);
    if (!task) fail('task_missing', `找不到任务 ${id}；可能已被清理`);
    if (task.status === 'review') fail('task_state', '这条任务还有块在待核对，先让人裁决');
    if (task.status !== 'processing') fail('task_state', `任务已是 ${task.status}，不能写回`);
    const patches = payload.patches;
    if (!Array.isArray(patches) || patches.length === 0) fail('patch_blocks', '写回至少要带一块 patch');
    const anchors = new Set();
    for (const patch of patches) {
      if (!patch || typeof patch !== 'object') fail('patch_blocks', '每块 patch 必须是对象');
      if (typeof patch.anchor !== 'string' || !BLOCK_ANCHOR_RE.test(patch.anchor)) fail('patch_anchor', '锚点形状不对');
      if (!task.blocks.some((block) => block.anchor === patch.anchor)) {
        fail('patch_anchor', `${patch.anchor} 不在这条任务里；模型只能改任务绑定的块`);
      }
      if (typeof patch.content !== 'string') fail('patch_blocks', '块内容必须是文本');
      if (anchors.has(patch.anchor)) fail('patch_blocks', `${patch.anchor} 在一次写回里出现了两次`);
      anchors.add(patch.anchor);
    }

    const document = readDocument(docPath);
    let raw = document.raw;
    const applied = [];
    const deferred = [];
    for (const patch of patches) {
      const block = blockAt(document, patch.anchor);
      if (!block) fail('patch_anchor', `找不到块 ${patch.anchor}；文档可能已被修改`);
      const baseline = task.blocks.find((item) => item.anchor === patch.anchor).sha256;
      const diskSha = sha256(block.raw);
      const owner = board.lockOf(patch.anchor);
      if (diskSha !== baseline || (owner && owner !== task.id)) {
        deferred.push({
          anchor: patch.anchor,
          reason: diskSha !== baseline ? 'block_changed' : 'block_locked',
          base_sha256: baseline,
          disk_sha256: diskSha,
          disk_raw: block.raw,
          model_content: patch.content,
        });
        continue;
      }
      // 先在候选全文上应用：结构不合法就整次拒绝，不留下半批写盘。
      const result = applyBlockContent(raw, patch.anchor, patch.content);
      raw = result.raw;
      applied.push(patch.anchor);
    }

    let sha = document.hash;
    if (applied.length) {
      // 补锚点先落盘，再把这一批 patch 写上去；target 是在 document.raw 上应用得到的。
      const repaired = persistRepairs(docPath, document, faults);
      sha = commitDocument(docPath, {
        oldRaw: repaired.raw,
        raw,
        applied,
        operation: 'patch',
        faults,
      }).sha256;
    }

    for (const item of deferred) conflicts.defer({ task_id: id, ...item });
    const updated = board.release(id, applied);
    return {
      ok: true,
      contract: TASK_CONTRACT,
      task_id: id,
      applied,
      deferred_blocks: deferred.map(({ anchor, reason, base_sha256, disk_sha256 }) => ({
        anchor, reason, base_sha256, disk_sha256,
      })),
      sha256: sha,
      task: updated,
    };
  });
}

/**
 * 人裁决一块待核对：mine 保留磁盘上人的版本，model 写入模型版，discard 放弃这一块的
 * 模型改动（磁盘同样保持人的版本）。三种裁决都解锁并删除待核对记录。
 */
function decideConflict(docPath, payload, board, conflicts, faults) {
  if (!payload || typeof payload !== 'object') fail('conflict_request', '请求体必须是 JSON 对象');
  const { anchor, decision } = payload;
  if (typeof anchor !== 'string' || !BLOCK_ANCHOR_RE.test(anchor)) fail('conflict_anchor', '锚点形状不对');
  if (!CONFLICT_DECISIONS.includes(decision)) fail('conflict_decision', '裁决只能是 mine / model / discard');

  return withWriteLock(docPath, () => {
    board.refresh();
    conflicts.refresh();
    const conflict = conflicts.get(anchor);
    if (!conflict) fail('conflict_missing', `${anchor} 没有待核对的版本；可能已经被裁决过了`);
    const document = readDocument(docPath);
    let block;
    let sha = document.hash;
    let written = false;
    if (decision === 'model') {
      const repaired = persistRepairs(docPath, document, faults);
      const result = applyBlockContent(repaired.raw, anchor, conflict.model_content);
      sha = commitDocument(docPath, {
        oldRaw: repaired.raw,
        raw: result.raw,
        applied: [anchor],
        operation: 'conflict',
        faults,
      }).sha256;
      block = result.block;
      written = true;
    } else {
      const repaired = persistRepairs(docPath, document, faults);
      sha = repaired.hash;
      block = blockAt(repaired, anchor) ?? fail('conflict_stale', `找不到块 ${anchor}；文档可能已被修改`);
    }
    const taskId = conflict.task_id;
    conflicts.resolve(anchor);
    const task = board.release(taskId, [anchor]);
    return {
      ok: true,
      contract: CONFLICT_CONTRACT,
      anchor,
      decision,
      written,
      sha256: sha,
      block: viewBlock(block, (value) => board.lockOf(value), (value) => conflicts.get(value)),
      task,
      deferred_blocks: conflicts.list().map(({ anchor: value, task_id: owner, reason }) => ({
        anchor: value, task_id: owner, reason,
      })),
    };
  });
}

/**
 * 保存一次重排：只接受显式的 move-block / move-page，一次一个动作。
 * 与改内容一样按 base_sha256 拒绝过期写入，并走同一把写锁与 journal；
 * 成功后回整份快照，页面据此重画目录与正文。
 */
function reorderDocument(docPath, payload, board, conflicts, faults) {
  if (!payload || typeof payload !== 'object') fail('reorder_request', '请求体必须是 JSON 对象');
  const { op, base_sha256: baseSha } = payload;
  if (op !== 'move-block' && op !== 'move-page') {
    fail('reorder_op', '重排只接受 move-block（移块）或 move-page（移页）');
  }
  return withWriteLock(docPath, () => {
    board.refresh();
    conflicts.refresh();
    const document = readDocument(docPath);
    // 锁定与待核对的块不可编辑（SPEC 第 5 节）：重排也是一次编辑，先拒再谈落点。
    // 整页移动会带着页内所有块一起走，所以页里只要有一块被占住就整页拒绝。
    const held = op === 'move-page'
      ? document.parsed.blocks.filter((block) => block.anchor && block.page
        && block.page.chapter?.index === payload.page?.chapter && block.page.index === payload.page?.index
        && (board.lockOf(block.anchor) || conflicts.get(block.anchor)))
      : (board.lockOf(payload.anchor) || conflicts.get(payload.anchor) ? [payload.anchor] : []);
    if (held.length) {
      const anchors = held.map((block) => block.anchor ?? block).join('、');
      fail('block_locked', `这些块正被模型处理或待核对，先处理完再拖动：${anchors}`);
    }
    if (typeof baseSha !== 'string' || baseSha !== sha256(document.raw)) {
      fail('stale_document', '文档已在别处被修改；请刷新工作台后再拖动');
    }
    const repaired = persistRepairs(docPath, document, faults); // 基线对得上才把这次打开补的锚点落盘
    const result = op === 'move-page'
      ? movePage(repaired.raw, { page: payload.page, to: payload.to })
      : moveBlock(repaired.raw, { anchor: payload.anchor, to: payload.to });
    if (result.changed) {
      commitDocument(docPath, { oldRaw: repaired.raw, raw: result.raw, applied: [], operation: 'reorder', faults });
    }
    return {
      ok: true,
      changed: result.changed,
      ...snapshotFrom(readDocument(docPath), docPath, board, conflicts),
    };
  });
}

/**
 * 换掉一个图块引用的文件。
 *
 * 请求里只有块身份与图字节，**没有路径**：用哪张图由正文的 Markdown 引用决定，
 * 所以换文件在结构上就不可能改掉正文引用。锁定的块先拒，再按 base_sha256 拒过期写入。
 * 清单跟着新指纹同步（`replaced_from_sha256` 记下上一版），正文一个字节都不写。
 */
function replaceImageAsset(docPath, payload, board, conflicts) {
  if (!payload || typeof payload !== 'object') fail('asset_request', '请求体必须是 JSON 对象');
  const { anchor, content_base64: encoded, base_sha256: baseSha } = payload;
  if (typeof anchor !== 'string' || !BLOCK_ANCHOR_RE.test(anchor)) fail('asset_request', '锚点形状不对');
  if (typeof encoded !== 'string' || !encoded.trim()) fail('asset_request', '需要 content_base64（图文件字节）');
  const compact = encoded.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact) || compact.length % 4 !== 0) {
    fail('asset_request', 'content_base64 不是合法的 base64');
  }
  const bytes = Buffer.from(compact, 'base64');
  if (bytes.length > 12 * 1024 * 1024) fail('asset_request', '一张图不要超过 12MB');

  board.refresh();
  conflicts.refresh();
  const owner = board.lockOf(anchor);
  if (owner) fail('block_locked', '模型正在改这一块，等它完成后再换图');
  // 待核对也是锁着：人和模型都改过这一块，先裁决再换图，别把两个版本的问题叠到文件上。
  if (conflicts.get(anchor)) fail('block_locked', '这一块正在待核对，先裁决再换图');
  const document = readDocument(docPath);
  if (typeof baseSha !== 'string' || baseSha !== sha256(document.raw)) {
    fail('stale_document', '文档已在别处被修改；请刷新工作台后再换图');
  }
  const block = document.parsed.blocks.find((item) => item.anchor === anchor);
  if (!block) fail('asset_anchor', `找不到图块 ${anchor}；文档可能已被修改`);
  if (block.type !== 'image') fail('asset_anchor', '只有图块可以换文件；文字块请用块编辑');
  const image = imageReference(block.raw);
  if (!image) fail('asset_reference', '这一块的 Markdown 图片引用解析不出来');
  const target = resolveInside(docPath, image.path);
  if (!target) fail('asset_path', `图片必须落在文档目录内：${image.path}`);
  if (!existsSync(target) || !statSync(target).isFile()) fail('asset_path', `图文件不存在：${image.path}`);
  if (!realPathInside(docPath, target)) fail('asset_path', `图片指向文档目录之外：${image.path}`);
  assertImageBytes(image.path, bytes);
  atomicWrite(target, bytes);
  // 文件已经换好；清单同步失败不该把这次替换说成失败，但要如实带出原因。
  const manifestPath = manifestPathFor(docPath);
  let manifest = buildManifest(docPath, document.parsed);
  let assetsError = null;
  try {
    manifest = syncManifest(docPath, document.parsed).manifest;
  } catch (error) {
    assetsError = error?.message ?? String(error);
  }
  return {
    ok: true,
    asset: manifest.assets.find((asset) => asset.path === image.path) ?? null,
    doc_sha256: sha256(document.raw),
    assets_manifest: basename(manifestPath),
    ...(assetsError ? { assets_error: assetsError } : {}),
  };
}

/**
 * 历史版本：只读列出；恢复把旧档当目标全文，走同一个 `commitDocument`。
 *
 * 因此恢复本身也是一次正常编辑：写前会把当前版本再存一档，旧档一个都不删
 * （SPEC 第 4 节）。整份恢复会覆盖所有块，锁与待核对的判据和块级编辑一致，
 * 有块被占住时先拒。
 */
function historyOf(docPath) {
  return { ok: true, contract: HISTORY_CONTRACT, ...listVersions(docPath) };
}

function restoreVersion(docPath, payload, board, conflicts, faults) {
  if (!payload || typeof payload !== 'object') fail('history_request', '请求体必须是 JSON 对象');
  if (typeof payload.id !== 'string' || !payload.id) fail('history_id', '需要历史版本 id');
  const archived = readVersion(docPath, payload.id);
  return withWriteLock(docPath, () => {
    board.refresh();
    conflicts.refresh();
    const document = readDocument(docPath);
    const held = document.parsed.blocks.filter((block) => block.anchor
      && (board.lockOf(block.anchor) || conflicts.get(block.anchor)));
    if (held.length) {
      fail('block_locked', `有块正被模型处理或待核对，先处理完再恢复：${held.map((block) => block.anchor).join('、')}`);
    }
    if (typeof payload.base_sha256 !== 'string' || payload.base_sha256 !== sha256(document.raw)) {
      fail('stale_document', '文档已在别处被修改；请刷新工作台后再恢复');
    }
    const repaired = persistRepairs(docPath, document, faults);
    // 旧档也按当前契约补锚点：恢复后磁盘与回执里的快照必须是同一份全文。
    const target = repairAnchors(archived.raw);
    const receipt = commitDocument(docPath, {
      oldRaw: repaired.raw,
      raw: target.raw,
      applied: [],
      operation: 'restore',
      faults,
    });
    return {
      ok: true,
      contract: HISTORY_CONTRACT,
      restored: payload.id,
      restored_sha256: archived.sha256,
      changed: receipt.written,
      ...snapshotFrom(readDocument(docPath), docPath, board, conflicts),
    };
  });
}


/* ── 批注草稿：攒在抽屉里，一次提交整批 ────────────────────────────────────────
 *
 * 只做两态：draft → committed。`resolved` 要等模型回执的 applied 才落，属于归档那条线。
 * 批注写盘和正文写盘共用文档写锁：两个进程同时提交时，看到的草稿是同一条队列。
 */

/** 只读列出：读批注不需要写锁，坏文件由 store 报错，不静默清空。 */
function listNotes(docPath) {
  const store = createNoteStore(docPath);
  const state = store.load();
  return { ok: true, contract: NOTES_CONTRACT, notes: state.notes };
}

/** 一次加一条或几条：同一段话落到多个块上时，每块各得一条，各自可删。 */
function addNotes(docPath, payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) fail('note_request', '请求体必须是 JSON 对象');
  const text = typeof payload.text === 'string' ? payload.text.trim() : '';
  if (!text) fail('note_text', '批注不能为空');
  if (text.length > MAX_NOTE_TEXT) fail('note_text', `一条批注不要超过 ${MAX_NOTE_TEXT} 字`);
  const anchors = Array.isArray(payload.anchors) ? payload.anchors : [payload.anchor];
  if (!anchors.length || anchors.some((anchor) => typeof anchor !== 'string' || !BLOCK_ANCHOR_RE.test(anchor))) {
    fail('note_anchor', '批注要落在一块上，锚点形状不对');
  }
  if (new Set(anchors).size !== anchors.length) fail('note_anchor', '同一块在一次批注里出现了两次');
  return withWriteLock(docPath, () => {
    const document = readDocument(docPath);
    const byAnchor = new Map(document.parsed.blocks.map((block) => [block.anchor, block]));
    // 先把每条都核对一遍再写：一半成功一半失败会让人以为批注丢了。
    const targets = anchors.map((anchor) => byAnchor.get(anchor)
      ?? fail('note_anchor', `找不到块 ${anchor}；文档可能已被修改，请刷新工作台`));
    const store = createNoteStore(docPath);
    const state = store.load();
    const added = targets.map((block) => draftNote({
      anchor: block.anchor,
      page: { chapter: block.page?.chapter?.index ?? 0, index: block.page?.index ?? 0 },
      text,
    }));
    state.notes.push(...added);
    store.save(state);
    return { ok: true, contract: NOTES_CONTRACT, note: added[0], added, notes: state.notes };
  });
}

/** 单条删除：只删草稿。已提交的批注在模型手里，删掉它等于把意见吞掉。 */
function deleteNote(docPath, payload) {
  if (!payload || typeof payload !== 'object') fail('note_request', '请求体必须是 JSON 对象');
  if (typeof payload.id !== 'string' || !payload.id) fail('note_id', '需要批注 id');
  return withWriteLock(docPath, () => {
    const store = createNoteStore(docPath);
    const state = store.load();
    const removed = dropNote(state.notes, payload.id);
    store.save(state);
    return { ok: true, contract: NOTES_CONTRACT, removed, notes: state.notes };
  });
}

/** 批次文案：模型要在一条任务里看全，所以按文档顺序把每条落到它的块锚点上。 */
function batchTextOf(entries, batch) {
  const lines = [`【批注批次 ${batch}】共 ${entries.length} 条，按块处理；块外一个字都不要动。`];
  for (const { note } of entries) lines.push(`- ${note.anchor}：${note.text}`);
  return lines.join('\n');
}

/**
 * 一次提交整批：所有草稿进同一批、同一份任务。
 *
 * 目标块已被删掉的草稿不静默消失：留在草稿里，并在回执 `orphaned` 里说明原因。
 * 还是老规矩，派发不是保存、也不是批准 —— 这一层只建任务，唤醒由入口决定。
 */
function submitNotes(docPath, payload, board) {
  if (payload !== undefined && (payload === null || typeof payload !== 'object' || Array.isArray(payload))) {
    fail('note_request', '请求体必须是 JSON 对象');
  }
  return withWriteLock(docPath, () => {
    board.refresh();
    const store = createNoteStore(docPath);
    const state = store.load();
    const drafts = draftsOf(state.notes);
    if (!drafts.length) fail('notes_empty', '还没有批注草稿；先在正文里选一段写下要改什么');
    const document = readDocument(docPath);
    const byAnchor = new Map(document.parsed.blocks.map((block) => [block.anchor, block]));
    const entries = [];
    const orphaned = [];
    for (const note of drafts) {
      const block = byAnchor.get(note.anchor);
      if (block) entries.push({ note, block });
      else orphaned.push({ note: note.id, text: note.text, anchor: note.anchor, reason: 'target_block_removed' });
    }
    if (!entries.length) {
      fail('notes_orphaned', '这批批注的块都已被删掉；刷新工作台后重新选块再提交');
    }
    const held = entries.filter(({ block }) => board.lockOf(block.anchor));
    if (held.length) {
      fail('block_locked', `这些块正由模型处理，等它完成再提交：${held.map(({ block }) => block.anchor).join('、')}`);
    }
    const repaired = persistRepairs(docPath, document);
    // 批次号先定下来再建任务：任务文案里的批次号是模型把回执与 notes.json 对上的锚。
    const batch = newBatchId();
    const task = board.submit({
      scope: 'blocks',
      page: null,
      text: batchTextOf(entries, batch),
      doc: {
        path: docPath,
        contract: repaired.parsed.front.contract ?? null,
        doc: repaired.parsed.front.doc ?? null,
        project: repaired.parsed.front.project ?? null,
      },
      // 同一块上的多条批注只绑一块：任务锁的是块，不是批注条数。
      blocks: [...new Map(entries.map(({ block }) => [block.anchor, block])).values()]
        .map((block) => ({ anchor: block.anchor, sha256: sha256(block.raw) })),
    });
    // 只提交有目标的那些；失去目标的留在草稿里，等它自己重新选块。
    const { notes: committed } = markDraftsCommitted(entries.map(({ note }) => note), { batch });
    store.save(state);
    return {
      ok: true,
      contract: NOTES_CONTRACT,
      batch,
      task,
      committed: committed.map((note) => note.id),
      orphaned,
      notes: state.notes,
    };
  });
}

/** 启动要拿写锁；另一个工作台正在写盘时等它一下，而不是把这次打开直接判死。 */
async function withStartupLock(docPath, run) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      return withWriteLock(docPath, run);
    } catch (error) {
      if (error?.code !== 'locked') throw error;
      await sleep(25);
    }
  }
  fail('locked', '另一个工作台正在写盘，请稍后再打开');
}

/**
 * 一份文档的工作台会话。本地 HTTP 与侧栏命令后端都从这个形状调用，
 * 所以「保存一块」在两条入口上是同一段代码，不是两份实现。
 *
 * `persistent` 为 true（默认）时任务板与待核对落在 `.doc-workbench/state/`，
 * 模型侧 CLI 与另一个进程才看得见同一组锁；false 时只在内存里（eval 里模拟两个窗口用）。
 */
export async function createDocSession({ docPath, faults = null, persistent = true } = {}) {
  if (!docPath) throw Error('需要一份文档路径');
  const file = realpathSync(resolve(docPath));
  if (!statSync(file).isFile()) throw Error(`不是文件：${file}`);
  // 旧 JSON 主稿不进入 planners-doc/2 的读-改-写：只挂成只读快照，不补锚点、不恢复 journal。
  const legacy = readLegacyMaster(file);
  // 先收上一次被中断的写盘，再补锚点：恢复用整份目标全文，不按块硬拼，不会生成幽灵块。
  const recovery = legacy ? { state: 'none' } : await withStartupLock(file, () => recoverJournal(file));
  if (recovery.state === 'orphaned') {
    console.warn(`journal 未恢复：${recovery.journal} 的基线已过期，文档保持现状，请人工核对`);
  }
  const startup = legacy ? null : await withStartupLock(file, () => openDocument(file, faults));
  const stores = legacy || !persistent ? null : createFileBoardStores(file);
  const board = createTaskBoard({ store: stores?.tasks ?? null });
  const conflicts = createConflictBoard({ store: stores?.conflicts ?? null });
  const journalState = recovery.state === 'orphaned'
    ? { state: recovery.state, path: recovery.journal }
    : null;
  const readonlyDocument = () => legacySnapshot({ path: file, master: readLegacyMaster(file) });
  const writable = () => { if (legacy) fail('readonly', LEGACY_READONLY_MESSAGE); };
  const guarded = (run) => { writable(); return run(); };

  return {
    path: file,
    readonly: legacy ? { reason: legacy.kind, message: LEGACY_READONLY_MESSAGE } : null,
    legacy: legacy ?? null,
    recovery,
    repairs: startup?.repairs ?? [],
    journal: legacy ? null : journalPathFor(file),
    journalState,
    boards: { tasks: board, conflicts },
    snapshot: () => {
      if (legacy) return readonlyDocument();
      const document = readForView(file);
      // 锁与待核对可能来自另一个进程（模型 CLI / 另一个工作台），渲染前先读回。
      board.refresh();
      conflicts.refresh();
      return snapshotFrom(document, file, board, conflicts, journalState);
    },
    saveBlock: (payload) => guarded(() => saveBlock(file, payload, board, faults)),
    splitBlock: (payload) => guarded(() => splitBlock(file, payload, board, conflicts, faults)),
    mergeBlocks: (payload) => guarded(() => mergeBlocks(file, payload, board, conflicts, faults)),
    reorder: (payload) => guarded(() => reorderDocument(file, payload, board, conflicts, faults)),
    replaceAsset: (payload) => guarded(() => replaceImageAsset(file, payload, board, conflicts)),
    history: () => historyOf(file),
    restore: (payload) => guarded(() => restoreVersion(file, payload, board, conflicts, faults)),
    submitFeedback: (payload) => guarded(() => submitFeedback(file, payload, board)),
    notes: () => (legacy ? { ok: true, contract: NOTES_CONTRACT, notes: [] } : listNotes(file)),
    addNote: (payload) => guarded(() => addNotes(file, payload)),
    deleteNote: (payload) => guarded(() => deleteNote(file, payload)),
    submitNotes: (payload) => guarded(() => submitNotes(file, payload, board)),
    // 侧栏每 3 秒轮询一次锁：读之前先读回磁盘，模型 CLI 在另一个进程里加的锁才看得见。
    tasks: () => { board.refresh(); return { ok: true, contract: TASK_CONTRACT, tasks: board.list() }; },
    claim: (payload) => guarded(() => claimTask(file, payload, board)),
    complete: (payload) => guarded(() => completeTask(file, payload, board)),
    patch: (payload) => guarded(() => patchTask(file, payload, board, conflicts, faults)),
    conflicts: () => { conflicts.refresh(); return { ok: true, contract: CONFLICT_CONTRACT, conflicts: conflicts.list() }; },
    decide: (payload) => guarded(() => decideConflict(file, payload, board, conflicts, faults)),
  };
}
