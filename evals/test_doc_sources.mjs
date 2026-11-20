import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';

// 出处（契约第 5 节）在工作台里的渲染与交互。数据层已经由解析器认出页末连续引用；
// 这里只测「怎么摆」：默认只摆一条、展开后每条都是块、页中段的引用不是出处。

const core = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VALIDATOR = join(core, 'scripts', 'validate-doc.mjs');
const ANCHOR = /^b:[0-9a-f]{6,12}$/;

const sandboxes = [];
after(() => { for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true }); });

const FRONT = '---\ncontract: planners-doc/2\ndoc: storyline\nproject: 出处测试\n---\n\n';

/** 两页：第 1 页页末两条引用（出处区），第 2 页中段一条引用 + 页末一条引用。 */
const TWO_PAGES = `# 一、判断

## 页一

正文。<!-- b:aa0001 -->

> 访谈记录。<!-- b:aa0002 -->

> 行业报告。<!-- b:aa0003 -->

## 页二

> 正文里引人注意的引文。<!-- b:aa0004 -->

正文继续。<!-- b:aa0005 -->

> 内部数据。<!-- b:aa0006 -->
`;

function scratchDoc(body = TWO_PAGES) {
  const dir = mkdtempSync(join(tmpdir(), 'planners-sources-'));
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

const postStructure = async (url, body) => {
  const response = await fetch(`${url}/api/structure`, {
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

async function openWorkbench(t, docPath) {
  const { startDocWorkbench } = await import('../scripts/doc-workbench.mjs');
  const server = await startDocWorkbench({ docPath, port: 0 });
  t.after(() => server.close());
  return server;
}

const pageBlocks = (doc, page) => doc.blocks.filter((block) => block.page.key === page.key);

const sourcesModule = async () => {
  const module = await import('../assets/workbench/doc-sources.js');
  return module.default ?? module;
};

const quote = (anchor, { sources = true, text = '一条引用。' } = {}) => ({
  anchor,
  type: 'quote',
  inline: text,
  in_sources: sources,
});

const paragraph = (anchor) => ({ anchor, type: 'paragraph', inline: '正文。', in_sources: false });

test('出处标签就是「出处 · N」：条数变了标签跟着变', async () => {
  const { labelOf } = await sourcesModule();
  assert.equal(labelOf(3), '出处 · 3');
  assert.equal(labelOf(1), '出处 · 1');
  assert.equal(labelOf(12), '出处 · 12');
});

test('出处区只取页末连续的那一串：页中段的引用留在正文里', async () => {
  const { splitSources } = await sourcesModule();
  const page = [
    paragraph('b:aaaaaa'),
    quote('b:bbbbbb', { sources: false, text: '正文里的引文。' }),
    paragraph('b:cccccc'),
    quote('b:dddddd'),
    quote('b:eeeeee'),
  ];
  const { body, sources } = splitSources(page);
  assert.deepEqual(body.map((block) => block.anchor), ['b:aaaaaa', 'b:bbbbbb', 'b:cccccc'],
    '页中段的引用不是出处，留在正文');
  assert.deepEqual(sources.map((block) => block.anchor), ['b:dddddd', 'b:eeeeee'],
    '只有页末连续的引用构成出处区');
  assert.equal(body[1].in_sources, false, '页中引用的标记是 false');
});

const threeSources = () => [
  paragraph('b:aaaaaa'),
  quote('b:bbbbbb', { text: '访谈记录。' }),
  quote('b:cccccc', { text: '行业报告。' }),
  quote('b:dddddd', { text: '内部数据。' }),
];

test('收起时只摆一条：正文逐块，出处只出一条带条数的条', async () => {
  const { layoutPage } = await sourcesModule();
  const plan = layoutPage(threeSources(), { expanded: false });
  const bars = plan.filter((entry) => entry.kind === 'sources');
  assert.equal(bars.length, 1, '收起时只渲染一条出处');
  assert.equal(bars[0].count, 3);
  assert.equal(bars[0].label, '出处 · 3');
  assert.equal(bars[0].collapsed, true);
  assert.deepEqual(plan.filter((entry) => entry.kind === 'block').map((entry) => entry.block.anchor),
    ['b:aaaaaa'], '收起时三条引用都不单独摆出来');
  assert.equal(plan[0].kind, 'block', '正文在出处条之前');
});

test('展开后每条引用都是可编辑块，组尾一个「＋ 出处」', async () => {
  const { layoutPage } = await sourcesModule();
  const plan = layoutPage(threeSources(), { expanded: true });
  assert.equal(plan.filter((entry) => entry.kind === 'sources').length, 0, '展开后不再有收起的条');
  assert.deepEqual(plan.filter((entry) => entry.kind === 'block').map((entry) => entry.block.anchor),
    ['b:aaaaaa', 'b:bbbbbb', 'b:cccccc', 'b:dddddd'],
    '每条引用照常是一条块，与正文块同一种摆法（因此同样可编辑）');
  const head = plan.find((entry) => entry.kind === 'sources-head');
  assert.equal(head?.label, '出处 · 3', '展开后同一位置给一个可收起的头，条数仍然在');
  assert.equal(head?.expanded, true);
  assert.equal(plan.at(-1).kind, 'add-source', '组尾是「＋ 出处」');
  assert.equal(plan.at(-1).label, '出处 · 3');
  assert.equal(plan.at(-1).count, 3);
});

test('没有出处区的页不摆出处条，也不摆「＋ 出处」', async () => {
  const { layoutPage } = await sourcesModule();
  const plan = layoutPage([paragraph('b:aaaaaa'), quote('b:bbbbbb', { sources: false })], {});
  assert.deepEqual(plan.map((entry) => entry.kind), ['block', 'block']);
});

// ── 「＋ 出处」：页尾追加一条引用，其余字节不动 ──────────────────────────────
test('「＋ 出处」在页尾加一条引用：进出处区、有自己的锚点、其余逐字不动', async (t) => {
  const { path } = scratchDoc();
  const original = readFileSync(path, 'utf8');
  const server = await openWorkbench(t, path);
  const before = await getDoc(server.url);
  const page = before.pages.find((item) => item.chapterIndex === 1 && item.index === 1);
  assert.equal(page.sources, 2, '前提：第 1 页已有两条出处');

  const added = await postStructure(server.url, {
    op: 'add-source', chapter: 1, index: 1, base_sha256: before.sha256,
  });
  assert.equal(added.status, 200, JSON.stringify(added.body));
  assert.equal(added.body.ok, true);
  assert.equal(added.body.changed, true);
  assert.match(added.body.source?.anchor ?? '', ANCHOR, '回执给出新引用块的锚点，页面据此聚焦');

  const saved = readFileSync(path, 'utf8');
  assert.ok(saved.includes(`> 在这里写这条出处。<!-- ${added.body.source.anchor} -->`),
    '新引用落在页尾，带一条可删的占位文字与自己的锚点');
  assert.equal(saved.replace(`\n\n> 在这里写这条出处。<!-- ${added.body.source.anchor} -->`, ''), original,
    '除了新加的这一条，其余字节逐字不动');

  const after = await getDoc(server.url);
  const nowPage = after.pages.find((item) => item.chapterIndex === 1 && item.index === 1);
  assert.equal(nowPage.sources, 3, '页视图的出处条数跟着加一');
  const sources = pageBlocks(after, nowPage).filter((block) => block.in_sources);
  assert.deepEqual(sources.map((block) => block.anchor), ['b:aa0002', 'b:aa0003', added.body.source.anchor],
    '新引用排在页尾，属于同一串出处');
  assert.equal(validate(path).code, 0, `加出处后仍合规：${validate(path).stdout}`);
});

test('「＋ 出处」也能让没有出处区的页有一条；不是引用块就没有出处可加', async (t) => {
  const { path } = scratchDoc(`# 第一章

## 空出处

正文。<!-- b:bb0001 -->
`);
  const server = await openWorkbench(t, path);
  const before = await getDoc(server.url);
  assert.equal(before.pages[0].sources, 0, '前提：这页还没有出处区');

  const added = await postStructure(server.url, {
    op: 'add-source', chapter: 1, index: 1, base_sha256: before.sha256,
  });
  assert.equal(added.status, 200, JSON.stringify(added.body));
  const after = await getDoc(server.url);
  assert.equal(after.pages[0].sources, 1, '页末新增的引用构成出处区');

  const missing = await postStructure(server.url, {
    op: 'add-source', chapter: 9, index: 1, base_sha256: after.sha256,
  });
  assert.equal(missing.status, 409, JSON.stringify(missing.body));
  assert.equal(missing.body.code, 'chapter_missing');
  assert.equal(validate(path).code, 0, '仍是合规文档');
});

// ── 服务端快照 → 摆法：数据层认出来的出处区，界面照着它摆 ────────────────────
test('服务端快照到摆法：页末三条只摆一条，页中引用照常是块', async (t) => {
  const { path } = scratchDoc();
  const server = await openWorkbench(t, path);
  const doc = await getDoc(server.url);
  const pageOne = doc.pages.find((page) => page.index === 1);
  const pageTwo = doc.pages.find((page) => page.index === 2);
  const { layoutPage } = await sourcesModule();

  const collapsed = layoutPage(pageBlocks(doc, pageOne), { expanded: false });
  assert.equal(collapsed.filter((entry) => entry.kind === 'sources').length, 1, '页末两条收成一条');
  assert.equal(collapsed.find((entry) => entry.kind === 'sources').count, 2, '页末两条引用收成一条');

  const pageTwoPlan = layoutPage(pageBlocks(doc, pageTwo), { expanded: false });
  const body = pageTwoPlan.filter((entry) => entry.kind === 'block').map((entry) => entry.block);
  assert.ok(body.some((block) => block.type === 'quote' && block.anchor === 'b:aa0004'),
    '页中段的引用是正文块，不被收进出处');
  assert.equal(pageTwoPlan.find((entry) => entry.kind === 'sources').count, 1, '只有页末那一条是出处');
});

// ── 出处条的样式：32px、整条是点击区、两端记号、中间虚线、留白大于段距 ─────────
const cssRule = (css, selector) => {
  const index = css.indexOf(selector);
  assert.notEqual(index, -1, `CSS 里要有 ${selector}`);
  const start = css.indexOf('{', index);
  return css.slice(start + 1, css.indexOf('}', start));
};

const marginBlock = (body) => {
  const match = body.match(/margin:\s*([^;]+);/);
  assert.ok(match, '规则里要有 margin');
  const values = match[1].trim().split(/\s+/).map(parseFloat);
  const [top, right, bottom] = values.length === 1
    ? [values[0], values[0], values[0]]
    : values.length === 2 ? [values[0], values[1], values[0]] : values;
  return { top, right, bottom };
};

test('出处条：32px 高、整条可点、两端 ›‹、中间虚线，收起时留白大于段距', async () => {
  const css = readFileSync(join(core, 'assets', 'workbench', 'doc-workbench.css'), 'utf8');
  const bar = cssRule(css, '.doc-sources-bar {');
  assert.match(bar, /height:\s*32px/, '收起时是一条 32px 高的条');
  assert.match(bar, /width:\s*100%/, '整条都是点击区，不是只有标签可点');
  assert.match(bar, /cursor:\s*pointer/);
  assert.match(bar, /display:\s*flex/);

  assert.match(cssRule(css, '.doc-sources-rule {'), /border-top:\s*1px dashed/, '中间是一条虚线');

  const wrap = marginBlock(cssRule(css, '.doc-sources {'));
  const block = marginBlock(cssRule(css, '.doc-block {'));
  assert.ok(wrap.top > block.top * 2, `出处上方留白要大于段距（${wrap.top} > ${block.top}）`);
  assert.ok(wrap.bottom > block.bottom * 2, `出处下方留白要大于段距（${wrap.bottom} > ${block.bottom}）`);

  const { marksOf } = await sourcesModule();
  assert.deepEqual(marksOf(false), { lead: '›', trail: '‹' }, '收起时左右两端是 › 与 ‹');
  assert.deepEqual(marksOf(true), { lead: '‹', trail: '›' }, '展开后的同一位置提示可以收起');
});

// ── 页面接线：渲染照 DocSources 的摆法，收起状态是页面状态，加出处走同一条命令 ──
test('工作台按摆法渲染：页面加载 doc-sources、收起状态按页记、加出处走 structure 命令', () => {
  const page = readFileSync(join(core, 'assets', 'workbench', 'doc-workbench.js'), 'utf8');
  const html = readFileSync(join(core, 'assets', 'workbench', 'doc-workbench.html'), 'utf8');
  const server = readFileSync(join(core, 'scripts', 'doc-workbench.mjs'), 'utf8');
  const surface = readFileSync(join(core, 'scripts', 'doc-surface.mjs'), 'utf8');

  assert.match(html, /<script src="\/doc-sources\.js"><\/script>/, '页面先加载出处模块');
  assert.ok(html.indexOf('/doc-sources.js') < html.indexOf('/doc-workbench.js'), '出处模块先于页面逻辑');
  assert.match(surface, /doc-sources\.js/, '侧栏自包含入口也要内联同一份模块');
  assert.match(server, /doc-sources\.js/, '本地宿主也要发这一份');

  assert.match(page, /DocSources\.layoutPage\(/, '正文按同一份摆法渲染，不在页面里另判一遍');
  assert.match(page, /expandedSources/, '展开是页面状态，重画后不丢');
  assert.match(page, /doc-sources-bar/, '收起时是一条可点的条');
  assert.match(page, /doc-sources-head/, '展开后同一位置有可收起的头');
  assert.match(page, /classList\.add\('doc-sources-bar',[^)]*'doc-sources'/, '收起条本身吃 .doc-sources 的上下留白');
  assert.match(page, /doc-sources-add/, '展开后组尾有「＋ 出处」');
  assert.match(page, /op: 'add-source'/, '「＋ 出处」走已有的 structure 命令');
  assert.match(page, /dataset\.pageKey/, '收起/展开按页身份记，不按页号猜');
});

test('CRLF 文档里加出处：新条目用同样的换行，其余字节逐字不动', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'planners-sources-crlf-'));
  sandboxes.push(dir);
  const path = join(dir, 'storyline.md');
  const original = (FRONT + TWO_PAGES).replace(/\n/g, '\r\n');
  writeFileSync(path, original, 'utf8');
  const server = await openWorkbench(t, path);
  const before = await getDoc(server.url);

  const added = await postStructure(server.url, {
    op: 'add-source', chapter: 1, index: 1, base_sha256: before.sha256,
  });
  assert.equal(added.status, 200, JSON.stringify(added.body));
  const saved = readFileSync(path, 'utf8');
  const line = `> 在这里写这条出处。<!-- ${added.body.source.anchor} -->`;
  assert.ok(saved.includes(`\r\n\r\n${line}\r\n`), '新条目两侧是两个 CRLF');
  assert.equal(saved.replace(`\r\n\r\n${line}`, ''), original, '其余字节逐字不动');
  assert.equal(validate(path).code, 0, `CRLF 文档仍合规：${validate(path).stdout}`);
});
