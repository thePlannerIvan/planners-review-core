/**
 * 任务板与待核对的落盘位置：文档同目录的 `.doc-workbench/state/`。
 *
 * 为什么落盘：DSH 侧栏里，页面命令、模型侧的 `doc-command.mjs` CLI 不一定是同一个进程。
 * 锁与待核对如果只活在某一侧的内存里，另一侧就永远看不见 —— 侧栏上「模型正在改这一段」
 * 会变成一句永远不出现的提示。落盘之后三边（本地页 / 侧栏命令 / 模型 CLI）读同一份任务板。
 *
 * 写入仍由文档写锁串行化：所有会改任务板的操作都在 `withWriteLock` 里，保存前先
 * `refresh()` 读回磁盘最新状态，避免两个进程各拿一份旧板互相覆盖。
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { atomicWrite, stateDirFor } from './doc-io.mjs';

export const BOARD_CONTRACT = 'planners-doc-board/1';

const fail = (code, message) => { throw Object.assign(Error(message), { code }); };

function readState(path, name) {
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
    fail('board_state', `工作台${name}状态不是合法 JSON：${path}`);
  }
  if (!value || typeof value !== 'object' || value.contract !== BOARD_CONTRACT) {
    fail('board_state', `工作台${name}状态契约不对：${path}`);
  }
  return value;
}

function writeState(path, state, name) {
  mkdirSync(dirname(path), { recursive: true });
  if (!Array.isArray(state.tasks) && !Array.isArray(state.conflicts)) {
    fail('board_state', `工作台${name}状态形状不对`);
  }
  atomicWrite(path, `${JSON.stringify({ contract: BOARD_CONTRACT, ...state }, null, 2)}\n`);
}

/**
 * 一个具名的状态文件。`null` 表示这次会话只用内存（eval 里模拟两个互不相通的窗口）。
 */
export function createFileBoardStore(docPath, name) {
  const path = join(stateDirFor(docPath), 'state', `${name}.json`);
  return {
    path,
    name,
    load: () => readState(path, name),
    save: (state) => writeState(path, state, name),
  };
}

export function createFileBoardStores(docPath) {
  return {
    tasks: createFileBoardStore(docPath, 'tasks'),
    conflicts: createFileBoardStore(docPath, 'conflicts'),
  };
}
