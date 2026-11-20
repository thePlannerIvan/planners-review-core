/**
 * 块级反馈任务的形状与「哪块正被模型处理」的锁。
 *
 * 任务只装「哪几块 + 提交时的内容指纹」，不装正文：模型拿到任务后按 doc.path 读工作稿，
 * 按 anchor 定位，用 sha256 判断这块还是不是提交时那一版。任务与锁落在文档同目录的
 * `.doc-workbench/state/tasks.json`（`doc-boards.mjs` 写入），所以本地页、侧栏命令与
 * 模型侧 CLI 即使不在同一个进程里，看到的也是同一组任务与锁；无插件派发另有一份
 * 收件箱副本（`doc-inbox.mjs`，同一个 task 形状），有插件时的唤醒由 `doc-dispatch.mjs`
 * 转交。同块双改的待核对属于 04（doc-conflicts），它们从这里接：
 *
 *   · 07：`GET /api/tasks` / board.list() 拿任务，写本地文件或唤醒模型；
 *   · 04：task.blocks[].sha256 是提交时的基线，board.lockOf(anchor) 给出占锁的任务；
 *         写回时逐块比对当前 sha256 与基线，只把变过的那一块交给待核对（doc-conflicts），
 *         release() 只解已应用的块，剩下的锁让人裁决后再解。
 */
import { randomBytes } from 'node:crypto';

export const TASK_CONTRACT = 'planners-doc-task/1';
export const TASK_SCOPES = ['blocks', 'page', 'doc'];

const fail = (code, message) => { throw Object.assign(Error(message), { code }); };
const newTaskId = () => `t:${randomBytes(6).toString('hex')}`;
const clone = (task) => ({
  ...task,
  page: task.page ? { ...task.page } : null,
  doc: { ...task.doc },
  blocks: task.blocks.map((block) => ({ ...block })),
  // 结构 diff 是普通 JSON，深拷一份：任务板与回执不能共享同一个对象。
  diff: task.diff ? JSON.parse(JSON.stringify(task.diff)) : null,
});

/**
 * 任务板：提交 → 处理中（锁块）→ 完成（解锁）。
 * 只做状态与锁，不碰文件；谁能改哪块由调用方先按文档校验。
 */
