/**
 * 判据三：同块双改只锁该块，其余块不丢失。复跑两遍，记录回执与磁盘结果。
 *
 * 演练顺序（每一步都记回执）：
 *   ① 人对 A 派发反馈（任务基线 = A0）
 *   ② 人先改 A → A1 落盘
 *   ③ 模型 claim 任务 → A 锁住，B 不锁
 *   ④ A 被锁时再存 A → 400 block_locked；同一时刻存 B → 200（只锁该块）
 *   ⑤ 模型 patch A（模型版 Am）→ 基线 A0 已过期 → 只有 A 进待核对，磁盘不动
 *   ⑥ 待核对期间 A 仍锁、B 可再改；/api/conflicts 给出 A1 与 Am 两版
 *   ⑦ 裁决 model → A 落 Am，B 保留人的版本；其余块逐字不动
 */
import { join } from 'node:path';
import {
  compareBlocks, getJson, openWorkbench, postJson, readDoc, sandboxCorpus, sha256,
} from './harness.mjs';

const SUFFIX_HUMAN_A = '（人改：更短）';
const SUFFIX_LOCKED_A = '（被锁时的第二改）';
const SUFFIX_HUMAN_B1 = '（人改 B：先改一版）';
const SUFFIX_HUMAN_B2 = '（人改 B：待核对期间再改）';
const SUFFIX_MODEL_A = '（模型改：收紧表述）';

