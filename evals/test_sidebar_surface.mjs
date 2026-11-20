import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { after, test } from 'node:test';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// 只测公开的缝：
//   · 生成的 review-surface（validate-surface 认得的文件）与它的自包含入口；
//   · 侧栏命令通道 runBrowserCommand(surface, {route, body}) —— 与本地页 HTTP 共用块级逻辑；
//   · 模型侧的 doc-command CLI（跨进程 claim / patch）；
//   · 页面源码里「两个入口，同一套逻辑」那条界线。
// 块怎么切、锚点怎么写是 lib 的实现细节，断言只落在磁盘字节、回执与任务形状上。
const core = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXAMPLES = join(core, 'contracts', 'examples');
const VALIDATE_SURFACE = join(core, 'scripts', 'validate-surface.mjs');
const DOC_COMMAND = join(core, 'scripts', 'doc-command.mjs');
const WORKBENCH_ASSETS = join(core, 'assets', 'workbench');
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

const sandboxes = [];
after(() => { for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true }); });

/** 真实样例：工作台必须能在交付语料上工作，而不是只手搓样例。 */
function sandboxExample(name = 'storyline.md') {
  const dir = mkdtempSync(join(tmpdir(), 'planners-sidebar-'));
  sandboxes.push(dir);
  cpSync(EXAMPLES, dir, { recursive: true });
  return { dir, path: join(dir, name) };
}

/** 宿主那一侧加载 surface 的方式：data + 解析后的绝对路径（DSH 插件与本地宿主都这样传）。 */
function loadSurface(surfacePath, extra = {}) {
  const data = JSON.parse(readFileSync(surfacePath, 'utf8'));
  const base = dirname(surfacePath);
  return {
    file: surfacePath,
    base,
    data,
    dir: resolve(base, data.dir),
    projectRoot: resolve(base, data.project_root),
    ...extra,
  };
}

const runner = () => import(pathToFileURL(join(core, 'scripts', 'lib', 'review-command.mjs')).href);
const command = async (surface, payload) => (await runner()).runBrowserCommand(surface, payload);

const cli = (args, input) => spawnSync(process.execPath, [DOC_COMMAND, ...args], { encoding: 'utf8', input });
const validateSurface = (path) => {
  const result = spawnSync(process.execPath, [VALIDATE_SURFACE, path], { encoding: 'utf8' });
  return { code: result.status, out: JSON.parse(result.stdout || 'null'), stdout: result.stdout, stderr: result.stderr };
};

const blockOf = (snapshot, anchor) => snapshot.blocks.find((block) => block.anchor === anchor);

// ── 验收：侧栏通道保存一块 → 只改这块，其余字节不动 ─────────────────────────
test('侧栏命令通道保存一块：只改这一块，其余字节逐字不动', async (t) => {
  const { dir, path } = sandboxExample();
  const original = readFileSync(path, 'utf8');
  const { buildDocSurface } = await import('../scripts/doc-surface.mjs');
  const built = buildDocSurface({ docPath: path });

  assert.equal(built.surfacePath, join(realpathSync(dir), '.doc-workbench', 'review-surface.json'));
  const verdict = validateSurface(built.surfacePath);
  assert.equal(verdict.code, 0, verdict.stdout + verdict.stderr);
  assert.equal(verdict.out.valid, true, JSON.stringify(verdict.out.errors));
  assert.equal(built.surface.command_backend, 'doc-workbench/1');
  assert.deepEqual(built.surface.capabilities, ['command']);

  const surface = loadSurface(built.surfacePath);
  const opened = await command(surface, { route: 'open' });
  assert.equal(opened.ok, true, JSON.stringify(opened));
  assert.equal(opened.sha256, sha256(original), '打开一份锚点齐全的稿子不应改写文件');
  assert.ok(opened.blocks.length > 0, '侧栏要看到正文块');

  const target = opened.blocks.find((block) => block.type === 'paragraph' && block.editable);
  assert.ok(target, '样例里应有一块可编辑段落');
  const content = '侧栏改过的这一段。';
  const saved = await command(surface, {
    route: 'block',
    body: {
      anchor: target.anchor,
      content,
      base_sha256: opened.sha256,
      base_block_sha256: target.sha256,
    },
  });
  assert.equal(saved.ok, true, JSON.stringify(saved));
  assert.equal(saved.block.raw, content);
  assert.equal(saved.block.sha256, sha256(content));

  // 独立算期望字节：只把这一块在原文里的那几个字节换掉，其余一律不动。
  const expected = original.slice(0, target.start)
    + original.slice(target.start, target.end).replace(target.raw, content)
    + original.slice(target.end);
  assert.equal(readFileSync(path, 'utf8'), expected, '磁盘上只有这一块的字节变化');

  // 没有插件时本地页仍可用：同一个文件、同一套块，本地 HTTP 读到的是侧栏刚写的那一版。
  const { startDocWorkbench } = await import('../scripts/doc-workbench.mjs');
  const server = await startDocWorkbench({ docPath: path, port: 0 });
  t.after(() => server.close());
  const local = await (await fetch(`${server.url}/api/doc`)).json();
  assert.equal(blockOf(local, target.anchor).raw, content, '两条入口读同一份磁盘上的块');
  assert.equal(local.blocks.length, opened.blocks.length);
});

