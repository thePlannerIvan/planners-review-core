import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// 结构 diff 这条缝只测外部行为：
//   · 模型侧取稿（`doc-command.mjs` 的 tasks，browser:false）刷新 `.doc-workbench/state/baseline.json`；
//   · 人提交一批批注时，回执与任务里带一份 `planners-doc-diff/1`；
//   · 断言只落在 baseline 文件、提交回执与模型能读到的任务形状上，不看内部匹配函数。
const core = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXAMPLES = join(core, 'contracts', 'examples');
const DIFF_CONTRACT = 'planners-doc-diff/1';

const sandboxes = [];
after(() => { for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true }); });

/** 真实样例：diff 要能在交付语料上工作，而不是只手搓样例。 */
function sandboxExample(name = 'storyline.md') {
  const dir = mkdtempSync(join(tmpdir(), 'planners-diff-'));
  sandboxes.push(dir);
  cpSync(EXAMPLES, dir, { recursive: true });
  return { dir, path: join(dir, name), baselinePath: join(dir, '.doc-workbench', 'state', 'baseline.json') };
}

const readBaseline = (path) => JSON.parse(readFileSync(path, 'utf8'));

const postJson = async (url, path, body) => {
  const response = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
};

async function openWorkbench(t, docPath) {
  const { startDocWorkbench } = await import('../scripts/doc-workbench.mjs');
  const server = await startDocWorkbench({ docPath, port: 0 });
  t.after(() => server.close());
  return server;
}

/** 宿主那一侧加载 surface 的方式：data + 解析后的绝对路径。 */
async function modelSurface(docPath) {
  const { buildDocSurface } = await import('../scripts/doc-surface.mjs');
  const built = buildDocSurface({ docPath });
  const data = JSON.parse(readFileSync(built.surfacePath, 'utf8'));
  const base = dirname(built.surfacePath);
  return {
    file: built.surfacePath,
    base,
    data,
    dir: resolve(base, data.dir),
    projectRoot: resolve(base, data.project_root),
  };
}

/** 模型侧取稿：与 `doc-command.mjs ... tasks` 是同一条路（browser:false 即模型身份）。 */
async function modelFetchTasks(surface) {
  const { runDocCommand } = await import('../scripts/doc-command.mjs');
  return runDocCommand(surface, { route: 'tasks' }, { browser: false });
}

