import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// 只测公开的缝：工作台的 HTTP 命令面（打开文档 / 改一块 / 存盘）与磁盘上的文本。
// 块怎么切、锚点怎么生成是实现细节，换实现时这些断言不该跟着改。
const core = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VALIDATOR = join(core, 'scripts', 'validate-doc.mjs');
const EXAMPLES = join(core, 'contracts', 'examples');

const sandboxes = [];
after(() => { for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true }); });

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

/** 把真实样例复制进临时目录：工作台必须能在真实语料上工作，而不是只为手搓样例写的。 */
function sandboxExample(name = 'storyline.md') {
  const dir = mkdtempSync(join(tmpdir(), 'planners-workbench-'));
  sandboxes.push(dir);
  cpSync(EXAMPLES, dir, { recursive: true });
  return { dir, path: join(dir, name) };
}

const getDoc = async (url) => {
  const response = await fetch(`${url}/api/doc`);
  assert.equal(response.status, 200, `GET /api/doc 应返回 200，实际 ${response.status}`);
  return response.json();
};

const saveBlock = (url, body) => fetch(`${url}/api/block`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

const validate = (path) => {
  const result = spawnSync(process.execPath, [VALIDATOR, path], { encoding: 'utf8' });
  return { code: result.status, out: JSON.parse(result.stdout || 'null'), stdout: result.stdout, stderr: result.stderr };
};

async function openWorkbench(t, docPath, options = {}) {
  const { startDocWorkbench } = await import('../scripts/doc-workbench.mjs');
  const server = await startDocWorkbench({ docPath, port: 0, ...options });
  t.after(() => server.close());
  return server;
}

// ── 验收：同一份文档改一块、存盘、逐块对比未编辑块字节相同 ──────────────────
test('改一块后，磁盘上只有这一块的字节变化，未编辑块逐字不动', async (t) => {
  const { path } = sandboxExample();
  const original = readFileSync(path, 'utf8');
  const server = await openWorkbench(t, path);

  const before = await getDoc(server.url);
  assert.equal(before.sha256, sha256(original), '刚打开且锚点齐全时不应改写文件');
  assert.equal(before.blocks.length, 40, '样例 storyline 有 40 块');
  const target = before.blocks.find((block) => block.anchor === 'b:7b057d');
  assert.ok(target, '样例第一页的主张块应当带锚点 b:7b057d');

  const content = '主张：用 **150ml** 浓缩形态进入 *状态调节* 货架，只做 `一次一支`，见[依据](https://example.com/basis)。';
  const response = await saveBlock(server.url, { anchor: target.anchor, content, base_sha256: before.sha256 });
  const receipt = await response.json();
  assert.equal(response.status, 200, JSON.stringify(receipt));
  assert.equal(receipt.ok, true);

  const saved = readFileSync(path, 'utf8');
  assert.notEqual(saved, original, '保存后磁盘上应当有变化');
  assert.ok(saved.includes(`${content}<!-- b:7b057d -->`), '锚点应当仍然贴在块末，行内格式应当写成 Markdown');
  assert.ok(saved.includes('**150ml**') && saved.includes('*状态调节*') && saved.includes('`一次一支`')
    && saved.includes('[依据](https://example.com/basis)'), '加粗/斜体/行内代码/链接都要落成 Markdown');

  const after = await getDoc(server.url);
  const edited = after.blocks.find((block) => block.anchor === target.anchor);
  assert.equal(edited.raw, content, '改过的块 raw 等于编辑内容（锚点不算块 raw）');
  assert.equal(edited.start, target.start, '块的头尾位置不应漂移');
  assert.equal(saved.slice(0, edited.start), original.slice(0, target.start), '编辑块之前的所有字节必须原样');
  assert.equal(saved.slice(edited.end), original.slice(target.end), '编辑块之后的所有字节必须原样');

  for (const block of before.blocks) {
    if (block.anchor === target.anchor) continue;
    const untouched = after.blocks.find((item) => item.anchor === block.anchor);
    assert.ok(untouched, `未编辑块 ${block.anchor} 不应消失`);
    assert.equal(untouched.raw, block.raw, `未编辑块 ${block.anchor} 的 raw 必须逐字相同`);
  }

  const verdict = validate(path);
  assert.equal(verdict.code, 0, `保存后仍应通过契约校验：${verdict.stdout}${verdict.stderr}`);
  assert.equal(verdict.out?.checked?.anchors, 40, '保存不应增删锚点');
});

// ── 锚点：缺的补写、重复的重建，只动锚点本身 ────────────────────────────────
const FRONT = '---\ncontract: planners-doc/2\ndoc: storyline\nproject: 测试项目\n---\n\n';
const writeDoc = (dir, name, body) => {
  const path = join(dir, name);
  writeFileSync(path, `${FRONT}${body}\n`, 'utf8');
  return path;
};
const scratchDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'planners-workbench-'));
  sandboxes.push(dir);
  return dir;
};
const stripAnchors = (text) => text.replace(/\n?[ \t]*<!--\s*b:[0-9a-f]{6,12}\s*-->/g, '');

