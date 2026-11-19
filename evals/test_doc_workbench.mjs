import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  assert.equal(before.blocks.length, 48, '样例 storyline 有 48 块');
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
  assert.equal(verdict.out?.checked?.anchors, 48, '保存不应增删锚点');
});

// ── 锚点：缺的补写、重复的重建，只动锚点本身 ────────────────────────────────
const FRONT = '---\ncontract: planners-doc/1\ndoc: storyline\nproject: 测试项目\n---\n\n';
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
  const original = `${FRONT}# 测试文档

## 章节

### 页一

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

#### 小节标题，没有锚点

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
  const path = writeDoc(dir, 'storyline.md', `# 测试文档

## 章节

### 页一

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
  const path = writeDoc(dir, 'storyline.md', `# 测试文档

## 章节

### 页一

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
  assert.doesNotMatch(html, /<textarea/i, '页面里不应有 Markdown 文本框');
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
  const path = writeDoc(dir, 'storyline.md', `# 测试文档

## 章节

### 页一

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
  const path = writeDoc(dir, 'storyline.md', `# 测试文档

## 章节

### 页一

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
