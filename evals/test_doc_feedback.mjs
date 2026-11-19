import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// 只测公开的缝：工作台的 HTTP 命令面（打开 / 反馈 / 处理 / 完成 / 改块）、磁盘上的文本，
// 以及页面真正调用的选区→块映射。任务怎么存、锁怎么记都是实现细节，换实现时这些断言不该跟着改。
const core = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

const FRONT = '---\ncontract: planners-doc/1\ndoc: storyline\nproject: 测试项目\n---\n\n';
const BODY = `# 测试文档

## 章节

### 页一

第一块正文。<!-- b:aaaaaa -->

第二块正文，要改。<!-- b:bbbbbb -->

第三块正文，不动。<!-- b:cccccc -->

### 页二

第四块正文。<!-- b:dddddd -->
`;
const RAW = {
  'b:aaaaaa': '第一块正文。',
  'b:bbbbbb': '第二块正文，要改。',
  'b:cccccc': '第三块正文，不动。',
  'b:dddddd': '第四块正文。',
};

const sandboxes = [];
after(() => { for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true }); });

const scratchDoc = () => {
  const dir = mkdtempSync(join(tmpdir(), 'planners-feedback-'));
  sandboxes.push(dir);
  const path = join(dir, 'storyline.md');
  writeFileSync(path, FRONT + BODY, 'utf8');
  return { dir, path };
};

async function openWorkbench(t, docPath) {
  const { startDocWorkbench } = await import('../scripts/doc-workbench.mjs');
  const server = await startDocWorkbench({ docPath, port: 0 });
  t.after(() => server.close());
  return server;
}

const getJson = async (url) => {
  const response = await fetch(url);
  const body = await response.json();
  assert.equal(response.status, 200, `${url} 应返回 200：${JSON.stringify(body)}`);
  return body;
};

const postJson = async (url, value) => {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(value),
  });
  return { status: response.status, body: await response.json() };
};

const getDoc = (url) => getJson(`${url}/api/doc`);
const getTasks = (url) => getJson(`${url}/api/tasks`);

