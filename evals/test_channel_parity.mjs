import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// 这条缝是「两条宿主路径必须同义」：同一份 fixture 分别经本地宿主与桥各跑一遍，
// 断言盘上的字节与拒绝理由完全一致。它补的是「侧栏里拖块永远失败、测试却全绿」
// 的那个缺口 —— 本地宿主与侧栏桥以前各有一套动作名，只有一条路径被测到。
const core = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXAMPLES = join(core, 'contracts', 'examples');

const sandboxes = [];
after(() => { for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true }); });

function sandboxExample() {
  const dir = mkdtempSync(join(tmpdir(), 'planners-channel-'));
  sandboxes.push(dir);
  cpSync(EXAMPLES, dir, { recursive: true });
  return { dir, path: join(dir, 'storyline.md') };
}

/** 本地宿主：页面原来那条路，直接 POST 重排路由。 */
async function startLocal(t, docPath) {
  const { startDocWorkbench } = await import('../scripts/doc-workbench.mjs');
  const server = await startDocWorkbench({ docPath, port: 0 });
  t.after(() => server.close());
  return server;
}

/** 桥：宿主那一侧加载 surface 的方式，与 DSH 插件传给 runBrowserCommand 的形状一致。 */
async function bridgeSurface(t, docPath) {
  const { buildDocSurface } = await import('../scripts/doc-surface.mjs');
  const built = buildDocSurface({ docPath });
  const data = JSON.parse(readFileSync(built.surfacePath, 'utf8'));
  const base = dirname(built.surfacePath);
  return { file: built.surfacePath, base, data, dir: resolve(base, data.dir), projectRoot: resolve(base, data.project_root) };
}

/** 页面在侧栏里唯一会做的事：把 `{route, body}` 原样交给桥。 */
async function bridgeCommand(surface, route, body) {
  const { runBrowserCommand } = await import('../scripts/lib/review-command.mjs');
  return runBrowserCommand(surface, { route, body });
}

/**
 * 页面真正的那条链路：doc-transport 的 sidebar 段 → `review.command(...)` → 桥的
 * `runBrowserCommand`。断言不能停在 runBrowserCommand 上，否则页面又发回 `op` 时它照样绿。
 */
async function openSidebarTransport(surface) {
  const source = readFileSync(join(core, 'assets', 'workbench', 'doc-transport.js'), 'utf8');
  const win = {
    parent: {},
    __REVIEW_BASE__: '/',
    ReviewBridge: {
      connect: async () => ({
        capabilities: ['command'],
        command: (payload) => bridgeCommand(surface, payload.route, payload.body),
      }),
    },
  };
  const Transport = new Function('window', 'globalThis', `${source}\nreturn window.DocTransport;`)(win, win);
  return Transport.connect();
}

const postJson = async (url, path, body) => {
  const response = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
};

const getDoc = async (url) => (await (await fetch(`${url}/api/doc`)).json());

/** 同一串动作：先页内拖块，再整页拖动。两条路各跑一遍。 */
test('侧栏桥与本地宿主：拖块、整页拖动的落盘字节与回执完全一致', async (t) => {
  const local = sandboxExample();
  const sidebar = sandboxExample();
  assert.equal(readFileSync(local.path, 'utf8'), readFileSync(sidebar.path, 'utf8'), 'fixture 必须是同一份');
  const server = await startLocal(t, local.path);
  const surface = await bridgeSurface(t, sidebar.path);
  const api = await openSidebarTransport(surface);
  assert.equal(api.mode, 'sidebar', '桥那条路走的是页面真正的 sidebar transport');

  // 打开：两条路看到同一份块身份。
  const localOpened = await getDoc(server.url);
  const bridgeOpened = await api.open();
  assert.equal(bridgeOpened.ok, true, JSON.stringify(bridgeOpened));
  assert.deepEqual(
    bridgeOpened.blocks.map((block) => block.anchor),
    localOpened.blocks.map((block) => block.anchor),
    '两条路读到同一批块身份',
  );

  // 页内拖块：同一个请求体，一条走 /api/reorder，一条走桥的 route=reorder。
  const page = localOpened.pages.find((item) => item.chapterIndex === 1 && item.index === 1);
  const onPage = localOpened.blocks.filter((block) => block.page.key === page.key);
  const [first, second, third] = onPage;
  assert.ok(third, '第 1 页至少有三块才能测页内换位');
  const moveBlock = {
    op: 'move-block',
    base_sha256: localOpened.sha256,
    anchor: third.anchor,
    to: { chapter: 1, index: 1, before: second.anchor },
  };
  const localMove = await postJson(server.url, '/api/reorder', moveBlock);
  const bridgeMove = await api.reorder(moveBlock);
  // 两份 fixture 在不同目录：回执里只有文档路径一项必然不同，其余必须完全一致。
  const sameReceipt = ({ path: _path, ...rest }) => rest;
  assert.equal(localMove.status, 200, JSON.stringify(localMove.body));
  assert.equal(bridgeMove.ok, true, JSON.stringify(bridgeMove));
  assert.deepEqual(sameReceipt(bridgeMove), sameReceipt(localMove.body), '两条路的回执同形');
  assert.equal(readFileSync(sidebar.path, 'utf8'), readFileSync(local.path, 'utf8'), '拖块后盘上的字节一致');

  // 整页拖动：拖页标题走同一个 route，body 换成 move-page。
  const movePage = {
    op: 'move-page',
    base_sha256: localMove.body.sha256,
    page: { chapter: 1, index: 3 },
    to: { chapter: 2, index: 1, position: 'before' },
  };
  const localPage = await postJson(server.url, '/api/reorder', movePage);
  const bridgePage = await api.reorder(movePage);
  assert.equal(localPage.status, 200, JSON.stringify(localPage.body));
  assert.equal(bridgePage.ok, true, JSON.stringify(bridgePage));
  assert.deepEqual(sameReceipt(bridgePage), sameReceipt(localPage.body), '整页拖动的回执同形');
  assert.equal(readFileSync(sidebar.path, 'utf8'), readFileSync(local.path, 'utf8'), '整页拖动后盘上的字节一致');

  // 未参与重排的块逐字不动这条约束，两条路都得满足（字节相等已经蕴含，仍显式验一次）。
  const after = await getDoc(server.url);
  for (const block of localOpened.blocks) {
    const now = after.blocks.find((item) => item.anchor === block.anchor);
    assert.ok(now, `块 ${block.anchor} 不应消失`);
    assert.equal(now.raw, block.raw, `块 ${block.anchor} 的 raw 必须逐字相同`);
  }
});

