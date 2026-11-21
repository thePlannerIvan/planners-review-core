/**
 * 一次写盘的 journal：先落「目标全文」，再替换文档，最后清掉 journal。
 *
 * 一次保存只改几块，但磁盘上只有一份全文。进程若在两次 rename 之间中断，
 * journal 里留着完整的目标全文，重启时按「当前磁盘哈希」判断怎么恢复：
 *
 *   · 当前 == old_sha256 → 替换还没发生，写入 journal.raw（未提交改动可恢复）；
 *   · 当前 == new_sha256 → 替换已经完成，只清 journal（幂等）；
 *   · 两者都不是       → 文档在中断后又被改过，不覆盖，保留 journal 待人工处理。
 *
 * journal 里存的是完整全文而不是块 patch：恢复时不重新按锚点拼块，
 * 因此不会在文档里凭空生成一块（幽灵块）。
 *
 * 位置：文档同目录的 `.doc-workbench/<文档文件名>.journal.json`。同一目录里的两份
 * 文档（storyline / by-page）各有自己的 journal；写盘用 `save.lock` 串行化。
 */
import {
  closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { archiveVersion } from './doc-history.mjs';
import { atomicWrite, sha256, stateDirFor } from './doc-io.mjs';

export const JOURNAL_CONTRACT = 'planners-doc-journal/1';

const fail = (code, message) => { throw Object.assign(Error(message), { code }); };

export function journalPathFor(docPath) {
  return join(stateDirFor(docPath), `${basename(docPath)}.journal.json`);
}

export function lockPathFor(docPath) {
  return join(stateDirFor(docPath), 'save.lock');
}

/**
 * 跨进程写锁：同一份文档同一时刻只有一次读-改-写。
 * 锁文件里写 pid；持锁进程已经不在时视为陈旧锁，清掉重试。
 */
export function acquireWriteLock(docPath) {
  const directory = stateDirFor(docPath);
  mkdirSync(directory, { recursive: true });
  const path = lockPathFor(docPath);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(path, 'wx');
      try { writeFileSync(fd, String(process.pid), 'utf8'); } finally { closeSync(fd); }
      return () => {
        try { unlinkSync(path); } catch { /* 已被恢复流程清掉 */ }
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let pid = NaN;
      try { pid = Number(readFileSync(path, 'utf8')); } catch { /* 锁刚被释放 */ }
      if (Number.isInteger(pid) && pid > 0) {
        try {
          process.kill(pid, 0);
          fail('locked', '另一个保存正在执行，请稍后重试');
        } catch (probe) {
          if (probe.code !== 'ESRCH') throw probe;
        }
      }
      try { unlinkSync(path); } catch { /* 竞争释放 */ }
    }
  }
  fail('locked', '拿不到写锁，请稍后重试');
}

/** 在写锁里跑一段同步的读-改-写；任何异常都会释放锁。 */
export function withWriteLock(docPath, run) {
  const release = acquireWriteLock(docPath);
  try {
    return run();
  } finally {
    release();
  }
}

const journalRecord = (docPath, { oldRaw, raw, applied = [], operation = 'write' }) => ({
  contract: JOURNAL_CONTRACT,
  doc: resolve(docPath),
  operation,
  applied: [...applied],
  old_sha256: sha256(oldRaw),
  new_sha256: sha256(raw),
  raw,
  created_at: new Date().toISOString(),
});

/**
 * 写文档：journal（含完整目标全文）→ 文档原子替换 → 删 journal。
 * `faults.beforeCommit` 只给崩溃恢复的 eval 用：它抛错时盘上留下「journal 已写、
 * 文档未替换」的状态，与进程在两次写之间被打断完全一样。
 */
export function commitDocument(docPath, { oldRaw, raw, applied, operation, faults } = {}) {
  if (typeof oldRaw !== 'string' || typeof raw !== 'string') fail('journal_request', '写盘需要旧文与新文');
  if (oldRaw === raw) return { written: false, sha256: sha256(raw), journal: journalPathFor(docPath) };
  const journal = journalPathFor(docPath);
  const record = journalRecord(docPath, { oldRaw, raw, applied, operation });
  // 先留上一版，再动盘：从这一行起，这次写入之后的任何结果都能从历史里找回来。
  archiveVersion(docPath, { raw: oldRaw, operation });
  atomicWrite(journal, `${JSON.stringify(record, null, 2)}\n`);
  faults?.beforeCommit?.({ journal, doc: resolve(docPath), record });
  atomicWrite(docPath, raw);
  try { unlinkSync(journal); } catch { /* 下次启动按 already_applied 清掉 */ }
  return { written: true, sha256: record.new_sha256, journal };
}

/** 启动时恢复上一次被中断的写盘；调用方负责持有写锁。 */
export function recoverJournal(docPath) {
  const journal = journalPathFor(docPath);
  if (!existsSync(journal)) return { state: 'none', journal };
  let record;
  try {
    record = JSON.parse(readFileSync(journal, 'utf8'));
  } catch {
    return { state: 'corrupt', journal };
  }
  if (record?.contract !== JOURNAL_CONTRACT || record.doc !== resolve(docPath) || typeof record.raw !== 'string') {
    return { state: 'foreign', journal };
  }
  if (sha256(record.raw) !== record.new_sha256) return { state: 'corrupt', journal };
  const current = readFileSync(docPath, 'utf8');
  const hash = sha256(current);
  if (hash === record.new_sha256) {
    unlinkSync(journal);
    return { state: 'already_applied', journal, sha256: hash, applied: record.applied ?? [] };
  }
  if (hash !== record.old_sha256) {
    // 中断之后文档又被改过：不拿旧的全量目标覆盖新内容，也不按块硬拼。
    // 把 journal 挪到一边留档，避免下一次正常写盘把它覆盖掉。
    let target = `${journal}.orphaned`;
    if (existsSync(target)) target = `${target}.${Date.now()}`;
    renameSync(journal, target);
    return { state: 'orphaned', journal: target, sha256: hash };
  }
  // 恢复也是一次写盘：先存恢复前的现场，旧内容不会因为「恢复成功」而消失。
  archiveVersion(docPath, { raw: current, operation: 'recover' });
  atomicWrite(docPath, record.raw);
  unlinkSync(journal);
  return { state: 'applied', journal, sha256: record.new_sha256, applied: record.applied ?? [] };
}