// ── 同一 id 再生成 = 刷新那一个面，不是另起一份 ─────────────────────────────
test('同一份稿子重复生成 surface：id 与路径不变；不同稿子各占一个面', async () => {
  const { path } = sandboxExample('storyline.md');
  const other = sandboxExample('by-page.md');
  const { buildDocSurface } = await import('../scripts/doc-surface.mjs');
  const first = buildDocSurface({ docPath: path });
  const second = buildDocSurface({ docPath: path });
  assert.equal(first.surface.id, second.surface.id, '同一个面只该有一个 id（同 id = 刷新）');
  assert.equal(first.surfacePath, second.surfacePath);
  assert.equal(first.entryPath, second.entryPath);
  assert.notEqual(buildDocSurface({ docPath: other.path }).surface.id, first.surface.id, '不同工作稿各占一个标签');

  const entry = readFileSync(first.entryPath, 'utf8');
  assert.match(entry, /^\s*\{\{REVIEW_BRIDGE\}\}\s*$/m, '入口留裸的桥注入点，宿主才能注入桥');
  assert.match(entry, /素材|工作稿|文字工作台/);
  assert.doesNotMatch(entry, /src="\/doc-workbench\.js"/, '侧栏入口是自包含页面，不依赖页面的 /api 服务器');
  assert.match(entry, /DocTransport/, '入口内联了同一份页面逻辑');
  assert.match(entry, /doc-block/, '入口带着正文块样式与渲染逻辑');
});

// ── 回车分块 / 删空合并：侧栏命令通道与本地 HTTP 共用同一份块级实现 ──────────
test('侧栏命令通道也能回车分块与删空合并，锚点随内容走', async (t) => {
  const { path } = sandboxExample();
  const { buildDocSurface } = await import('../scripts/doc-surface.mjs');
  const built = buildDocSurface({ docPath: path });
  const surface = loadSurface(built.surfacePath);
  const opened = await command(surface, { route: 'open' });
  assert.equal(opened.ok, true, JSON.stringify(opened));
  const target = opened.blocks.find((block) => block.type === 'paragraph' && block.editable
    && !String(block.raw).includes('\n'));
  assert.ok(target, '样例里应有一块单行可编辑段落');

  const split = await command(surface, {
    route: 'split',
    body: {
      anchor: target.anchor,
      before: '侧栏前半。',
      after: '侧栏后半。',
      base_sha256: opened.sha256,
    },
  });
  assert.equal(split.ok, true, JSON.stringify(split));
  assert.notEqual(split.new_block.anchor, target.anchor, '新块拿新锚点');
  const saved = readFileSync(path, 'utf8');
  assert.ok(saved.includes(`侧栏前半。<!-- ${target.anchor} -->`), '原锚点留在前半');
  assert.ok(saved.includes(`侧栏后半。<!-- ${split.new_block.anchor} -->`), '新锚点贴在后半');

  const merged = await command(surface, {
    route: 'merge',
    body: {
      anchor: split.new_block.anchor,
      previous: target.anchor,
      content: '',
      base_sha256: split.sha256,
    },
  });
  assert.equal(merged.ok, true, JSON.stringify(merged));
  assert.equal(merged.block.anchor, target.anchor, '合并后留下前一块的锚点');
  const after = await command(surface, { route: 'open' });
  assert.equal(after.blocks.some((block) => block.anchor === split.new_block.anchor), false, '后一块的锚点被删除');
  assert.equal(blockOf(after, target.anchor).raw, '侧栏前半。', '前一块内容逐字不动');
});