test('侧栏桥与本地宿主：同一条拒绝在两条路上同码同句，且都不落盘', async (t) => {
  const local = sandboxExample();
  const sidebar = sandboxExample();
  const server = await startLocal(t, local.path);
  const surface = await bridgeSurface(t, sidebar.path);
  const api = await openSidebarTransport(surface);
  const opened = await getDoc(server.url);
  const localBefore = readFileSync(local.path, 'utf8');
  const sidebarBefore = readFileSync(sidebar.path, 'utf8');

  const cases = [
    {
      // 过期基线不再是拒绝理由（票 23：自动重读、重放），所以这里改测「块已被别处删掉」。
      name: '块不存在',
      body: {
        op: 'move-block', base_sha256: opened.sha256, anchor: 'b:ffffff',
        to: { chapter: 1, index: 1, before: null },
      },
      code: 'block_missing',
    },
    {
      name: '落点不在目标页',
      body: {
        op: 'move-block', base_sha256: opened.sha256, anchor: opened.blocks[1].anchor,
        to: { chapter: 1, index: 1, before: 'b:ffffff' },
      },
      code: 'reorder_target',
    },
  ];

  for (const item of cases) {
    const localFail = await postJson(server.url, '/api/reorder', item.body);
    const bridgeFail = await api.reorder(item.body);
    assert.equal(localFail.status, 409, `${item.name}：本地宿主是拒绝，不是崩溃`);
    assert.equal(bridgeFail.ok, false, `${item.name}：桥也必须拒绝`);
    assert.equal(localFail.body.code, item.code);
    assert.equal(bridgeFail.code, item.code);
    assert.equal(bridgeFail.error, localFail.body.error, `${item.name}：拒绝理由必须一字不差`);
  }

  assert.equal(readFileSync(local.path, 'utf8'), localBefore, '本地宿主：被拒的动作不留写入');
  assert.equal(readFileSync(sidebar.path, 'utf8'), sidebarBefore, '桥：被拒的动作不留写入');
});

test('浏览器不能借桥执行模型侧动作：理由可读、不落盘，旧 op 信封不再被接受', async (t) => {
  const sidebar = sandboxExample();
  const surface = await bridgeSurface(t, sidebar.path);
  const before = readFileSync(sidebar.path, 'utf8');

  for (const route of ['claim', 'patch', 'complete']) {
    const refused = await bridgeCommand(surface, route, { task_id: 't:abcdefabcdef', patches: [] });
    assert.equal(refused.ok, false, `${route} 不能从浏览器进来`);
    assert.equal(refused.code, 'command_operation');
    assert.match(refused.error, /模型|领取|patch|完成/, `${route} 的拒绝理由要让人看得懂：${refused.error}`);
  }
  assert.equal(readFileSync(sidebar.path, 'utf8'), before, '被拒的模型侧动作不留写入');

  // 旧写法（op 信封）已经没有意义：通道只有一套 route 词汇，op 只活在页面给本地服务器的请求体里。
  const legacy = await bridgeCommand(surface, undefined, { op: 'open' });
  assert.equal(legacy.ok, false, '旧 op 信封不再是通道形状');
  assert.equal(legacy.code, 'command_shape');
});
