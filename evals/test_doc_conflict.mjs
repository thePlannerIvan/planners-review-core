import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// 只测公开的缝：工作台的 HTTP 命令面（打开 / 反馈 / 处理 / 模型写回 / 裁决）、
// 回执里的 applied 与 deferred_blocks、磁盘上的文本，以及进程中断后留下的 journal。
// 锁表、冲突队列、journal 内部结构都是实现细节，换实现时这些断言不该跟着改。
const core = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VALIDATOR = join(core, 'scripts', 'validate-doc.mjs');

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

const FRONT = '---\ncontract: planners-doc/1\ndoc: storyline\nproject: 测试项目\n---\n\n';
const BODY = `# 测试文档

## 章节

### 页一

第一块正文。<!-- b:aaaaaa -->

第二块正文。<!-- b:bbbbbb -->

第三块正文，不参与。<!-- b:cccccc -->

### 页二

第四块正文。<!-- b:dddddd -->
`;
const RAW = {
  'b:aaaaaa': '第一块正文。',
  'b:bbbbbb': '第二块正文。',
  'b:cccccc': '第三块正文，不参与。',
  'b:dddddd': '第四块正文。',
};

const sandboxes = [];
after(() => { for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true }); });

const scratchDoc = () => {
  const dir = mkdtempSync(join(tmpdir(), 'planners-conflict-'));
  sandboxes.push(dir);
  const path = join(dir, 'storyline.md');
  writeFileSync(path, FRONT + BODY, 'utf8');
  return { dir, path };
};

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

const getDoc = (url) => getJson(`${url}/api/doc`);
const getConflicts = (url) => getJson(`${url}/api/conflicts`);

const validate = (path) => {
  const result = spawnSync(process.execPath, [VALIDATOR, path], { encoding: 'utf8' });
  return { code: result.status, out: JSON.parse(result.stdout || 'null'), stdout: result.stdout, stderr: result.stderr };
};

const blockOf = (doc, anchor) => {
  const block = doc.blocks.find((item) => item.anchor === anchor);
  assert.ok(block, `文档里应当有块 ${anchor}`);
  return block;
};

// ── 端到端：同块双改只锁该块，其余块照常落盘 ─────────────────────────────────
test('同块双改只把该块标待核对并保持锁定，其余块照常落盘', async (t) => {
  const { path } = scratchDoc();
  const server = await openWorkbench(t, path);
  const opened = await getDoc(server.url);

  // 人先派发，再在模型开工前改了第一块（此时任务只是 pending，不锁块）。
  const task = await claimTaskPending(server.url, ['b:aaaaaa', 'b:bbbbbb']);
  const baseline = new Map(task.blocks.map((block) => [block.anchor, block.sha256]));
  const human = '人改的第一块。';
  const edit = await postJson(`${server.url}/api/block`, {
    anchor: 'b:aaaaaa',
    content: human,
    base_sha256: opened.sha256,
    base_block_sha256: blockOf(opened, 'b:aaaaaa').sha256,
  });
  assert.equal(edit.status, 200, JSON.stringify(edit.body));

  // 模型开始处理：两块都锁上。
  const claimed = await postJson(`${server.url}/api/task/claim`, { task_id: task.id });
  assert.equal(claimed.status, 200, JSON.stringify(claimed.body));

  // 模型一次写回两块：第一块基线已变，第二块没变。
  const modelFirst = '模型改的第一块。';
  const modelSecond = '模型改的第二块。';
  const patched = await postJson(`${server.url}/api/patch`, {
    task_id: task.id,
    patches: [
      { anchor: 'b:aaaaaa', content: modelFirst },
      { anchor: 'b:bbbbbb', content: modelSecond },
    ],
  });
  assert.equal(patched.status, 200, JSON.stringify(patched.body));
  assert.deepEqual(patched.body.applied, ['b:bbbbbb'], '只有基线未变的块直接应用');
  assert.equal(patched.body.deferred_blocks.length, 1, '变过的那一块进待核对');
  const [deferred] = patched.body.deferred_blocks;
  assert.equal(deferred.anchor, 'b:aaaaaa');
  assert.equal(deferred.reason, 'block_changed');
  assert.equal(deferred.base_sha256, baseline.get('b:aaaaaa'), '回执要给出任务基线指纹');
  assert.equal(deferred.disk_sha256, sha256(human), '回执要给出当前磁盘指纹');
  assert.equal(patched.body.task.status, 'review', '有待核对块的任务停在待核对');

  const disk = readFileSync(path, 'utf8');
  assert.ok(disk.includes(`${human}<!-- b:aaaaaa -->`), '冲突块保持人的版本，不被模型覆盖');
  assert.ok(disk.includes(`${modelSecond}<!-- b:bbbbbb -->`), '没冲突的块照常落盘');
  assert.ok(disk.includes(`${RAW['b:cccccc']}<!-- b:cccccc -->`), '没参与的块逐字不动');

  const after = await getDoc(server.url);
  const conflicted = blockOf(after, 'b:aaaaaa');
  assert.equal(conflicted.raw, human);
  assert.equal(conflicted.locked, true, '待核对期间该块保持锁定');
  assert.equal(conflicted.locked_by, task.id);
  assert.ok(conflicted.deferred, '块视图要标出待核对');
  const applied = blockOf(after, 'b:bbbbbb');
  assert.equal(applied.raw, modelSecond);
  assert.equal(applied.locked, false, '已应用的块立即解锁');

  const conflicts = await getConflicts(server.url);
  assert.equal(conflicts.contract, 'planners-doc-conflict/1');
  assert.equal(conflicts.conflicts.length, 1);
  assert.equal(conflicts.conflicts[0].anchor, 'b:aaaaaa');
  assert.equal(conflicts.conflicts[0].disk_raw, human, '裁决需要看到人的版本');
  assert.equal(conflicts.conflicts[0].model_content, modelFirst, '裁决需要看到模型版');

  assert.equal(validate(path).code, 0, '写回后文档仍应通过契约校验');
  assert.equal(after.blocks.length, opened.blocks.length, '写回不能增删块');
});