// ── 派发：有插件唤醒、没插件收件箱，任务形状与页面状态同形 ──────────────────
const feedbackShape = (task) => ({
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

test('派发在两通道同形：本地宿主落收件箱，侧栏命令回唤醒', async (t) => {
  const local = sandboxExample();
  const sidebar = sandboxExample();
  const { buildDocSurface } = await import('../scripts/doc-surface.mjs');
  const localBuilt = buildDocSurface({ docPath: local.path });
  const sidebarBuilt = buildDocSurface({ docPath: sidebar.path });
  const localSurface = loadSurface(localBuilt.surfacePath, { host: 'local' });
  const sidebarSurface = loadSurface(sidebarBuilt.surfacePath);

  const opened = await command(localSurface, { route: 'open' });
  const anchors = opened.blocks.filter((block) => block.type === 'paragraph').slice(0, 2).map((block) => block.anchor);
  const payload = { route: 'feedback', body: { scope: 'blocks', anchors, text: '把这两块写紧一点。只改这两块。' } };

  const inbox = await command(localSurface, payload);
  const wake = await command(sidebarSurface, payload);
  assert.equal(inbox.ok, true, JSON.stringify(inbox));
  assert.equal(wake.ok, true, JSON.stringify(wake));
  assert.equal(inbox.dispatch.channel, 'inbox', '没有插件时派发落收件箱，不假装唤醒了模型');
  assert.equal(wake.dispatch.channel, 'wake', '有插件时派发是唤醒');
  assert.ok(inbox.dispatch.path, '收件箱回执要说任务落在哪');
  assert.deepEqual(feedbackShape(wake.task), feedbackShape(inbox.task), '两条通道拿到同一条任务形状');
  assert.equal(wake.task.status, 'pending');
  assert.equal(wake.task.text, payload.body.text);
  assert.deepEqual(wake.task.blocks.map((block) => block.anchor), anchors, '侧栏派发绑定的是同一批块身份');

  // 唤醒文案要能让模型真的开工：任务、稿子、块、人的话、下一步命令，一个都不少。
  for (const piece of [wake.task.id, wake.task.doc.path, anchors[0], payload.body.text, 'doc-command.mjs']) {
    assert.ok(wake.dispatch.text.includes(piece), `唤醒文案缺少 ${piece}：${wake.dispatch.text}`);
  }
  assert.ok(wake.dispatch.next.includes('doc-command.mjs') && wake.dispatch.next.includes(sidebarBuilt.surfacePath));

  // 派发是请求，不是保存也不是批准：原文一个字节都不动。
  assert.equal(readFileSync(sidebar.path, 'utf8'), readFileSync(join(EXAMPLES, 'storyline.md'), 'utf8'));
});

// ── 锁与待核对：侧栏可见、可裁决；模型侧 CLI 跨进程对同一块加锁 ─────────────
test('侧栏锁与待核对可见可裁决：模型 CLI 跨进程 claim / patch，页面命令读锁、裁决', async (t) => {
  const { path } = sandboxExample();
  const { buildDocSurface } = await import('../scripts/doc-surface.mjs');
  const built = buildDocSurface({ docPath: path });
  const surface = loadSurface(built.surfacePath);
  const opened = await command(surface, { route: 'open' });
  const [first, second] = opened.blocks.filter((block) => block.type === 'paragraph').slice(0, 2);

  const submitted = await command(surface, {
    route: 'feedback', body: { scope: 'blocks', anchors: [first.anchor, second.anchor], text: '两块都收紧。' },
  });
  assert.equal(submitted.ok, true, JSON.stringify(submitted));
  const taskId = submitted.task.id;

  const listed = cli([built.surfacePath, 'tasks']);
  assert.equal(listed.status, 0, listed.stderr);
  assert.equal(JSON.parse(listed.stdout).tasks[0].id, taskId, '模型跨进程读得到侧栏派发的任务');

  const claimed = cli([built.surfacePath, 'claim', taskId]);
  assert.equal(claimed.status, 0, claimed.stderr);
  assert.equal(JSON.parse(claimed.stdout).task.status, 'processing');

  const locked = await command(surface, { route: 'open' });
  assert.equal(blockOf(locked, first.anchor).locked, true, '模型开工后侧栏块显示为锁定');
  assert.equal(blockOf(locked, first.anchor).locked_by, taskId);

  // 锁定块不许从浏览器改：锁判定仍然在同一个 session 里，不是界面上的一层灰。
  const blocked = await command(surface, {
    route: 'block', body: { anchor: first.anchor, content: '想绕过锁。', base_sha256: locked.sha256 },
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, 'block_locked');

  // 模型开工后人在别处（或直接改文件）改了第一块：写回时只这一块进待核对。
  const disk = readFileSync(path, 'utf8');
  const human = '人抢在模型前改的第一块。';
  const target = blockOf(locked, first.anchor);
  const edited = disk.slice(0, target.start)
    + disk.slice(target.start, target.end).replace(target.raw, human)
    + disk.slice(target.end);
  writeFileSync(path, edited, 'utf8');

  const modelFirst = '模型改的第一块。';
  const modelSecond = '模型改的第二块。';
  const patched = cli([built.surfacePath, 'patch'], JSON.stringify({
    task_id: taskId,
    patches: [
      { anchor: first.anchor, content: modelFirst },
      { anchor: second.anchor, content: modelSecond },
    ],
  }));
  assert.equal(patched.status, 0, patched.stderr);
  const patchReceipt = JSON.parse(patched.stdout);
  assert.deepEqual(patchReceipt.applied, [second.anchor], '基线没变的块照常写回');
  assert.deepEqual(patchReceipt.deferred_blocks.map((block) => block.anchor), [first.anchor]);

  const after = await command(surface, { route: 'open' });
  assert.equal(blockOf(after, first.anchor).raw, human, '冲突块保持人的版本');
  assert.equal(blockOf(after, first.anchor).locked, true, '待核对期间该块保持锁定');
  assert.ok(blockOf(after, first.anchor).deferred, '侧栏块视图要标出待核对');

  const conflicts = await command(surface, { route: 'conflicts' });
  assert.equal(conflicts.ok, true);
  const conflict = conflicts.conflicts.find((item) => item.anchor === first.anchor);
  assert.equal(conflict.disk_raw, human, '裁决要能看到人的版本');
  assert.equal(conflict.model_content, modelFirst, '裁决要能看到模型版');

  const decided = await command(surface, { route: 'decide', body: { anchor: first.anchor, decision: 'model' } });
  assert.equal(decided.ok, true, JSON.stringify(decided));
  assert.equal(decided.written, true);

  const final = readFileSync(path, 'utf8');
  assert.ok(final.includes(`${modelFirst}<!-- ${first.anchor} -->`), '裁决「用模型版」后磁盘写下模型版');
  assert.ok(!final.includes(human), '人的那一版被裁决替换');
  const settled = await command(surface, { route: 'open' });
  assert.equal(blockOf(settled, first.anchor).locked, false, '裁决后解锁');
  assert.equal(blockOf(settled, first.anchor).raw, modelFirst);

  // 模型侧身份不能从浏览器借道：claim / patch / complete 只能走模型 CLI。
  for (const route of ['claim', 'patch', 'complete']) {
    const refused = await command(surface, { route, body: { task_id: taskId, patches: [] } });
    assert.equal(refused.ok, false, `${route} 不该允许浏览器调用`);
    assert.equal(refused.code, 'command_operation');
    assert.match(refused.error, /模型/, `${route} 的拒绝理由要可读`);
  }
});

// ── 两条入口互不破坏：生成 surface 不改稿子；本地页仍走 /api，侧栏页走桥 ─────
test('页面源码：同一套页面逻辑，本地走 /api、侧栏走 command，生成页内联桥注入点', async () => {
  const transport = readFileSync(join(WORKBENCH_ASSETS, 'doc-transport.js'), 'utf8');
  const page = readFileSync(join(WORKBENCH_ASSETS, 'doc-workbench.js'), 'utf8');
  const drag = readFileSync(join(WORKBENCH_ASSETS, 'doc-drag.js'), 'utf8');
  const html = readFileSync(join(WORKBENCH_ASSETS, 'doc-workbench.html'), 'utf8');

  assert.match(transport, /ReviewBridge/, '侧栏通道必须走公共桥');
  assert.match(transport, /\.command\(/, '侧栏保存/派发/裁决都走 bridge 的 command');
  assert.match(transport, /\/api\/block/, '没有插件时仍走本地页面的 HTTP 入口');
  assert.match(transport, /\/api\/feedback/);
  assert.match(transport, /channel === 'wake'/, '侧栏派发由页面调 wake');
  assert.match(transport, /imageUrl|review\.asset/, '侧栏里的图走桥取字节');

  assert.doesNotMatch(page, /fetch\('\/api\/block'/, '页面不再自己写盘：保存经 transport');
  assert.doesNotMatch(drag, /fetch\('\/api\/reorder'/, '拖动重排也经 transport');
  assert.match(page, /DocTransport\.connect/);
  assert.match(page, /channel === 'inbox'/, '页面区分「写进收件箱」与「已唤醒」两条派发出口');
  assert.match(page, /channel === 'wake'/);
  assert.match(page, /已写入收件箱/);
  assert.match(page, /已唤醒模型/);
  assert.match(page, /原文未改，不算批准/);
  assert.match(html, /src="\/doc-transport\.js"/, '本地页也要加载同一份 transport');

  // 生成入口不复制一份写盘逻辑：它内联的就是这些源文件。
  const { path } = sandboxExample();
  const { buildDocSurface } = await import('../scripts/doc-surface.mjs');
  const built = buildDocSurface({ docPath: path });
  const entry = readFileSync(built.entryPath, 'utf8');
  assert.ok(entry.includes('ReviewBridge'), '入口里带着桥（宿主会在注入点换掉它）');
  assert.ok(entry.includes('function persist(node)'), '入口内联的是同一份页面保存逻辑');
  assert.ok(entry.includes('doc-command.mjs') || entry.includes('DocTransport'), '入口带着侧栏 command 通道');
  assert.equal(readFileSync(path, 'utf8'), readFileSync(join(EXAMPLES, 'storyline.md'), 'utf8'), '生成 surface 不改稿子');
});

// ── 没有插件的宿主也能直接打开生成的 surface（桥 + command + 收件箱）──────────
function startReviewHost(t, surfacePath) {
  return new Promise((resolveHost, rejectHost) => {
    const child = spawn(process.execPath, [join(core, 'scripts', 'serve-review.mjs'), surfacePath, '--port', '0', '--no-open'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      rejectHost(new Error(`本地宿主没有起来：\n${out}\n${err}`));
    }, 10000);
    child.stdout.on('data', (chunk) => {
      out += chunk;
      if (!out.includes('next_action_zh')) return;
      clearTimeout(timer);
      resolveHost({ child, info: JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1)) });
    });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('exit', (code) => {
      if (code === 0 || out.includes('next_action_zh')) return;
      clearTimeout(timer);
      rejectHost(new Error(`本地宿主退出 ${code}：\n${err}`));
    });
  });
}

test('没有插件时生成的 surface 也能直接打开：页面带桥、命令可用、派发落收件箱', async (t) => {
  const { dir, path } = sandboxExample();
  const { buildDocSurface } = await import('../scripts/doc-surface.mjs');
  const built = buildDocSurface({ docPath: path });
  const { child, info } = await startReviewHost(t, built.surfacePath);
  t.after(() => child.kill('SIGTERM'));
  const origin = new URL('/', info.url).origin;
  const post = async (payload) => (await fetch(`${origin}/__review/command`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
  })).json();

  const page = await (await fetch(info.url)).text();
  assert.ok(page.includes('ReviewBridge'), '宿主把公共桥注进了页面');
  assert.ok(!page.includes('{{REVIEW_BRIDGE}}'), '注入点必须被替换掉，不能留在页面上');
  assert.deepEqual((await (await fetch(`${origin}/__review/capabilities`)).json()).capabilities, ['command']);

  const opened = await post({ route: 'open' });
  assert.equal(opened.ok, true, JSON.stringify(opened));
  assert.ok(opened.blocks.length > 0);
  const feedback = await post({ route: 'feedback', body: { scope: 'doc', text: '整份收紧。' } });
  assert.equal(feedback.ok, true, JSON.stringify(feedback));
  assert.equal(feedback.dispatch.channel, 'inbox', '没有插件：同一份页面走收件箱，不假装唤醒');
  assert.ok(existsSync(feedback.dispatch.path), '任务必须真的落盘');
  assert.ok(feedback.dispatch.path.startsWith(join(realpathSync(dir), '.doc-workbench', 'inbox')), '任务落在文档旁路目录');

  // 本地页仍然可用：同一份磁盘，两套入口读同一批块。
  const { startDocWorkbench } = await import('../scripts/doc-workbench.mjs');
  const server = await startDocWorkbench({ docPath: path, port: 0 });
  t.after(() => server.close());
  const local = await (await fetch(`${server.url}/api/doc`)).json();
  assert.equal(local.blocks.length, opened.blocks.length);
  assert.equal(local.sha256, opened.sha256);
});

// ── 页面在侧栏里真的把保存 / 派发交给桥，而不是自己拼第二套写盘 ─────────────
test('侧栏 transport 只转发 {route, body}：保存/重排/派发共用同一套动作名', async () => {
  const source = readFileSync(join(WORKBENCH_ASSETS, 'doc-transport.js'), 'utf8');
  const calls = [];
  const wakes = [];
  const review = {
    capabilities: ['command'],
    command: async (payload) => {
      calls.push(payload);
      if (payload.route === 'feedback') {
        return {
          ok: true,
          task: { id: 't:abcdefabcdef', blocks: [{ anchor: 'b:aaaaaa' }], doc: { path: '/tmp/a.md' }, text: '收紧。' },
          dispatch: { channel: 'wake', text: '派发文案：只改这一块。', next: 'node doc-command.mjs /tmp/s.json tasks' },
        };
      }
      return { ok: true, echo: payload.route };
    },
    wake: async (payload) => { wakes.push(payload); return { ok: true, woke: true }; },
    asset: async (path, extra) => `blob:${path}?${extra?.v ?? ''}`,
  };
  const win = {
    parent: {},
    __REVIEW_BASE__: '/',
    ReviewBridge: { connect: async () => review },
  };
  const Transport = new Function('window', 'globalThis', `${source}\nreturn window.DocTransport;`)(win, win);
  const api = await Transport.connect();
  assert.equal(api.mode, 'sidebar', '帧内且桥可用时走侧栏通道');
  await api.saveBlock({ anchor: 'b:aaaaaa', content: 'x' });
  assert.deepEqual(calls[0], { route: 'block', body: { anchor: 'b:aaaaaa', content: 'x' } }, '保存只发 route 与原始 body');
  // 拖块与 Alt+↑↓ 都走这一个 route；move-block / move-page 只活在 body 里，不是桥的动作名。
  const moveBlock = { op: 'move-block', base_sha256: 'a'.repeat(64), anchor: 'b:aaaaaa', to: { chapter: 1, index: 1, before: null } };
  await api.reorder(moveBlock);
  assert.deepEqual(calls[1], { route: 'reorder', body: moveBlock }, '拖块经 route=reorder 转发，body 原样');
  assert.equal(Object.hasOwn(calls[1], 'op'), false, '动作名只在 route 上，不在信封顶层');
  const movePage = { op: 'move-page', base_sha256: 'a'.repeat(64), page: { chapter: 1, index: 1 }, to: { chapter: 2, index: 1, position: 'before' } };
  await api.reorder(movePage);
  assert.deepEqual(calls[2], { route: 'reorder', body: movePage }, '整页拖动也走同一个 route');
  const receipt = await api.feedback({ scope: 'blocks', anchors: ['b:aaaaaa'], text: '收紧。' });
  assert.equal(calls[3].route, 'feedback');
  assert.deepEqual(calls[3].body, { scope: 'blocks', anchors: ['b:aaaaaa'], text: '收紧。' });
  assert.deepEqual(wakes, [{ unit: 't:abcdefabcdef', text: '派发文案：只改这一块。' }], '唤醒由页面带着整句文案发出');
  assert.equal(receipt.dispatch.woke, true);
  assert.equal(await api.imageUrl('assets/a.png', 'v1'), 'blob:assets/a.png?v1', '侧栏里的图走桥取字节');

  // 宿主没启用 command 时不能装没事：侧栏里没有 /api 可退，必须说清缺什么。
  const disabled = { ...win, ReviewBridge: { connect: async () => ({ ...review, capabilities: [] }) } };
  const DisabledTransport = new Function('window', 'globalThis', `${source}\nreturn window.DocTransport;`)(disabled, disabled);
  await assert.rejects(DisabledTransport.connect(), /doc-workbench\/1/);
});

// ── 历史：侧栏命令通道与本地页共用同一份存档与恢复 ──────────────────────────
test('侧栏命令通道也能列出与恢复历史：恢复是一次新编辑，旧档不删', async (t) => {
  const { path } = sandboxExample();
  const original = readFileSync(path, 'utf8');
  const { buildDocSurface } = await import('../scripts/doc-surface.mjs');
  const built = buildDocSurface({ docPath: path });
  const surface = loadSurface(built.surfacePath);

  const opened = await command(surface, { route: 'open' });
  assert.equal(opened.ok, true, JSON.stringify(opened));
  const target = opened.blocks.find((block) => block.type === 'paragraph' && block.editable);
  assert.ok(target, '样例里应有一块可编辑段落');
  const saved = await command(surface, {
    route: 'block',
    body: {
      anchor: target.anchor,
      content: '侧栏改过的这一段。',
      base_sha256: opened.sha256,
      base_block_sha256: target.sha256,
    },
  });
  assert.equal(saved.ok, true, JSON.stringify(saved));

  const listed = await command(surface, { route: 'history' });
  assert.equal(listed.ok, true, JSON.stringify(listed));
  assert.equal(listed.contract, 'planners-doc-history/1');
  assert.equal(listed.versions.length, 1, '保存前的原稿已经存档');
  assert.equal(listed.versions[0].sha256, sha256(original));

  const restored = await command(surface, {
    route: 'restore',
    body: { id: listed.versions[0].id, base_sha256: saved.sha256 },
  });
  assert.equal(restored.ok, true, JSON.stringify(restored));
  assert.equal(restored.changed, true, '恢复也要真的落盘');
  assert.equal(readFileSync(path, 'utf8'), original, '侧栏恢复把稿子带回原稿');

  const after = await command(surface, { route: 'history' });
  assert.equal(after.versions.length, 2, '恢复本身又存了一档');
  assert.equal(after.versions[0].operation, 'restore');
  assert.ok(after.versions.some((version) => version.id === listed.versions[0].id), '旧档不删');

  const modelOnly = await command(surface, { route: 'claim', body: { task_id: 't:abcdefabcdef' } });
  assert.equal(modelOnly.ok, false);
  assert.equal(modelOnly.code, 'command_operation', '模型侧动作仍然不能从浏览器进来');
});
