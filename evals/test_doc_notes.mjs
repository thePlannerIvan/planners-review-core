import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// 批注这条缝只测外部行为：命令面进、磁盘上的 planners-doc-notes/1 文件出。
// 批注怎么分组、气泡怎么画是实现细节；哪些批注被提交、盘上留下什么状态才是契约。
const core = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXAMPLES = join(core, 'contracts', 'examples');

const sandboxes = [];
after(() => { for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true }); });

function sandboxExample(name = 'storyline.md') {
  const dir = mkdtempSync(join(tmpdir(), 'planners-notes-'));
  sandboxes.push(dir);
  cpSync(EXAMPLES, dir, { recursive: true });
  return { dir, path: join(dir, name), notesPath: join(dir, '.doc-workbench', 'notes.json') };
}

const postJson = async (url, path, body) => {
  const response = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
};

const getJson = async (url, path) => {
  const response = await fetch(`${url}${path}`);
  return { status: response.status, body: await response.json() };
};

async function openWorkbench(t, docPath) {
  const { startDocWorkbench } = await import('../scripts/doc-workbench.mjs');
  const server = await startDocWorkbench({ docPath, port: 0 });
  t.after(() => server.close());
  return server;
}

const readNotesFile = (path) => JSON.parse(readFileSync(path, 'utf8'));

// ── 草稿落盘：同一份文件里按页记，关掉浏览器（换一个进程）也读得回来 ──────────
test('草稿落在 planners-doc-notes/1 文件里：跨页、跨天、关掉浏览器都还在', async (t) => {
  const { path, notesPath } = sandboxExample();
  const server = await openWorkbench(t, path);

  const first = await postJson(server.url, '/api/note', { anchor: 'b:7b057d', text: '这句太虚' });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.ok, true, JSON.stringify(first.body));
  const note = first.body.note;
  assert.match(note.id, /^n:[0-9a-f]+$/);
  assert.equal(note.anchor, 'b:7b057d');
  assert.deepEqual(note.page, { chapter: 1, index: 1 }, '批注记住它落在哪一章哪一页，不只记块');
  assert.equal(note.state, 'draft');
  assert.equal(note.batch, null);
  assert.equal(note.model_state, null, '草稿没有「模型没动」状态');
  assert.equal(note.resolved_at, null);
  assert.equal(note.snapshot, null, '还没改到，就没有改前改后的快照');
  assert.match(note.created_at, /^\d{4}-\d{2}-\d{2}T/);

  const second = await postJson(server.url, '/api/note', { anchor: 'b:292f6c', text: '补一个数字' });
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal(second.body.ok, true, JSON.stringify(second.body));

  const saved = readNotesFile(notesPath);
  assert.equal(saved.contract, 'planners-doc-notes/1');
  assert.deepEqual(Object.keys(saved).sort(), ['contract', 'notes'], '文件只有契约名和批注列表两个字段');
  assert.equal(saved.notes.length, 2, '跨页的草稿在同一个文件里');
  assert.deepEqual(saved.notes.map((item) => item.anchor), ['b:7b057d', 'b:292f6c']);
  assert.deepEqual(saved.notes[1].page, { chapter: 1, index: 2 }, '第二条记的是它自己那一页');

  // 关掉页面 = 关掉这个服务进程；下一个进程要从同一份文件里读回草稿。
  await server.close();
  const reopened = await openWorkbench(t, path);
  const listed = await getJson(reopened.url, '/api/notes');
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  assert.equal(listed.body.ok, true);
  assert.equal(listed.body.contract, 'planners-doc-notes/1');
  assert.deepEqual(listed.body.notes.map((item) => item.id), saved.notes.map((item) => item.id));
  assert.deepEqual(listed.body.notes.map((item) => item.state), ['draft', 'draft']);
});

