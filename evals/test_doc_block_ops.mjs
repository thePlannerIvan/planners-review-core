import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// 只测公开的缝：工作台的 HTTP 命令面（GET /api/doc、POST /api/block、
// POST /api/block/split、POST /api/block/merge）与磁盘上的文本。
// 块怎么切、锚点怎么生成是实现细节，换实现时这些断言不该跟着变。
const core = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VALIDATOR = join(core, 'scripts', 'validate-doc.mjs');

const sandboxes = [];
after(() => { for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true }); });

const FRONT = '---\ncontract: planners-doc/2\ndoc: storyline\nproject: 块操作测试\n---\n\n';
const ANCHOR = /^b:[0-9a-f]{6}$/;

/** 两章三页：改第一页的块会让后面页的标题行号整体位移（旧判据误报的现场）。 */
const THREE_PAGES = `# 第一章

## 页一

第一段第一行。<!-- b:aaaaaa -->

第二段。<!-- b:bbbbbb -->

# 第二章

## 页二

第三段。<!-- b:cccccc -->
`;

function scratchDoc(body = THREE_PAGES) {
  const dir = mkdtempSync(join(tmpdir(), 'planners-block-ops-'));
  sandboxes.push(dir);
  const path = join(dir, 'storyline.md');
  writeFileSync(path, FRONT + body, 'utf8');
  return { dir, path };
}

const getDoc = async (url) => {
  const response = await fetch(`${url}/api/doc`);
  assert.equal(response.status, 200, `GET /api/doc 应返回 200，实际 ${response.status}`);
  return response.json();
};

const postJson = async (url, path, body) => {
  const response = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
};

const validate = (path) => {
  const result = spawnSync(process.execPath, [VALIDATOR, path], { encoding: 'utf8' });
  return { code: result.status, out: JSON.parse(result.stdout || 'null'), stdout: result.stdout, stderr: result.stderr };
};

const blockOf = (doc, anchor) => doc.blocks.find((block) => block.anchor === anchor) ?? null;
const pageKeys = (doc) => [...new Set(doc.blocks.map((block) => block.page.key))];

async function openWorkbench(t, docPath, options = {}) {
  const { startDocWorkbench } = await import('../scripts/doc-workbench.mjs');
  const server = await startDocWorkbench({ docPath, port: 0, ...options });
  t.after(() => server.close());
  return server;
}