// ── 基准与空 diff：没越界时照常提交，模型读得到 ───────────────────────────────
test('模型取稿时刷新基准；提交批次随附 planners-doc-diff/1，结构没变时是空 diff 也照常提交', async (t) => {
  const { path, baselinePath } = sandboxExample();
  const surface = await modelSurface(path);

  // 模型取稿之前没有基准：这是「上一次模型取稿时看到的版本」的起点。
  const fetched = await modelFetchTasks(surface);
  assert.equal(fetched.ok, true, JSON.stringify(fetched));
  const baseline = readBaseline(baselinePath);
  assert.equal(baseline.contract, 'planners-doc-baseline/1');
  assert.match(baseline.sha256, /^[0-9a-f]{64}$/);
  assert.match(baseline.taken_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(baseline.pages.map((page) => page.title).slice(0, 2), [
    '品类机会不在「解渴」，在「调节状态」', '人群不是「熬夜党」，是「需要准时切换的人」',
  ], '基准记下模型当时看到的页结构');

  const server = await openWorkbench(t, path);
  const added = await postJson(server.url, '/api/note', { anchor: 'b:7b057d', text: '这句太虚' });
  assert.equal(added.status, 200, JSON.stringify(added.body));

  const submitted = await postJson(server.url, '/api/note/submit', {});
  assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
  assert.equal(submitted.body.ok, true, '结构没变（diff 为空）也照常提交');

  const diff = submitted.body.diff;
  assert.equal(diff.contract, DIFF_CONTRACT);
  assert.equal(diff.batch, submitted.body.batch);
  assert.equal(diff.baseline_sha256, baseline.sha256, 'diff 基准就是模型上次取稿时看到的版本');
  for (const key of ['chapters', 'pages', 'blocks', 'orphan_notes']) {
    assert.deepEqual(diff[key], [], `没有越界时 ${key} 是空数组`);
  }
  assert.deepEqual(submitted.body.task.diff, diff, '任务里带同一份 diff');

  // 模型侧读得到：CLI 那条路读回的任务里带着同一份 diff。
  const tasks = await modelFetchTasks(surface);
  assert.equal(tasks.ok, true, JSON.stringify(tasks));
  const task = tasks.tasks.find((item) => item.id === submitted.body.task.id);
  assert.ok(task, '模型侧 tasks 读得到这批任务');
  assert.deepEqual(task.diff, diff);
});

// ── 改名：标题换了，锚点与位置没动 ─────────────────────────────────────────────
test('章节与页改名进 diff：标题换了，块锚点与位置没动', async (t) => {
  const { path, baselinePath } = sandboxExample();
  const surface = await modelSurface(path);
  await modelFetchTasks(surface);
  const baseline = readBaseline(baselinePath);

  // 只换两行标题：章节名与一页的页名。人的编辑面就是正文，换的是同一批块。
  const changed = readFileSync(path, 'utf8')
    .replace('# 一、判断', '# 一、判断（改）')
    .replace('## 品类机会不在「解渴」，在「调节状态」', '## 品类机会：状态调节');
  writeFileSync(path, changed);

  const server = await openWorkbench(t, path);
  const note = await postJson(server.url, '/api/note', { anchor: 'b:7b057d', text: '这句太虚' });
  assert.equal(note.status, 200, JSON.stringify(note.body));
  const submitted = await postJson(server.url, '/api/note/submit', {});
  assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
  const diff = submitted.body.diff;

  assert.equal(diff.baseline_sha256, baseline.sha256);
  assert.deepEqual(diff.chapters, [{
    action: 'renamed',
    from: { index: 1, title: '一、判断' },
    to: { index: 1, title: '一、判断（改）' },
  }], '章节改名：同一章换了标题，不是删一章再加一章');
  assert.deepEqual(diff.pages, [{
    action: 'renamed',
    from: [{ chapter: 1, index: 1, title: '品类机会不在「解渴」，在「调节状态」' }],
    to: { chapter: 1, index: 1, title: '品类机会：状态调节' },
  }], '页改名：锚点还在同一页，只说标题换了');
  assert.deepEqual(diff.blocks, [], '改名不挪块，块列表为空');
});

const only = (list, predicate, label) => {
  const found = list.filter(predicate);
  assert.equal(found.length, 1, `${label}：应恰好一条，实际 ${JSON.stringify(list)}`);
  return found[0];
};

// ── 页的新增与删除：整页连同块一起消失 / 出现 ─────────────────────────────────
test('页与块的新增、删除进 diff：整页删掉时说清是哪一页、哪几块', async (t) => {
  const { path } = sandboxExample();
  const surface = await modelSurface(path);
  await modelFetchTasks(surface);

  const lines = readFileSync(path, 'utf8').split('\n');
  const start = lines.indexOf('## 竞争空白在「剂量—场景」的交叉处');
  assert.ok(start > 0, '样例里应有这一页');
  const end = lines.findIndex((line, offset) => offset > start && line.startsWith('# '));
  lines.splice(start, end - start);
  const insertAt = lines.indexOf('# 二、主线');
  lines.splice(insertAt, 0, '## 新增：复购判断', '', '复购是首轮唯一的硬指标。<!-- b:ab12cd -->', '');
  writeFileSync(path, lines.join('\n'));

  const server = await openWorkbench(t, path);
  const note = await postJson(server.url, '/api/note', { anchor: 'b:7b057d', text: '这句太虚' });
  assert.equal(note.status, 200);
  const submitted = await postJson(server.url, '/api/note/submit', {});
  assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
  const diff = submitted.body.diff;

  assert.deepEqual(diff.chapters, [], '章节没动');
  const added = only(diff.pages, (entry) => entry.action === 'added', '页新增');
  assert.deepEqual(added.to, { chapter: 1, index: 3, title: '新增：复购判断' });
  const removed = only(diff.pages, (entry) => entry.action === 'removed', '页删除');
  assert.deepEqual(removed.from, [{ chapter: 1, index: 3, title: '竞争空白在「剂量—场景」的交叉处' }]);

  const removedBlocks = diff.blocks.filter((entry) => entry.action === 'removed');
  assert.deepEqual(removedBlocks.map((entry) => entry.anchor).sort(), [
    'b:2534cb', 'b:3669fa', 'b:727685', 'b:d5fc89', 'b:e3d281',
  ], '整页删掉时页里的块逐个报删除');
  for (const entry of removedBlocks) assert.deepEqual(entry.from, { chapter: 1, page: 3 });
  const addedBlock = only(diff.blocks, (entry) => entry.action === 'added', '块新增');
  assert.deepEqual(addedBlock, { anchor: 'b:ab12cd', action: 'added', from: null, to: { chapter: 1, page: 3 } });
});

const getJson = async (url, path) => {
  const response = await fetch(`${url}${path}`);
  return { status: response.status, body: await response.json() };
};

// ── 页的移动：整页换章节，块跟着页走、不算块移动 ───────────────────────────────
test('页移动进 diff：整页换章节，页里每一块都跟着走', async (t) => {
  const { path } = sandboxExample();
  const surface = await modelSurface(path);
  await modelFetchTasks(surface);

  const server = await openWorkbench(t, path);
  const opened = await getJson(server.url, '/api/doc');
  const moved = await postJson(server.url, '/api/reorder', {
    op: 'move-page',
    base_sha256: opened.body.sha256,
    page: { chapter: 1, index: 1 },
    to: { chapter: 2, index: 1, position: 'after' },
  });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.equal(moved.body.ok, true, JSON.stringify(moved.body));

  const note = await postJson(server.url, '/api/note', { anchor: 'b:7b057d', text: '这句太虚' });
  assert.equal(note.status, 200, JSON.stringify(note.body));
  const submitted = await postJson(server.url, '/api/note/submit', {});
  assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
  const diff = submitted.body.diff;

  assert.deepEqual(diff.chapters, [], '章节没动，整页只是换了一章');
  const crossChapter = only(diff.pages, (entry) => entry.action === 'moved'
    && entry.from[0].chapter === 1 && entry.to.chapter === 2, '跨章移动');
  assert.deepEqual(crossChapter.from, [{ chapter: 1, index: 1, title: '品类机会不在「解渴」，在「调节状态」' }]);
  assert.deepEqual(crossChapter.to, { chapter: 2, index: 2, title: '品类机会不在「解渴」，在「调节状态」' });
  assert.equal(diff.blocks.length, 0, '块跟着它那一页走，不报成块的跨页移动');
});

// ── 小样例：结构动作逐条对照，断言才看得清是哪一条 ─────────────────────────────
const COMPACT = `---
contract: planners-doc/2
doc: storyline
project: 结构 diff 样例
---

# 甲

## 甲一

甲一第一段。<!-- b:a10001 -->

甲一第二段。<!-- b:a10002 -->

## 甲二

甲二第一段。<!-- b:a20001 -->

# 乙

## 乙一

乙一第一段。<!-- b:b10001 -->

## 乙二

乙二第一段。<!-- b:b20001 -->
`;

function sandboxDoc(markdown = COMPACT) {
  const dir = mkdtempSync(join(tmpdir(), 'planners-diff-'));
  sandboxes.push(dir);
  const path = join(dir, 'storyline.md');
  writeFileSync(path, markdown);
  return { dir, path, baselinePath: join(dir, '.doc-workbench', 'state', 'baseline.json') };
}

const md = (lines) => `${lines.join('\n').replace(/\n+$/, '')}\n`;

// ── 章节移动：章节还在，只是换了位置 ───────────────────────────────────────────
test('章节移动进 diff：两章互换位置，页跟着换章节', async (t) => {
  const { path } = sandboxDoc();
  const surface = await modelSurface(path);
  await modelFetchTasks(surface);

  // 把「乙」整章挪到「甲」前面。
  writeFileSync(path, md([
    '---', 'contract: planners-doc/2', 'doc: storyline', 'project: 结构 diff 样例', '---', '',
    '# 乙', '', '## 乙一', '', '乙一第一段。<!-- b:b10001 -->', '',
    '## 乙二', '', '乙二第一段。<!-- b:b20001 -->', '',
    '# 甲', '', '## 甲一', '', '甲一第一段。<!-- b:a10001 -->', '',
    '甲一第二段。<!-- b:a10002 -->', '',
    '## 甲二', '', '甲二第一段。<!-- b:a20001 -->',
  ]));

  const server = await openWorkbench(t, path);
  const note = await postJson(server.url, '/api/note', { anchor: 'b:b10001', text: '这句太虚' });
  assert.equal(note.status, 200, JSON.stringify(note.body));
  const submitted = await postJson(server.url, '/api/note/submit', {});
  assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
  const diff = submitted.body.diff;

  assert.deepEqual(diff.chapters, [
    { action: 'moved', from: { index: 2, title: '乙' }, to: { index: 1, title: '乙' } },
    { action: 'moved', from: { index: 1, title: '甲' }, to: { index: 2, title: '甲' } },
  ], '章节移动只报移动，不报成删一章再加一章；按新顺序排');
  assert.deepEqual(diff.blocks, [], '块没跨页，章节换位置不算块移动');
  assert.equal(diff.pages.length, 4, '四页的章节号 / 页号都变了，逐页报移动');
  for (const entry of diff.pages) assert.equal(entry.action, 'moved');
});

// ── 页合并 / 拆分：两页并一页、一页分成两页 ────────────────────────────────────
test('页合并进 diff：两页并一页，锚点都在，报一条合并而不是删两页加一页', async (t) => {
  const { path } = sandboxDoc();
  const surface = await modelSurface(path);
  await modelFetchTasks(surface);

  // 去掉「甲二」的页标题：它下面那块并进「甲一」。
  writeFileSync(path, COMPACT.replace('## 甲二\n\n', ''));
  const server = await openWorkbench(t, path);
  const note = await postJson(server.url, '/api/note', { anchor: 'b:a10001', text: '这句太虚' });
  assert.equal(note.status, 200, JSON.stringify(note.body));
  const submitted = await postJson(server.url, '/api/note/submit', {});
  assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
  const diff = submitted.body.diff;

  assert.deepEqual(diff.pages, [{
    action: 'merged',
    from: [
      { chapter: 1, index: 1, title: '甲一' },
      { chapter: 1, index: 2, title: '甲二' },
    ],
    to: { chapter: 1, index: 1, title: '甲一' },
  }], '两页并成一页：from 是被并进来的页');
  assert.deepEqual(diff.blocks, [], '并页时块没有跨页移动：它们只是不再属于原来那页');
});

test('页拆分进 diff：一页分成两页，同一批锚点散到两页里', async (t) => {
  const { path } = sandboxDoc();
  const surface = await modelSurface(path);
  await modelFetchTasks(surface);

  // 在第二段前加一个页标题：原来的「甲一」拆成两页。
  writeFileSync(path, COMPACT.replace('甲一第二段。<!-- b:a10002 -->', '## 甲一·续\n\n甲一第二段。<!-- b:a10002 -->'));
  const server = await openWorkbench(t, path);
  const note = await postJson(server.url, '/api/note', { anchor: 'b:a10001', text: '这句太虚' });
  assert.equal(note.status, 200, JSON.stringify(note.body));
  const submitted = await postJson(server.url, '/api/note/submit', {});
  assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
  const diff = submitted.body.diff;

  const split = only(diff.pages, (entry) => entry.action === 'split', '页拆分');
  assert.deepEqual(split, {
    action: 'split',
    from: [{ chapter: 1, index: 1, title: '甲一' }],
    to: { chapter: 1, index: 2, title: '甲一·续' },
  }, '拆分报「从哪一页分出哪一页」：原页还在，只有新分出来的那张进 diff');
  assert.deepEqual(diff.blocks, [], '拆分不把留在原页的块报成新增，也不把第二段报成移动');
});

// ── 块的跨页移动与删除 ────────────────────────────────────────────────────────
test('块跨页移动进 diff：记下从哪一页到哪一页', async (t) => {
  const { path } = sandboxDoc();
  const surface = await modelSurface(path);
  await modelFetchTasks(surface);

  const server = await openWorkbench(t, path);
  const opened = await getJson(server.url, '/api/doc');
  const moved = await postJson(server.url, '/api/reorder', {
    op: 'move-block',
    base_sha256: opened.body.sha256,
    anchor: 'b:a10002',
    to: { chapter: 1, index: 2, before: 'b:a20001' },
  });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.equal(moved.body.ok, true, JSON.stringify(moved.body));

  const note = await postJson(server.url, '/api/note', { anchor: 'b:a10002', text: '这段挪个位置' });
  assert.equal(note.status, 200, JSON.stringify(note.body));
  const submitted = await postJson(server.url, '/api/note/submit', {});
  assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
  const diff = submitted.body.diff;

  assert.deepEqual(diff.chapters, []);
  assert.deepEqual(diff.pages, [], '页本身没变，只挪了一块');
  assert.deepEqual(diff.blocks, [{
    anchor: 'b:a10002',
    action: 'moved',
    from: { chapter: 1, page: 1 },
    to: { chapter: 1, page: 2 },
  }], '块移动只说锚点、从哪一页到哪一页');
});

test('块删除进 diff：锚点不在了就报删除', async (t) => {
  const { path } = sandboxDoc();
  const surface = await modelSurface(path);
  await modelFetchTasks(surface);

  writeFileSync(path, COMPACT.replace('甲一第二段。<!-- b:a10002 -->\n\n', ''));
  const server = await openWorkbench(t, path);
  const note = await postJson(server.url, '/api/note', { anchor: 'b:a10001', text: '这句太虚' });
  assert.equal(note.status, 200, JSON.stringify(note.body));
  const submitted = await postJson(server.url, '/api/note/submit', {});
  assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
  const diff = submitted.body.diff;

  assert.deepEqual(diff.blocks, [{
    anchor: 'b:a10002', action: 'removed', from: { chapter: 1, page: 1 }, to: null,
  }]);
  assert.deepEqual(diff.pages, [], '页还在，只是少了一块');
});

// ── 孤儿批注：目标块被人删掉，意见不许静默消失 ────────────────────────────────
test('目标块被删的批注进 diff.orphan_notes：不静默消失，其余照常提交', async (t) => {
  const { path } = sandboxDoc();
  const surface = await modelSurface(path);
  await modelFetchTasks(surface);

  const server = await openWorkbench(t, path);
  const doomed = await postJson(server.url, '/api/note', { anchor: 'b:a10002', text: '这条会失去目标' });
  const kept = await postJson(server.url, '/api/note', { anchor: 'b:a10001', text: '这条还在' });
  assert.equal(doomed.status, 200, JSON.stringify(doomed.body));
  assert.equal(kept.status, 200, JSON.stringify(kept.body));

  // 块在别处被删掉（模型 / 别的工具）：批注文件里留下一条指向已不存在块的意见。
  writeFileSync(path, COMPACT.replace('甲一第二段。<!-- b:a10002 -->\n\n', ''));

  const submitted = await postJson(server.url, '/api/note/submit', {});
  assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
  assert.deepEqual(submitted.body.diff.orphan_notes, [{
    note: doomed.body.note.id,
    text: '这条会失去目标',
    reason: 'target_block_removed',
  }], '失去目标的批注进 orphan_notes，说清哪一条、为什么');
  assert.deepEqual(submitted.body.orphaned.map((entry) => entry.anchor), ['b:a10002'], '回执里仍带锚点，人知道去哪重选');
  assert.deepEqual(submitted.body.committed, [kept.body.note.id], '有目标的批注照常提交');
  assert.deepEqual(submitted.body.task.diff.orphan_notes, submitted.body.diff.orphan_notes);
  const removed = only(submitted.body.diff.blocks, (entry) => entry.action === 'removed', '被删的块');
  assert.equal(removed.anchor, 'b:a10002');
});

// ── 基准只由模型取稿刷新：页面轮询 tasks 不能把基准冲掉 ────────────────────────
test('基准是上一次模型取稿时看到的版本：页面读 tasks 不刷新基准', async (t) => {
  const { path, baselinePath } = sandboxDoc();
  const surface = await modelSurface(path);
  await modelFetchTasks(surface);
  const baseline = readBaseline(baselinePath);

  writeFileSync(path, COMPACT.replace('## 甲二', '## 甲二（改）'));
  // 页面每 3 秒轮询一次锁：它走的是 browser 身份，不该动基准。
  const pagePoll = await (await import('../scripts/doc-command.mjs'))
    .runDocCommand(surface, { route: 'tasks' }, { browser: true });
  assert.equal(pagePoll.ok, true, JSON.stringify(pagePoll));
  assert.deepEqual(readBaseline(baselinePath), baseline, '页面轮询不改基准');

  const server = await openWorkbench(t, path);
  await postJson(server.url, '/api/note', { anchor: 'b:a10001', text: '这句太虚' });
  const first = await postJson(server.url, '/api/note/submit', {});
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(only(first.body.diff.pages, (entry) => entry.action === 'renamed', '改名').to.title, '甲二（改）');

  // 模型又取了一次稿：基准换成它这次看到的样子，旧的改名不再重复报。
  await modelFetchTasks(surface);
  const second = await postJson(server.url, '/api/note', { anchor: 'b:a10001', text: '再改一句' });
  assert.equal(second.status, 200, JSON.stringify(second.body));
  const next = await postJson(server.url, '/api/note/submit', {});
  assert.equal(next.status, 200, JSON.stringify(next.body));
  assert.deepEqual(next.body.diff.pages, [], '上一次取稿之后的改动已经报过，不再重复');
  assert.deepEqual(next.body.diff.chapters, []);
  assert.deepEqual(next.body.diff.blocks, []);
});

// ── 模型侧读得到：CLI 的 tasks 就是读取入口，没有第二套 CLI ────────────────────
test('模型侧 CLI 用 tasks 读得到这份 diff（不另造命令）', async (t) => {
  const { spawnSync } = await import('node:child_process');
  const { path } = sandboxDoc();
  const surface = await modelSurface(path);
  await modelFetchTasks(surface);

  writeFileSync(path, COMPACT.replace('## 乙一', '## 乙一（改名）'));
  const server = await openWorkbench(t, path);
  await postJson(server.url, '/api/note', { anchor: 'b:b10001', text: '这句太虚' });
  const submitted = await postJson(server.url, '/api/note/submit', {});
  assert.equal(submitted.status, 200, JSON.stringify(submitted.body));

  const result = spawnSync(process.execPath, [join(core, 'scripts', 'doc-command.mjs'), surface.file, 'tasks'], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(result.stdout);
  const task = receipt.tasks.find((item) => item.id === submitted.body.task.id);
  assert.ok(task, 'CLI 的 tasks 读得到这批任务');
  assert.equal(task.diff.contract, DIFF_CONTRACT);
  assert.equal(only(task.diff.pages, (entry) => entry.action === 'renamed', '改名').to.title, '乙一（改名）');
});

// ── 章节的新增与删除 ──────────────────────────────────────────────────────────
test('章节新增、删除进 diff：整章连同页和块一起出现 / 消失', async (t) => {
  const { path } = sandboxDoc();
  const surface = await modelSurface(path);
  await modelFetchTasks(surface);

  // 删掉「乙」整章（两页两块），换成新的一章「丙」。
  const lines = COMPACT.split('\n');
  const start = lines.indexOf('# 乙');
  lines.splice(start);
  lines.push('', '# 丙', '', '## 丙一', '', '丙一第一段。<!-- b:c10001 -->', '');
  writeFileSync(path, `${lines.join('\n').replace(/\n+$/, '')}\n`);

  const server = await openWorkbench(t, path);
  const note = await postJson(server.url, '/api/note', { anchor: 'b:a10001', text: '这句太虚' });
  assert.equal(note.status, 200, JSON.stringify(note.body));
  const submitted = await postJson(server.url, '/api/note/submit', {});
  assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
  const diff = submitted.body.diff;

  assert.deepEqual(diff.chapters, [
    { action: 'added', from: null, to: { index: 2, title: '丙' } },
    { action: 'removed', from: { index: 2, title: '乙' }, to: null },
  ], '删一章 + 加一章如实报，不拼成改名');
  const added = only(diff.pages, (entry) => entry.action === 'added', '页新增');
  assert.deepEqual(added.to, { chapter: 2, index: 1, title: '丙一' });
  assert.deepEqual(diff.pages.filter((entry) => entry.action === 'removed').map((entry) => entry.from[0].title), ['乙一', '乙二']);
  const removedBlocks = diff.blocks.filter((entry) => entry.action === 'removed').map((entry) => entry.anchor).sort();
  assert.deepEqual(removedBlocks, ['b:b10001', 'b:b20001'], '整章删掉时章里的块逐个报删除');
  assert.deepEqual(diff.blocks.filter((entry) => entry.action === 'added').map((entry) => entry.anchor), ['b:c10001']);
});
