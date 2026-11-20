/**
 * 批注草稿：攒在抽屉里、跨页跨天都在、一次提交整批。
 *
 * 形状写在 `.doc-workbench/notes.json`，契约 `planners-doc-notes/1`：
 *
 *   { contract, notes: [{ id, anchor, page: {chapter, index}, text,
 *                         state: 'draft' | 'committed' | 'resolved',
 *                         batch, created_at, resolved_at, note, snapshot }] }
 *
 * 为什么落盘而不是只留在页面里：人关掉浏览器、第二天回来，草稿还得在；模型在另一个
 * 进程里读任务时，看到的也必须是同一份批注。写盘仍由文档写锁串行化（调用方持有）。
 *
 * 三态里这一份只负责前两态：`draft` → `committed`。`resolved` 与快照要等模型回执的
 * `applied` 才能落，属于归档那条线；这里只保证形状留了位置，不替它做决定。
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { atomicWrite, stateDirFor } from './doc-io.mjs';

export const NOTES_CONTRACT = 'planners-doc-notes/1';
export const NOTE_STATES = ['draft', 'committed', 'resolved'];
export const MAX_NOTE_TEXT = 2000;

const fail = (code, message) => { throw Object.assign(Error(message), { code }); };

export function notesPathFor(docPath) {
  return join(stateDirFor(docPath), 'notes.json');
}

const newNoteId = () => `n:${randomBytes(4).toString('hex')}`;
const newBatchId = () => `b:${randomBytes(6).toString('hex')}`;

const emptyState = () => ({ contract: NOTES_CONTRACT, notes: [] });

/** 批注文件只认自己的契约；坏文件不静默清空，宁可报错让人看见。 */
function readState(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return emptyState();
    throw error;
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    fail('notes_state', `批注文件不是合法 JSON：${path}`);
  }
  if (!value || typeof value !== 'object' || value.contract !== NOTES_CONTRACT || !Array.isArray(value.notes)) {
    fail('notes_state', `批注文件契约不对（需要 ${NOTES_CONTRACT}）：${path}`);
  }
  return { contract: NOTES_CONTRACT, notes: value.notes };
}

/**
 * 批注存储。`load` 只读、`save` 原子写；业务判断留在调用方，写入由文档写锁串行化。
 * `pending: true` 表示这份会话不该在磁盘上留东西（只读挂载），读写都退化成内存。
 */
export function createNoteStore(docPath) {
  const path = notesPathFor(docPath);
  return {
    path,
    load: () => readState(path),
    save: (state) => {
      mkdirSync(dirname(path), { recursive: true });
      const notes = Array.isArray(state?.notes) ? state.notes : [];
      atomicWrite(path, `${JSON.stringify({ contract: NOTES_CONTRACT, notes }, null, 2)}\n`);
    },
  };
}

/** 一条草稿：人只看自己写的那句话，快照等模型改到才生成。 */
export function draftNote({ anchor, page, text, id = newNoteId(), now = new Date().toISOString() }) {
  return {
    id,
    anchor,
    page: { chapter: page.chapter, index: page.index },
    text,
    state: 'draft',
    batch: null,
    created_at: now,
    resolved_at: null,
    note: null,
    snapshot: null,
  };
}

/** 草稿 → 已提交：只动草稿，已提交的批注不受影响。 */
export function commitDrafts(notes, { batch = newBatchId() } = {}) {
  const committed = [];
  for (const note of notes) {
    if (note.state !== 'draft') continue;
    note.state = 'committed';
    note.batch = batch;
    committed.push(note);
  }
  return { batch, notes: committed };
}

export function removeNote(notes, id) {
  const index = notes.findIndex((note) => note.id === id);
  if (index < 0) fail('note_missing', `找不到批注 ${id}；可能已被删除，刷新后再试`);
  if (notes[index].state !== 'draft') fail('note_state', '已提交的批注不能删；它正在模型手里');
  const [removed] = notes.splice(index, 1);
  return removed;
}

export function draftsOf(notes) {
  return notes.filter((note) => note.state === 'draft');
}

export { newBatchId };