/** 只提交反馈，不 claim：让模型开工前的时间窗存在。 */
async function claimTaskPending(url, anchors) {
  const submitted = await postJson(`${url}/api/feedback`, { anchors, text: '只改这几块。' });
  assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
  return submitted.body.task;
}

// ── 端到端：人裁决两个方向，裁决后解锁并落盘 ─────────────────────────────────
test('裁决两个方向：保留我的不动盘并解锁，用模型版落盘并解锁', async (t) => {
  const { path } = scratchDoc();
  const server = await openWorkbench(t, path);
  const opened = await getDoc(server.url);
  const anchors = ['b:aaaaaa', 'b:bbbbbb', 'b:cccccc'];
  const task = await claimTaskPending(server.url, anchors);

  // 三块都在提交之后被人改过。
  const human = {};
  let docSha = opened.sha256;
  for (const anchor of anchors) {
    human[anchor] = `人改的 ${anchor}。`;
    const saved = await postJson(`${server.url}/api/block`, {
      anchor,
      content: human[anchor],
      base_sha256: docSha,
      base_block_sha256: blockOf(opened, anchor).sha256,
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    docSha = saved.body.sha256;
  }

  const claimed = await postJson(`${server.url}/api/task/claim`, { task_id: task.id });
  assert.equal(claimed.status, 200, JSON.stringify(claimed.body));

  const beforePatch = readFileSync(path, 'utf8');
  const patched = await postJson(`${server.url}/api/patch`, {
    task_id: task.id,
    patches: anchors.map((anchor) => ({ anchor, content: `模型版 ${anchor}。` })),
  });
  assert.equal(patched.status, 200, JSON.stringify(patched.body));
  assert.deepEqual(patched.body.applied, [], '三块都改过，一块都不直接应用');
  assert.equal(patched.body.deferred_blocks.length, 3);
  assert.equal(readFileSync(path, 'utf8'), beforePatch, '全部待核对时磁盘一个字节都不动');

  const lockedDoc = await getDoc(server.url);
  for (const anchor of anchors) {
    const block = blockOf(lockedDoc, anchor);
    assert.equal(block.locked, true, `${anchor} 待核对期间保持锁定`);
    assert.equal(block.raw, human[anchor], '磁盘上仍是人的版本');
  }

  // 方向一：保留我的 = 不写盘，只解锁。
  const mine = await postJson(`${server.url}/api/conflict/decide`, { anchor: 'b:aaaaaa', decision: 'mine' });
  assert.equal(mine.status, 200, JSON.stringify(mine.body));
  assert.equal(mine.body.decision, 'mine');
  assert.equal(mine.body.written, false, '保留我的不需要写盘');
  assert.equal(mine.body.block.locked, false, '裁决后解锁');
  assert.ok(readFileSync(path, 'utf8').includes(`${human['b:aaaaaa']}<!-- b:aaaaaa -->`));
  assert.equal(mine.body.deferred_blocks.length, 2);
  assert.equal(blockOf(await getDoc(server.url), 'b:bbbbbb').locked, true, '没裁决的块仍然锁着');

  // 方向二：用模型版 = 写盘并解锁。
  const model = await postJson(`${server.url}/api/conflict/decide`, { anchor: 'b:bbbbbb', decision: 'model' });
  assert.equal(model.status, 200, JSON.stringify(model.body));
  assert.equal(model.body.decision, 'model');
  assert.equal(model.body.written, true);
  assert.equal(model.body.block.raw, '模型版 b:bbbbbb。');
  assert.equal(model.body.block.locked, false);
  const afterModel = readFileSync(path, 'utf8');
  assert.ok(afterModel.includes('模型版 b:bbbbbb。<!-- b:bbbbbb -->'), '用模型版必须落盘');
  assert.ok(afterModel.includes(`${human['b:aaaaaa']}<!-- b:aaaaaa -->`), '别人的裁决不覆盖');
  assert.equal(model.body.deferred_blocks.length, 1);

  // 第三种出口：放弃这一块的模型改动，磁盘保持人的版本并解锁。
  const discard = await postJson(`${server.url}/api/conflict/decide`, { anchor: 'b:cccccc', decision: 'discard' });
  assert.equal(discard.status, 200, JSON.stringify(discard.body));
  assert.equal(discard.body.written, false);
  assert.equal(discard.body.block.locked, false);
  assert.equal(discard.body.deferred_blocks.length, 0);
  assert.equal(discard.body.task.status, 'done', '全部裁决完任务收尾');

  const final = readFileSync(path, 'utf8');
  assert.ok(final.includes(`${human['b:aaaaaa']}<!-- b:aaaaaa -->`));
  assert.ok(final.includes('模型版 b:bbbbbb。<!-- b:bbbbbb -->'));
  assert.ok(final.includes(`${human['b:cccccc']}<!-- b:cccccc -->`));
  assert.equal((await getConflicts(server.url)).conflicts.length, 0);

  const done = await getDoc(server.url);
  for (const anchor of anchors) assert.equal(blockOf(done, anchor).locked, false, `${anchor} 已解锁`);
  assert.equal(validate(path).code, 0, '裁决后文档仍应通过契约校验');

  const again = await postJson(`${server.url}/api/conflict/decide`, { anchor: 'b:aaaaaa', decision: 'model' });
  assert.equal(again.status, 409, JSON.stringify(again.body));
  assert.equal(again.body.code, 'conflict_missing', '已经裁决过的块不能重复裁决');
});

// ── 端到端：两个进程改不同块都落盘；同块竞态拒绝，不静默覆盖 ────────────────
test('跨块并发：两个进程改不同块都落盘，不互相覆盖', async (t) => {
  const { path } = scratchDoc();
  const first = await openWorkbench(t, path);
  const second = await openWorkbench(t, path);
  const a0 = await getDoc(first.url);
  const b0 = await getDoc(second.url);
  assert.equal(a0.sha256, b0.sha256, '两个进程从同一份基线打开');

  const aEdit = '进程 A 改的第一块。';
  const savedA = await postJson(`${first.url}/api/block`, {
    anchor: 'b:aaaaaa',
    content: aEdit,
    base_sha256: a0.sha256,
    base_block_sha256: blockOf(a0, 'b:aaaaaa').sha256,
  });
  assert.equal(savedA.status, 200, JSON.stringify(savedA.body));
  assert.equal(savedA.body.merged, false, '整份基线还新，不需要合并');

  // 进程 B 的快照已经过期，但它要改的是另一块：按块合并，不丢 A 的改动。
  const bEdit = '进程 B 改的第二块。';
  const savedB = await postJson(`${second.url}/api/block`, {
    anchor: 'b:bbbbbb',
    content: bEdit,
    base_sha256: b0.sha256,
    base_block_sha256: blockOf(b0, 'b:bbbbbb').sha256,
  });
  assert.equal(savedB.status, 200, JSON.stringify(savedB.body));
  assert.equal(savedB.body.merged, true, '整份基线过期但这一块没变，按块合并');

  const disk = readFileSync(path, 'utf8');
  assert.ok(disk.includes(`${aEdit}<!-- b:aaaaaa -->`), 'A 的改动不能被 B 的保存覆盖');
  assert.ok(disk.includes(`${bEdit}<!-- b:bbbbbb -->`), 'B 的改动要落盘');
  assert.ok(disk.includes(`${RAW['b:cccccc']}<!-- b:cccccc -->`), '没参与的块逐字不动');

  // 同一块两边都改过：B 拿着过期基线再改 A 已改过的块，必须拒绝。
  const raced = await postJson(`${second.url}/api/block`, {
    anchor: 'b:aaaaaa',
    content: '想覆盖 A 的版本。',
    base_sha256: b0.sha256,
    base_block_sha256: blockOf(b0, 'b:aaaaaa').sha256,
  });
  assert.equal(raced.status, 409, JSON.stringify(raced.body));
  assert.equal(raced.body.code, 'block_conflict', '同一块的过期写入必须拒绝');
  assert.equal(readFileSync(path, 'utf8'), disk, '被拒的保存不得留下半截写入');

  const both = await getDoc(second.url);
  assert.equal(blockOf(both, 'b:aaaaaa').raw, aEdit);
  assert.equal(blockOf(both, 'b:bbbbbb').raw, bEdit);
  assert.equal(validate(path).code, 0, '两个进程写完后仍应通过契约校验');
  assert.equal(both.blocks.length, a0.blocks.length, '并发保存不能增删块');
});

// ── 端到端：写盘中段被打断，重启按 journal 恢复且不产生幽灵块 ─────────────────
test('崩溃中断用 journal 恢复未提交的写盘，不产生幽灵块', async (t) => {
  const { path } = scratchDoc();
  const original = readFileSync(path, 'utf8');
  const crashed = await openWorkbench(t, path, {
    faults: { beforeCommit: () => { throw Object.assign(Error('模拟进程中断'), { code: 'crashed' }); } },
  });
  const opened = await getDoc(crashed.url);
  const anchorsBefore = opened.blocks.map((block) => block.anchor);

  const task = await claimTaskPending(crashed.url, ['b:aaaaaa', 'b:bbbbbb']);
  await postJson(`${crashed.url}/api/task/claim`, { task_id: task.id });
  const patch = await postJson(`${crashed.url}/api/patch`, {
    task_id: task.id,
    patches: [
      { anchor: 'b:aaaaaa', content: '崩溃前写的第一块。' },
      { anchor: 'b:bbbbbb', content: '崩溃前写的第二块。' },
    ],
  });
  assert.notEqual(patch.status, 200, '中断的写回不应该返回成功');

  // 中断现场：journal 已落盘、文档还是旧的、没有半截写入。
  assert.ok(existsSync(crashed.journal), `应当留下 journal：${crashed.journal}`);
  const journal = JSON.parse(readFileSync(crashed.journal, 'utf8'));
  assert.equal(journal.contract, 'planners-doc-journal/1');
  assert.equal(journal.old_sha256, sha256(original), 'journal 记着写之前的基线');
  assert.ok(journal.raw.includes('崩溃前写的第一块。') && journal.raw.includes('崩溃前写的第二块。'));
  assert.deepEqual(journal.applied, ['b:aaaaaa', 'b:bbbbbb']);
  assert.equal(readFileSync(path, 'utf8'), original, '中断时文档不能留下半截写入');

  // 重启：按 journal 恢复到「整份目标全文」，不是按锚点拼块。
  const restarted = await openWorkbench(t, path);
  assert.equal(restarted.recovery.state, 'applied', `重启应当恢复未提交改动：${JSON.stringify(restarted.recovery)}`);
  assert.equal(existsSync(crashed.journal), false, '恢复后 journal 应当清掉');

  const recovered = readFileSync(path, 'utf8');
  assert.ok(recovered.includes('崩溃前写的第一块。<!-- b:aaaaaa -->'));
  assert.ok(recovered.includes('崩溃前写的第二块。<!-- b:bbbbbb -->'));
  assert.ok(recovered.includes(`${RAW['b:cccccc']}<!-- b:cccccc -->`), '没参与的块逐字不动');

  const doc = await getDoc(restarted.url);
  assert.equal(doc.blocks.length, opened.blocks.length, '恢复不能增删块');
  assert.deepEqual(doc.blocks.map((block) => block.anchor), anchorsBefore, '锚点集合必须原样');
  assert.equal(new Set(doc.blocks.map((block) => block.anchor)).size, anchorsBefore.length, '不能出现重复锚点');
  assert.equal(doc.errors.length, 0, '恢复后的文档不应有结构错误');
  assert.equal(doc.journal, null);
  assert.equal(validate(path).code, 0, '恢复后仍应通过契约校验');

  // 再重启一次是幂等的：没有 journal 就不动盘。
  const third = await openWorkbench(t, path);
  assert.equal(third.recovery.state, 'none');
  assert.equal(readFileSync(path, 'utf8'), recovered);

  // 中断之后文档又被改过：journal 不覆盖新内容，也不按块硬拼出幽灵块。
  const stale = await openWorkbench(t, path, {
    faults: { beforeCommit: () => { throw Object.assign(Error('模拟进程中断'), { code: 'crashed' }); } },
  });
  const latest = await getDoc(stale.url);
  const taskTwo = await claimTaskPending(stale.url, ['b:dddddd']);
  await postJson(`${stale.url}/api/task/claim`, { task_id: taskTwo.id });
  const crashedAgain = await postJson(`${stale.url}/api/patch`, {
    task_id: taskTwo.id,
    patches: [{ anchor: 'b:dddddd', content: '这次没写进去的第四块。' }],
  });
  assert.notEqual(crashedAgain.status, 200);
  assert.ok(existsSync(stale.journal));
  const external = readFileSync(path, 'utf8').replace('第四块正文。', '外部改过的第四块。');
  writeFileSync(path, external, 'utf8');

  const guarded = await openWorkbench(t, path);
  assert.equal(guarded.recovery.state, 'orphaned', '基线已过期时不能覆盖文档');
  assert.equal(readFileSync(path, 'utf8'), external, '外部改动必须保留');
  assert.ok(existsSync(guarded.recovery.journal), 'orphaned journal 留给人工核对，不能悄悄清掉');
  assert.equal(existsSync(stale.journal), false, '孤儿 journal 挪到一边，不挡住下一次正常写盘');
  const guardedDoc = await getDoc(guarded.url);
  assert.equal(guardedDoc.journal.state, 'orphaned', '页面要能知道有一笔写盘待人工处理');
  assert.equal(guardedDoc.journal.path, guarded.recovery.journal);
  assert.equal(guardedDoc.blocks.length, latest.blocks.length, '不产生幽灵块');
  assert.equal(new Set(guardedDoc.blocks.map((block) => block.anchor)).size, guardedDoc.blocks.length);
});

// ── 渲染面：待核对块要有可见状态、两个版本与三个裁决入口 ──────────────────────
test('工作台页面为待核对块给出三个裁决入口，并按块带上保存基线', () => {
  const page = readFileSync(join(core, 'assets', 'workbench', 'doc-workbench.js'), 'utf8');
  const css = readFileSync(join(core, 'assets', 'workbench', 'doc-workbench.css'), 'utf8');

  assert.match(page, /\/api\/conflicts/, '待核对状态要随任务同步');
  assert.match(page, /\/api\/conflict\/decide/, '裁决走专用命令');
  assert.match(page, /data-decision/, '每个出口都要有可点的标记');
  for (const label of ['保留我的', '用模型版', '放弃该块']) {
    assert.ok(page.includes(label), `缺少裁决按钮 ${label}`);
  }
  assert.match(page, /deferred-note/, '待核对要有一句人话说明');
  assert.match(page, /model_content/, '人要先看得到模型版');
  assert.match(page, /base_block_sha256/, '保存要带这一块的基线，跨块并发才能合并');
  assert.match(page, /locked_blocks/, '待核对块要继续按任务锁住');
  assert.match(page, /'review'/, '待核对状态属于锁定态');
  assert.match(css, /\.block-deferred/, '待核对面板必须有样式');
  assert.match(css, /\.is-deferred/, '待核对块要有可见状态');
});
