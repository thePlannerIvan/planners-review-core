/**
 * 待核对队列：同一块在别处也被改过，写回时不能静默覆盖。
 *
 * 一条记录同时装两个版本，人也需要看到它们才能裁决：
 *   · `source: "model"` —— 磁盘上人的版本（`disk_raw`）与模型的版本（`model_content`）；
 *   · `source: "human"` —— 磁盘上先落盘的那一版（`disk_raw`）与后保存那个标签页的版本
 *     （`your_content`）。两个标签页改同一块时后保存的一方拿到它，刷新后靠它恢复；
 *     没有任务，所以 `task_id` 为 `null`。
 *
 * 队列和任务、块锁一样落在文档同目录的 `.doc-workbench/state/conflicts.json`
 * （`doc-boards.mjs` 写入），本地页、侧栏命令与模型侧 CLI 跨进程看到同一份；
 * journal 的恢复只管「一次写盘被中断」，不碰待核对。
 */
export const CONFLICT_CONTRACT = 'planners-doc-conflict/1';
/** 模型 vs 人：保留人的 / 写模型版 / 放弃模型这一块。 */
export const CONFLICT_DECISIONS = ['mine', 'model', 'discard'];
/** 人 vs 人：保留磁盘上那一版 / 写后保存的那一版。 */
export const HUMAN_CONFLICT_DECISIONS = ['mine', 'theirs'];
export const CONFLICT_SOURCES = ['model', 'human'];

/** 一条记录允许的出口由它的来源决定：人与人的记录没有「模型版」可选。 */
export const decisionsFor = (source) => (source === 'human' ? HUMAN_CONFLICT_DECISIONS : CONFLICT_DECISIONS);

const fail = (code, message) => { throw Object.assign(Error(message), { code }); };
const clone = (conflict) => ({ ...conflict });

export function createConflictBoard({ now = () => new Date().toISOString(), store = null } = {}) {
  const conflicts = new Map(); // anchor → conflict
  const persist = () => { if (store) store.save({ conflicts: [...conflicts.values()].map(clone) }); };
  /** 写之前读回磁盘最新状态：另一个进程可能刚裁决或新增了一条。 */
  const refresh = () => {
    if (!store) return;
    const saved = store.load();
    conflicts.clear();
    if (!saved) return;
    if (!Array.isArray(saved.conflicts)) fail('board_state', '工作台待核对队列形状不对');
    for (const conflict of saved.conflicts) {
      if (!conflict || typeof conflict !== 'object' || typeof conflict.anchor !== 'string') {
        fail('board_state', '工作台待核对记录形状不对');
      }
      // 早期记录没有 source：那时只有模型 vs 人这一种，按它读。
      const source = conflict.source ?? 'model';
      if (!CONFLICT_SOURCES.includes(source)) fail('board_state', `工作台待核对记录的来源不对：${source}`);
      conflicts.set(conflict.anchor, { ...conflict, source });
    }
  };
  refresh();

  return {
    /**
     * 同一块重复进入待核对时，以最新一次磁盘版本与另一版为准。
     * `source` 缺省为 `model`（既有调用方只传模型那一套字段）。
     */
    defer(record) {
      const source = record.source === 'human' ? 'human' : 'model';
      const conflict = {
        contract: CONFLICT_CONTRACT,
        anchor: record.anchor,
        source,
        task_id: record.task_id ?? null,
        reason: record.reason ?? 'block_changed',
        base_sha256: record.base_sha256 ?? null,
        disk_sha256: record.disk_sha256,
        disk_raw: record.disk_raw,
        created_at: now(),
        // 两版之一：模型给的是 model_content；人给的是后保存那个标签页的 your_content。
        ...(source === 'human'
          ? { your_content: record.your_content, base_block_sha256: record.base_block_sha256 ?? null }
          : { model_content: record.model_content }),
      };
      conflicts.set(conflict.anchor, conflict);
      persist();
      return clone(conflict);
    },

    list() {
      return [...conflicts.values()].map(clone);
    },

    refresh,

    get(anchor) {
      const conflict = conflicts.get(anchor);
      return conflict ? clone(conflict) : null;
    },

    /** 取出并移除一条；调用方据 decision 决定写不写盘。 */
    resolve(anchor) {
      const conflict = conflicts.get(anchor);
      if (!conflict) return null;
      conflicts.delete(anchor);
      persist();
      return clone(conflict);
    },

    size() {
      return conflicts.size;
    },
  };
}
