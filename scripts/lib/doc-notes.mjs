/**
 * 批注：攒在抽屉里、跨页跨天都在、一次提交整批，模型改到的进历史。
 *
 * 形状写在 `.doc-workbench/notes.json`，契约 `planners-doc-notes/1`：
 *
 *   { contract, notes: [{ id, anchor, page: {chapter, index}, target: 'block' | 'page',
 *                         text, state: 'draft' | 'committed' | 'resolved',
 *                         batch, created_at, resolved_at, model_state, snapshot }] }
 *
 * 为什么落盘而不是只留在页面里：人关掉浏览器、第二天回来，草稿还得在；模型在另一个
 * 进程里读任务时，看到的也必须是同一份批注。写盘仍由文档写锁串行化（调用方持有）。
 *
 * 三态：`draft` → `committed` 在这里；`resolved` 由模型回执的 `applied` 落定（ADR 0007），
 * 也在这里，因为归档同样只是改这份数据。归档要存**块快照**（改前 / 改后 raw）：块后来
 * 又被改过，只看锚点会显示成现在的内容，看不出人当初指的是什么。快照只给模型回查，
 * 不在人的历史列表里展开。
 *
 * 单文件超过 2 MB 时搬到 `notes-archive.json`：最老的归档先走，人的历史列表照旧读得到
 * （`listNotes` 把两边合起来），「重新打开」也能把档案里的那条搬回主文件。
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { atomicWrite, stateDirFor } from './doc-io.mjs';

export const NOTES_CONTRACT = 'planners-doc-notes/1';
export const NOTE_STATES = ['draft', 'committed', 'resolved'];
export const MAX_NOTE_TEXT = 2000;

/**
 * 模型看了任务却没动这一块：留在右侧，并如实标出来（不是人的错觉）。
 * 这是**结构化状态**，不是一句文案：页面按它渲染，不靠文本相等判断。
 */
export const MODEL_UNTOUCHED = 'untouched';

/** 主文件上限；超了就按归档时间从老到新搬进档案。 */
export const MAX_NOTES_BYTES = 2 * 1024 * 1024;
export const NOTES_ARCHIVE = 'notes-archive.json';

const fail = (code, message) => { throw Object.assign(Error(message), { code }); };

export function notesPathFor(docPath) {
  return join(stateDirFor(docPath), 'notes.json');
}

export function archivePathFor(docPath) {
  return join(stateDirFor(docPath), NOTES_ARCHIVE);
}

const newNoteId = () => `n:${randomBytes(4).toString('hex')}`;
const newBatchId = () => `b:${randomBytes(6).toString('hex')}`;

const emptyState = () => ({ contract: NOTES_CONTRACT, notes: [] });

const serialize = (notes) => `${JSON.stringify({ contract: NOTES_CONTRACT, notes }, null, 2)}\n`;

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

const resolvedTime = (note) => String(note.resolved_at ?? note.created_at ?? '');

/**
 * 把超过 2 MB 的主文件收到上限以内：只搬 `resolved`，最老的先走。
 * 草稿与已提交还在模型 / 人手里，不能搬；如果只剩下它们仍然超限，就让它超着。
 * 一次搬最老的一成，既保证「最老的先走」，也不会为了几十条小批注反复整份序列化。
 */
function splitOversized(notes) {
  let kept = [...notes];
  const moved = [];
  if (Buffer.byteLength(serialize(kept)) <= MAX_NOTES_BYTES) return { kept, moved };
  while (Buffer.byteLength(serialize(kept)) > MAX_NOTES_BYTES) {
    const resolved = kept
      .filter((note) => note.state === 'resolved')
      .sort((left, right) => resolvedTime(left).localeCompare(resolvedTime(right)));
    if (!resolved.length) break;
    const take = Math.max(1, Math.ceil(resolved.length / 10));
    const cut = new Set(resolved.slice(0, take).map((note) => note.id));
    moved.push(...kept.filter((note) => cut.has(note.id)));
    kept = kept.filter((note) => !cut.has(note.id));
  }
  return { kept, moved };
}

/**
 * 批注存储。`load` 只读主文件、`save` 原子写并把超限的归档搬走；
 * 业务判断留在调用方，写入由文档写锁串行化。
 * `pending: true` 表示这份会话不该在磁盘上留东西（只读挂载），读写都退化成内存。
 */
