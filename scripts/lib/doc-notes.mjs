/**
 * 批注：攒在抽屉里、跨页跨天都在、一次提交整批，模型改到的进历史。
 *
 * 形状写在 `.doc-workbench/notes.json`，契约 `planners-doc-notes/1`：
 *
 *   { contract, notes: [{ id, scope: 'blocks' | 'doc', anchor,
 *                         page: {chapter, index} | null, target: 'block' | 'page' | null,
 *                         text, state: 'draft' | 'committed' | 'resolved',
 *                         batch, created_at, resolved_at, model_state, snapshot }] }
 *
 * `scope` 是这条意见针对的范围：
 *   · `blocks`（缺省）：落在一块上（票 38 起也可以是 `##` 页标题的页锚点），`anchor` 是目标
 *     身份，`page` 记它当初在第几章第几页；
 *   · `doc`：针对整份文档（抽屉底部的「整篇反馈」）。它**没有锚点** —— `anchor` 与
 *     `page` 都是 `null`。硬给它挂一块就是在任务里撒谎，说这条意见只改那一处。
 * 老文件里的批注没有 `scope` 字段，一律按 `blocks` 读（契约没换版本：这是加字段，不是改形状）。
 *
 * 为什么落盘而不是只留在页面里：人关掉浏览器、第二天回来，草稿还得在；模型在另一个
 * 进程里读任务时，看到的也必须是同一份批注。写盘仍由文档写锁串行化（调用方持有）。
 *
 * 三态：`draft` → `committed` 在这里；`resolved` 由模型回执的 `applied` 落定（ADR 0007），
 * 也在这里，因为归档同样只是改这份数据。归档要存**块快照**（改前 / 改后 raw）：块后来
 * 又被改过，只看锚点会显示成现在的内容，看不出人当初指的是什么。整份批注存整份文档的
 * 改前 / 改后（`docSnapshot`），同一个归档函数、同一条路径。快照只给模型回查，不在人的
 * 历史列表里展开。
 *
 * 单文件超过 2 MB 时搬到 `notes-archive.json`：最老的归档先走，人的历史列表照旧读得到
 * （`listNotes` 把两边合起来），「重新打开」也能把档案里的那条搬回主文件。
 *
 * 契约全文（字段、命令面、归档规则、错误码）见 `contracts/planners-doc-notes.md`。
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { atomicWrite, stateDirFor } from './doc-io.mjs';
import { BLOCK_ANCHOR_RE } from './doc-blocks.mjs';

export const NOTES_CONTRACT = 'planners-doc-notes/1';
export const NOTE_STATES = ['draft', 'committed', 'resolved'];
/** 批注范围：块级（缺省）与整份。整份没有锚点，所以必须有这个字段说清楚。 */
export const NOTE_SCOPES = ['blocks', 'doc'];
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

/**
 * 一条批注的校验与归一化：范围只有两种，整份不许带锚点，块级必须有真锚点。
 * 老文件没有 `scope` 就按 `blocks` 读；别的错不静默修，宁可报出来让人看见。
 */
function normalizeNote(note, path) {
  if (!note || typeof note !== 'object' || Array.isArray(note)) {
    fail('notes_state', `批注文件里有形状不对的条目：${path}`);
  }
  const scope = note.scope ?? 'blocks';
  const id = typeof note.id === 'string' ? note.id : '?';
  if (!NOTE_SCOPES.includes(scope)) {
    fail('notes_state', `批注 ${id} 的范围只能是 ${NOTE_SCOPES.join(' / ')}：${path}`);
  }
  if (scope === 'doc') {
    if (note.anchor !== null && note.anchor !== undefined) {
      fail('notes_state', `整份批注（${id}）不该挂块锚点：${path}`);
    }
    return { ...note, scope, anchor: null, page: null, target: null };
  }
  if (typeof note.anchor !== 'string' || !BLOCK_ANCHOR_RE.test(note.anchor)) {
    fail('notes_state', `块级批注（${id}）要落在一块或一页标题上：${path}`);
  }
  // 老文件没有 target：按块读（页批注是票 38 才有的），形状仍归一成 block / page 两种。
  return { ...note, scope, target: note.target === 'page' ? 'page' : 'block' };
}

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
  return { contract: NOTES_CONTRACT, notes: value.notes.map((note) => normalizeNote(note, path)) };
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
 * `scope: 'doc'` 是整份意见：没有锚点，也没有页 —— 它不属于任何一块。
 *
 * `target` 记 `scope: 'blocks'` 的批注挂在什么上：块（缺省，老文件没有这个字段也按块读）
 * 或页（票 38，挂在 `##` 页标题的页锚点上）。它只用来在目标消失时说清「失去的是一块还是
 * 一页」，不影响批注文本与状态流转；整份批注两者都不是，`target` 为 `null`。
 */