// ── 每条可单独删除：删一条不动别的，已提交的不让删（它在模型手里） ────────────
test('每条批注可单独删除；已提交的不能删，未知 id 说明原因', async (t) => {
  const { path, notesPath } = sandboxExample();
  const server = await openWorkbench(t, path);

  const first = await postJson(server.url, '/api/note', { anchor: 'b:7b057d', text: '这句太虚' });
  const second = await postJson(server.url, '/api/note', { anchor: 'b:7b057d', text: '换个动词' });
  const third = await postJson(server.url, '/api/note', { anchor: 'b:deb3fc', text: '数字要有出处' });
  for (const response of [first, second, third]) assert.equal(response.status, 200, JSON.stringify(response.body));

  const dropped = await postJson(server.url, '/api/note/delete', { id: second.body.note.id });
  assert.equal(dropped.status, 200, JSON.stringify(dropped.body));
  assert.equal(dropped.body.ok, true);
  assert.equal(dropped.body.removed.id, second.body.note.id);
  assert.deepEqual(dropped.body.notes.map((note) => note.id), [first.body.note.id, third.body.note.id]);
  assert.deepEqual(readNotesFile(notesPath).notes.map((note) => note.text), ['这句太虚', '数字要有出处']);

  const unknown = await postJson(server.url, '/api/note/delete', { id: 'n:00000000' });
  assert.equal(unknown.status, 400, JSON.stringify(unknown.body));
  assert.equal(unknown.body.code, 'note_missing');
  assert.match(unknown.body.error, /找不到批注/);

  const missingId = await postJson(server.url, '/api/note/delete', {});
  assert.equal(missingId.status, 400);
  assert.equal(missingId.body.code, 'note_id');

  const emptyText = await postJson(server.url, '/api/note', { anchor: 'b:7b057d', text: '   ' });
  assert.equal(emptyText.status, 400, JSON.stringify(emptyText.body));
  assert.equal(emptyText.body.code, 'note_text');

  const badAnchor = await postJson(server.url, '/api/note', { anchor: 'b:ffffff', text: '落在不存在的块上' });
  assert.equal(badAnchor.status, 400, JSON.stringify(badAnchor.body));
  assert.equal(badAnchor.body.code, 'note_anchor');
  assert.deepEqual(readNotesFile(notesPath).notes.map((note) => note.text), ['这句太虚', '数字要有出处'],
    '被拒的批注一条也不落盘');
});

// ── 一次提交整批：一条任务装全，草稿清空，该批进入已提交 ──────────────────────
test('底部一次提交整批：一条任务装全，草稿清空，该批进入已提交', async (t) => {
  const { dir, path, notesPath } = sandboxExample();
  const server = await openWorkbench(t, path);

  // 空白时提交：说清楚原因，不建任务，也不凭空留下批注文件。
  const empty = await postJson(server.url, '/api/note/submit', {});
  assert.equal(empty.status, 400, JSON.stringify(empty.body));
  assert.equal(empty.body.code, 'notes_empty');

  const one = await postJson(server.url, '/api/note', { anchor: 'b:7b057d', text: '这句太虚' });
  const two = await postJson(server.url, '/api/note', { anchor: 'b:7b057d', text: '换个动词' });
  const three = await postJson(server.url, '/api/note', { anchor: 'b:292f6c', text: '补一个数字' });
  for (const response of [one, two, three]) assert.equal(response.status, 200, JSON.stringify(response.body));

  const submitted = await postJson(server.url, '/api/note/submit', {});
  assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
  assert.equal(submitted.body.ok, true, JSON.stringify(submitted.body));
  assert.match(submitted.body.batch, /^b:[0-9a-f]+$/);
  assert.match(submitted.body.task.id, /^t:/);
  assert.equal(submitted.body.task.status, 'pending');
  assert.equal(submitted.body.committed.length, 3);
  assert.equal(submitted.body.dispatch.channel, 'inbox', '没有插件时整批任务落进收件箱');

  const task = submitted.body.task;
  assert.deepEqual(task.blocks.map((block) => block.anchor).sort(), ['b:292f6c', 'b:7b057d'],
    '同一块的多条批注只绑一块，不重复锁');
  assert.equal(task.text.includes('这句太虚') && task.text.includes('换个动词') && task.text.includes('补一个数字'), true,
    '任务文案要装全整批，模型一次看齐');
  assert.match(task.text, /b:292f6c/);
  assert.ok(task.text.includes(submitted.body.batch), '任务文案带上批次号：模型能把回执里的批次和 notes.json 里的 batch 对上');

  const saved = readNotesFile(notesPath);
  assert.deepEqual(saved.notes.map((note) => note.state), ['committed', 'committed', 'committed']);
  assert.deepEqual(saved.notes.map((note) => note.batch), Array(3).fill(submitted.body.batch));
  assert.deepEqual(saved.notes.map((note) => note.id), [
    one.body.note.id, two.body.note.id, three.body.note.id,
  ], '提交不改批注的顺序');

  const listed = await getJson(server.url, '/api/notes');
  assert.equal(listed.body.notes.filter((note) => note.state === 'draft').length, 0, '草稿清空');
  assert.equal(listed.body.notes.filter((note) => note.state === 'committed').length, 3, '该批进入已提交态');

  const again = await postJson(server.url, '/api/note/submit', {});
  assert.equal(again.status, 400, JSON.stringify(again.body));
  assert.equal(again.body.code, 'notes_empty', '已提交的批注不会被重复提交');

  const dropCommitted = await postJson(server.url, '/api/note/delete', { id: one.body.note.id });
  assert.equal(dropCommitted.status, 409, JSON.stringify(dropCommitted.body));
  assert.equal(dropCommitted.body.code, 'note_state', '已提交的批注在模型手里，不让删');
  assert.equal(readNotesFile(notesPath).notes.length, 3);

  // 收件箱里是同一批任务：两条路消费同一个任务形状。
  const inbox = join(dir, '.doc-workbench', 'inbox');
  assert.deepEqual(readdirSync(inbox), [`${task.id.replace(':', '-')}.json`]);
});