export function createTaskBoard({ now = () => new Date().toISOString(), nextId = newTaskId, store = null } = {}) {
  const tasks = [];
  const locks = new Map(); // anchor → task id

  /** 落盘形状：任务的内部字段 + 锁表。`view()` 算出来的 locked_blocks 不存。 */
  const state = () => ({
    tasks: tasks.map((task) => ({
      ...task,
      page: task.page ? { ...task.page } : null,
      doc: { ...task.doc },
      blocks: task.blocks.map((block) => ({ ...block })),
      diff: task.diff ? JSON.parse(JSON.stringify(task.diff)) : null,
    })),
    locks: [...locks],
  });
  const persist = () => { if (store) store.save(state()); };
  /** 写之前读回磁盘最新状态：另一个进程可能刚派发/取走了任务。内存板 refresh 是空操作。 */
  const refresh = () => {
    if (!store) return;
    const saved = store.load();
    tasks.length = 0;
    locks.clear();
    if (!saved) return;
    if (!Array.isArray(saved.tasks) || !Array.isArray(saved.locks)) {
      fail('board_state', '工作台任务板形状不对');
    }
    for (const task of saved.tasks) {
      if (!task || typeof task !== 'object' || typeof task.id !== 'string' || !Array.isArray(task.blocks)) {
        fail('board_state', '工作台任务板里的任务形状不对');
      }
      tasks.push({ ...task, blocks: task.blocks.map((block) => ({ ...block })) });
    }
    for (const item of saved.locks) {
      if (!Array.isArray(item) || item.length !== 2) fail('board_state', '工作台锁表形状不对');
      locks.set(item[0], item[1]);
    }
  };
  refresh();

  const find = (id) => tasks.find((task) => task.id === id) ?? null;
  const requireTask = (id) => {
    if (typeof id !== 'string' || !id) fail('task_id', '需要任务 id');
    const task = find(id);
    if (!task) fail('task_missing', `找不到任务 ${id}；可能已被清理`);
    return task;
  };
  /** 任务当前还占着哪些块：部分写回后只剩待核对的那几块。 */
  const lockedBlocks = (task) => [...locks].filter(([, owner]) => owner === task.id).map(([anchor]) => anchor);
  const view = (task) => ({ ...clone(task), locked_blocks: lockedBlocks(task) });

  return {
    /**
     * `batch` 是批注批次的编号（块级反馈没有批次，为 null）。它同时出现在任务文案里，
     * 模型能把它与 notes.json 的 `batch` 对上；这里结构化存一份，是因为归档要按批次
     * 认出「这批里哪几条被改到」，不能靠解析文案。
     *
     * `diff` 是这一批提交时算出的 `planners-doc-diff/1`（块级反馈没有批次，为 null）：
     * 模型读任务时一并读到人动过的结构，不必猜。它随任务落盘、随任务回执返回。
     */
    submit({ scope, page = null, text, doc, blocks, batch = null, diff = null }) {
      if (!TASK_SCOPES.includes(scope)) fail('task_scope', `任务范围只能是 ${TASK_SCOPES.join(' / ')}`);
      if (!Array.isArray(blocks) || blocks.length === 0) fail('task_blocks', '任务至少要绑定一块');
      const task = {
        contract: TASK_CONTRACT,
        id: nextId(),
        scope,
        page: scope === 'page' ? { ...page } : null,
        text,
        batch: typeof batch === 'string' && batch ? batch : null,
        doc: { ...doc },
        blocks: blocks.map(({ anchor, sha256 }) => ({ anchor, sha256 })),
        diff: diff ? JSON.parse(JSON.stringify(diff)) : null,
        status: 'pending',
        created_at: now(),
        started_at: null,
        finished_at: null,
      };
      tasks.push(task);
      persist();
      return view(task);
    },

    /** 模型开始处理：任务绑定的块全部锁上；同一任务重复 claim 是幂等的。 */
    claim(id) {
      const task = requireTask(id);
      if (task.status === 'processing') return view(task);
      if (task.status !== 'pending') fail('task_state', `任务已是 ${task.status}，不能再开始处理`);
      const held = task.blocks.filter(({ anchor }) => locks.has(anchor) && locks.get(anchor) !== task.id);
      if (held.length) {
        fail('block_locked', `这些块正由别的任务处理：${held.map(({ anchor }) => anchor).join('、')}`);
      }
      for (const { anchor } of task.blocks) locks.set(anchor, task.id);
      task.status = 'processing';
      task.started_at = now();
      persist();
      return view(task);
    },

    /** 模型处理完：只解自己持有的锁；已完成的任务再 complete 是幂等的。 */
    complete(id) {
      const task = requireTask(id);
      if (task.status === 'done') return view(task);
      if (task.status === 'review') fail('task_state', '还有块在待核对，先让人裁决再完成');
      if (task.status !== 'processing') fail('task_state', '任务还没开始处理，不能直接完成');
      for (const [anchor, owner] of locks) {
        if (owner === task.id) locks.delete(anchor);
      }
      task.status = 'done';
      task.finished_at = now();
      persist();
      return view(task);
    },

    list() {
      return tasks.map(view);
    },

    /** 从落盘状态读回最新任务与锁（写操作前调用）。 */
    refresh,

    get(id) {
      const task = find(id);
      return task ? view(task) : null;
    },

    /**
     * 写回后按块收尾：只解 applied 的块，待核对的块继续锁着。
     * 手里还有锁 → `review`（人裁决后才 done）；一块不剩 → `done`。
     * 只有 `processing` 的任务可以收尾；重复写回由调用方先按状态拦住。
     */
    release(id, anchors) {
      const task = requireTask(id);
      const wanted = new Set(anchors ?? []);
      for (const [anchor, owner] of locks) {
        if (owner === task.id && wanted.has(anchor)) locks.delete(anchor);
      }
      if (lockedBlocks(task).length) {
        task.status = 'review';
      } else if (task.status !== 'done') {
        task.status = 'done';
        task.finished_at = now();
      }
      persist();
      return view(task);
    },

    /** 这一块现在被哪条任务占着；没有锁返回 null。 */
    lockOf(anchor) {
      return locks.get(anchor) ?? null;
    },
  };
}