// ── 结构比较按页身份，不按绝对行号 ──────────────────────────────────────────
test('多行块（块内换行）能保存：后续页行号整体位移不误报，只有该块变', async (t) => {
  const { path } = scratchDoc();
  const server = await openWorkbench(t, path);
  const before = await getDoc(server.url);
  const savedPages = pageKeys(before);

  // 硬换行（反斜杠 + 换行）就是 Shift+Enter 在契约里的写法：一个块、两行。
  const content = '第一段第一行。\\\n第一段第二行。';
  const response = await postJson(server.url, '/api/block', {
    anchor: 'b:aaaaaa',
    content,
    base_sha256: before.sha256,
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.block.raw, content, '多行内容应原样读回');

  const disk = readFileSync(path, 'utf8');
  assert.ok(disk.includes(`${content}<!-- b:aaaaaa -->`), '磁盘上这一块是两行，锚点贴最后一行');
  assert.ok(disk.includes('第三段。<!-- b:cccccc -->'), '后面页的块逐字不动（只是行号位移）');

  const after = await getDoc(server.url);
  assert.equal(after.blocks.length, before.blocks.length, '换行不增删块');
  assert.deepEqual(pageKeys(after), savedPages, '页身份（章节 + 页序）不变');
  for (const anchor of ['b:bbbbbb', 'b:cccccc']) {
    assert.equal(blockOf(after, anchor).raw, blockOf(before, anchor).raw, `未编辑块 ${anchor} 逐字不动`);
  }
  // 软换行（浏览器把块内换行写成文本里的 \n）同样是「同一块两行」，也要能保存。
  const softBreak = '第一段第一行。\n第一段第二行。';
  const soft = await postJson(server.url, '/api/block', {
    anchor: 'b:aaaaaa',
    content: softBreak,
    base_sha256: response.body.sha256,
  });
  assert.equal(soft.status, 200, JSON.stringify(soft.body));
  assert.equal(soft.body.block.raw, softBreak);
  assert.ok(readFileSync(path, 'utf8').includes(`${softBreak}<!-- b:aaaaaa -->`), '软换行同样落盘');

  const verdict = validate(path);
  assert.equal(verdict.code, 0, `${verdict.stdout}${verdict.stderr}`);
});

// ── Enter 分块 ──────────────────────────────────────────────────────────────
test('Enter 分块：光标处切成两块，原锚点留在前半，后半拿新锚点', async (t) => {
  const { path } = scratchDoc();
  const server = await openWorkbench(t, path);
  const before = await getDoc(server.url);
  const target = blockOf(before, 'b:aaaaaa');

  const response = await postJson(server.url, '/api/block/split', {
    anchor: target.anchor,
    before: '第一段第一行。',
    after: '第一段第二行。',
    base_sha256: before.sha256,
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const receipt = response.body;
  assert.match(receipt.new_block.anchor, ANCHOR, '新块有独立的锚点');
  assert.notEqual(receipt.new_block.anchor, target.anchor, '新块不复用原锚点');
  assert.equal(receipt.block.anchor, target.anchor, '原锚点留在前半');
  assert.equal(receipt.block.raw, '第一段第一行。');
  assert.equal(receipt.new_block.raw, '第一段第二行。');

  const disk = readFileSync(path, 'utf8');
  assert.ok(disk.includes(`第一段第一行。<!-- b:aaaaaa -->\n\n第一段第二行。<!-- ${receipt.new_block.anchor} -->`), disk);

  const after = await getDoc(server.url);
  assert.equal(after.blocks.length, before.blocks.length + 1, '分块多一块');
  assert.equal(after.pages.length, before.pages.length, '分块不增减页');
  const index = after.blocks.findIndex((block) => block.anchor === target.anchor);
  assert.equal(after.blocks[index + 1].anchor, receipt.new_block.anchor, '新块紧跟在原块之后');
  assert.equal(after.blocks[index].page.key, after.blocks[index + 1].page.key, '两块仍在同一页');
  assert.equal(blockOf(after, 'b:bbbbbb').raw, blockOf(before, 'b:bbbbbb').raw, '其余块逐字不动');
  assert.equal(validate(path).code, 0, '分块后仍合规');
});

test('Enter 在块首分块：新块在前半拿新锚点，原锚点跟着原来的内容走', async (t) => {
  const { path } = scratchDoc();
  const server = await openWorkbench(t, path);
  const before = await getDoc(server.url);

  const response = await postJson(server.url, '/api/block/split', {
    anchor: 'b:aaaaaa',
    before: '新插入的一段。',
    after: '第一段第一行。',
    keep: 'after',
    base_sha256: before.sha256,
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.match(response.body.new_block.anchor, ANCHOR);
  assert.equal(response.body.block.anchor, 'b:aaaaaa', '原锚点留在原来的内容上');
  assert.equal(response.body.block.raw, '第一段第一行。');
  assert.equal(response.body.new_block.raw, '新插入的一段。');

  const after = await getDoc(server.url);
  const index = after.blocks.findIndex((block) => block.anchor === response.body.new_block.anchor);
  assert.equal(after.blocks[index + 1].anchor, 'b:aaaaaa', '新块在前，原块在后');
  assert.equal(validate(path).code, 0, '块首分块后仍合规');
});

test('Enter 分块：标题块回车，后半块成为正文段落，标题本身不变', async (t) => {
  const { path } = scratchDoc(`# 章节

## 页一

### 小节标题<!-- b:dddddd -->

正文。<!-- b:eeeeee -->
`);
  const server = await openWorkbench(t, path);
  const before = await getDoc(server.url);

  const response = await postJson(server.url, '/api/block/split', {
    anchor: 'b:dddddd',
    before: '小节',
    after: '标题',
    base_sha256: before.sha256,
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.block.type, 'heading', '前半仍是标题块');
  assert.equal(response.body.block.raw, '### 小节');
  assert.equal(response.body.new_block.type, 'paragraph', '标题回车后的后半是正文段落');
  assert.equal(response.body.new_block.raw, '标题');
  assert.equal(validate(path).code, 0, '标题分块后仍合规');
});

test('Enter 分块拒绝空的一半、前后文重叠与不可拆的块类型', async (t) => {
  const { path } = scratchDoc(`# 章节

## 页一

第一段。<!-- b:aaaaaa -->

\`\`\`text
代码块
\`\`\`
<!-- b:bbbbbb -->
`);
  const server = await openWorkbench(t, path);
  const before = await getDoc(server.url);
  const split = (body) => postJson(server.url, '/api/block/split', { base_sha256: before.sha256, ...body });

  const emptyBefore = await split({ anchor: 'b:aaaaaa', before: '', after: '后半。' });
  assert.equal(emptyBefore.status, 409, JSON.stringify(emptyBefore.body));
  assert.equal(emptyBefore.body.code, 'block_empty', '前半为空就是没有可拆的内容');

  const emptyAfter = await split({ anchor: 'b:aaaaaa', before: '前半。', after: '' });
  assert.equal(emptyAfter.status, 409, JSON.stringify(emptyAfter.body));
  assert.equal(emptyAfter.body.code, 'block_empty', '后半为空就不该落一个空块');

  const code = await split({ anchor: 'b:bbbbbb', before: '代码', after: '块' });
  assert.equal(code.status, 409, JSON.stringify(code.body));
  assert.equal(code.body.code, 'block_split_type', '代码块不拆成两个代码围栏');

  assert.equal(readFileSync(path, 'utf8').endsWith('```\n<!-- b:bbbbbb -->\n'), true, '被拒绝的拆分不改磁盘');
});

// ── 空块 Backspace 合并 ─────────────────────────────────────────────────────
test('Backspace 合并空块：保留前一块锚点，后一块锚点删除，前一块内容逐字不动', async (t) => {
  const { path } = scratchDoc();
  const server = await openWorkbench(t, path);
  const before = await getDoc(server.url);

  const response = await postJson(server.url, '/api/block/merge', {
    anchor: 'b:bbbbbb',
    previous: 'b:aaaaaa',
    content: '',
    base_sha256: before.sha256,
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.block.anchor, 'b:aaaaaa', '合并后留下的是前一块的锚点');

  const after = await getDoc(server.url);
  assert.equal(after.blocks.length, before.blocks.length - 1, '合并少一块');
  assert.equal(blockOf(after, 'b:bbbbbb'), null, '后一块的锚点被删除，不迁移到前一块');
  assert.equal(blockOf(after, 'b:aaaaaa').raw, blockOf(before, 'b:aaaaaa').raw, '前一块内容逐字不动');
  assert.equal(blockOf(after, 'b:aaaaaa').start, blockOf(before, 'b:aaaaaa').start, '前一块位置不漂移');
  assert.equal(blockOf(after, 'b:cccccc').raw, blockOf(before, 'b:cccccc').raw, '下一章页的块逐字不动');
  assert.deepEqual(pageKeys(after), pageKeys(before), '合并不增减页');
  assert.equal(validate(path).code, 0, '合并后仍合规');
});

test('Backspace 合并只接受「空块并入紧邻的前一块」', async (t) => {
  const { path } = scratchDoc();
  const server = await openWorkbench(t, path);
  const before = await getDoc(server.url);
  const merge = (body) => postJson(server.url, '/api/block/merge', { base_sha256: before.sha256, ...body });

  const notEmpty = await merge({ anchor: 'b:bbbbbb', previous: 'b:aaaaaa', content: '第二段。' });
  assert.equal(notEmpty.status, 409, JSON.stringify(notEmpty.body));
  assert.equal(notEmpty.body.code, 'merge_not_empty', '还有内容的块不能靠合并静默丢掉');

  const notAdjacent = await merge({ anchor: 'b:bbbbbb', previous: 'b:cccccc', content: '' });
  assert.equal(notAdjacent.status, 409, JSON.stringify(notAdjacent.body));
  assert.equal(notAdjacent.body.code, 'merge_target', '只能并入紧挨着的前一块');

  const firstBlock = await merge({ anchor: 'b:aaaaaa', previous: null, content: '' });
  assert.equal(firstBlock.status, 409, JSON.stringify(firstBlock.body));
  assert.equal(firstBlock.body.code, 'merge_previous_missing', '页里的第一块没有上一块可并');

  assert.equal(readFileSync(path, 'utf8'), FRONT + THREE_PAGES, '被拒绝的合并不改磁盘');
});

test('合并只删块身份：前一块的任务仍绑定原锚点，被删块的任务变 stale、不迁移', async (t) => {
  const { path } = scratchDoc();
  const server = await openWorkbench(t, path);
  const before = await getDoc(server.url);

  const taskOf = async (anchor) => {
    const receipt = await postJson(server.url, '/api/feedback', {
      scope: 'blocks',
      anchors: [anchor],
      text: `只改 ${anchor}。`,
    });
    assert.equal(receipt.status, 200, JSON.stringify(receipt.body));
    return receipt.body.task;
  };
  const taskPrevious = await taskOf('b:aaaaaa');
  const taskMergedAway = await taskOf('b:bbbbbb');

  const merged = await postJson(server.url, '/api/block/merge', {
    anchor: 'b:bbbbbb',
    previous: 'b:aaaaaa',
    content: '',
    base_sha256: before.sha256,
  });
  assert.equal(merged.status, 200, JSON.stringify(merged.body));

  // 任务只认锚点：被删块的任务仍然指向被删的锚点，不会被偷换到前一块。
  const tasks = await (await fetch(`${server.url}/api/tasks`)).json();
  const stillBound = tasks.tasks.find((task) => task.id === taskMergedAway.id);
  assert.equal(stillBound.blocks[0].anchor, 'b:bbbbbb', '旧任务保留原锚点，不跟随合并');
  const previousTask = tasks.tasks.find((task) => task.id === taskPrevious.id);
  assert.equal(previousTask.blocks[0].anchor, 'b:aaaaaa', '前一块的任务不受合并影响');

  const claimPrevious = await postJson(server.url, '/api/task/claim', { task_id: taskPrevious.id });
  assert.equal(claimPrevious.status, 200, JSON.stringify(claimPrevious.body));
  assert.equal(claimPrevious.body.task.status, 'processing', '前一块的任务照常开工');

  const claimMergedAway = await postJson(server.url, '/api/task/claim', { task_id: taskMergedAway.id });
  assert.equal(claimMergedAway.status, 409, JSON.stringify(claimMergedAway.body));
  assert.equal(claimMergedAway.body.code, 'task_stale', '被删块的任务明确失效，而不是静默改到别的块');

  const patched = await postJson(server.url, '/api/patch', {
    task_id: taskPrevious.id,
    patches: [{ anchor: 'b:aaaaaa', content: '第一段第一行。' }],
  });
  assert.equal(patched.status, 200, JSON.stringify(patched.body));
  assert.deepEqual(patched.body.applied, ['b:aaaaaa'], '前一块仍能按原锚点写回');
});

test('分块不改锚点归属：绑定原块的任务拿旧基线写回会进待核对，新块不被牵连', async (t) => {
  const { path } = scratchDoc();
  const server = await openWorkbench(t, path);
  const before = await getDoc(server.url);

  const feedback = await postJson(server.url, '/api/feedback', {
    scope: 'blocks',
    anchors: ['b:aaaaaa'],
    text: '把这一块改紧一点。',
  });
  assert.equal(feedback.status, 200, JSON.stringify(feedback.body));
  const task = feedback.body.task;
  const baseSha = task.blocks[0].sha256;

  const split = await postJson(server.url, '/api/block/split', {
    anchor: 'b:aaaaaa',
    before: '前半。',
    after: '后半。',
    base_sha256: before.sha256,
  });
  assert.equal(split.status, 200, JSON.stringify(split.body));

  // 任务还绑在原锚点上，新块没有被写成任务的一部分。
  const tasks = await (await fetch(`${server.url}/api/tasks`)).json();
  assert.deepEqual(tasks.tasks.find((item) => item.id === task.id).blocks.map((block) => block.anchor), ['b:aaaaaa']);
  assert.equal(tasks.tasks.find((item) => item.id === task.id).blocks[0].sha256, baseSha, '任务基线还是分块前的内容');

  const claim = await postJson(server.url, '/api/task/claim', { task_id: task.id });
  assert.equal(claim.status, 200, JSON.stringify(claim.body));
  const patched = await postJson(server.url, '/api/patch', {
    task_id: task.id,
    patches: [{ anchor: 'b:aaaaaa', content: '模型版。' }],
  });
  assert.equal(patched.status, 200, JSON.stringify(patched.body));
  assert.deepEqual(patched.body.applied, [], '原块内容已被分块改过，旧基线不能静默覆盖');
  assert.deepEqual(patched.body.deferred_blocks.map((item) => item.anchor), ['b:aaaaaa'], '只有这一块进待核对');

  const conflicts = await (await fetch(`${server.url}/api/conflicts`)).json();
  const conflict = conflicts.conflicts.find((item) => item.anchor === 'b:aaaaaa');
  assert.equal(conflict.disk_raw, '前半。', '待核对里人的版本是分块后的前半');
  assert.equal(conflict.model_content, '模型版。');
});

// ── 锁：正在被模型改的块不能拆也不能并 ─────────────────────────────────────
test('被模型锁住的块不能拆分或合并，磁盘一个字节不动', async (t) => {
  const { path } = scratchDoc();
  const server = await openWorkbench(t, path);
  const original = readFileSync(path, 'utf8');
  const before = await getDoc(server.url);

  const feedback = await postJson(server.url, '/api/feedback', {
    scope: 'blocks',
    anchors: ['b:bbbbbb'],
    text: '模型改这一块。',
  });
  assert.equal(feedback.status, 200, JSON.stringify(feedback.body));
  const claim = await postJson(server.url, '/api/task/claim', { task_id: feedback.body.task.id });
  assert.equal(claim.status, 200, JSON.stringify(claim.body));

  const split = await postJson(server.url, '/api/block/split', {
    anchor: 'b:bbbbbb',
    before: '第二',
    after: '段。',
    base_sha256: before.sha256,
  });
  assert.equal(split.status, 409, JSON.stringify(split.body));
  assert.equal(split.body.code, 'block_locked');

  const merge = await postJson(server.url, '/api/block/merge', {
    anchor: 'b:bbbbbb',
    previous: 'b:aaaaaa',
    content: '',
    base_sha256: before.sha256,
  });
  assert.equal(merge.status, 409, JSON.stringify(merge.body));
  assert.equal(merge.body.code, 'block_locked');

  assert.equal(readFileSync(path, 'utf8'), original, '被锁的块一个字节都不动');
});