export function draftNote({
  scope = 'blocks', anchor = null, page = null, target = 'block',
  text, id = newNoteId(), now = new Date().toISOString(),
}) {
  if (!NOTE_SCOPES.includes(scope)) fail('note_scope', `批注范围只能是 ${NOTE_SCOPES.join(' / ')}`);
  if (scope === 'doc' && anchor !== null) fail('note_scope', '整份批注不绑块，不要带锚点');
  if (scope === 'blocks' && (typeof anchor !== 'string' || !BLOCK_ANCHOR_RE.test(anchor))) {
    fail('note_anchor', '批注要落在一块或一页标题的锚点上，锚点形状不对');
  }
  return {
    id,
    scope,
    anchor: scope === 'doc' ? null : anchor,
    page: scope === 'doc' ? null : { chapter: page.chapter, index: page.index },
    target: scope === 'doc' ? null : (target === 'page' ? 'page' : 'block'),
    text,
    state: 'draft',
    batch: null,
    created_at: now,
    resolved_at: null,
    model_state: null,
    snapshot: null,
  };
}

/**
 * 这条批注在任务里叫什么：块级给锚点，整份就说「整份」。
 * 派发文案与归档判断都从这里取 —— 不要在两处各拼一遍「整份」。
 */
export const noteTargetOf = (note) => (note?.scope === 'doc' ? '整份' : note?.anchor ?? null);

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
 * 整份批注看 `docSnapshot`（整份文档的改前 / 改后），同一个归档路径；
 * 都没有的（`markUntouched` 为真时）留在 `committed` 并标「模型没动这条」。
 *
 * 只认这一批自己的批注（`batch` 相同），不把别的批次一起归档——否则刚被别条任务
 * 跳过的批注会凭空变成「已处理」。归档不由人点（ADR 0007）。
 */
export function settleModelChange(
  notes,
  { batch, snapshots = new Map(), docSnapshot = null, markUntouched = false, now = new Date().toISOString() } = {},
) {
  if (!batch) return { resolved: [], untouched: [] };
  const resolved = [];
  const untouched = [];
  for (const note of notes) {
    if (note.state !== 'committed' || note.batch !== batch) continue;
    const shot = note.scope === 'doc' ? docSnapshot : snapshots.get(note.anchor);
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

/**
 * 删一条批注。
 *
 * 草稿随时能删。已提交的也能删，但只在**模型没在它身上干活**的时候：没被领取的批次、
 * 或者模型已经明确回过「没动这条」。否则人会卡在中间——批注既不能提交（已不是草稿），
 * 又不能删（被这句「正在模型手里」挡着），而模型可能早就没动静了。
 *
 * @param notes - 批注列表，原地修改。
 * @param id - 批注 id。
 * @param isInFlight - 判断这条批注对应的批次是否正被模型处理；不传则按「没在飞」处理。
 */
export function removeNote(notes, id, isInFlight = () => false) {
  const index = notes.findIndex((note) => note.id === id);
  if (index < 0) fail('note_missing', `找不到批注 ${id}；可能已被删除，刷新后再试`);
  const note = notes[index];
  if (note.state !== 'draft' && note.model_state !== 'untouched' && isInFlight(note)) {
    fail('note_state', '这条批注正在模型手里；等它处理完就能收回');
  }
  const [removed] = notes.splice(index, 1);
  return removed;
}

export function draftsOf(notes) {
  return notes.filter((note) => note.state === 'draft');
}

export { newBatchId };