test('缺锚点的块在打开时补写，正文一个字节都不改；再打开是幂等的', async (t) => {
  const dir = scratchDir();
  const original = `${FRONT}
# 章节

## 页一

第一段，还没有锚点。

- 列表一，没有锚点
- 列表二，没有锚点

> 一段引文，没有锚点

\`\`\`
代码块，没有锚点
\`\`\`

| 元素 | 规格 |
|---|---|
| 瓶身 | 150ml |

### 小节标题，没有锚点

![示意图](assets/pic.svg)
`;
  const path = join(dir, 'storyline.md');
  mkdirSync(join(dir, 'assets'), { recursive: true });
  writeFileSync(join(dir, 'assets', 'pic.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>', 'utf8');
  writeFileSync(path, original, 'utf8');

  const server = await openWorkbench(t, path);
  const opened = await getDoc(server.url);
  assert.ok(server.repairs.length >= 8, `应当补写至少 8 个锚点，实际 ${JSON.stringify(server.repairs)}`);
  assert.equal(opened.blocks.length, 8);
  assert.ok(opened.blocks.every((block) => /^b:[0-9a-f]{6,12}$/.test(block.anchor ?? '')), '每个块都应当有锚点');
  assert.equal(new Set(opened.blocks.map((block) => block.anchor)).size, 8, '锚点必须全局唯一');

  const saved = readFileSync(path, 'utf8');
  assert.equal(stripAnchors(saved), stripAnchors(original), '补锚点只能插入注释，正文必须原样');
  assert.ok(saved.includes('第一段，还没有锚点。<!-- b:'), '段落锚点紧贴块末');
  assert.ok(saved.includes('| 瓶身 | 150ml |\n<!-- b:'), '表格锚点单独写在元素下一行');
  assert.ok(saved.includes('```\n<!-- b:'), '代码块锚点单独写在元素下一行');

  const verdict = validate(path);
  assert.equal(verdict.code, 0, `补完锚点应当合规：${verdict.stdout}${verdict.stderr}`);

  const shaBefore = opened.sha256;
  const again = await getDoc(server.url);
  assert.equal(again.sha256, shaBefore, '第二次打开不应再改写文件');
  assert.deepEqual(again.repairs, [], '第二次打开不应再补锚点');
  assert.equal(readFileSync(path, 'utf8'), saved);
});

test('重复锚点在打开时重建，第一次出现的身份保留', async (t) => {
  const dir = scratchDir();
  const path = writeDoc(dir, 'storyline.md', `

# 章节

## 页一

第一块，先出现。<!-- b:aaaaaa -->

第二块，重复了。<!-- b:aaaaaa -->

第三块，没锚点。`);
  const before = readFileSync(path, 'utf8');
  const server = await openWorkbench(t, path);
  const opened = await getDoc(server.url);
  assert.equal(server.repairs.filter((repair) => repair.action === 'rebuilt').length, 1, '应当只重建后出现的重复锚点');

  const saved = readFileSync(path, 'utf8');
  assert.ok(saved.includes('第一块，先出现。<!-- b:aaaaaa -->'), '第一次出现的锚点保留');
  assert.doesNotMatch(saved, /第二块，重复了。<!-- b:aaaaaa -->/, '后出现的重复锚点必须换掉');
  assert.equal(stripAnchors(saved), stripAnchors(before), '重建锚点不能改正文');
  assert.equal(opened.blocks.length, 3);
  assert.equal(new Set(opened.blocks.map((block) => block.anchor)).size, 3);
  assert.equal(validate(path).code, 0, '重建后应当合规');
});

// ── 超出子集：退化原文显示，不静默改写，也不允许借编辑面偷改 ─────────────────
test('超出块类型子集的写法退化为原文显示，保存被拒且磁盘不动', async (t) => {
  const dir = scratchDir();
  const path = writeDoc(dir, 'storyline.md', `

# 章节

## 页一

| 元素 | 规格 |
|---|---|
| 瓶身 |
<!-- b:aaaaaa -->

~~删除线~~ 不在行内编辑子集里。<!-- b:bbbbbb -->

<div class="callout">原始 HTML 不静默改写</div>`);
  const before = readFileSync(path, 'utf8');
  const server = await openWorkbench(t, path);
  const opened = await getDoc(server.url);

  const table = opened.blocks.find((block) => block.type === 'table');
  assert.ok(table, '表格应当仍被识别为一块');
  assert.equal(table.degraded, true, '列数不一致的表格应当退化');
  assert.equal(table.editable, false);
  assert.equal(table.raw, '| 元素 | 规格 |\n|---|---|\n| 瓶身 |', '退化时返回原文');
  assert.match(table.reason, /列数/);

  const strike = opened.blocks.find((block) => block.anchor === 'b:bbbbbb');
  assert.equal(strike.degraded, true, '删除线超出子集，应当退化');
  assert.match(strike.reason, /删除线/);

  const html = opened.blocks.find((block) => block.type === 'html');
  assert.equal(html.degraded, true, '原始 HTML 块应当退化为原文显示');

  assert.equal(readFileSync(path, 'utf8'), before, '打开退化块不应改写磁盘');

  for (const block of [table, strike]) {
    const response = await saveBlock(server.url, { anchor: block.anchor, content: '想强行改成正常段落', base_sha256: opened.sha256 });
    const receipt = await response.json();
    assert.equal(response.status, 409, JSON.stringify(receipt));
    assert.equal(receipt.code, 'block_degraded');
    assert.equal(readFileSync(path, 'utf8'), before, '被拒的保存不得留下半截写入');
  }
});

// ── 块内行内格式：DOM → Markdown 的序列化规则 ───────────────────────────────
// 页面的 contenteditable 只产出加粗/斜体/行内代码/链接这四种行内格式；
// 序列化是纯函数，用最小 DOM 形状在 Node 里测，不依赖浏览器。
const text = (value) => ({ nodeType: 3, nodeValue: value, textContent: value });
const el = (tagName, childNodes = [], attributes = {}) => ({ nodeType: 1, tagName, childNodes, ...attributes });

test('行内编辑序列化：加粗、斜体、行内代码、链接落成 Markdown', async () => {
  const { serializeInline } = await inlineModule();
  const tree = el('div', [
    text('谱系：'),
    el('strong', [text('加粗')]),
    text('、'),
    el('em', [text('斜体')]),
    text('、'),
    el('code', [text('行内代码')]),
    text('，见'),
    el('a', [text('链接')], { href: 'https://example.com/basis' }),
    text('。'),
  ]);
  assert.equal(serializeInline(tree), '谱系：**加粗**、*斜体*、`行内代码`，见[链接](https://example.com/basis)。');
});

test('行内编辑序列化：普通文本里的 Markdown 符号被转义，不改变原意', async () => {
  const { serializeInline } = await inlineModule();
  assert.equal(serializeInline(el('div', [text('5 * 3 与 snake_case 与 [草稿] 与 `反引号`')])),
    '5 \\* 3 与 snake\\_case 与 \\[草稿\\] 与 \\`反引号\\`');
  // 行首如果是块级标记，也必须转义，否则下一次打开会被切成另一种块。
  assert.equal(serializeInline(el('div', [text('# 不是标题')])), '\\# 不是标题');
  assert.equal(serializeInline(el('div', [text('- 不是列表')])), '\\- 不是列表');
  assert.equal(serializeInline(el('div', [text('1. 不是有序列表')])), '1\\. 不是有序列表');
  assert.equal(serializeInline(el('div', [text('1) 也不是')])), '1\\) 也不是');
});

test('行内编辑序列化：链接地址带空格、代码里有反引号时仍然可解析', async () => {
  const { serializeInline } = await inlineModule();
  assert.equal(serializeInline(el('div', [
    el('a', [text('带空格')], { href: 'https://example.com/a b' }),
  ])), '[带空格](<https://example.com/a b>)');
  assert.equal(serializeInline(el('div', [el('code', [text('a ` b')])])), '``a ` b``');
});

test('行内编辑序列化：粘贴进来的未知行内标签只保留文字，不写出 HTML', async () => {
  const { serializeInline } = await inlineModule();
  assert.equal(serializeInline(el('div', [el('span', [text('纯文字')])])), '纯文字');
  assert.equal(serializeInline(el('div', [el('br')])), '\\\n', '换行写成 Markdown 硬换行，不写成 HTML');
});

async function dragModule() {
  const module = await import('../assets/workbench/doc-drag.js');
  return module.default ?? module;
}

async function inlineModule() {
  const module = await import('../assets/workbench/doc-inline.js');
  return module.default ?? module;
}

// ── 渲染面：块级就地编辑，不是弹 Markdown 文本框 ─────────────────────────────
test('工作台页面按块就地编辑，带四种行内格式按钮，没有 Markdown 文本框', () => {
  const page = readFileSync(join(core, 'assets', 'workbench', 'doc-workbench.js'), 'utf8');
  const html = readFileSync(join(core, 'assets', 'workbench', 'doc-workbench.html'), 'utf8');
  assert.match(page, /data-anchor/, '块要带锚点身份');
  assert.match(page, /contentEditable\s*=\s*'true'/, '块内容用 contenteditable 就地编辑');
  assert.doesNotMatch(page, /createElement\(['"]textarea['"]\)/, '块编辑不能退回 Markdown 文本框');
  // 页面上唯一的文本框是块级反馈的意见框；块本身仍是就地排版，不是 Markdown 编辑器。
  assert.equal((html.match(/<textarea\b/gi) ?? []).length, 1, '只留一个反馈意见框');
  assert.match(html, /<textarea[^>]*id="feedbackText"/, '反馈意见框不算块编辑器');
  assert.match(page, /DocInline\.serialize/, '保存时把行内 DOM 序列化成块 raw');
  for (const command of ['bold', 'italic', 'code', 'link']) {
    assert.match(page, new RegExp(`data-inline="${command}"`), `缺少行内格式按钮 ${command}`);
  }
  assert.match(page, /execCommand\(['"]bold['"]\)/, '加粗走浏览器行内命令');
  assert.match(page, /execCommand\(['"]italic['"]\)/, '斜体走浏览器行内命令');
  assert.match(page, /execCommand\(['"]createLink['"]/, '链接走浏览器行内命令');
  assert.match(page, /data-degraded/, '退化块要有原文显示的标记');
  assert.match(page, /saveState/, '保存状态要给人看');
});

// ── 保真：表格对齐、代码围栏、图片 title 在改别的块时逐字保留 ────────────────
test('改一段话时，表格对齐、代码块、图片 title 都不动', async (t) => {
  const dir = scratchDir();
  mkdirSync(join(dir, 'assets'), { recursive: true });
  writeFileSync(join(dir, 'assets', 'pic.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>', 'utf8');
  const path = writeDoc(dir, 'storyline.md', `

# 章节

## 页一

这一段会被改。<!-- b:aaaaaa -->

| 元素 | 规格 | 说明 |
|:---|:---:|---:|
| 瓶身 | 150ml | 一手可握 |
<!-- b:bbbbbb -->

\`\`\`text
这里 的   空格
  和缩进都不能动
\`\`\`
<!-- b:cccccc -->

![示意图](assets/pic.svg "保留的 title")
<!-- b:dddddd -->`);
  const server = await openWorkbench(t, path);
  const before = await getDoc(server.url);
  const target = before.blocks.find((block) => block.anchor === 'b:aaaaaa');

  const response = await saveBlock(server.url, {
    anchor: target.anchor,
    content: '这一段**改过了**，保留 *行内格式*。',
    base_sha256: before.sha256,
  });
  const receipt = await response.json();
  assert.equal(response.status, 200, JSON.stringify(receipt));

  const saved = readFileSync(path, 'utf8');
  const after = await getDoc(server.url);
  for (const anchor of ['b:bbbbbb', 'b:cccccc', 'b:dddddd']) {
    const prior = before.blocks.find((block) => block.anchor === anchor);
    const next = after.blocks.find((block) => block.anchor === anchor);
    assert.equal(next.raw, prior.raw, `未编辑块 ${anchor} 的 raw 必须逐字相同`);
  }
  assert.ok(saved.includes('|:---|:---:|---:|'), '表格对齐行原样保留');
  assert.ok(saved.includes('\`\`\`text\n这里 的   空格\n  和缩进都不能动\n\`\`\`'), '代码块内部空白原样保留');
  assert.ok(saved.includes('![示意图](assets/pic.svg "保留的 title")'), '图片 title 原样保留');
  assert.equal(validate(path).code, 0, '改完仍应通过契约校验');
});

// ── 保存边界：只换内容，不换块身份与结构 ─────────────────────────────────────
test('借编辑面改块结构、改类型或提交过期基线都会被拒，磁盘不动', async (t) => {
  const dir = scratchDir();
  const path = writeDoc(dir, 'storyline.md', `

# 章节

## 页一

第一段，只允许换内容。<!-- b:aaaaaa -->`);
  const before = readFileSync(path, 'utf8');
  const server = await openWorkbench(t, path);
  const opened = await getDoc(server.url);

  const attempt = async (body) => {
    const response = await saveBlock(server.url, body);
    return { status: response.status, body: await response.json() };
  };

  const split = await attempt({ anchor: 'b:aaaaaa', content: '第一段\n\n第二段', base_sha256: opened.sha256 });
  assert.equal(split.status, 409, JSON.stringify(split.body));
  assert.equal(split.body.code, 'block_structure', '空行会把一块变成两块，必须拒绝');

  const retype = await attempt({ anchor: 'b:aaaaaa', content: '- 变成列表', base_sha256: opened.sha256 });
  assert.equal(retype.status, 409, JSON.stringify(retype.body));
  assert.equal(retype.body.code, 'block_structure', '改块类型必须拒绝');

  const empty = await attempt({ anchor: 'b:aaaaaa', content: '   ', base_sha256: opened.sha256 });
  assert.equal(empty.status, 409, JSON.stringify(empty.body));
  assert.equal(empty.body.code, 'block_empty');

  const stale = await attempt({ anchor: 'b:aaaaaa', content: '第一段，改过。', base_sha256: '0'.repeat(64) });
  assert.equal(stale.status, 409, JSON.stringify(stale.body));
  assert.equal(stale.body.code, 'stale_document', '过期基线不能覆盖别处的新版本');

  assert.equal(readFileSync(path, 'utf8'), before, '被拒绝的请求都不能留下写入');
});

// ── 重排：拖动块与页走一个显式操作，未参与重排的块逐字不动 ──────────────────
// 重排是**另一个**操作：`applyBlockContent` 仍然只换内容、不许换类型与顺序，
// 序的变化只能从这里来（anchor + base_sha256 + 目标位置，一次一个动作）。
const reorder = (url, body) => fetch(`${url}/api/reorder`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

const ANCHOR_COMMENTS = /<!-- b:[0-9a-f]{6,12} -->/g;

test('页内拖动：块在同一页里换位置，其他块逐字不动，页与章节不变', async (t) => {
  const { path } = sandboxExample();
  const original = readFileSync(path, 'utf8');
  const server = await openWorkbench(t, path);
  const before = await getDoc(server.url);

  const page = before.pages.find((item) => item.chapterIndex === 1 && item.index === 1);
  assert.ok(page, '样例应当有第 1 章第 1 页');
  const onPage = before.blocks.filter((block) => block.page.key === page.key);
  const [first, second, third] = onPage;
  assert.ok(third, '第 1 页至少有三块，才能测页内换位');

  const response = await reorder(server.url, {
    op: 'move-block',
    base_sha256: before.sha256,
    anchor: third.anchor,
    to: { chapter: 1, index: 1, before: second.anchor },
  });
  const receipt = await response.json();
  assert.equal(response.status, 200, JSON.stringify(receipt));
  assert.equal(receipt.ok, true, JSON.stringify(receipt));

  const after = await getDoc(server.url);
  const order = after.blocks.filter((block) => block.page.key === page.key).map((block) => block.anchor);
  assert.deepEqual(order.slice(0, 3), [first.anchor, third.anchor, second.anchor], '被拖的块要插到第二块之前');

  assert.equal(after.blocks.length, before.blocks.length, '重排不增删块');
  assert.deepEqual(
    after.blocks.map((block) => block.anchor).sort(),
    before.blocks.map((block) => block.anchor).sort(),
    '重排不换块身份',
  );
  for (const block of before.blocks) {
    const now = after.blocks.find((item) => item.anchor === block.anchor);
    assert.ok(now, `块 ${block.anchor} 不应消失`);
    assert.equal(now.raw, block.raw, `块 ${block.anchor} 的 raw 必须逐字相同`);
    assert.equal(now.page.key, block.page.key, `块 ${block.anchor} 仍应在原来那一页`);
  }
  assert.deepEqual(after.pages.map((item) => item.key), before.pages.map((item) => item.key), '页序不变');

  const saved = readFileSync(path, 'utf8');
  assert.notEqual(saved, original, '重排后磁盘上应当有变化');
  const headings = (text) => text.split('\n').filter((line) => /^#{1,2} /.test(line));
  assert.deepEqual(headings(saved), headings(original), '章节与页标题行原样，只挪块');
  assert.equal((saved.match(ANCHOR_COMMENTS) ?? []).length, 40, '锚点一个不增一个不减');

  const verdict = validate(path);
  assert.equal(verdict.code, 0, `重排后仍应通过契约校验：${verdict.stdout}${verdict.stderr}`);
  assert.equal(verdict.out?.checked?.anchors, 40);
});

test('跨页拖动：块落到另一章的页里，归属跟着目标页，页序与锚点都不变', async (t) => {
  const { path } = sandboxExample();
  const server = await openWorkbench(t, path);
  const before = await getDoc(server.url);

  const sourcePage = before.pages.find((page) => page.chapterIndex === 1 && page.index === 1);
  const targetPage = before.pages.find((page) => page.chapterIndex === 2 && page.index === 1);
  assert.ok(sourcePage && targetPage, '样例应当有一、二两章，各有多页');
  const moving = before.blocks.filter((block) => block.page.key === sourcePage.key)[1];
  const landing = before.blocks.filter((block) => block.page.key === targetPage.key)[0];

  const response = await reorder(server.url, {
    op: 'move-block',
    base_sha256: before.sha256,
    anchor: moving.anchor,
    to: { chapter: 2, index: 1, before: landing.anchor },
  });
  const receipt = await response.json();
  assert.equal(response.status, 200, JSON.stringify(receipt));

  const after = await getDoc(server.url);
  const moved = after.blocks.find((block) => block.anchor === moving.anchor);
  assert.equal(moved.raw, moving.raw, '跨页移动不改这一块的 raw');
  assert.equal(moved.page.key, targetPage.key, '块要落在目标页');
  assert.equal(moved.page.chapter, targetPage.chapter, '章节归属跟着目标页');
  const order = after.blocks.filter((block) => block.page.key === targetPage.key).map((block) => block.anchor);
  assert.deepEqual(order.slice(0, 2), [moving.anchor, landing.anchor], '插在目标页第一块之前');

  const sourceAfter = after.blocks.filter((block) => block.page.key === sourcePage.key);
  assert.equal(sourceAfter.length, before.blocks.filter((block) => block.page.key === sourcePage.key).length - 1);
  assert.ok(sourceAfter.length > 0, '源页不能因为跨页拖动变空');
  assert.deepEqual(after.pages.map((page) => page.key), before.pages.map((page) => page.key), '页序不变');
  assert.deepEqual(
    after.pages.map((page) => `${page.chapterIndex}:${page.index}:${page.title}`),
    before.pages.map((page) => `${page.chapterIndex}:${page.index}:${page.title}`),
    '页的边界与归属都没有挪动，只是块换了页',
  );
  for (const block of before.blocks) {
    assert.equal(after.blocks.find((item) => item.anchor === block.anchor)?.raw, block.raw, `块 ${block.anchor} 逐字不变`);
  }

  const verdict = validate(path);
  assert.equal(verdict.code, 0, `跨页拖动后仍应合规：${verdict.stdout}${verdict.stderr}`);
  assert.equal(verdict.out?.checked?.anchors, 40);
  assert.equal((readFileSync(path, 'utf8').match(ANCHOR_COMMENTS) ?? []).length, 40);
});

test('页重排：拖页标题把整页连块移到另一章，页号按新顺序重排', async (t) => {
  const { path } = sandboxExample();
  const server = await openWorkbench(t, path);
  const before = await getDoc(server.url);

  const movingPage = before.pages.find((page) => page.chapterIndex === 1 && page.index === 3);
  const landingPage = before.pages.find((page) => page.chapterIndex === 2 && page.index === 1);
  assert.ok(movingPage && landingPage, '样例有一章三页、二章三页');
  const movingBlocks = before.blocks.filter((block) => block.page.key === movingPage.key);
  assert.ok(movingBlocks.length > 2, '整页移动要连着一串块一起搬');

  const response = await reorder(server.url, {
    op: 'move-page',
    base_sha256: before.sha256,
    page: { chapter: 1, index: 3 },
    to: { chapter: 2, index: 1, position: 'before' },
  });
  const receipt = await response.json();
  assert.equal(response.status, 200, JSON.stringify(receipt));
  assert.equal(receipt.ok, true);
  assert.equal(receipt.changed, true);

  const after = await getDoc(server.url);
  assert.equal(after.pages.length, before.pages.length, '整页移动不增删页');
  const movedPage = after.pages.find((page) => page.title === movingPage.title);
  assert.equal(movedPage.chapter, '二、主线', '页要归到落点所在的章节');
  assert.equal(movedPage.chapterIndex, 2);
  assert.equal(movedPage.index, 1, '页号按新顺序重排：它成了二章第一页');
  // 页号 = 顺序：每章各自从 1 数，连续无洞。
  const counts = after.pages.reduce((all, page) => ({ ...all, [page.chapterIndex]: (all[page.chapterIndex] ?? 0) + 1 }), {});
  assert.deepEqual(counts, { 1: 2, 2: 4, 3: 2 }, '一章少一页、二章多一页，其余章节不变');
  assert.deepEqual(after.pages.map((page) => page.index), [1, 2, 1, 2, 3, 4, 1, 2], '页号按新顺序重排');
  const expectedTitles = before.pages.map((page) => page.title).filter((title) => title !== movingPage.title);
  expectedTitles.splice(expectedTitles.indexOf(landingPage.title), 0, movingPage.title);
  assert.deepEqual(after.pages.map((page) => page.title), expectedTitles, '页序与落点一致');
  assert.deepEqual(
    after.blocks.filter((block) => block.page.key === movedPage.key).map((block) => block.anchor),
    movingBlocks.map((block) => block.anchor),
    '整页的块连顺序一起搬过去',
  );

  assert.equal(after.blocks.length, before.blocks.length);
  for (const block of before.blocks) {
    assert.equal(after.blocks.find((item) => item.anchor === block.anchor)?.raw, block.raw, `块 ${block.anchor} 逐字不变`);
  }
  const saved = readFileSync(path, 'utf8');
  assert.equal((saved.match(ANCHOR_COMMENTS) ?? []).length, 40);
  const verdict = validate(path);
  assert.equal(verdict.code, 0, `整页移动后仍应合规：${verdict.stdout}${verdict.stderr}`);
  assert.equal(verdict.out?.checked?.chapters, 3, '章节数不变');
});

test('重排的边界：空页、空章节、过期基线、坏落点都被拒，磁盘不动', async (t) => {
  const dir = scratchDir();
  const path = writeDoc(dir, 'storyline.md', `

# 甲

## 页一

块一。<!-- b:aaaaaa -->

# 乙

## 页二

块二。<!-- b:bbbbbb -->

## 页三

块三。<!-- b:cccccc -->

# 丙

## 页四

块四。<!-- b:dddddd -->`);
  const before = readFileSync(path, 'utf8');
  const server = await openWorkbench(t, path);
  const opened = await getDoc(server.url);

  const attempt = async (body) => {
    const response = await reorder(server.url, body);
    return { status: response.status, body: await response.json() };
  };

  const lastBlock = await attempt({
    op: 'move-block', base_sha256: opened.sha256, anchor: 'b:aaaaaa',
    to: { chapter: 2, index: 1, before: null },
  });
  assert.equal(lastBlock.status, 409, JSON.stringify(lastBlock.body));
  assert.equal(lastBlock.body.code, 'page_would_be_empty', '把页里最后一块移走会让页变空，必须拒绝');

  const lastPage = await attempt({
    op: 'move-page', base_sha256: opened.sha256, page: { chapter: 1, index: 1 },
    to: { chapter: 2, index: 1, position: 'before' },
  });
  assert.equal(lastPage.status, 409, JSON.stringify(lastPage.body));
  assert.equal(lastPage.body.code, 'chapter_would_be_empty', '把章节里最后一页移走会让章节变空，必须拒绝');

  const stale = await attempt({
    op: 'move-block', base_sha256: '0'.repeat(64), anchor: 'b:bbbbbb',
    to: { chapter: 2, index: 1, before: null },
  });
  assert.equal(stale.status, 409, JSON.stringify(stale.body));
  assert.equal(stale.body.code, 'stale_document', '过期基线不能盖掉别处的新版本');

  const missingTarget = await attempt({
    op: 'move-block', base_sha256: opened.sha256, anchor: 'b:bbbbbb',
    to: { chapter: 2, index: 1, before: 'b:ffffff' },
  });
  assert.equal(missingTarget.status, 409, JSON.stringify(missingTarget.body));
  assert.equal(missingTarget.body.code, 'reorder_target', '目标页里没有这块就不猜，直接拒');

  const missingPage = await attempt({
    op: 'move-page', base_sha256: opened.sha256, page: { chapter: 1, index: 1 },
    to: { chapter: 9, index: 1, position: 'before' },
  });
  assert.equal(missingPage.status, 409, JSON.stringify(missingPage.body));
  assert.equal(missingPage.body.code, 'page_missing');

  const unknownOp = await attempt({ op: 'swap-all', base_sha256: opened.sha256 });
  assert.equal(unknownOp.status, 400, JSON.stringify(unknownOp.body));
  assert.equal(unknownOp.body.code, 'reorder_op', '重排只接受两个显式动作');

  assert.equal(readFileSync(path, 'utf8'), before, '被拒绝的重排都不能留下写入');

  // 落回原位不是修改：仍回 200，但磁盘一个字节都不动。
  const samePlace = await attempt({
    op: 'move-block', base_sha256: opened.sha256, anchor: 'b:bbbbbb',
    to: { chapter: 2, index: 1, before: null },
  });
  assert.equal(samePlace.status, 200, JSON.stringify(samePlace.body));
  assert.equal(samePlace.body.changed, false, '原位落回不算一次重排');
  assert.equal(readFileSync(path, 'utf8'), before, '原位落回不重写文件');

  // 页序不变、只是跨过 # 章节标题换了归属：这是一次真实移动，不是空操作。
  const changeChapter = await attempt({
    op: 'move-page', base_sha256: opened.sha256, page: { chapter: 2, index: 2 },
    to: { chapter: 3, index: 1, position: 'before' },
  });
  assert.equal(changeChapter.status, 200, JSON.stringify(changeChapter.body));
  assert.equal(changeChapter.body.changed, true, '跨章节标题换归属要真的搬过去');
  const after = await getDoc(server.url);
  const movedByChapter = after.pages.find((page) => page.title === '页三');
  assert.equal(movedByChapter.chapter, '丙', '跨过章节标题后归到下一章');
  assert.equal(movedByChapter.index, 1, '在丙章里排第一页');
  assert.deepEqual(after.pages.map((page) => page.title), ['页一', '页二', '页三', '页四'], '文档顺序不变');
  assert.equal(validate(path).code, 0);
});

test('重排保真：图片、表格、代码块整块跟着走，块 raw 一个字都不变', async (t) => {
  const { path } = sandboxExample('by-page.md');
  const server = await openWorkbench(t, path);
  const before = await getDoc(server.url);

  const image = before.blocks.find((block) => block.type === 'image');
  const table = before.blocks.find((block) => block.type === 'table');
  const code = before.blocks.find((block) => block.type === 'code');
  assert.ok(image && table && code, '样例应当同时有图片、表格、代码块');
  const targetPage = before.pages.find((page) => page.key !== code.page.key);
  const landing = before.blocks.find((block) => block.page.key === targetPage.key);

  const response = await reorder(server.url, {
    op: 'move-block', base_sha256: before.sha256, anchor: code.anchor,
    to: { chapter: targetPage.chapterIndex, index: targetPage.index, before: landing.anchor },
  });
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));

  const after = await getDoc(server.url);
  for (const anchor of [image.anchor, table.anchor, code.anchor]) {
    assert.equal(after.blocks.find((block) => block.anchor === anchor)?.raw,
      before.blocks.find((block) => block.anchor === anchor)?.raw,
      `块 ${anchor} 的 raw 逐字不变`);
  }
  const movedCode = after.blocks.find((block) => block.anchor === code.anchor);
  assert.equal(movedCode.page.key, targetPage.key, '代码块整块落到目标页');
  assert.match(movedCode.raw, /^```text\n[\s\S]*```$/, '围栏与内部缩进原样');
  const saved = readFileSync(path, 'utf8');
  assert.ok(saved.includes(`${code.raw}\n<!-- ${code.anchor} -->`), '独立块的锚点仍单独跟在元素下一行');
  for (const block of before.blocks) {
    assert.equal(after.blocks.find((item) => item.anchor === block.anchor)?.raw, block.raw, `块 ${block.anchor} 逐字不变`);
  }
  const verdict = validate(path);
  assert.equal(verdict.code, 0, `重排后仍应合规：${verdict.stdout}${verdict.stderr}`);
});

// ── 拖动与目录：六点句柄、可拖的页标题、两级目录、Alt+↑↓ ─────────────────────
test('落点算法：拖动时算出「插到哪两块之间」，页落点区分「本页之后」与「下一章之前」', async () => {
  const { blockGaps, pageGaps, nearestGap } = await dragModule();

  const items = [
    { anchor: 'b:aaaaaa', page: '1-1', top: 100, bottom: 120 },
    { anchor: 'b:bbbbbb', page: '1-1', top: 140, bottom: 160 },
    { anchor: 'b:cccccc', page: '1-2', top: 220, bottom: 240 },
  ];
  const gaps = blockGaps(items);
  assert.deepEqual(
    gaps.map((gap) => [gap.y, gap.page, gap.before]),
    [[100, '1-1', 'b:aaaaaa'], [130, '1-1', 'b:bbbbbb'], [160, '1-1', null], [220, '1-2', 'b:cccccc'], [240, '1-2', null]],
    '每块的上下沿之间都是落点；页尾的落点是本页末尾（before: null）',
  );
  assert.deepEqual(pick(nearestGap(gaps, 90)), { page: '1-1', before: 'b:aaaaaa' }, '拖到第一块上方 → 插到它之前');
  assert.deepEqual(pick(nearestGap(gaps, 125)), { page: '1-1', before: 'b:bbbbbb' }, '拖到两块之间 → 插到下一块之前');
  assert.deepEqual(pick(nearestGap(gaps, 165)), { page: '1-1', before: null }, '拖到页末 → 成为本页最后一块');
  assert.deepEqual(pick(nearestGap(gaps, 232)), { page: '1-2', before: null }, '拖到另一页的最后一块下方 → 落在那一页末尾');

  const pages = [
    { key: '1-1', chapterIndex: 1, top: 100, bottom: 160 },
    { key: '1-2', chapterIndex: 1, top: 200, bottom: 260 },
    { key: '2-1', chapterIndex: 2, top: 320, bottom: 380 },
  ];
  const pageGapList = pageGaps(pages);
  assert.deepEqual(
    new Set(pageGapList.map((gap) => `${gap.page}:${gap.position}`)),
    new Set(['1-1:before', '1-1:after', '1-2:before', '1-2:after', '2-1:before', '2-1:after']),
    '每一页都有「之前 / 之后」两个页落点',
  );
  assert.deepEqual(pick(nearestGap(pageGapList, 90)), { page: '1-1', position: 'before' }, '拖到最前 → 成为第一页');
  assert.deepEqual(pick(nearestGap(pageGapList, 155)), { page: '1-1', position: 'after' }, '在页末拖 → 留在这一页之后，不换章');
  assert.deepEqual(pick(nearestGap(pageGapList, 310)), { page: '2-1', position: 'before' }, '越过 # 章节标题 → 进下一章第一页之前');
  assert.deepEqual(pick(nearestGap(pageGapList, 400)), { page: '2-1', position: 'after' }, '拖到整份最后 → 成为最后一页');

  function pick(gap) {
    const { y, ...rest } = gap;
    return rest;
  }

  const { stepGap } = await dragModule();
  const flat = [
    { anchor: 'b:aaaaaa', page: { key: '1-1' } },
    { anchor: 'b:bbbbbb', page: { key: '1-1' } },
    { anchor: 'b:cccccc', page: { key: '1-1' } },
    { anchor: 'b:dddddd', page: { key: '1-1' } },
    { anchor: 'b:eeeeee', page: { key: '1-2' } },
  ];
  assert.deepEqual(stepGap(flat, 1, 'up'), { page: '1-1', before: 'b:aaaaaa' }, 'Alt+↑ 插到上一块之前');
  assert.deepEqual(stepGap(flat, 1, 'down'), { page: '1-1', before: 'b:dddddd' }, 'Alt+↓ 要越过下一块，不是插回原位');
  assert.deepEqual(stepGap(flat, 2, 'down'), { page: '1-1', before: null }, '下一块是本页最后一块 → 挪到页末');
  assert.deepEqual(stepGap(flat, 2, 'up'), { page: '1-1', before: 'b:bbbbbb' });
  assert.equal(stepGap(flat, 0, 'up'), null, '第一块没有上方可去');
  assert.equal(stepGap(flat, 4, 'down'), null, '最后一块没有下方可去');
});

test('工作台源码：六点句柄、页标题可拖、两级目录随滚动高亮、Alt+↑↓ 走同一条重排接口', async () => {
  const page = readFileSync(join(core, 'assets', 'workbench', 'doc-workbench.js'), 'utf8');
  const html = readFileSync(join(core, 'assets', 'workbench', 'doc-workbench.html'), 'utf8');
  const drag = readFileSync(join(core, 'assets', 'workbench', 'doc-drag.js'), 'utf8');
  const css = readFileSync(join(core, 'assets', 'workbench', 'doc-workbench.css'), 'utf8');

  assert.match(html, /id="toc"/, '目录要在左侧栏里');
  assert.match(html, /doc-drag\.js/, '拖动逻辑单独一份，页面要加载它');
  assert.match(drag, /block-handle/, '块前缀要有六点句柄');
  assert.match(drag, /viewBox="0 0 8 14"/, '句柄是六个点，不是随便一个图标');
  assert.match(drag, /draggable/, '句柄与页标题都要能拖');
  assert.match(drag, /dragstart/);
  assert.match(drag, /dragover/);
  assert.match(drag, /drop-line/, '落点要有一条提示线');
  assert.match(drag, /hooks\.reorder\(/, '拖动与 Alt+↑↓ 都走同一个显式重排接口');
  assert.match(drag, /altKey/);
  assert.match(drag, /ArrowUp/);
  assert.match(drag, /ArrowDown/);
  assert.match(drag, /toc-chapter/, '目录两级：章节');
  assert.match(drag, /toc-page/, '目录两级：页');
  assert.match(drag, /addEventListener\('scroll'/, '滚动要更新当前页');
  assert.match(drag, /aria-current/, '当前页要有可读状态');
  assert.match(page, /dataset\.pageKey/, '页标题渲染时要带页身份，目录才能跳转');
  assert.match(drag, /data-page-key/, '目录与落点按页身份定位，不按页号猜');
  assert.match(page, /DocDrag\.render/, '每次重画正文后目录与句柄要跟着重画');
  assert.match(css, /\.toc/, '目录要有左侧栏样式');
});

// ── 锁定与待核对：不可编辑的块也不可拖动（SPEC 第 5 节） ─────────────────────
const postJson = (url, path, body) => fetch(`${url}${path}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

test('被模型锁住的块不能被拖动：块与整页重排都被拒，解锁后同一动作可做', async (t) => {
  const dir = scratchDir();
  const path = writeDoc(dir, 'storyline.md', `

# 甲

## 页一

块一。<!-- b:aaaaaa -->

## 页二

块二。<!-- b:bbbbbb -->

块五。<!-- b:eeeeee -->

# 乙

## 页三

块三。<!-- b:cccccc -->`);
  const original = readFileSync(path, 'utf8');
  const server = await openWorkbench(t, path);
  const opened = await getDoc(server.url);

  const feedback = await postJson(server.url, '/api/feedback', {
    scope: 'blocks', anchors: ['b:bbbbbb'], text: '模型改这一块。',
  });
  const task = await feedback.json();
  assert.equal(feedback.status, 200, JSON.stringify(task));
  const claim = await postJson(server.url, '/api/task/claim', { task_id: task.task.id });
  assert.equal(claim.status, 200, '模型应当拿到这一块的锁');

  const moveBlock = await reorder(server.url, {
    op: 'move-block', base_sha256: opened.sha256, anchor: 'b:bbbbbb',
    to: { chapter: 1, index: 2, before: null },
  });
  const blockBody = await moveBlock.json();
  assert.equal(moveBlock.status, 409, JSON.stringify(blockBody));
  assert.equal(blockBody.code, 'block_locked', '锁定块不能被拖动');

  const movePage = await reorder(server.url, {
    op: 'move-page', base_sha256: opened.sha256, page: { chapter: 1, index: 2 },
    to: { chapter: 2, index: 1, position: 'before' },
  });
  const pageBody = await movePage.json();
  assert.equal(movePage.status, 409, JSON.stringify(pageBody));
  assert.equal(pageBody.code, 'block_locked', '页里有锁定块时整页也不能拖');
  assert.equal(readFileSync(path, 'utf8'), original, '被拒绝的重排不能留下写入');

  const complete = await postJson(server.url, '/api/task/complete', { task_id: task.task.id });
  assert.equal(complete.status, 200, '完成后再试同一动作');
  const unlocked = await getDoc(server.url);
  const retry = await reorder(server.url, {
    op: 'move-page', base_sha256: unlocked.sha256, page: { chapter: 1, index: 2 },
    to: { chapter: 2, index: 1, position: 'before' },
  });
  const retryBody = await retry.json();
  assert.equal(retry.status, 200, JSON.stringify(retryBody));
  assert.equal(retryBody.ok, true);
  assert.equal(retryBody.changed, true, '解锁后同一动作应当真的执行');
});

test('待核对的块也不能被拖动，裁决后才恢复', async (t) => {
  const dir = scratchDir();
  const path = writeDoc(dir, 'storyline.md', `

# 甲

## 页一

块一。<!-- b:aaaaaa -->

## 页二

块二。<!-- b:bbbbbb -->

块五。<!-- b:eeeeee -->

# 乙

## 页三

块三。<!-- b:cccccc -->`);
  const server = await openWorkbench(t, path);
  const opened = await getDoc(server.url);

  const feedback = await postJson(server.url, '/api/feedback', {
    scope: 'blocks', anchors: ['b:bbbbbb'], text: '模型改这一块。',
  });
  const task = (await feedback.json()).task;
  const human = await saveBlock(server.url, {
    anchor: 'b:bbbbbb', content: '人改过的。', base_sha256: opened.sha256,
  });
  assert.equal(human.status, 200, '任务还没被取走，人可以先改这一块');
  const claimed = await postJson(server.url, '/api/task/claim', { task_id: task.id });
  assert.equal(claimed.status, 200);
  const patched = await postJson(server.url, '/api/patch', {
    task_id: task.id, patches: [{ anchor: 'b:bbbbbb', content: '模型版。' }],
  });
  const patchBody = await patched.json();
  assert.deepEqual(patchBody.deferred_blocks.map((item) => item.anchor), ['b:bbbbbb'], '旧基线写回只让这一块待核对');
  const afterHuman = readFileSync(path, 'utf8');
  const openedNow = await getDoc(server.url);

  const moveBlock = await reorder(server.url, {
    op: 'move-block', base_sha256: openedNow.sha256, anchor: 'b:bbbbbb',
    to: { chapter: 1, index: 2, before: null },
  });
  const blockBody = await moveBlock.json();
  assert.equal(moveBlock.status, 409, JSON.stringify(blockBody));
  assert.equal(blockBody.code, 'block_locked', '待核对块也不能被拖动');

  const movePage = await reorder(server.url, {
    op: 'move-page', base_sha256: openedNow.sha256, page: { chapter: 1, index: 2 },
    to: { chapter: 2, index: 1, position: 'before' },
  });
  assert.equal(movePage.status, 409, '页里有待核对块时整页也不能拖');
  assert.equal(readFileSync(path, 'utf8'), afterHuman, '被拒绝的重排不能留下写入');

  const decided = await postJson(server.url, '/api/conflict/decide', { anchor: 'b:bbbbbb', decision: 'mine' });
  assert.equal(decided.status, 200, '裁决后解锁');
  const afterDecide = await getDoc(server.url);
  const retry = await reorder(server.url, {
    op: 'move-block', base_sha256: afterDecide.sha256, anchor: 'b:bbbbbb',
    to: { chapter: 1, index: 2, before: null },
  });
  const retryBody = await retry.json();
  assert.equal(retry.status, 200, JSON.stringify(retryBody));
  assert.equal(retryBody.changed, true, '裁决后同一动作应当真的执行');
});

// ── 历史：每次写盘前存上一版，恢复是一次新编辑（SPEC 第 4 节） ───────────────
const historyOf = async (url) => {
  const response = await fetch(`${url}/api/history`);
  assert.equal(response.status, 200, 'GET /api/history 应返回 200');
  return response.json();
};

const restoreFrom = (url, body) => postJson(url, '/api/history/restore', body);
const pause = () => new Promise((done) => setTimeout(done, 5));

test('历史按次记录：每次写盘前把上一版存档，列出时间、指纹与摘要', async (t) => {
  const dir = scratchDir();
  const path = writeDoc(dir, 'storyline.md', `

# 甲

## 页一

原句。<!-- b:aaaaaa -->`);
  const original = readFileSync(path, 'utf8');
  const server = await openWorkbench(t, path);
  const opened = await getDoc(server.url);

  const first = await saveBlock(server.url, { anchor: 'b:aaaaaa', content: '第二版。', base_sha256: opened.sha256 });
  const firstBody = await first.json();
  assert.equal(first.status, 200, JSON.stringify(firstBody));
  const afterFirst = readFileSync(path, 'utf8');
  await pause();
  const second = await saveBlock(server.url, { anchor: 'b:aaaaaa', content: '第三版。', base_sha256: firstBody.sha256 });
  assert.equal(second.status, 200);
  const afterSecond = readFileSync(path, 'utf8');

  const listed = await historyOf(server.url);
  assert.equal(listed.ok, true);
  assert.equal(listed.contract, 'planners-doc-history/1');
  assert.equal(listed.versions.length, 2, '两次写盘应当留下两版历史：原稿与第二版');
  assert.equal(listed.versions[0].sha256, sha256(afterFirst), '新的在前：第二版被第三版取代时存档');
  assert.equal(listed.versions[1].sha256, sha256(original), '最早一版是打开前的原稿');
  for (const version of listed.versions) {
    assert.match(version.id, /^\d{4}-\d{2}-\d{2}T[\d-]+Z-[0-9a-f]{8}-[0-9a-f]{6}$/, '历史 id 是时间 + 指纹');
    assert.equal(version.bytes > 0, true, '列表要给出字节数');
    assert.match(version.archived_at, /Z$/);
    assert.equal(typeof version.preview, 'string');
  }
  assert.ok(listed.versions[0].preview.includes('第二版'), `摘要应来自上一版正文：${listed.versions[0].preview}`);

  const historyDir = join(dir, '.doc-workbench', 'history', 'storyline.md');
  assert.equal(readdirSync(historyDir).length, 2, '一版一个文件，按次存档');
  assert.notEqual(afterSecond, afterFirst);
});

test('历史恢复是一次新编辑：旧档不删，过期基线与锁定期间都被拒', async (t) => {
  const dir = scratchDir();
  const path = writeDoc(dir, 'storyline.md', `

# 甲

## 页一

原句。<!-- b:aaaaaa -->`);
  const original = readFileSync(path, 'utf8');
  const server = await openWorkbench(t, path);
  const opened = await getDoc(server.url);
  const first = await saveBlock(server.url, { anchor: 'b:aaaaaa', content: '第二版。', base_sha256: opened.sha256 });
  const firstBody = await first.json();
  await pause();
  const second = await saveBlock(server.url, { anchor: 'b:aaaaaa', content: '第三版。', base_sha256: firstBody.sha256 });
  assert.equal(second.status, 200);
  const afterSecond = readFileSync(path, 'utf8');

  const before = await historyOf(server.url);
  const oldest = before.versions.at(-1);
  assert.equal(oldest.sha256, sha256(original));
  const current = await getDoc(server.url);
  const restored = await restoreFrom(server.url, { id: oldest.id, base_sha256: current.sha256 });
  const restoredBody = await restored.json();
  assert.equal(restored.status, 200, JSON.stringify(restoredBody));
  assert.equal(restoredBody.ok, true);
  assert.equal(restoredBody.changed, true, '恢复要真的落一次盘');
  assert.equal(restoredBody.restored, oldest.id);
  assert.equal(readFileSync(path, 'utf8'), original, '磁盘回到被恢复的那一版');

  const after = await historyOf(server.url);
  assert.equal(after.versions.length, 3, '恢复本身也按次存档，旧档一个不删');
  assert.equal(after.versions[0].operation, 'restore', '恢复作为一次新编辑记录');
  assert.equal(after.versions[0].sha256, sha256(afterSecond), '恢复前的那一版被存了下来');
  assert.ok(after.versions.some((version) => version.id === oldest.id), '被恢复的旧档仍在列表里');

  const beforeBytes = readFileSync(path, 'utf8');
  const stale = await restoreFrom(server.url, { id: after.versions[1].id, base_sha256: '0'.repeat(64) });
  const staleBody = await stale.json();
  assert.equal(stale.status, 409, JSON.stringify(staleBody));
  assert.equal(staleBody.code, 'stale_document', '过期基线不能覆盖别处的新版本');
  assert.equal(readFileSync(path, 'utf8'), beforeBytes, '被拒绝的恢复不能留下写入');

  const feedback = await postJson(server.url, '/api/feedback', {
    scope: 'blocks', anchors: ['b:aaaaaa'], text: '模型正在改这一块。',
  });
  const task = (await feedback.json()).task;
  const claim = await postJson(server.url, '/api/task/claim', { task_id: task.id });
  assert.equal(claim.status, 200);
  const locked = await restoreFrom(server.url, {
    id: after.versions[1].id,
    base_sha256: sha256(readFileSync(path, 'utf8')),
  });
  const lockedBody = await locked.json();
  assert.equal(locked.status, 409, JSON.stringify(lockedBody));
  assert.equal(lockedBody.code, 'block_locked', '有块被模型占着时整份恢复会覆盖它，必须拒绝');
  assert.equal(readFileSync(path, 'utf8'), beforeBytes, '被拒绝的恢复不能留下写入');
});

// ── 一处事实一个来源（references/design-and-porting-rules.md 规则一） ─────────
test('浏览器操作白名单只有 doc-command 一份，传输层与文档引用同一组', async () => {
  const { DOC_BROWSER_OPERATIONS } = await import('../scripts/doc-command.mjs');
  const reviewCommand = readFileSync(join(core, 'scripts', 'lib', 'review-command.mjs'), 'utf8');
  assert.doesNotMatch(reviewCommand, /DOC_OPERATIONS/, '传输层不许再留第二份文字工作台白名单');
  assert.match(reviewCommand, /DOC_BROWSER_OPERATIONS/, '传输层直接引用命令后端导出的那一份');

  const expected = [
    'open', 'block', 'split', 'merge', 'reorder', 'asset_replace', 'feedback', 'tasks', 'conflicts', 'decide',
    'history', 'restore',
  ];
  assert.deepEqual([...DOC_BROWSER_OPERATIONS].sort(), expected.sort(), '浏览器操作只有这十二项');
  for (const op of ['claim', 'complete', 'patch']) {
    assert.equal(DOC_BROWSER_OPERATIONS.has(op), false, `${op} 只能从模型侧 CLI 进来`);
  }
  for (const doc of ['references/command-transport.md', 'references/architecture.md']) {
    const text = readFileSync(join(core, doc), 'utf8');
    for (const op of expected) assert.ok(text.includes(`\`${op}\``), `${doc} 应列出 ${op}`);
  }
});

test('sha256 与原子写只有一份实现：资产模块复用内核的内容哈希与写盘原语', () => {
  const assetsSource = readFileSync(join(core, 'scripts', 'lib', 'doc-assets.mjs'), 'utf8');
  const journalSource = readFileSync(join(core, 'scripts', 'lib', 'doc-journal.mjs'), 'utf8');
  const ioSource = readFileSync(join(core, 'scripts', 'lib', 'doc-io.mjs'), 'utf8');

  assert.doesNotMatch(assetsSource, /createHash\(/, '资产清单不许自带第二份 sha256');
  assert.doesNotMatch(assetsSource, /writeAtomicFile/, '旧名不许再留一份原子写');
  assert.match(assetsSource, /from '\.\/doc-io\.mjs'/, '原子写引用唯一实现');
  assert.match(assetsSource, /from '\.\.\/content-review-contract\.mjs'/, '内容哈希引用唯一实现');
  assert.doesNotMatch(journalSource, /function atomicWrite/, '原子写只在 doc-io 里定义');
  assert.match(journalSource, /from '\.\/doc-io\.mjs'/);
  assert.match(ioSource, /export function atomicWrite/);
  for (const file of ['doc-boards.mjs', 'doc-inbox.mjs']) {
    const source = readFileSync(join(core, 'scripts', 'lib', file), 'utf8');
    assert.match(source, /from '\.\/doc-io\.mjs'/, `${file} 的原子写也要引用同一份`);
  }
});

test('图资产的包含性判定复用 doc-assets 的唯一实现', () => {
  const workbenchSource = readFileSync(join(core, 'scripts', 'doc-workbench.mjs'), 'utf8');
  assert.match(workbenchSource, /resolveInside\(docPath, requested\)/, '路径解析交给 resolveInside');
  assert.match(workbenchSource, /realPathInside\(docPath, file\)/, '符号链接判定交给 realPathInside');
  assert.doesNotMatch(workbenchSource, /startsWith\(root \+ '\/'\)/, '不许再手拼字符串前缀');
});

test('锚点身份与任务范围只从 doc-blocks / doc-tasks 取', () => {
  const sessionSource = readFileSync(join(core, 'scripts', 'lib', 'doc-session.mjs'), 'utf8');
  const blocksSource = readFileSync(join(core, 'scripts', 'lib', 'doc-blocks.mjs'), 'utf8');
  const tasksSource = readFileSync(join(core, 'scripts', 'lib', 'doc-tasks.mjs'), 'utf8');
  assert.match(sessionSource, /BLOCK_ANCHOR_RE/, '锚点形状引用 doc-blocks 的导出');
  assert.doesNotMatch(sessionSource, /b:\[0-9a-f\]\{6,12\}/, 'doc-session 不许再手敲锚点正则');
  assert.match(sessionSource, /TASK_SCOPES/, '任务范围引用 doc-tasks 的导出');
  assert.doesNotMatch(sessionSource, /\['blocks', 'page', 'doc'\]/, '任务范围不许重列');
  assert.match(blocksSource, /export const BLOCK_ANCHOR_RE/);
  assert.equal((blocksSource.match(/0-9a-f\]\{6,12\}/g) ?? []).length, 1, '锚点形状在 doc-blocks 里也只写一次');
  assert.match(tasksSource, /export const TASK_SCOPES/);
});

test('页面不给锁定与待核对块装拖柄，历史入口在页面上', () => {
  const page = readFileSync(join(core, 'assets', 'workbench', 'doc-workbench.js'), 'utf8');
  const drag = readFileSync(join(core, 'assets', 'workbench', 'doc-drag.js'), 'utf8');
  const html = readFileSync(join(core, 'assets', 'workbench', 'doc-workbench.html'), 'utf8');
  assert.match(drag, /is-locked/, '锁定块不给拖柄');
  assert.match(drag, /is-deferred/, '待核对块不给拖柄');
  assert.match(drag, /blockedNode/, '块与整页共用同一条锁定判据');
  assert.match(drag, /function refresh/, '锁变化后只重算句柄');
  assert.match(page, /DocDrag\.refresh\(\)/, '锁与待核对同步后要刷新句柄');
  assert.match(html, /id="historyOpen"/, '页面要有历史入口');
  assert.match(html, /id="historyList"/, '历史要有可查看的列表');
  assert.match(page, /transport\.history\(\)/, '历史走同一条 transport');
  assert.match(page, /transport\.restore\(/, '恢复走同一条 transport');
});

test('页末引用在数据层就是出处区：页视图给条数，块上标 in_sources', async (t) => {
  const { path } = sandboxExample();
  const server = await openWorkbench(t, path);
  const doc = await getDoc(server.url);

  const first = doc.pages.find((page) => page.chapterIndex === 1 && page.index === 1);
  assert.equal(first.sources, 2, '第 1 页末连续两条引用构成出处区');
  const sources = doc.blocks.filter((block) => block.page.key === first.key && block.in_sources);
  assert.deepEqual(sources.map((block) => block.type), ['quote', 'quote'], '出处区里的每一条都是引用块');
  assert.equal(sources[0].anchor, 'b:21dcae', '出处条目保留自己的锚点');

  const second = doc.pages.find((page) => page.chapterIndex === 1 && page.index === 2);
  assert.equal(second.sources, 2, '页末两条引用');
  const midQuote = doc.blocks.find((block) => block.page.key === second.key && block.type === 'quote' && !block.in_sources);
  assert.ok(midQuote, '页中段的引用照常显示，不标出处');
  assert.equal(midQuote.raw, '> 我们不是在卖提神，是在卖「把状态按时调回来」。');
});