// ── 目标块被删：那条留在草稿里并说明原因，不许静默消失 ───────────────────────
test('目标块已被删的批注不静默消失：留在草稿并进回执 orphaned', async (t) => {
  const { path, notesPath } = sandboxExample();
  const server = await openWorkbench(t, path);
  const opened = await getJson(server.url, '/api/doc');
  assert.equal(opened.status, 200);

  const gone = await postJson(server.url, '/api/note', { anchor: 'b:deb3fc', text: '这一条会失去目标' });
  const kept = await postJson(server.url, '/api/note', { anchor: 'b:7b057d', text: '这一条还在' });
  assert.equal(gone.status, 200, JSON.stringify(gone.body));
  assert.equal(kept.status, 200, JSON.stringify(kept.body));

  // 另一处把 b:deb3fc 删掉了：批注文件里留下的是一条指向已不存在块的意见。
  // 直接改文件而不是走某个删除接口——块在别处被删（模型、别的工具）也是这个输入形状。
  const stale = readNotesFile(notesPath);
  stale.notes = stale.notes.map((note) => (note.id === gone.body.note.id ? { ...note, anchor: 'b:ffffff' } : note));
  writeFileSync(notesPath, `${JSON.stringify(stale, null, 2)}\n`);

  const submitted = await postJson(server.url, '/api/note/submit', {});
  assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
  assert.deepEqual(submitted.body.orphaned, [{
    note: gone.body.note.id, text: '这一条会失去目标', anchor: 'b:ffffff', reason: 'target_block_removed',
  }], '失去目标的批注要进回执，说清哪一条、为什么');
  assert.deepEqual(submitted.body.committed, [kept.body.note.id], '有目标的批注照常提交');
  assert.deepEqual(submitted.body.task.blocks.map((block) => block.anchor), ['b:7b057d']);

  const saved = readNotesFile(notesPath);
  const orphan = saved.notes.find((note) => note.id === gone.body.note.id);
  assert.equal(orphan.state, 'draft', '失去目标的批注留在草稿里，等人重新选块');
  assert.equal(orphan.batch, null);
  assert.equal(saved.notes.find((note) => note.id === kept.body.note.id).state, 'committed');
});

// ── 两条宿主路径同义：同一串批注操作，盘上留下同一份状态，拒绝也同码同句 ──────
function sandboxForNotes() {
  return sandboxExample();
}

async function bridgeSurface(t, docPath) {
  const { buildDocSurface } = await import('../scripts/doc-surface.mjs');
  const built = buildDocSurface({ docPath });
  const data = JSON.parse(readFileSync(built.surfacePath, 'utf8'));
  const base = dirname(built.surfacePath);
  return { file: built.surfacePath, base, data, dir: resolve(base, data.dir), projectRoot: resolve(base, data.project_root) };
}

async function openSidebarTransport(surface) {
  const { runBrowserCommand } = await import('../scripts/lib/review-command.mjs');
  const source = readFileSync(join(core, 'assets', 'workbench', 'doc-transport.js'), 'utf8');
  const win = {
    parent: {},
    __REVIEW_BASE__: '/',
    ReviewBridge: {
      connect: async () => ({
        capabilities: ['command'],
        command: async (payload) => runBrowserCommand(surface, { route: payload.route, body: payload.body }),
      }),
    },
  };
  const Transport = new Function('window', 'globalThis', `${source}\nreturn window.DocTransport;`)(win, win);
  return Transport.connect();
}

/** id 与时间戳每次生成都不同：只比较被契约固定下来的形状与内容。 */
const settledNotes = (notes) => notes.map((note) => ({
  ...note,
  id: 'n:x',
  batch: note.batch ? 'b:x' : null,
  created_at: 'time',
}));