export function createNoteStore(docPath) {
  const path = notesPathFor(docPath);
  const archivePath = archivePathFor(docPath);
  const loadArchive = () => readState(archivePath).notes;
  const saveArchive = (notes) => {
    mkdirSync(dirname(archivePath), { recursive: true });
    atomicWrite(archivePath, serialize(notes));
  };
  return {
    path,
    archivePath,
    load: () => readState(path),
    /** 归档里的历史批注；主文件与档案是同一份契约的两种存放位置。 */
    archived: () => loadArchive(),
    /** 写主文件；超限时把最老的归档夹带搬进档案（同一次调用里完成）。 */
    save: (state) => {
      const notes = Array.isArray(state?.notes) ? state.notes : [];
      const { kept, moved } = splitOversized(notes);
      if (moved.length) {
        const archived = loadArchive();
        const known = new Set(archived.map((note) => note.id));
        saveArchive([...archived, ...moved.filter((note) => !known.has(note.id))]);
      }
      mkdirSync(dirname(path), { recursive: true });
      atomicWrite(path, serialize(kept));
      // 调用方拿同一份 state 继续拼回执：主文件里现在是哪几条，state 就只留哪几条。
      if (state && typeof state === 'object') state.notes = kept;
      return { kept: kept.length, archived: moved.length };
    },
    /** 从档案里搬回主文件时先读、后写主文件、最后再删档案（宁可重复也不丢）。 */
    dropArchived: (id) => {
      const archived = loadArchive();
      const next = archived.filter((note) => note.id !== id);
      if (next.length !== archived.length) saveArchive(next);
      return archived.length !== next.length;
    },
  };
}

/**
 * 一条草稿：人只看自己写的那句话，快照等模型改到才生成。
 *
 * `target` 记这条批注挂在什么上：块（默认，老文件没有这个字段也按块读）或页（票 38）。
 * 它只用来在目标消失时说清「失去的是一块还是一页」，不影响批注文本与状态流转。
 */
export function draftNote({ anchor, page, target = 'block', text, id = newNoteId(), now = new Date().toISOString() }) {
  return {
    id,
    anchor,
    page: { chapter: page.chapter, index: page.index },
    target: target === 'page' ? 'page' : 'block',
    text,
    state: 'draft',
    batch: null,
    created_at: now,
    resolved_at: null,
    model_state: null,
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

/**
 * 模型回执落定这一批：`snapshots` 里有锚点的 → `resolved` 并记下改前 / 改后；
 * 没有的（`markUntouched` 为真时）留在 `committed` 并标「模型没动这条」。
 *
 * 只认这一批自己的批注（`batch` 相同），不把别的批次一起归档——否则刚被别条任务
 * 跳过的批注会凭空变成「已处理」。归档不由人点（ADR 0007）。
 */
export function settleModelChange(notes, { batch, snapshots = new Map(), markUntouched = false, now = new Date().toISOString() } = {}) {
  if (!batch) return { resolved: [], untouched: [] };
  const resolved = [];
  const untouched = [];
  for (const note of notes) {
    if (note.state !== 'committed' || note.batch !== batch) continue;
    const shot = snapshots.get(note.anchor);
    if (shot) {
      note.state = 'resolved';
      note.resolved_at = now;
      note.model_state = null;
      note.snapshot = { before: shot.before, after: shot.after };
      resolved.push(note);
    } else if (markUntouched && note.model_state !== MODEL_UNTOUCHED) {
      note.model_state = MODEL_UNTOUCHED;
      untouched.push(note);
    }
  }
  return { resolved, untouched };
}

/** 已提交 / 已归档 → 草稿：归档错了或模型没动，人能退回去重新提。 */
export function reopenNote(notes, id) {
  const index = notes.findIndex((note) => note.id === id);
  if (index < 0) fail('note_missing', `找不到批注 ${id}；可能已被删除，刷新后再试`);
  const note = notes[index];
  if (note.state === 'draft') fail('note_state', '这条还是草稿；不用重新打开');
  note.state = 'draft';
  note.batch = null;
  note.resolved_at = null;
  note.model_state = null;
  note.snapshot = null;
  return note;
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