async function drill(docPath) {
  const server = await openWorkbench(docPath);
  try {
    const before = readDoc(docPath);
    const opened = await getJson(`${server.url}/api/doc`);
    const blocks = opened.body.blocks;
    const editable = blocks.filter((block) => block.anchor && block.editable
      && ['paragraph', 'list', 'quote', 'heading'].includes(block.type) && !String(block.raw).includes('\n'));
    const A = editable[0];
    const B = editable.find((block) => block.page?.key !== A?.page?.key)
      ?? editable.find((block) => block.anchor !== A?.anchor);
    if (!A || !B) throw Error('找不到两块可分页的纯文本块，无法演练');
    const A0 = A.raw;
    const B0 = B.raw;
    const record = {
      doc: docPath.split('/').pop(),
      anchor_a: A.anchor,
      anchor_b: B.anchor,
      page_a: A.page,
      page_b: B.page,
      baseline_a: A0,
      baseline_b: B0,
      receipts: {},
      disk: {},
      assertions: {},
    };

    // ① 派发反馈：任务基线是 A0。
    const feedback = await postJson(`${server.url}/api/feedback`, {
      scope: 'blocks', text: '把这一条改短，只改这一块。', anchors: [A.anchor],
    });
    const taskId = feedback.body?.task?.id;
    record.receipts.feedback = {
      status: feedback.status,
      ok: feedback.body?.ok === true,
      task_id: taskId,
      task_status: feedback.body?.task?.status ?? null,
      baseline_sha256: feedback.body?.task?.blocks?.[0]?.sha256 ?? null,
      dispatch: feedback.body?.dispatch ?? null,
    };

    // ② 人先改 A → A1。
    const A1 = `${A0}${SUFFIX_HUMAN_A}`;
    const humanA = await postJson(`${server.url}/api/block`, {
      anchor: A.anchor, content: A1, base_sha256: opened.body.sha256, base_block_sha256: A.sha256,
    });
    record.receipts.human_edit_a = { status: humanA.status, ok: humanA.body?.ok === true, raw: humanA.body?.block?.raw ?? null };
    record.disk.after_human_a = readDoc(docPath).parsed.blocks.find((block) => block.anchor === A.anchor)?.raw ?? null;

    // ③ 模型 claim → A 锁住。
    const claimed = await postJson(`${server.url}/api/task/claim`, { task_id: taskId });
    record.receipts.claim = {
      status: claimed.status,
      ok: claimed.body?.ok === true,
      task_status: claimed.body?.task?.status ?? null,
      locked_blocks: claimed.body?.task?.locked_blocks ?? null,
    };
    const lockedDoc = await getJson(`${server.url}/api/doc`);
    const lockedA = lockedDoc.body.blocks.find((block) => block.anchor === A.anchor);
    const lockedB = lockedDoc.body.blocks.find((block) => block.anchor === B.anchor);
    record.assertions.only_a_locked = lockedA?.locked === true && lockedB?.locked === false;
    record.disk.lock_state = { a_locked: lockedA?.locked ?? null, b_locked: lockedB?.locked ?? null };

    // ④ A 被锁时再改 A 必须被拒；同时改 B 必须成功。
    const lockedSaveA = await postJson(`${server.url}/api/block`, {
      anchor: A.anchor,
      content: `${A1}${SUFFIX_LOCKED_A}`,
      base_sha256: lockedDoc.body.sha256,
      base_block_sha256: lockedA.sha256,
    });
    const diskAAfterBlocked = readDoc(docPath).parsed.blocks.find((block) => block.anchor === A.anchor)?.raw ?? null;
    record.receipts.blocked_edit_a = {
      status: lockedSaveA.status,
      code: lockedSaveA.body?.code ?? null,
      error: lockedSaveA.body?.error ?? null,
      disk_unchanged: diskAAfterBlocked === A1,
    };
    const B1 = `${B0}${SUFFIX_HUMAN_B1}`;
    const editBWhileLocked = await postJson(`${server.url}/api/block`, {
      anchor: B.anchor,
      content: B1,
      base_sha256: lockedDoc.body.sha256,
      base_block_sha256: lockedB.sha256,
    });
    record.receipts.edit_b_while_a_locked = {
      status: editBWhileLocked.status, ok: editBWhileLocked.body?.ok === true, raw: editBWhileLocked.body?.block?.raw ?? null,
    };

    // ⑤ 模型写回 A（模型版 Am）：任务基线 A0 已过期 → 只有 A 进待核对。
    const Am = `${A0}${SUFFIX_MODEL_A}`;
    const patch = await postJson(`${server.url}/api/patch`, {
      task_id: taskId, patches: [{ anchor: A.anchor, content: Am }],
    });
    record.receipts.patch = {
      status: patch.status,
      ok: patch.body?.ok === true,
      applied: patch.body?.applied ?? null,
      deferred_blocks: patch.body?.deferred_blocks ?? null,
      task_status: patch.body?.task?.status ?? null,
      sha256: patch.body?.sha256 ?? null,
    };
    record.disk.after_patch_a = readDoc(docPath).parsed.blocks.find((block) => block.anchor === A.anchor)?.raw ?? null;

    // ⑥ /api/conflicts 给出两版；A 仍锁，B 可再改。
    const conflicts = await getJson(`${server.url}/api/conflicts`);
    const conflict = (conflicts.body?.conflicts ?? []).find((item) => item.anchor === A.anchor);
    record.receipts.conflicts = {
      status: conflicts.status,
      count: conflicts.body?.conflicts?.length ?? null,
      only_a: (conflicts.body?.conflicts ?? []).length === 1,
      anchor: conflict?.anchor ?? null,
      reason: conflict?.reason ?? null,
      disk_raw: conflict?.disk_raw ?? null,
      model_content: conflict?.model_content ?? null,
    };
    record.disk.after_patch_b = readDoc(docPath).parsed.blocks.find((block) => block.anchor === B.anchor)?.raw ?? null;
    const deferredDoc = await getJson(`${server.url}/api/doc`);
    record.disk.deferred_lock_state = {
      a_locked: deferredDoc.body.blocks.find((block) => block.anchor === A.anchor)?.locked ?? null,
      b_locked: deferredDoc.body.blocks.find((block) => block.anchor === B.anchor)?.locked ?? null,
    };
    const B2 = `${B1}${SUFFIX_HUMAN_B2}`;
    const deferredB = deferredDoc.body.blocks.find((block) => block.anchor === B.anchor);
    const editBWhileDeferred = await postJson(`${server.url}/api/block`, {
      anchor: B.anchor, content: B2, base_sha256: deferredDoc.body.sha256, base_block_sha256: deferredB.sha256,
    });
    record.receipts.edit_b_while_a_deferred = {
      status: editBWhileDeferred.status, ok: editBWhileDeferred.body?.ok === true, raw: editBWhileDeferred.body?.block?.raw ?? null,
    };

    // ⑦ 裁决 model → A 落模型版。
    const decided = await postJson(`${server.url}/api/conflict/decide`, { anchor: A.anchor, decision: 'model' });
    record.receipts.decide = {
      status: decided.status,
      ok: decided.body?.ok === true,
      decision: decided.body?.decision ?? null,
      written: decided.body?.written ?? null,
      raw: decided.body?.block?.raw ?? null,
      deferred_blocks: decided.body?.deferred_blocks ?? null,
    };
    const after = readDoc(docPath);
    const comparison = compareBlocks(before, after);
    const finalA = after.parsed.blocks.find((block) => block.anchor === A.anchor)?.raw ?? null;
    const finalB = after.parsed.blocks.find((block) => block.anchor === B.anchor)?.raw ?? null;
    const changedAnchors = comparison.changed.map((item) => item.anchor_after);
    record.disk.final = {
      a_raw: finalA,
      b_raw: finalB,
      changed_anchors: changedAnchors,
      untouched_blocks: comparison.untouched.length,
      total_blocks: comparison.after_count,
      contract_errors: after.parsed.errors.length,
    };
    record.assertions.only_a_deferred = record.receipts.conflicts.only_a
      && record.receipts.patch.deferred_blocks?.length === 1
      && record.receipts.patch.deferred_blocks[0].anchor === A.anchor
      && record.receipts.patch.deferred_blocks[0].reason === 'block_changed'
      && record.receipts.patch.applied?.length === 0;
    record.assertions.others_not_lost = comparison.changed.length === 2
      && new Set(changedAnchors).size === 2
      && changedAnchors.includes(A.anchor) && changedAnchors.includes(B.anchor);
    record.assertions.final_a_is_model = finalA === Am;
    record.assertions.final_b_is_human = finalB === B2;
    return record;
  } finally {
    await server.close();
  }
}

