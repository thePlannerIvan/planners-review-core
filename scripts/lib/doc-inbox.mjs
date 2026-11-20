/**
 * 无插件派发的本地收件箱：一条任务一个文件，文件内容就是 `planners-doc-task/1` 那个任务形状。
 *
 * 为什么落盘：有侧栏插件时工作台能直接唤醒模型；没有插件时人写下的反馈不能丢在工作台进程里，
 * 要先攒成文件，等人说一声「去看看」，模型再用 `scripts/doc-inbox.mjs` 读回来。
 *
 * 位置：文档同目录的 `.doc-workbench/inbox/`（与 journal、写锁共用同一个旁路目录）。
 * 文件名：`t-<12 位十六进制>.json`，由任务 id `t:<12 位十六进制>` 派生；id 是任务身份，
 * 重复写同一条任务只会覆盖同一个文件，不产生第二个条目。
 *
 * 状态：`pending` 是「等人/模型来读」；`take` 把它改成 `processing` 并写下 `started_at` 与
 * `locked_blocks`（处理中的任务占着它绑定的块），这样「派发 → 被取走」在文件里看得见。
 * 收件箱不复制正文，也不改文档：派发不是保存，也不是批准。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWrite, stateDirFor } from './doc-io.mjs';

export const INBOX_CONTRACT = 'planners-doc-task/1';
export const INBOX_DIRNAME = 'inbox';

const fail = (code, message) => { throw Object.assign(Error(message), { code }); };
const clone = (value) => JSON.parse(JSON.stringify(value));

/** 文档同目录的收件箱目录；与 journal 一样不进正文目录。 */
export function inboxDirFor(docPath) {
  return join(stateDirFor(docPath), INBOX_DIRNAME);
}

/** 任务 id → 文件名；id 的形状由任务契约固定，文件名只把 `:` 换成 `-` 以便跨平台。 */
export function taskFileName(id) {
  const match = /^t:([0-9a-f]{12})$/.exec(typeof id === 'string' ? id : '');
  if (!match) fail('task_id', `任务 id 形状不对：${id ?? '(空)'}`);
  return `t-${match[1]}.json`;
}

const taskPathFor = (docPath, id) => join(inboxDirFor(docPath), taskFileName(id));

function assertTask(task) {
  if (!task || typeof task !== 'object' || Array.isArray(task)) fail('task_request', '任务必须是对象');
  if (task.contract !== INBOX_CONTRACT) {
    fail('task_contract', `收件箱只接收 ${INBOX_CONTRACT}，收到 ${task.contract ?? '(没写契约)'}`);
  }
  taskFileName(task.id);
  if (!Array.isArray(task.blocks)) fail('task_blocks', '任务绑定的块必须是列表');
  // 整份批注没有锚点（`planners-doc-task/1`）：它的任务块列表可以为空，范围由 scope 说清。
  if (task.blocks.length === 0 && task.scope !== 'doc') fail('task_blocks', '任务至少要绑定一块');
}

/**
 * 写一条任务：按 id 覆盖，原子落盘。重复派发同一条任务不会多出条目。
 * 返回实际路径，方便调用方在回执里告诉人任务落在哪。
 */
export function writeTask(docPath, task) {
  assertTask(task);
  const dir = inboxDirFor(docPath);
  mkdirSync(dir, { recursive: true });
  const path = taskPathFor(docPath, task.id);
  atomicWrite(path, JSON.stringify(task, null, 2) + '\n');
  return { path, task: clone(task) };
}

/** 读回收件箱里的全部任务，按创建时间（再按 id）排序；坏文件直接报出路径，不静默跳过。 */
export function readTasks(docPath) {
  const dir = inboxDirFor(docPath);
  if (!existsSync(dir)) return [];
  const tasks = [];
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith('.json')) continue;
    const path = join(dir, name);
    if (!statSync(path).isFile()) continue;
    let task;
    try {
      task = JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) {
      fail('task_inbox', `收件箱里的 ${name} 不是合法 JSON：${error.message}`);
    }
    assertTask(task);
    tasks.push(task);
  }
  return tasks.sort((left, right) => String(left.created_at).localeCompare(String(right.created_at))
    || String(left.id).localeCompare(String(right.id)));
}

/** 只读列出任务：默认只给还没被取走的 `pending`；`status: null` 给全部。 */
export function listTasks(docPath, { status = 'pending' } = {}) {
  const tasks = readTasks(docPath);
  return status === null ? tasks : tasks.filter((task) => task.status === status);
}

/**
 * 模型取走任务：`pending → processing`，写 `started_at` 与 `locked_blocks`，返回取走的任务。
 * 没有待取任务时返回空列表（幂等重试不是错误）；显式指定一条不存在的任务是错误。
 */
export function takeTasks(docPath, { id = null, now = () => new Date().toISOString() } = {}) {
  const tasks = readTasks(docPath);
  if (id !== null && !tasks.some((task) => task.id === id)) {
    fail('task_missing', `收件箱里找不到任务 ${id}`);
  }
  const picked = tasks.filter((task) => task.status === 'pending' && (id === null || task.id === id));
  const taken = picked.map((task) => {
    const next = {
      ...clone(task),
      status: 'processing',
      started_at: now(),
      finished_at: null,
      locked_blocks: task.blocks.map((block) => block.anchor),
    };
    writeTask(docPath, next);
    return next;
  });
  return taken;
}

/** 收件箱的小接口：工作台派发只依赖 put，模型侧命令依赖 list / take。 */
export function createTaskInbox(docPath) {
  return {
    dir: inboxDirFor(docPath),
    put: (task) => writeTask(docPath, task),
    list: (options) => listTasks(docPath, options),
    take: (options) => takeTasks(docPath, options),
    read: () => readTasks(docPath),
  };
}
