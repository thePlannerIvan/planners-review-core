/**
 * 待核对队列：同一块在任务提交之后被人改过，模型写回时不能静默覆盖。
 *
 * 一条记录同时装两个版本——磁盘上人的版本（disk_raw）与模型的版本（model_content），
 * 人也需要看到它们才能裁决。队列只在工作台进程里存在，和任务、块锁一样；
 * 落盘恢复只负责「一次写盘被中断」，不负责把待核对带过重启。
 */
export const CONFLICT_CONTRACT = 'planners-doc-conflict/1';
export const CONFLICT_DECISIONS = ['mine', 'model', 'discard'];

const clone = (conflict) => ({ ...conflict });

export function createConflictBoard({ now = () => new Date().toISOString() } = {}) {
  const conflicts = new Map(); // anchor → conflict

  return {
    /** 同一块重复进入待核对时，以最新一次磁盘版本与模型版为准。 */
    defer(record) {
      const conflict = {
        contract: CONFLICT_CONTRACT,
        anchor: record.anchor,
        task_id: record.task_id,
        reason: record.reason ?? 'block_changed',
        base_sha256: record.base_sha256,
        disk_sha256: record.disk_sha256,
        disk_raw: record.disk_raw,
        model_content: record.model_content,
        created_at: now(),
      };
      conflicts.set(conflict.anchor, conflict);
      return clone(conflict);
    },

    list() {
      return [...conflicts.values()].map(clone);
    },

    get(anchor) {
      const conflict = conflicts.get(anchor);
      return conflict ? clone(conflict) : null;
    },

    /** 取出并移除一条；调用方据 decision 决定写不写盘。 */
    resolve(anchor) {
      const conflict = conflicts.get(anchor);
      if (!conflict) return null;
      conflicts.delete(anchor);
      return clone(conflict);
    },

    size() {
      return conflicts.size;
    },
  };
}