test('侧栏桥与本地宿主：同一串批注操作同义，拒绝也同码同句', async (t) => {
  const local = sandboxForNotes();
  const sidebar = sandboxForNotes();
  const server = await openWorkbench(t, local.path);
  const surface = await bridgeSurface(t, sidebar.path);
  const api = await openSidebarTransport(surface);
  assert.equal(api.mode, 'sidebar', '桥那条路走的是页面真正的 sidebar transport');

  // 两条路各加三条草稿（同一块两条 + 另一页一条）。
  for (const [url, transport] of [[server.url, null], [null, api]]) {
    for (const [anchor, text] of [['b:7b057d', '这句太虚'], ['b:7b057d', '换个动词'], ['b:292f6c', '补一个数字']]) {
      const receipt = url
        ? (await postJson(url, '/api/note', { anchor, text })).body
        : await transport.addNote({ anchor, text });
      assert.equal(receipt.ok, true, JSON.stringify(receipt));
    }
  }

  // 删一条，再整批提交：两条路留下同一份批注状态。
  const localDelete = (await postJson(server.url, '/api/note/delete', {
    id: readNotesFile(local.notesPath).notes[1].id,
  })).body;
  const bridgeNotesBefore = await api.notes();
  const bridgeDelete = await api.deleteNote({ id: bridgeNotesBefore.notes[1].id });
  assert.equal(localDelete.ok, true);
  assert.equal(bridgeDelete.ok, true);

  const localSubmit = (await postJson(server.url, '/api/note/submit', {})).body;
  const bridgeSubmit = await api.submitNotes({});
  assert.equal(localSubmit.ok, true, JSON.stringify(localSubmit));
  assert.equal(bridgeSubmit.ok, true, JSON.stringify(bridgeSubmit));
  const withoutBatch = (text) => text.replace(/b:[0-9a-f]+/g, 'b:x');
  assert.equal(withoutBatch(localSubmit.task.text), withoutBatch(bridgeSubmit.task.text),
    '两条路的批次文案一字不差（批次号每次生成，去掉再看）');
  assert.deepEqual(localSubmit.task.blocks, bridgeSubmit.task.blocks, '两条路绑同样的块与指纹');
  assert.deepEqual(localSubmit.committed.length, bridgeSubmit.committed.length);
  assert.equal(localSubmit.dispatch.channel, 'inbox', '本地宿主落收件箱');
  assert.equal(bridgeSubmit.dispatch.channel, 'wake', '侧栏宿主交给人唤醒模型');

  const localNotes = await getJson(server.url, '/api/notes');
  const bridgeNotes = await api.notes();
  assert.deepEqual(settledNotes(bridgeNotes.notes), settledNotes(localNotes.body.notes),
    '两条路在盘上留下同一份 planners-doc-notes/1 状态');
  assert.deepEqual(
    settledNotes(readNotesFile(sidebar.notesPath).notes),
    settledNotes(readNotesFile(local.notesPath).notes),
  );

  // 拒绝：两条路同码同句，且都不落盘。
  const localEmpty = await postJson(server.url, '/api/note/submit', {});
  const bridgeEmpty = await api.submitNotes({});
  assert.equal(localEmpty.body.code, 'notes_empty');
  assert.equal(bridgeEmpty.code, 'notes_empty');
  assert.equal(bridgeEmpty.error, localEmpty.body.error, '拒绝理由一字不差');
  const bridgeBadAnchor = await api.addNote({ anchor: 'b:ffffff', text: '不存在' });
  assert.equal(bridgeBadAnchor.code, 'note_anchor');
});

// ── 抽屉是一张单子：条数按状态分开，顺序跟正文走，不按页分组 ──────────────────
test('抽屉是一张正文顺序的单子：不按页分组，条目里没有页名 / 章节名 / 页号', async () => {
  const module = await import('../assets/workbench/doc-notes.js');
  const DocNotes = module.default ?? module;
  const order = new Map([['b:7b057d', 2], ['b:292f6c', 5], ['b:36a372', 9]]);
  const notes = [
    { id: 'n:1', anchor: 'b:7b057d', page: { chapter: 1, index: 1 }, text: '这句太虚', state: 'draft', created_at: '2026-11-20T08:00:00.000Z' },
    { id: 'n:2', anchor: 'b:292f6c', page: { chapter: 1, index: 2 }, text: '补数字', state: 'draft', created_at: '2026-11-20T08:01:00.000Z' },
    { id: 'n:3', anchor: 'b:7b057d', page: { chapter: 1, index: 1 }, text: '换个动词', state: 'draft', created_at: '2026-11-20T08:02:00.000Z' },
    { id: 'n:4', anchor: 'b:7b057d', page: { chapter: 1, index: 1 }, text: '已交的', state: 'committed', batch: 'b:1', created_at: '2026-11-20T07:00:00.000Z' },
  ];

  const drawer = DocNotes.drawer(notes, { order });
  assert.equal(drawer.draft.count, 3);
  assert.equal(drawer.committed.count, 1);
  assert.equal(drawer.resolved.count, 0, '还没有归档的批注');
  assert.deepEqual(Object.keys(drawer.draft).sort(), ['count', 'notes'], '抽屉只有条数与条目，没有按页分组');
  assert.deepEqual(drawer.draft.notes.map((note) => note.id), ['n:1', 'n:3', 'n:2'],
    '按正文顺序：同一块里的多条按写下顺序，接着是后一块');
  assert.deepEqual(Object.keys(drawer.draft.notes[0]).sort(), ['anchor', 'created_at', 'id', 'state', 'text'],
    '每条只有抽屉要用的字段：没有页名、章节名、页号');
  assert.deepEqual(drawer.committed.notes.map((note) => note.id), ['n:4'], '已提交的单独一组，不和草稿混在一起');

  const empty = DocNotes.drawer([], { order });
  assert.deepEqual([empty.draft.count, empty.committed.count, empty.draft.notes], [0, 0, []],
    '空白时抽屉是第一个能被判定的状态');
});

