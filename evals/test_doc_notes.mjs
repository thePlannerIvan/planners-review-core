import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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
  assert.equal(note.note, null);
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

// ── 抽屉分组：按页组织，同一块多条收成一个计数气泡 ───────────────────────────
test('抽屉按页组织；同一块的多条批注收成一个计数气泡，草稿与已提交分开', async () => {
  const module = await import('../assets/workbench/doc-notes.js');
  const DocNotes = module.default ?? module;
  const pages = [
    { key: '1-1', chapter: '一、判断', chapterIndex: 1, index: 1, title: '品类机会' },
    { key: '1-2', chapter: '一、判断', chapterIndex: 1, index: 2, title: '人群' },
    { key: '2-1', chapter: '二、主线', chapterIndex: 2, index: 1, title: '主线' },
  ];
  const order = new Map([['b:7b057d', 2], ['b:292f6c', 5], ['b:36a372', 9]]);
  const notes = [
    { id: 'n:1', anchor: 'b:7b057d', page: { chapter: 1, index: 1 }, text: '这句太虚', state: 'draft', created_at: '2026-11-20T08:00:00.000Z' },
    { id: 'n:2', anchor: 'b:292f6c', page: { chapter: 1, index: 2 }, text: '补数字', state: 'draft', created_at: '2026-11-20T08:01:00.000Z' },
    { id: 'n:3', anchor: 'b:7b057d', page: { chapter: 1, index: 1 }, text: '换个动词', state: 'draft', created_at: '2026-11-20T08:02:00.000Z' },
    { id: 'n:4', anchor: 'b:7b057d', page: { chapter: 1, index: 1 }, text: '已交的', state: 'committed', batch: 'b:1', created_at: '2026-11-20T07:00:00.000Z' },
  ];

  const drawer = DocNotes.drawer(notes, { pages, order });
  assert.equal(drawer.draft.count, 3);
  assert.equal(drawer.committed.count, 1);
  assert.equal(drawer.resolved.count, 0, '还没有归档的批注');
  assert.deepEqual(drawer.draft.pages.map((page) => page.key), ['1-1', '1-2'], '草稿按页组织，空页不占位');
  assert.equal(drawer.draft.pages[0].chapterTitle, '一、判断');
  assert.equal(drawer.draft.pages[0].title, '品类机会');

  const [firstPage] = drawer.draft.pages;
  assert.equal(firstPage.blocks.length, 1, '同一块的多条批注只占一个位置');
  assert.equal(firstPage.blocks[0].anchor, 'b:7b057d');
  assert.equal(firstPage.blocks[0].count, 2, '计数气泡上的数字 = 这一块的批注条数');
  assert.deepEqual(firstPage.blocks[0].notes.map((note) => note.id), ['n:1', 'n:3'], '按写下顺序');
  assert.equal(firstPage.count, 2);
  assert.equal(drawer.committed.pages[0].blocks[0].count, 1, '已提交的单独一组，不和草稿混在一起');

  const empty = DocNotes.drawer([], { pages, order });
  assert.deepEqual([empty.draft.count, empty.committed.count, empty.draft.pages], [0, 0, []],
    '空白时抽屉是第一个能被判定的状态');
});

// ── 抽屉的样子：默认展开、按页、计数气泡、底部一次提交、每条可删 ──────────────
test('批注抽屉默认展开：按页列出，同一块收成计数气泡，底部整批提交，每条可删', async () => {
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
  assert.match(html, />提交给模型修改</, '底部按钮就是「提交给模型修改」');
  assert.match(html, /id="notesCollapse"[^>]*aria-expanded="true"/);

  // 按页组织 + 计数气泡 + 单条删除都经同一份分组规则与同一条通道。
  assert.match(page, /DocNotes\.drawer/, '抽屉按 DocNotes.drawer 的分组分页渲染');
  assert.match(page, /transport\.notes\(\)/, '打开时从批注文件读草稿');
  assert.match(page, /transport\.addNote\(/, '加入批注走同一条 route 词汇');
  assert.match(page, /transport\.deleteNote\(/, '每条单独删除');
  assert.match(page, /transport\.submitNotes\(/, '底部一次提交整批');
  assert.match(page, /note-bubble/, '同一块多条收成一个计数气泡');
  assert.match(page, /notesSubmit\.disabled/, '空白时按钮是禁用的状态，不是点了才报错');
  assert.match(page, /已提交/, '提交后该批进入已提交态，看得见');
  assert.match(page, /加入批注/, '写批注的入口在同一个行内输入里');
  assert.match(page, /feedbackNote[\s\S]{0,240}hidden = scope !== 'blocks'/, '批注只落在块上：整页 / 整份派发不改成逐块批注');
  assert.match(transport, /note_submit/, '通道只有一套动作名：批注提交是 note_submit');
  assert.match(surface, /doc-notes\.js/, '侧栏自包含入口也内联批注分组逻辑');

  // 计数气泡：圆角小徽标、数字居中、悬停浮起、不描边框。
  assert.match(css, /\.note-bubble\s*\{[^}]*border-radius:\s*999px/, '气泡是圆角小徽标');
  assert.match(css, /\.note-bubble\s*\{[^}]*border:\s*0/, '气泡不描边框');
  assert.match(css, /\.note-bubble\s*\{[^}]*justify-content:\s*center/, '数字居中');
  assert.match(css, /\.note-bubble:hover[^{]*\{[^}]*transform:\s*translateY\(-1px\)/, '悬停浮起');
  assert.match(css, /\.notes-panel/, '抽屉要有自己的样式');
});