// ── 任务形状：只有块身份与内容指纹，带不到全文 ────────────────────────────────
test('块级反馈任务只携带被选块的身份与内容指纹，不携带全文', async (t) => {
  const { path } = scratchDoc();
  const server = await openWorkbench(t, path);
  const before = await getDoc(server.url);

  const response = await postJson(`${server.url}/api/feedback`, {
    scope: 'blocks',
    anchors: ['b:aaaaaa', 'b:bbbbbb'],
    text: '把这两块写紧一点。',
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.ok, true);

  const { task } = response.body;
  assert.equal(task.contract, 'planners-doc-task/1', '任务要带自己的契约版本，模型侧据此消费');
  assert.equal(task.scope, 'blocks');
  assert.equal(task.text, '把这两块写紧一点。');
  assert.equal(task.status, 'pending', '刚提交的任务等人/模型开始处理');
  assert.ok(!Number.isNaN(Date.parse(task.created_at)), '任务要带可解析的创建时间');
  assert.equal(task.doc.path, realpathSync(path), '任务指向工作稿本身，模型据此读文件');
  assert.equal(task.doc.contract, 'planners-doc/1');
  assert.equal(task.doc.doc, 'storyline');

  assert.deepEqual(task.blocks, [
    { anchor: 'b:aaaaaa', sha256: sha256(RAW['b:aaaaaa']) },
    { anchor: 'b:bbbbbb', sha256: sha256(RAW['b:bbbbbb']) },
  ], '任务只携带被选块的身份与 sha256(block.raw)');
  for (const block of task.blocks) {
    assert.deepEqual(Object.keys(block).sort(), ['anchor', 'sha256'], '块项只有身份与指纹');
  }
  const serialized = JSON.stringify(task);
  for (const raw of Object.values(RAW)) {
    assert.ok(!serialized.includes(raw), `任务里不能出现块正文：${raw}`);
  }
  assert.ok(before.blocks.every((block) => block.sha256 === sha256(block.raw)), '块视图也要给出同一套指纹');

  const listed = await getTasks(server.url);
  assert.equal(listed.tasks.length, 1);
  assert.deepEqual(listed.tasks[0], task, 'GET /api/tasks 是模型读取待办的那条缝');
});

// ── 三个入口：整页 / 整份把范围换算成该范围的全部块 ──────────────────────────
test('整页与整份反馈绑定该范围的全部块，页身份按章节 + 序号 + 标题匹配', async (t) => {
  const { path } = scratchDoc();
  const server = await openWorkbench(t, path);

  const page = await postJson(`${server.url}/api/feedback`, {
    scope: 'page',
    page: { chapter: '章节', number: 1, title: '页一' },
    text: '这一页再压一压。',
  });
  assert.equal(page.status, 200, JSON.stringify(page.body));
  assert.equal(page.body.task.scope, 'page');
  assert.deepEqual(page.body.task.page, { chapter: '章节', number: 1, title: '页一' });
  assert.deepEqual(page.body.task.blocks.map((block) => block.anchor), ['b:aaaaaa', 'b:bbbbbb', 'b:cccccc']);

  const doc = await postJson(`${server.url}/api/feedback`, { scope: 'doc', text: '整份再想一遍。' });
  assert.equal(doc.status, 200, JSON.stringify(doc.body));
  assert.equal(doc.body.task.scope, 'doc');
  assert.equal(doc.body.task.page, null);
  assert.deepEqual(doc.body.task.blocks.map((block) => block.anchor), ['b:aaaaaa', 'b:bbbbbb', 'b:cccccc', 'b:dddddd']);

  const missing = await postJson(`${server.url}/api/feedback`, {
    scope: 'page',
    page: { chapter: '章节', number: 2, title: '页一' },
    text: '不存在的页。',
  });
  assert.equal(missing.status, 409, JSON.stringify(missing.body));
  assert.equal(missing.body.code, 'feedback_page');

  const unknown = await postJson(`${server.url}/api/feedback`, { anchors: ['b:ffffff'], text: '不存在的块。' });
  assert.equal(unknown.status, 409, JSON.stringify(unknown.body));
  assert.equal(unknown.body.code, 'feedback_anchor');

  const empty = await postJson(`${server.url}/api/feedback`, { anchors: ['b:aaaaaa'], text: '   ' });
  assert.equal(empty.status, 400, JSON.stringify(empty.body));
  assert.equal(empty.body.code, 'feedback_text');
});

// ── 端到端：提交两块 → 锁定 → 改第三块 → 前两块逐字不动 → 解锁 ────────────────
test('选中两块提交任务，锁定期间只能改第三块，前两块未被动过，完成后解锁', async (t) => {
  const { path } = scratchDoc();
  const original = readFileSync(path, 'utf8');
  const server = await openWorkbench(t, path);

  const submitted = await postJson(`${server.url}/api/feedback`, {
    anchors: ['b:aaaaaa', 'b:bbbbbb'],
    text: '只改这两块：写短、写具体。',
  });
  assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
  const task = submitted.body.task;
  assert.deepEqual(task.blocks.map((block) => block.anchor), ['b:aaaaaa', 'b:bbbbbb']);
  assert.ok(!JSON.stringify(task).includes(RAW['b:cccccc']), '第三块不在任务里');

  // 模型开始处理：任务绑定的块进入锁定，其余块不受影响。
  const claimed = await postJson(`${server.url}/api/task/claim`, { task_id: task.id });
  assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
  assert.equal(claimed.body.task.status, 'processing');
  assert.ok(!Number.isNaN(Date.parse(claimed.body.task.started_at)));

  const locked = await getDoc(server.url);
  for (const anchor of ['b:aaaaaa', 'b:bbbbbb']) {
    const block = locked.blocks.find((item) => item.anchor === anchor);
    assert.equal(block.locked, true, `${anchor} 应当锁定`);
    assert.equal(block.locked_by, task.id, `${anchor} 的锁应当记在这条任务上`);
  }
  const free = locked.blocks.find((item) => item.anchor === 'b:cccccc');
  assert.equal(free.locked, false, '没被任务绑定的块不锁定');

  // 第三块照常改、照常存盘。
  const third = '第三块正文，照常改。';
  const saved = await postJson(`${server.url}/api/block`, {
    anchor: 'b:cccccc',
    content: third,
    base_sha256: locked.sha256,
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));

  const afterEdit = readFileSync(path, 'utf8');
  for (const anchor of ['b:aaaaaa', 'b:bbbbbb']) {
    assert.ok(afterEdit.includes(`${RAW[anchor]}<!-- ${anchor} -->`), `锁定块 ${anchor} 的原文必须逐字还在`);
  }
  assert.ok(afterEdit.includes(`${third}<!-- b:cccccc -->`), '第三块应当已落盘');
  const afterThird = await getDoc(server.url);
  for (const anchor of ['b:aaaaaa', 'b:bbbbbb']) {
    const block = afterThird.blocks.find((item) => item.anchor === anchor);
    assert.equal(block.raw, RAW[anchor], `未参与本次编辑的锁定块 ${anchor} 不得被动过`);
    assert.equal(block.sha256, sha256(RAW[anchor]));
  }

  // 锁定的块不能被保存路径改动——即使有人绕过界面直接发请求。
  const blocked = await postJson(`${server.url}/api/block`, {
    anchor: 'b:aaaaaa',
    content: '想趁锁定时偷偷改掉。',
    base_sha256: afterThird.sha256,
  });
  assert.equal(blocked.status, 409, JSON.stringify(blocked.body));
  assert.equal(blocked.body.code, 'block_locked');
  assert.equal(readFileSync(path, 'utf8'), afterEdit, '被拒的保存不得留下任何写入');

  // 模型完成：解锁；任务留档为 done。
  const completed = await postJson(`${server.url}/api/task/complete`, { task_id: task.id });
  assert.equal(completed.status, 200, JSON.stringify(completed.body));
  assert.equal(completed.body.task.status, 'done');
  assert.ok(!Number.isNaN(Date.parse(completed.body.task.finished_at)));

  const unlocked = await getDoc(server.url);
  for (const anchor of ['b:aaaaaa', 'b:bbbbbb']) {
    const block = unlocked.blocks.find((item) => item.anchor === anchor);
    assert.equal(block.locked, false, `${anchor} 完成后应当解锁`);
    assert.equal(block.locked_by, null);
  }

  const resaved = await postJson(`${server.url}/api/block`, {
    anchor: 'b:aaaaaa',
    content: '解锁后可以正常改了。',
    base_sha256: unlocked.sha256,
  });
  assert.equal(resaved.status, 200, JSON.stringify(resaved.body));
  const final = readFileSync(path, 'utf8');
  assert.ok(final.includes('解锁后可以正常改了。<!-- b:aaaaaa -->'));
  assert.ok(final.includes(`${third}<!-- b:cccccc -->`), '解锁后保存其它块仍不影响先前改动');
  assert.equal(final.includes(`${RAW['b:bbbbbb']}<!-- b:bbbbbb -->`), true, '从头到尾没被改的第二块原样保留');

  const tasks = await getTasks(server.url);
  assert.equal(tasks.tasks[0].status, 'done');
});

// ── 任务状态机：重复开始幂等、未开始不能完成、重叠任务不能同时锁同一块 ────────
test('任务状态机：重复开始幂等，未开始不能完成，重叠任务不能同时锁同一块', async (t) => {
  const { path } = scratchDoc();
  const server = await openWorkbench(t, path);
  const submit = async (anchors) => (await postJson(`${server.url}/api/feedback`, { anchors, text: '改一下。' })).body.task;

  const first = await submit(['b:aaaaaa']);
  const second = await submit(['b:aaaaaa', 'b:bbbbbb']);
  const third = await submit(['b:cccccc']);

  const once = await postJson(`${server.url}/api/task/claim`, { task_id: first.id });
  assert.equal(once.status, 200, JSON.stringify(once.body));
  const again = await postJson(`${server.url}/api/task/claim`, { task_id: first.id });
  assert.equal(again.status, 200, '重复开始同一条任务是幂等的');
  assert.equal(again.body.task.started_at, once.body.task.started_at, '幂等重试不能刷新开始时间');

  const overlap = await postJson(`${server.url}/api/task/claim`, { task_id: second.id });
  assert.equal(overlap.status, 409, JSON.stringify(overlap.body));
  assert.equal(overlap.body.code, 'block_locked', '同一块不能同时由两条任务处理');

  const early = await postJson(`${server.url}/api/task/complete`, { task_id: third.id });
  assert.equal(early.status, 409, JSON.stringify(early.body));
  assert.equal(early.body.code, 'task_state', '没开始的任务不能直接完成');

  const done = await postJson(`${server.url}/api/task/complete`, { task_id: first.id });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  const doneAgain = await postJson(`${server.url}/api/task/complete`, { task_id: first.id });
  assert.equal(doneAgain.status, 200, '重复完成是幂等的');
  assert.equal(doneAgain.body.task.finished_at, done.body.task.finished_at);

  const reclaimed = await postJson(`${server.url}/api/task/claim`, { task_id: second.id });
  assert.equal(reclaimed.status, 200, '前一条任务完成后，块可以交给下一条任务');

  const blockedFeedback = await postJson(`${server.url}/api/feedback`, { anchors: ['b:bbbbbb'], text: '处理中再派一条。' });
  assert.equal(blockedFeedback.status, 409, JSON.stringify(blockedFeedback.body));
  assert.equal(blockedFeedback.body.code, 'block_locked', '处理中的块不能再派新任务');

  await postJson(`${server.url}/api/task/complete`, { task_id: second.id });
  const afterDone = await postJson(`${server.url}/api/task/claim`, { task_id: second.id });
  assert.equal(afterDone.status, 409, JSON.stringify(afterDone.body));
  assert.equal(afterDone.body.code, 'task_state', '已完成的任务不能再开始');

  const unknown = await postJson(`${server.url}/api/task/claim`, { task_id: 't:000000000000' });
  assert.equal(unknown.status, 409, JSON.stringify(unknown.body));
  assert.equal(unknown.body.code, 'task_missing');
});

// ── 选区吸附：半句也吸成整块，跨块选区按文档顺序返回 ─────────────────────────
test('半句选区也吸成整块：页面按命中的块整体提交反馈', async () => {
  const module = await import('../assets/workbench/doc-feedback.js');
  const feedback = module.default ?? module;
  const nodes = ['b:aaaaaa', 'b:bbbbbb', 'b:cccccc'].map((anchor) => ({
    getAttribute: (name) => (name === 'data-anchor' ? anchor : null),
  }));

  const halfSentence = { intersectsNode: (node) => node === nodes[1] };
  assert.deepEqual(feedback.anchorsForRange(halfSentence, nodes), ['b:bbbbbb'], '半句命中的块整体入选');

  const spanning = { intersectsNode: (node) => node === nodes[0] || node === nodes[2] };
  assert.deepEqual(feedback.anchorsForRange(spanning, nodes), ['b:aaaaaa', 'b:cccccc'], '跨块选区按文档顺序返回');

  assert.deepEqual(feedback.anchorsForRange({ intersectsNode: () => false }, nodes), []);
  assert.deepEqual(feedback.anchorsForRange(null, nodes), [], '没有选区时不凭空产生目标');
});

// ── 渲染面：三个反馈入口、将改块高亮、锁定提示 ───────────────────────────────
test('页面有三个反馈入口，提交前高亮将改的块，锁定时提示且不可编辑', () => {
  const page = readFileSync(join(core, 'assets', 'workbench', 'doc-workbench.js'), 'utf8');
  const html = readFileSync(join(core, 'assets', 'workbench', 'doc-workbench.html'), 'utf8');
  const css = readFileSync(join(core, 'assets', 'workbench', 'doc-workbench.css'), 'utf8');

  assert.match(page, /data-feedback-block/, '块尾要有反馈按钮');
  assert.match(page, /data-feedback-selection/, '选中后要浮出反馈按钮');
  assert.match(html + page, /overallFeedback|data-overall/, '顶部要有整页 / 整份反馈入口');
  assert.match(page, /DocFeedback\.anchorsForRange/, '选区要经同一份吸附规则换算成块');
  assert.match(page, /is-feedback-target/, '提交前要标出「将改的块」');
  assert.match(page, /scope = 'page'|scope: 'page'|scope === 'page'/, '整页反馈要按页换算范围');
  assert.match(page, /scope = 'doc'|scope: 'doc'|scope === 'doc'/, '整份反馈要按整份换算范围');
  assert.match(page, /\/api\/feedback/, '提交走反馈命令');
  assert.match(page, /\/api\/tasks/, '锁状态要随任务同步');

  assert.match(page, /is-locked/, '锁定块要有可见状态');
  assert.match(page, /模型正在改这一段/, '锁定提示文案要明说');
  assert.match(page, /contentEditable = 'false'/, '锁定的块不能被编辑');
  assert.match(css, /\.is-locked/, '锁定样式必须存在');
  assert.match(css, /\.is-feedback-target/, '将改块的高亮样式必须存在');
});