// ── 抽屉的样子：默认展开、一张单子、引用的话截一行、底部两枚按钮 ──────────────
test('批注抽屉默认展开：每条只有引用的话、正文、时间、删除，底部只有整篇反馈与提交模型', async () => {
  const html = readFileSync(join(core, 'assets', 'workbench', 'doc-workbench.html'), 'utf8');
  const page = readFileSync(join(core, 'assets', 'workbench', 'doc-workbench.js'), 'utf8');
  const css = readFileSync(join(core, 'assets', 'workbench', 'doc-workbench.css'), 'utf8');
  const transport = readFileSync(join(core, 'assets', 'workbench', 'doc-transport.js'), 'utf8');
  const surface = readFileSync(join(core, 'scripts', 'doc-surface.mjs'), 'utf8');

  // 默认展开：画在页面里、没有被 hidden 挡住，收起是一个可回退的按钮。
  const panel = html.match(/<aside[^>]*id="notesPanel"[^>]*>/);
  assert.ok(panel, '正文右侧要有批注抽屉');
  assert.doesNotMatch(panel[0], /\bhidden\b/, '抽屉默认展开，不是先藏起来等人找');
  assert.match(html, /id="notesList"/);
  assert.match(html, /id="notesSubmit"[^>]*disabled/, '空白草稿时提交按钮禁用');
  assert.match(html, />提交模型</, '底部按钮就是「提交模型」，条数由脚本写在后面');
  assert.match(html, /id="notesCollapse"[^>]*aria-expanded="true"/);

  // 一张单子：同一条规则决定出现哪几条、按什么顺序；每条自带引用的话。
  assert.match(page, /DocNotes\.drawer/, '抽屉按 DocNotes.drawer 的条目渲染');
  assert.match(page, /note-quote/, '每条批注带着它引用的那句话');
  assert.doesNotMatch(page, /note-bubble|note-block-preview|note-page-title/,
    '同一句引用不再由分组标题与计数气泡重复一遍');
  assert.match(page, /transport\.notes\(\)/, '打开时从批注文件读草稿');
  assert.match(page, /transport\.addNote\(/, '加入批注走同一条 route 词汇');
  assert.match(page, /transport\.deleteNote\(/, '每条单独删除');
  assert.match(page, /transport\.submitNotes\(/, '底部一次提交整批');
  assert.match(page, /notesSubmit\.disabled/, '空白时按钮是禁用的状态，不是点了才报错');
  assert.match(page, /startNoteDraft/, '点块尾气泡直接在抽屉里开草稿');
  assert.match(page, /note-draft/, '草稿在抽屉里就地写，不再有第二层浮层');
  assert.match(page, /flushPendingDraft/, '有字才落盘，空草稿不留');
  assert.match(transport, /note_submit/, '通道只有一套动作名：批注提交是 note_submit');
  assert.match(surface, /DOC_SCRIPTS|assertDocScripts/, '侧栏自包含入口按唯一脚本清单内联批注规则');

  // 引用的话截成一行：单行省略，不换行也不撑高抽屉。
  assert.match(css, /\.note-quote\s*\{[^}]*white-space:\s*nowrap/, '引用的话只占一行');
  assert.match(css, /\.note-quote\s*\{[^}]*text-overflow:\s*ellipsis/, '一行放不下就省略');
  assert.doesNotMatch(css, /\.note-page-title|\.note-page\b/, '按页分组的标题样式删干净');
  assert.match(css, /\.notes-panel/, '抽屉要有自己的样式');
});

// ── 归档以模型回执的 applied 为准：改到的块归档，没改到的留在右侧并标注 ────────
test('模型写回：applied 的块上批注自动归档并留改前改后快照，没改到的标「模型没动这条」', async (t) => {
  const { path, notesPath } = sandboxExample();
  const server = await openWorkbench(t, path);
  const opened = await getJson(server.url, '/api/doc');
  const beforeRaw = opened.body.blocks.find((block) => block.anchor === 'b:7b057d').raw;

  const changed = (await postJson(server.url, '/api/note', { anchor: 'b:7b057d', text: '这句太虚' })).body.note;
  const skipped = (await postJson(server.url, '/api/note', { anchor: 'b:292f6c', text: '补一个数字' })).body.note;
  const submitted = (await postJson(server.url, '/api/note/submit', {})).body;
  assert.equal(submitted.ok, true, JSON.stringify(submitted));

  const claimed = await postJson(server.url, '/api/task/claim', { task_id: submitted.task.id });
  assert.equal(claimed.status, 200, JSON.stringify(claimed.body));

  const patched = await postJson(server.url, '/api/patch', {
    task_id: submitted.task.id,
    patches: [{ anchor: 'b:7b057d', content: '主张：用 150ml 浓缩形态进入「状态调节」货架。' }],
  });
  assert.equal(patched.status, 200, JSON.stringify(patched.body));
  assert.deepEqual(patched.body.applied, ['b:7b057d'], '模型只改了这一块');

  const afterDoc = await getJson(server.url, '/api/doc');
  const afterRaw = afterDoc.body.blocks.find((block) => block.anchor === 'b:7b057d').raw;

  // 落盘：改到的自动进 resolved；人没点，归档由回执决定。
  const saved = readNotesFile(notesPath);
  const archived = saved.notes.find((note) => note.id === changed.id);
  assert.equal(archived.state, 'resolved');
  assert.match(archived.resolved_at, /^\d{4}-\d{2}-\d{2}T/, '归档时间就是模型回执落盘的时间');
  assert.equal(archived.model_state, null, '改到了就没有「没动这条」的标注');
  assert.deepEqual(archived.page, { chapter: 1, index: 1 }, '归档还记着当初所在页');
  assert.deepEqual(archived.snapshot, { before: beforeRaw, after: afterRaw },
    '快照存的是块 raw 本身：改前、改后，不是只存锚点');

  const left = saved.notes.find((note) => note.id === skipped.id);
  assert.equal(left.state, 'committed', '没改到的留在右侧，不退成草稿也不消失');
  assert.equal(left.model_state, 'untouched', '没改到的是结构化状态，不是一句文案');
  assert.equal(left.snapshot, null, '没改到就没有快照');

  // 两条都还读得到：列表与历史用同一份批注文件。
  const listed = await getJson(server.url, '/api/notes');
  assert.deepEqual(listed.body.notes.map((note) => note.state).sort(), ['committed', 'resolved']);
  const listedArchived = listed.body.notes.find((note) => note.id === changed.id);
  assert.deepEqual(listedArchived.snapshot, { before: beforeRaw, after: afterRaw }, '模型侧读同一个快照');

  // 快照不随之后的编辑漂移：块后来又被改过，归档里仍是当时的改前/改后。
  const edited = await postJson(server.url, '/api/block', {
    anchor: 'b:7b057d',
    content: '又被改了一次。',
    base_sha256: afterDoc.body.sha256,
  });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  const drifted = readNotesFile(notesPath).notes.find((note) => note.id === changed.id);
  assert.deepEqual(drifted.snapshot, { before: beforeRaw, after: afterRaw },
    '块后来再被改，归档快照不跟着变成现在的内容');
});

// ── 模型没写回就完成：这批批注一条都不归档，全部标「模型没动这条」 ────────────
test('模型 claim 后直接 complete：没改到的批注留在右侧并标「模型没动这条」', async (t) => {
  const { path, notesPath } = sandboxExample();
  const server = await openWorkbench(t, path);

  const one = (await postJson(server.url, '/api/note', { anchor: 'b:7b057d', text: '这句太虚' })).body.note;
  const two = (await postJson(server.url, '/api/note', { anchor: 'b:292f6c', text: '补一个数字' })).body.note;
  const submitted = (await postJson(server.url, '/api/note/submit', {})).body;
  await postJson(server.url, '/api/task/claim', { task_id: submitted.task.id });
  const completed = await postJson(server.url, '/api/task/complete', { task_id: submitted.task.id });
  assert.equal(completed.status, 200, JSON.stringify(completed.body));

  const saved = readNotesFile(notesPath);
  assert.deepEqual(saved.notes.map((note) => note.state), ['committed', 'committed'], '一条都不归档');
  assert.deepEqual(saved.notes.map((note) => note.model_state), ['untouched', 'untouched']);
  assert.deepEqual(saved.notes.map((note) => note.id), [one.id, two.id]);
});

// ── 每条可重新打开回草稿：归档的与没动过的都能退回去 ─────────────────────────
test('历史批注与「模型没动这条」都能重新打开回草稿', async (t) => {
  const { path, notesPath } = sandboxExample();
  const server = await openWorkbench(t, path);

  const changed = (await postJson(server.url, '/api/note', { anchor: 'b:7b057d', text: '这句太虚' })).body.note;
  const skipped = (await postJson(server.url, '/api/note', { anchor: 'b:292f6c', text: '补一个数字' })).body.note;
  const submitted = (await postJson(server.url, '/api/note/submit', {})).body;
  await postJson(server.url, '/api/task/claim', { task_id: submitted.task.id });
  await postJson(server.url, '/api/patch', {
    task_id: submitted.task.id,
    patches: [{ anchor: 'b:7b057d', content: '改好了。' }],
  });

  const reopenResolved = await postJson(server.url, '/api/note/reopen', { id: changed.id });
  assert.equal(reopenResolved.status, 200, JSON.stringify(reopenResolved.body));
  assert.equal(reopenResolved.body.note.state, 'draft');
  assert.equal(reopenResolved.body.note.batch, null);
  assert.equal(reopenResolved.body.note.resolved_at, null);
  assert.equal(reopenResolved.body.note.model_state, null);
  assert.equal(reopenResolved.body.note.snapshot, null, '退回草稿就不再挂着旧快照');

  const reopenSkipped = await postJson(server.url, '/api/note/reopen', { id: skipped.id });
  assert.equal(reopenSkipped.status, 200, JSON.stringify(reopenSkipped.body));
  assert.equal(reopenSkipped.body.note.state, 'draft');
  assert.equal(reopenSkipped.body.note.model_state, null, '退回草稿就没有「模型没动这条」的标注');

  const saved = readNotesFile(notesPath);
  assert.deepEqual(saved.notes.map((note) => note.state), ['draft', 'draft']);

  const unknown = await postJson(server.url, '/api/note/reopen', { id: 'n:00000000' });
  assert.equal(unknown.status, 400, JSON.stringify(unknown.body));
  assert.equal(unknown.body.code, 'note_missing');

  const draft = await postJson(server.url, '/api/note/reopen', { id: changed.id });
  assert.equal(draft.status, 409, JSON.stringify(draft.body));
  assert.equal(draft.body.code, 'note_state', '还是草稿就不用重新打开');
});

// ── 文件超过 2 MB：最老的归档移到 notes-archive.json，列表照样读得到 ──────────
test('批注文件超过 2 MB：最老的归档移进 notes-archive.json，历史仍可读、可重新打开', async (t) => {
  const { path, notesPath } = sandboxExample();
  const server = await openWorkbench(t, path);

  // 直接写一份超过 2 MB 的批注文件：每条都带块快照，时间从老到新。
  mkdirSync(dirname(notesPath), { recursive: true });
  const fat = Array.from({ length: 30 }, (_, index) => ({
    id: `n:${String(index).padStart(8, '0')}`,
    anchor: 'b:7b057d',
    page: { chapter: 1, index: 1 },
    text: `第 ${index} 条历史批注`,
    state: 'resolved',
    batch: 'b:old',
    created_at: `2026-01-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`,
    resolved_at: `2026-01-${String(index + 1).padStart(2, '0')}T01:00:00.000Z`,
    model_state: null,
    snapshot: { before: 'A'.repeat(90000), after: 'B'.repeat(90000) },
  }));
  writeFileSync(notesPath, `${JSON.stringify({ contract: 'planners-doc-notes/1', notes: fat }, null, 2)}\n`);
  assert.ok(statSync(notesPath).size > 2 * 1024 * 1024, '前提：这份文件已经超过 2 MB');

  // 任何一次保存都会顺手收口：加一条草稿触发。
  const added = await postJson(server.url, '/api/note', { anchor: 'b:7b057d', text: '新提的草稿' });
  assert.equal(added.status, 200, JSON.stringify(added.body));

  const archivePath = join(dirname(notesPath), 'notes-archive.json');
  const main = readNotesFile(notesPath);
  const archive = JSON.parse(readFileSync(archivePath, 'utf8'));
  assert.equal(archive.contract, 'planners-doc-notes/1');
  assert.ok(statSync(notesPath).size <= 2 * 1024 * 1024, '主文件收口在 2 MB 以内');
  assert.ok(archive.notes.length > 0, '最老的归档真的搬走了，不是原样留着');

  const mainIds = new Set(main.notes.map((note) => note.id));
  const archiveIds = new Set(archive.notes.map((note) => note.id));
  assert.equal([...mainIds].some((id) => archiveIds.has(id)), false, '同一份批注不会同时留在两个文件里');
  assert.equal(mainIds.size + archiveIds.size, 31, '30 条历史 + 1 条新草稿一条不丢');
  const oldest = archive.notes.reduce((min, note) => (note.resolved_at < min ? note.resolved_at : min), archive.notes[0].resolved_at);
  assert.equal(oldest, fat[0].resolved_at, '移走的是最老的那几条');
  const mainResolved = main.notes.filter((note) => note.state === 'resolved');
  if (mainResolved.length) {
    const newestArchived = archive.notes.reduce((max, note) => (note.resolved_at > max ? note.resolved_at : max), archive.notes[0].resolved_at);
    const oldestMain = mainResolved.reduce((min, note) => (note.resolved_at < min ? note.resolved_at : min), mainResolved[0].resolved_at);
    assert.ok(newestArchived <= oldestMain, '档案里的都比主文件里的老');
  }

  // 列表把两边合起来读：人的历史不因为搬家而消失。
  const listed = await getJson(server.url, '/api/notes');
  assert.equal(listed.body.notes.filter((note) => note.state === 'resolved').length, 30);

  // 归档里的那条也能重新打开：回到主文件、回草稿、快照清掉。
  const archivedId = archive.notes[0].id;
  const reopened = await postJson(server.url, '/api/note/reopen', { id: archivedId });
  assert.equal(reopened.status, 200, JSON.stringify(reopened.body));
  assert.equal(reopened.body.note.state, 'draft');
  const afterArchive = JSON.parse(readFileSync(archivePath, 'utf8'));
  assert.equal(afterArchive.notes.some((note) => note.id === archivedId), false, '从档案里搬回来，不留副本');
  assert.equal(readNotesFile(notesPath).notes.find((note) => note.id === archivedId).state, 'draft');
});

// ── 历史列表只给人看「当初那句话 + 时间」，快照与页号都不进列表 ───────────────
test('历史批注列表只给原话与时间；快照不展开，也不再记「第 N 页」', async () => {
  const module = await import('../assets/workbench/doc-notes.js');
  const DocNotes = module.default ?? module;
  const notes = [
    {
      id: 'n:1', anchor: 'b:7b057d', page: { chapter: 1, index: 1 }, text: '这句太虚', state: 'resolved',
      batch: 'b:1', created_at: '2026-11-20T08:00:00.000Z', resolved_at: '2026-11-20T09:00:00.000Z',
      note: null, snapshot: { before: '旧块', after: '新块' },
    },
    {
      id: 'n:2', anchor: 'b:292f6c', page: { chapter: 1, index: 2 }, text: '补一个数字', state: 'resolved',
      batch: 'b:1', created_at: '2026-11-20T08:10:00.000Z', resolved_at: '2026-11-20T09:10:00.000Z',
      note: null, snapshot: { before: '旧块二', after: '新块二' },
    },
    { id: 'n:3', anchor: 'b:7b057d', page: { chapter: 1, index: 1 }, text: '还在右侧', state: 'committed', batch: 'b:2', created_at: '2026-11-20T10:00:00.000Z', resolved_at: null, model_state: 'untouched', snapshot: null },
  ];

  const history = DocNotes.history(notes);
  assert.deepEqual(history.map((item) => item.id), ['n:3', 'n:2', 'n:1'],
    '新的归档在前；「模型没动」的那条也进历史（抽屉只留三样）');
  assert.deepEqual(Object.keys(history[0]).sort(),
    ['created_at', 'id', 'model_state', 'resolved_at', 'text'],
    '历史条目只有人当初那句话、时间与结构化状态；快照与页号都不在列表上');
  assert.equal(history[0].model_state, 'untouched', '没动的那条带着结构化状态，页面据此标出来');
  assert.equal(history[2].text, '这句太虚');
  assert.equal(history[2].created_at, '2026-11-20T08:00:00.000Z');
  assert.equal('page' in history[2], false, '历史不再带「第 N 页」那种定位');
});

// ── 历史批注与版本历史同一个面板两个页签，默认停在批注 ───────────────────────
test('历史批注与版本历史在同一个面板的两个页签，默认停在批注', async () => {
  const html = readFileSync(join(core, 'assets', 'workbench', 'doc-workbench.html'), 'utf8');
  const page = readFileSync(join(core, 'assets', 'workbench', 'doc-workbench.js'), 'utf8');
  const transport = readFileSync(join(core, 'assets', 'workbench', 'doc-transport.js'), 'utf8');
  const command = readFileSync(join(core, 'scripts', 'doc-command.mjs'), 'utf8');

  assert.match(html, /id="historyTabs"/, '同一个面板里要有页签');
  assert.match(html, /data-history-tab="notes"[^>]*aria-selected="true"/, '默认停在批注');
  assert.match(html, /data-history-tab="versions"[^>]*aria-selected="false"/);
  const notesPanel = html.match(/<section[^>]*id="historyNotesPanel"[^>]*>/);
  assert.ok(notesPanel, '批注页签要有自己的面板');
  assert.doesNotMatch(notesPanel[0], /\bhidden\b/, '默认展开的是批注，不是版本');
  const versionsPanel = html.match(/<section[^>]*id="historyVersionsPanel"[^>]*>/);
  assert.ok(versionsPanel, '版本历史还在同一个面板里');
  assert.match(versionsPanel[0], /\bhidden\b/, '版本页签默认收起，但入口不丢');
  assert.match(html, /id="historyList"/, '版本历史列表还在');
  assert.match(html, /id="historyNotesList"/, '历史批注列表');

  assert.match(page, /DocNotes\.history\(/, '历史批注按同一份分组规则列出来');
  assert.match(page, /transport\.reopenNote\(/, '每条可重新打开，走同一条 route 词汇');
  assert.doesNotMatch(page, /noteStateSection|\.note-badge\b/, '抽屉不再用状态分组与徽标');
  assert.match(page, /note-delete/, '草稿仍可单条删除');
  assert.match(transport, /note_reopen:\s*'\/api\/note\/reopen'/, '本地路由表加一个同名动作');
  assert.match(transport, /reopenNote:\s*\(body\)\s*=>\s*send\('note_reopen'/, '页面只发 {route, body}');
  assert.match(command, /note_reopen:\s*\(\{ session, body \}\)\s*=>\s*session\.reopenNote\(body\)/,
    '后端路由表与本地路由同名');

  // 历史条目不展开快照：渲染函数里不出现 snapshot。
  const historySection = page.slice(page.indexOf('function renderHistoryNotes'), page.indexOf('async function openHistory'));
  assert.ok(historySection.length > 0, '页面里有独立的历史批注渲染函数');
  assert.doesNotMatch(historySection, /\.snapshot\b/, '快照不在列表展开');
});
