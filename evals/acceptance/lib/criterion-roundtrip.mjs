/**
 * 判据一：往返零字节差异。
 *
 * 对每份语料：
 *   1. 打开一次（契约要求首次打开补锚点）→ 关闭。把补完锚点的文件当基线。
 *   2. 再打开 → 不做任何编辑 → 关闭。断言文件字节与基线完全一致。
 *   3. 改一块（在块尾追加一句），断言：只有这一块的字节变了；其余块、文档头、表格、图片语法都在。
 *
 * 工作台没有手动保存按钮（SPEC 第 4 节：自动保存）。所以「保存/关闭」按实际行为取：
 * 不编辑就没有写盘动作，关闭即完成一次往返；编辑由自动保存写盘，回执为盘上结果。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  compareBlocks, diffSpan, charRangeToBytes, getJson, openClose, openWorkbench, pickEditableBlock,
  postJson, readDoc, sandboxCorpus, sha256,
} from './harness.mjs';

const EDIT_SUFFIX = '（验收：只改这一块）';

export async function runRoundtrip(corpus) {
  const cases = [];
  const documents = [];
  const sandbox = sandboxCorpus('acceptance-roundtrip-');
  try {
    for (const entry of corpus.documents) {
      const path = join(sandbox.dir, entry.file);
      const record = {
        id: entry.id,
        file: entry.file,
        source: entry.source,
        handling: entry.handling,
        output: entry.output,
        adoption_repairs: null,
        noop_equal: null,
        noop_sha256: null,
        edited: null,
        contract_errors_after_edit: null,
      };
      try {
        // 1. 首次打开：补锚点，形成基线。
        const adoption = await openClose(path);
        record.adoption_repairs = adoption.repairs;
        const baseline = readFileSync(path);
        const baselineReparsed = readDoc(path);
        record.baseline_sha256 = sha256(baseline);
        record.baseline_bytes = baseline.length;
        record.baseline_blocks = baselineReparsed.parsed.blocks.length;
        record.baseline_tables = baselineReparsed.parsed.blocks.filter((block) => block.type === 'table').length;
        record.baseline_images = baselineReparsed.parsed.blocks.filter((block) => block.type === 'image').length;

        // 2. 不做任何编辑，再打开一次再关闭。
        const second = await openClose(path);
        const afterNoop = readFileSync(path);
        record.noop_equal = baseline.equals(afterNoop);
        record.noop_sha256 = sha256(afterNoop);
        record.second_open_repairs = second.repairs;
        cases.push({
          id: `roundtrip/${entry.id}/noop`,
          ok: record.noop_equal && second.repairs === 0,
          name: `${entry.id}：打开→不编辑→关闭，字节不变`,
          evidence: {
            bytes: baseline.length,
            sha256_before: record.baseline_sha256,
            sha256_after: record.noop_sha256,
            adoption_repairs: adoption.repairs,
            second_open_repairs: second.repairs,
          },
        });
        if (!record.noop_equal) continue;

        // 3. 改一块：在块尾追加一句（不换行，避免把「块内换行」的缺陷混进来）。
        const server = await openWorkbench(path);
        try {
          const opened = await getJson(`${server.url}/api/doc`);
          const target = pickEditableBlock(opened.body.blocks, { singleLine: true });
          const content = `${target.raw}${EDIT_SUFFIX}`;
          const saved = await postJson(`${server.url}/api/block`, {
            anchor: target.anchor,
            content,
            base_sha256: opened.body.sha256,
            base_block_sha256: target.sha256,
          });
          const afterEdit = readDoc(path);
          const comparison = compareBlocks(baselineReparsed, afterEdit);
          const span = diffSpan(baseline, readFileSync(path));
          const targetAfter = afterEdit.parsed.blocks.find((block) => block.anchor === target.anchor);
          const range = targetAfter
            ? charRangeToBytes(afterEdit.raw, targetAfter.startOffset, targetAfter.endOffset)
            : null;
          const prefixOk = range ? span.start >= range.start && span.end <= range.end : false;
          const onlyTarget = comparison.changed.length === 1
            && comparison.changed[0].anchor_after === target.anchor
            && comparison.untouched.every((anchor) => anchor !== target.anchor);
          record.edited = {
            anchor: target.anchor,
            type: target.type,
            suffix: EDIT_SUFFIX,
            receipt_status: saved.status,
            receipt_ok: saved.body?.ok === true,
            only_target_changed: onlyTarget,
            changed: comparison.changed,
            untouched_blocks: comparison.untouched.length,
            total_blocks: comparison.after_count,
            diff_span: span,
            target_span_bytes: range,
            diff_inside_target: prefixOk,
            content_readback: targetAfter?.raw ?? null,
            anchor_kept: targetAfter?.anchor === target.anchor,
            sha256_after_edit: sha256(afterEdit.raw),
          };
          record.contract_errors_after_edit = afterEdit.parsed.errors.map(({ code, line, message }) => ({ code, line, message }));
          cases.push({
            id: `roundtrip/${entry.id}/only-one-block`,
            ok: saved.status === 200 && saved.body?.ok === true && onlyTarget,
            name: `${entry.id}：改一块后只有该块变`,
            evidence: {
              anchor: target.anchor,
              changed_blocks: comparison.changed.map((item) => item.anchor_after),
              unchanged_blocks: comparison.untouched.length,
              total_blocks: comparison.after_count,
            },
          });
          cases.push({
            id: `roundtrip/${entry.id}/diff-bytes`,
            ok: prefixOk,
            name: `${entry.id}：字节差异落在目标块区间内`,
            evidence: { diff_span: span, target_span_bytes: range },
          });
          cases.push({
            id: `roundtrip/${entry.id}/readback`,
            ok: targetAfter?.raw === content
              && targetAfter?.anchor === target.anchor
              && afterEdit.parsed.errors.length === 0,
            name: `${entry.id}：读回内容正确、锚点在、文档仍合规`,
            evidence: {
              expected: content,
              actual: targetAfter?.raw ?? null,
              anchor: targetAfter?.anchor ?? null,
              contract_errors: afterEdit.parsed.errors.length,
            },
          });
        } finally {
          await server.close();
        }
      } catch (error) {
        cases.push({
          id: `roundtrip/${entry.id}/error`,
          ok: false,
          name: `${entry.id}：用例异常`,
          evidence: { error: error.message },
        });
      }
      documents.push(record);
    }
  } finally {
    sandbox.cleanup();
  }
  return {
    id: 'roundtrip',
    title: '往返零字节差异',
    cases,
    documents,
  };
}