export async function runConflict(corpus) {
  const cases = [];
  const passes = [];
  const entry = corpus.documents.find((item) => item.id === '05-delivery-notes') ?? corpus.documents[0];
  for (let pass = 1; pass <= 2; pass += 1) {
    const sandbox = sandboxCorpus(`acceptance-conflict-${pass}-`);
    try {
      const path = join(sandbox.dir, entry.file);
      const record = await drill(path);
      record.pass = pass;
      passes.push(record);
      cases.push({
        id: `conflict/pass${pass}/same-block-deferred`,
        ok: record.assertions.only_a_deferred,
        name: `第 ${pass} 遍：同块双改只有 A 进待核对（其余块照常落盘）`,
        evidence: {
          patch: record.receipts.patch,
          conflicts: {
            count: record.receipts.conflicts.count,
            anchor: record.receipts.conflicts.anchor,
            reason: record.receipts.conflicts.reason,
            disk_raw: record.receipts.conflicts.disk_raw,
            model_content: record.receipts.conflicts.model_content,
          },
        },
      });
      cases.push({
        id: `conflict/pass${pass}/only-a-locked`,
        ok: record.assertions.only_a_locked && record.disk.deferred_lock_state.a_locked === true
          && record.disk.deferred_lock_state.b_locked === false,
        name: `第 ${pass} 遍：模型处理 A 时只有 A 锁，B 不锁`,
        evidence: { lock_state: record.disk.lock_state, deferred_lock_state: record.disk.deferred_lock_state },
      });
      cases.push({
        id: `conflict/pass${pass}/locked-block-rejects`,
        ok: record.receipts.blocked_edit_a.status === 409
          && record.receipts.blocked_edit_a.code === 'block_locked'
          && record.receipts.blocked_edit_a.disk_unchanged === true,
        name: `第 ${pass} 遍：锁定块的编辑被拒且磁盘不变`,
        evidence: record.receipts.blocked_edit_a,
      });
      cases.push({
        id: `conflict/pass${pass}/other-block-editable`,
        ok: record.receipts.edit_b_while_a_locked.status === 200
          && record.receipts.edit_b_while_a_locked.ok === true
          && record.receipts.edit_b_while_a_deferred.status === 200
          && record.receipts.edit_b_while_a_deferred.ok === true,
        name: `第 ${pass} 遍：B 在 A 锁定与待核对期间都能保存`,
        evidence: {
          while_locked: record.receipts.edit_b_while_a_locked,
          while_deferred: record.receipts.edit_b_while_a_deferred,
        },
      });
      cases.push({
        id: `conflict/pass${pass}/decision`,
        ok: record.receipts.decide.status === 200 && record.receipts.decide.written === true
          && record.assertions.final_a_is_model,
        name: `第 ${pass} 遍：裁决 model 后 A 落模型版、B 保留人的版本`,
        evidence: { decide: record.receipts.decide, final: record.disk.final },
      });
      cases.push({
        id: `conflict/pass${pass}/others-not-lost`,
        ok: record.assertions.others_not_lost && record.assertions.final_b_is_human
          && record.disk.final.contract_errors === 0,
        name: `第 ${pass} 遍：只有 A、B 两块变化，其余块逐字不动`,
        evidence: {
          changed_anchors: record.disk.final.changed_anchors,
          untouched_blocks: record.disk.final.untouched_blocks,
          total_blocks: record.disk.final.total_blocks,
          final_b: record.disk.final.b_raw,
        },
      });
    } catch (error) {
      cases.push({
        id: `conflict/pass${pass}/error`,
        ok: false,
        name: `第 ${pass} 遍演练异常`,
        evidence: { error: error.message },
      });
    } finally {
      sandbox.cleanup();
    }
  }
  // 两遍的结构性结论必须一致，才算「可复跑」。
  const shape = (record) => JSON.stringify(record?.assertions ?? {});
  cases.push({
    id: 'conflict/repeatable',
    ok: passes.length === 2 && shape(passes[0]) === shape(passes[1]),
    name: '复跑两遍：结构性结论一致',
    evidence: { pass1: passes[0]?.assertions ?? null, pass2: passes[1]?.assertions ?? null },
  });
  return {
    id: 'conflict',
    title: '同块双改只锁该块',
    cases,
    passes,
  };
}
