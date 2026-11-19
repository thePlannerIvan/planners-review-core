import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// 只测公开的缝：工作台的 HTTP 命令面、模型侧的收件箱命令、磁盘上的文件。
// 收件箱内部怎么排序、怎么原子写都是实现细节，换实现时这些断言不应跟着改。
const core = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const INBOX = join(core, 'scripts', 'doc-inbox.mjs');
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

const FRONT = '---\ncontract: planners-doc/1\ndoc: storyline\nproject: 派发测试\n---\n\n';
const BODY = `# 派发测试

## 章节

### 页一

第一块正文。<!-- b:aaaaaa -->

第二块正文。<!-- b:bbbbbb -->
`;
const RAW = {
  'b:aaaaaa': '第一块正文。',
  'b:bbbbbb': '第二块正文。',
};

const sandboxes = [];
after(() => { for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true }); });

function scratchDoc() {
  const dir = mkdtempSync(join(tmpdir(), 'planners-dispatch-'));
  sandboxes.push(dir);
  const path = join(dir, 'storyline.md');
  writeFileSync(path, FRONT + BODY, 'utf8');
  return { dir, path };
}

async function openWorkbench(t, docPath, options = {}) {
  const { startDocWorkbench } = await import('../scripts/doc-workbench.mjs');
  const server = await startDocWorkbench({ docPath, port: 0, ...options });
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

const inboxDir = (dir) => join(dir, '.doc-workbench', 'inbox');
const cli = (args) => spawnSync(process.execPath, [INBOX, ...args], { encoding: 'utf8' });

const FEEDBACK = { scope: 'blocks', anchors: ['b:aaaaaa', 'b:bbbbbb'], text: '把这两块写紧一点。' };

// ── 无插件：任务落本地文件，模型用一条命令读回同样的块身份与指纹 ─────────────
test('无插件派发落进本地收件箱，模型用 doc-inbox list 读回块身份、指纹与意见', async (t) => {
  const { dir, path } = scratchDoc();
  const original = readFileSync(path);
  const server = await openWorkbench(t, path);

  const response = await postJson(`${server.url}/api/feedback`, FEEDBACK);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const { task } = response.body;
  assert.equal(response.body.dispatch?.channel, 'inbox', '没有插件时派发走收件箱，不假装唤醒了模型');
  assert.equal(task.status, 'pending', '派发只是建了一条任务，还没开始处理');
  assert.equal(task.contract, 'planners-doc-task/1');

  const dirPath = inboxDir(dir);
  const files = readdirSync(dirPath);
  assert.deepEqual(files, [`${task.id.replace(':', '-')}.json`], '一条任务一个文件，文件名由任务 id 决定');
  const stored = JSON.parse(readFileSync(join(dirPath, files[0]), 'utf8'));
  assert.deepEqual(stored, task, '收件箱里存的就是任务契约那一个形状，不另造一份');

  // 重复写同一条任务（派发重试）不得产生第二个条目。
  const { writeTask } = await import('../scripts/lib/doc-inbox.mjs');
  writeTask(path, task);
  assert.equal(readdirSync(dirPath).length, 1, '同一任务重复写只覆盖，不追加');

  const listed = cli(['list', path]);
  assert.equal(listed.status, 0, listed.stderr);
  const view = JSON.parse(listed.stdout);
  assert.equal(view.ok, true);
  assert.equal(view.contract, 'planners-doc-task/1');
  assert.equal(view.tasks.length, 1);
  assert.equal(view.tasks[0].id, task.id);
  assert.equal(view.tasks[0].text, FEEDBACK.text, '模型要读到人的意见原文');
  assert.deepEqual(view.tasks[0].blocks, [
    { anchor: 'b:aaaaaa', sha256: sha256(RAW['b:aaaaaa']) },
    { anchor: 'b:bbbbbb', sha256: sha256(RAW['b:bbbbbb']) },
  ], '模型拿到的块身份与内容指纹和 API 回执一致');
  assert.equal(view.tasks[0].doc.path, realpathSync(path), '模型据 doc.path 读工作稿');
  assert.equal(dirPath.includes('.doc-workbench'), true);

  // 派发不等于保存：文档一个字节都不动。
  assert.deepEqual(readFileSync(path), original, '派发后原文不变');
  assert.equal(response.body.task.status === 'pending', true, '派发不是批准，任务没有进入完成态');
});

// ── 取走：pending → processing，状态变化在文件与读取命令里都看得见 ────────────
test('模型取走任务后状态从 pending 变成 processing，原文照旧不变', async (t) => {
  const { dir, path } = scratchDoc();
  const original = readFileSync(path);
  const server = await openWorkbench(t, path);
  const submitted = await postJson(`${server.url}/api/feedback`, FEEDBACK);
  const task = submitted.body.task;
  const file = join(inboxDir(dir), `${task.id.replace(':', '-')}.json`);

  const before = cli(['list', path]);
  assert.equal(JSON.parse(before.stdout).tasks[0].status, 'pending');

  const taken = cli(['take', path]);
  assert.equal(taken.status, 0, taken.stderr);
  const receipt = JSON.parse(taken.stdout);
  assert.equal(receipt.ok, true);
  assert.deepEqual(receipt.taken.map((entry) => entry.id), [task.id]);

  const stored = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(stored.status, 'processing', '被取走 = 任务进入处理中');
  assert.ok(!Number.isNaN(Date.parse(stored.started_at)), '取走时写下开始时间');
  assert.deepEqual(stored.locked_blocks, ['b:aaaaaa', 'b:bbbbbb'], '处理中占着任务绑定的块');

  const pending = JSON.parse(cli(['list', path]).stdout);
  assert.deepEqual(pending.tasks, [], '默认只列未处理任务');
  const all = JSON.parse(cli(['list', path, '--all']).stdout);
  assert.equal(all.tasks[0].status, 'processing', '--all 能看出它已经被取走');

  const again = cli(['take', path]);
  assert.equal(again.status, 0, '没有待取任务时 take 不是错误');
  assert.deepEqual(JSON.parse(again.stdout).taken, [], '重复取走不重复取');

  assert.deepEqual(readFileSync(path), original, '取走任务不改原文');
});

// ── 两条路径同一个任务形状：有插件时 onTask 收到的就是收件箱里那一份 ─────────
test('有插件唤醒与无插件收件箱消费同一个任务形状', async (t) => {
  const without = scratchDoc();
  const withPlugin = scratchDoc();
  const inboxServer = await openWorkbench(t, without.path);
  const woke = [];
  const wakeServer = await openWorkbench(t, withPlugin.path, { onTask: (task) => { woke.push(task); } });

  const inboxReceipt = await postJson(`${inboxServer.url}/api/feedback`, FEEDBACK);
  const wakeReceipt = await postJson(`${wakeServer.url}/api/feedback`, FEEDBACK);
  assert.equal(inboxReceipt.status, 200, JSON.stringify(inboxReceipt.body));
  assert.equal(wakeReceipt.status, 200, JSON.stringify(wakeReceipt.body));
  assert.equal(wakeReceipt.body.dispatch?.channel, 'wake', '有插件时走唤醒');
  assert.equal(woke.length, 1, 'onTask 收到一次派发');
  assert.deepEqual(woke[0], wakeReceipt.body.task, '唤醒拿到的是任务本身，不是另一份投影');

  const shape = (task) => ({
    keys: Object.keys(task).sort(),
    contract: task.contract,
    scope: task.scope,
    page: task.page,
    text: task.text,
    doc: { contract: task.doc.contract, doc: task.doc.doc, project: task.doc.project },
    blocks: task.blocks,
    status: task.status,
    locked_blocks: task.locked_blocks,
    started_at: task.started_at,
    finished_at: task.finished_at,
  });
  const inboxTask = inboxReceipt.body.task;
  assert.deepEqual(shape(woke[0]), shape(inboxTask), '两条路径的任务形状逐字段相同');

  const stored = JSON.parse(readFileSync(join(inboxDir(without.dir), `${inboxTask.id.replace(':', '-')}.json`), 'utf8'));
  assert.deepEqual(stored, inboxTask, '收件箱里落下的任务与唤醒的是同一个形状');

  assert.equal(existsSync(inboxDir(withPlugin.dir)), false, '有插件时不再另写一份收件箱，避免同一个任务被消费两次');
});

// ── 旧 JSON 主稿：只读挂载，保存被拒，磁盘零变化 ────────────────────────────
const LEGACY = {
  contract_version: '2.0.0',
  project_id: 'pj_test',
  storyline_thesis: '旧主稿只应该被看，不应该被新工作台写。',
  sections: [{ section_id: 'sec-1', title: '旧章节', cognitive_job: '', transition: '' }],
  pages: [
    { page_number: 1, section_id: 'sec-1', title_intent: '第一页主张', claim: '第一页的旧主张。', content_blocks: [] },
    { page_number: 2, section_id: 'sec-1', title_intent: '第二页主张', claim: '第二页的旧主张。', content_blocks: [] },
  ],
};

function scratchLegacy() {
  const dir = mkdtempSync(join(tmpdir(), 'planners-legacy-'));
  sandboxes.push(dir);
  const work = join(dir, '.proposal-work');
  mkdirSync(work);
  const path = join(work, 'page-architecture.json');
  writeFileSync(path, JSON.stringify(LEGACY, null, 2) + '\n', 'utf8');
  return { dir, path };
}

test('旧 JSON 主稿被打开时只读：界面状态可读、保存被拒且磁盘零变化', async (t) => {
  const { dir, path } = scratchLegacy();
  const original = readFileSync(path);
  const server = await openWorkbench(t, path);

  const doc = await getJson(`${server.url}/api/doc`);
  assert.equal(doc.readonly?.reason, 'legacy-json', '旧 JSON 主稿以只读模式挂载');
  assert.match(doc.readonly?.message ?? '', /只读/, '只读原因要写给人看');
  assert.match(doc.readonly?.message ?? '', /planners-doc\/1/, '要说清楚新工作台只认哪份契约');
  assert.equal(doc.project, 'pj_test');
  assert.deepEqual(doc.legacy?.contract_version, '2.0.0');
  assert.equal(doc.pages.length, 2, '旧主稿的页要能看见，才能判断是不是它');
  assert.equal(doc.blocks.length, 2);
  assert.deepEqual(doc.pages.map((page) => page.title), ['第一页主张', '第二页主张']);
  assert.equal(doc.blocks.every((block) => block.readonly === true), true, '块在界面上是只读的');

  const save = await postJson(`${server.url}/api/block`, {
    anchor: 'b:aaaaaa',
    content: '新工作台不该写进来。',
    base_sha256: doc.sha256,
  });
  assert.equal(save.status, 409, JSON.stringify(save.body));
  assert.equal(save.body.code, 'readonly');
  assert.match(save.body.error, /只读/, '拒绝原因要可读');

  const feedback = await postJson(`${server.url}/api/feedback`, FEEDBACK);
  assert.equal(feedback.status, 409, JSON.stringify(feedback.body));
  assert.equal(feedback.body.code, 'readonly', '只读主稿不能派发任务');

  const reorder = await postJson(`${server.url}/api/reorder`, {
    op: 'move-block', anchor: 'b:aaaaaa', to: { chapter: 1, index: 1, before: null }, base_sha256: doc.sha256,
  });
  assert.equal(reorder.status, 409, JSON.stringify(reorder.body));
  assert.equal(reorder.body.code, 'readonly');

  assert.deepEqual(readFileSync(path), original, '被拒的保存一个字节都不写');
  assert.equal(existsSync(join(dir, '.doc-workbench')), false, '只读打开不应留下工作台旁路文件');
});

// ── 界面状态：只读要看得出来；派发不显示成保存，更不显示成批准 ────────────────
test('页面状态如实：旧 JSON 只读有说明，派发写明原文未改、不算批准', () => {
  const html = readFileSync(join(core, 'assets', 'workbench', 'doc-workbench.html'), 'utf8');
  const page = readFileSync(join(core, 'assets', 'workbench', 'doc-workbench.js'), 'utf8');
  const css = readFileSync(join(core, 'assets', 'workbench', 'doc-workbench.css'), 'utf8');
  const drag = readFileSync(join(core, 'assets', 'workbench', 'doc-drag.js'), 'utf8');

  assert.match(html, /id="readonlyNotice"/, '只读说明要有一个固定的显示位置');
  assert.match(page, /renderReadonlyState/, '只读状态要由快照驱动，不是写死');
  assert.match(page, /snapshot\??\.readonly/, '页面读服务端给的只读状态');
  assert.match(page, /body\.classList\.toggle\('is-readonly'/, '只读要落在可见的界面状态上');
  assert.match(page, /旧项目 · 只读/, '顶部要写明这是只读的旧项目');
  assert.match(page, /block\.readonly/, '只读块不接编辑面与反馈按钮');
  assert.match(page, /feedback\.hidden = true/, '只读时不显示整体反馈入口');
  assert.match(drag, /snapshot\.readonly/, '只读时不装拖柄，避免看起来还能重排');
  assert.match(css, /\.readonly-notice/, '只读说明要有样式');
  assert.match(css, /body\.is-readonly/, '只读状态要有可见样式');

  assert.match(page, /channel === 'inbox'/, '页面区分「写进收件箱」与「已唤醒」两条派发出口');
  assert.match(page, /channel === 'wake'/);
  assert.match(page, /已写入收件箱/, '没有插件时要说清楚任务落在哪');
  assert.match(page, /原文未改，不算批准/, '派发不是保存，也不是批准');
  assert.match(page, /派发不等于保存，也不等于批准/);
  assert.doesNotMatch(page, /已批准/, '页面不得把派发显示成批准');
});

