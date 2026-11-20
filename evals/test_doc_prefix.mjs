import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// 票 30「块类型由行首前缀产生」（规格第 7 节）。
// 只测公开的缝：工作台的 HTTP 命令面与磁盘上的文本。前缀怎么认、锚点怎么摆是实现细节。
//
// 判据：
//   · 行首 `# ` / `## ` 改变结构（真的写成 `# 标题` / `## 标题` 行），前缀不落成字面量；
//   · `### `–`###### ` 得到对应层级的标题块（任意层级）；
//   · `- ` / `1. ` / `> ` / 围栏代码 / `|` 得到对应块类型；
//   · 前缀只有写在行首、且后面紧跟空格才转换（`##标题`、段落中间都不算）；
//   · 标题块里把文字删空，退回段落，前缀重新出现；
//   · 保存路径对「前缀产生的类型变化」放行，其他结构变化仍然拒绝。
const core = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VALIDATOR = join(core, 'scripts', 'validate-doc.mjs');
const READ = (rel) => readFileSync(join(core, rel), 'utf8');

const sandboxes = [];
after(() => { for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true }); });

const FRONT = '---\ncontract: planners-doc/2\ndoc: storyline\nproject: 前缀测试\n---\n\n';

/** 三块：页一占两块（第二块改完还有第一块撑着），页二一块。 */
const DOC = `# 章一

## 页一

第一块。<!-- b:aaaaaa -->

第二块。<!-- b:bbbbbb -->

## 页二

第三块。<!-- b:cccccc -->
`;

function scratchDoc(body = DOC) {
  const dir = mkdtempSync(join(tmpdir(), 'planners-prefix-'));
  sandboxes.push(dir);
  const path = join(dir, 'storyline.md');
  writeFileSync(path, `${FRONT}${body}`, 'utf8');
  return { dir, path };
}

const getDoc = async (url) => {
  const response = await fetch(`${url}/api/doc`);
  assert.equal(response.status, 200, `GET /api/doc 应返回 200，实际 ${response.status}`);
  return response.json();
};

const postJson = async (url, route, body) => {
  const response = await fetch(`${url}${route}`, {
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

const save = (server, opened, anchor, content) => postJson(server.url, '/api/block', {
  anchor,
  content,
  base_sha256: opened.sha256,
});

const blockOf = (doc, anchor) => doc.blocks.find((block) => block.anchor === anchor) ?? null;

// ── 行首 `## ` / `# `：改变结构，文件里是真标题行 ───────────────────────────
test('行首 `## ` 得到一页：文件里是真正的 `## 标题` 行，出现在目录里，前缀不被转义', async (t) => {
  const { path } = scratchDoc();
  const server = await openWorkbench(t, path);
  const opened = await getDoc(server.url);

  const receipt = await save(server, opened, 'b:aaaaaa', '## 新的一页');
  assert.equal(receipt.status, 200, JSON.stringify(receipt.body));
  assert.equal(receipt.body.ok, true);
  assert.equal(receipt.body.retype?.to, 'page', '回执要说明这次是「变成一页」');
  assert.equal(receipt.body.block, null, '页标题不是块，原来的块身份随这一块消失');

  const saved = readFileSync(path, 'utf8');
  assert.ok(saved.includes('## 新的一页'), '文件里要是真正的 `## 标题` 行');
  assert.ok(!saved.includes('\\#'), '前缀不能再被转义成 `\\# `');
  assert.ok(!saved.includes('<!-- b:aaaaaa -->'), '页标题不能带锚点');
  assert.ok(saved.includes('第二块。<!-- b:bbbbbb -->'), '后面的块逐字不动');

  const after = await getDoc(server.url);
  const page = after.pages.find((item) => item.title === '新的一页');
  assert.ok(page, `目录里要出现这一页：${JSON.stringify(after.pages)}`);
  assert.equal(page.chapter, '章一', '新页归原来那一章');
  assert.equal(blockOf(after, 'b:bbbbbb').page.title, '新的一页', '紧跟其后的块属于新页');
  assert.equal(blockOf(after, 'b:aaaaaa'), null, '原来的块不再存在');
});

test('行首 `# ` 得到一章：文件里是真正的 `# 标题` 行，后面的页归新章', async (t) => {
  const { path } = scratchDoc();
  const server = await openWorkbench(t, path);
  const opened = await getDoc(server.url);

  const receipt = await save(server, opened, 'b:bbbbbb', '# 章二');
  assert.equal(receipt.status, 200, JSON.stringify(receipt.body));
  assert.equal(receipt.body.retype?.to, 'chapter');

  const saved = readFileSync(path, 'utf8');
  assert.ok(saved.includes('# 章二'), '文件里要是真正的 `# 标题` 行');
  assert.ok(!saved.includes('\\#'), '前缀不能再被转义');
  assert.ok(!saved.includes('<!-- b:bbbbbb -->'), '章节标题不能带锚点');

  const after = await getDoc(server.url);
  assert.ok(after.chapters.some((chapter) => chapter.title === '章二'), '目录里要出现这一章');
  const pageTwo = after.pages.find((item) => item.title === '页二');
  assert.equal(pageTwo.chapter, '章二', '落在新章后面的页归新章');
  assert.equal(after.pages.find((item) => item.title === '页一').chapter, '章一', '前面的页还在原章');
});

// ── 页中间敲 `# ` / `## `：结构落在边界上，页里的块不被推出去（票 34） ──────
/** 一页四块（两块正文 + 一组出处）：在页中间造结构时，后面的块不能变成页外块。 */
const MIDDLE_DOC = `# 章一

## 页一

第一块。<!-- b:aaaaaa -->

第二块。<!-- b:bbbbbb -->

第三块。<!-- b:cccccc -->

> 出处。<!-- b:dddddd -->

## 页二

第四块。<!-- b:eeeeee -->
`;

test('页中间敲 `# ` 不造章：前缀退回字面段落，页里的块一个都不出页', async (t) => {
  const { path } = scratchDoc(MIDDLE_DOC);
  const server = await openWorkbench(t, path);
  const opened = await getDoc(server.url);

  const receipt = await save(server, opened, 'b:bbbbbb', '# 新章');
  assert.equal(receipt.status, 200, JSON.stringify(receipt.body));
  assert.equal(receipt.body.ok, true, '保存永远成功');
  assert.notEqual(receipt.body.retype?.to, 'chapter', '页中间不造出页外块：这一块退回字面段落');

  const saved = readFileSync(path, 'utf8');
  assert.ok(!/^# 新章$/m.test(saved), '文件里不能出现落在页中间的 `# 新章` 行');
  assert.ok(saved.includes('新章'), '用户敲的字不丢');

  const after = await getDoc(server.url);
  assert.equal(after.chapters.length, 1, '没有凭空多出一章');
  for (const anchor of ['b:aaaaaa', 'b:bbbbbb', 'b:cccccc', 'b:dddddd']) {
    assert.ok(blockOf(after, anchor), `块 ${anchor} 不应消失`);
    assert.equal(blockOf(after, anchor).page.title, '页一', `块 ${anchor} 仍在这一页里`);
  }
  assert.equal(blockOf(after, 'b:bbbbbb').type, 'paragraph');
  assert.ok(blockOf(after, 'b:bbbbbb').raw.includes('新章'), '前缀退回字面段落，文字还在');

  const verdict = validate(path);
  assert.equal(verdict.code, 0, `不该有校验错误：${verdict.stdout}`);
  assert.deepEqual(verdict.out.errors.map((error) => error.code), [], '不出现 block_outside_page');
});

test('页中间敲 `## ` 得到一页：页边界就在这一行，后面的块归新页而不是变成页外块', async (t) => {
  const { path } = scratchDoc(MIDDLE_DOC);
  const server = await openWorkbench(t, path);
  const opened = await getDoc(server.url);

  const receipt = await save(server, opened, 'b:bbbbbb', '## 新半页');
  assert.equal(receipt.status, 200, JSON.stringify(receipt.body));
  assert.equal(receipt.body.retype?.to, 'page');

  const saved = readFileSync(path, 'utf8');
  assert.ok(saved.includes('## 新半页'), '文件里要是真正的 `## 标题` 行');

  const after = await getDoc(server.url);
  assert.equal(blockOf(after, 'b:aaaaaa').page.title, '页一', '前面的块还在原页');
  assert.equal(blockOf(after, 'b:cccccc').page.title, '新半页', '后面的块归新页');
  assert.equal(blockOf(after, 'b:dddddd').page.title, '新半页', '出处跟着后面的块走，仍在页里');
  assert.equal(blockOf(after, 'b:bbbbbb'), null, '页标题不是块');

  const verdict = validate(path);
  assert.equal(verdict.code, 0, `不该有校验错误：${verdict.stdout}`);
});

// ── `### `–`###### `：对应层级的标题块，任意层级都合法 ─────────────────────
test('`### `–`###### ` 得到对应层级的标题块：前缀隐去、锚点还在、任意层级合法', async (t) => {
  const { path } = scratchDoc();
  const server = await openWorkbench(t, path);

  for (const level of [3, 4, 5, 6]) {
    const opened = await getDoc(server.url);
    const prefix = `${'#'.repeat(level)} `;
    const receipt = await save(server, opened, 'b:aaaaaa', `${prefix}第 ${level} 级小标题`);
    assert.equal(receipt.status, 200, `${level} 级：${JSON.stringify(receipt.body)}`);
    assert.equal(receipt.body.block.type, 'heading', `${level} 级要落成标题块`);
    assert.equal(receipt.body.block.prefix, prefix, `${level} 级的前缀按层级出`);
    assert.equal(receipt.body.block.raw, `${prefix}第 ${level} 级小标题`, '块 raw 只留标题本身');
    assert.equal(receipt.body.block.inline, `第 ${level} 级小标题`, '编辑面里不再有前缀字面量');
    assert.equal(receipt.body.block.page.title, '页一', '标题块不参与结构，仍在这一页');

    const saved = readFileSync(path, 'utf8');
    assert.ok(saved.includes(`${prefix}第 ${level} 级小标题<!-- b:aaaaaa -->`), `文件里要是 ${level} 级标题行`);
    assert.ok(!saved.includes(`\\${prefix.trim()}`), '前缀不能被转义');
    assert.equal(validate(path).code, 0, `${level} 级标题块应当通过契约校验`);
  }
});

// ── `- ` / `1. ` / `> ` / 围栏代码 / `|`：对应块类型，前缀不在正文留字面量 ──
const CASES = [
  { content: '- 第一条', type: 'list', prefix: '- ', mark: '- 第一条' },
  { content: '* 星号列表', type: 'list', prefix: '* ', mark: '* 星号列表' },
  { content: '1. 第一步', type: 'list', prefix: '1. ', mark: '1. 第一步' },
  { content: '1) 另一条', type: 'list', prefix: '1) ', mark: '1) 另一条' },
  { content: '> 引用一句', type: 'quote', prefix: '> ', mark: '> 引用一句' },
  {
    content: '```js\nconst 剂量 = 150;\n```',
    type: 'code',
    prefix: '',
    mark: '```js\nconst 剂量 = 150;\n```',
    standalone: true,
  },
  {
    content: '| 元素 | 规格 |\n| --- | --- |\n| 瓶身 | 150ml |',
    type: 'table',
    prefix: '',
    mark: '| 元素 | 规格 |\n| --- | --- |\n| 瓶身 | 150ml |',
    standalone: true,
  },
];

test('`- ` / `1. ` / `> ` / 围栏代码 / `|` 各自得到对应块类型，前缀在正文里不留字面量', async (t) => {
  const { path } = scratchDoc();
  const server = await openWorkbench(t, path);

  for (const item of CASES) {
    const opened = await getDoc(server.url);
    const receipt = await save(server, opened, 'b:aaaaaa', item.content);
    assert.equal(receipt.status, 200, `${item.type}：${JSON.stringify(receipt.body)}`);
    assert.equal(receipt.body.block.type, item.type, `${item.type}：块类型要跟着前缀走`);
    assert.equal(receipt.body.block.raw, item.mark, `${item.type}：块 raw 只留元素本身`);
    if (item.prefix) assert.equal(receipt.body.block.prefix, item.prefix, `${item.type}：前缀从正文里移出`);
    if (!item.prefix) assert.equal(receipt.body.block.inline, item.mark, `${item.type}：整块内容就是正文`);

    const saved = readFileSync(path, 'utf8');
    assert.ok(saved.includes(item.standalone ? `${item.mark}\n<!-- b:aaaaaa -->` : `${item.mark}<!-- b:aaaaaa -->`),
      `${item.type}：锚点位置要符合契约`);
    assert.ok(!/\\(#|-|>|\*|`)/.test(saved), `${item.type}：前缀不能被转义成字面量`);
    assert.equal(validate(path).code, 0, `${item.type}：转换后应当通过契约校验`);
  }
});

test('只有行首且前缀后紧跟空格才转换；不是行首 / 没有空格仍是段落', async (t) => {
  const { path } = scratchDoc();
  const server = await openWorkbench(t, path);

  const opened = await getDoc(server.url);
  const noSpace = await save(server, opened, 'b:aaaaaa', '##没有空格');
  assert.equal(noSpace.status, 200, JSON.stringify(noSpace.body));
  assert.equal(noSpace.body.block.type, 'paragraph', '前缀后面没空格不算标题');
  assert.equal(noSpace.body.block.raw, '##没有空格');

  const openedAgain = await getDoc(server.url);
  const midText = await save(server, openedAgain, 'b:aaaaaa', '前面一句\n## 行中间');
  assert.equal(midText.status, 200, JSON.stringify(midText.body));
  assert.equal(midText.body.block.type, 'paragraph', '段落中间的行首不改变这一块的类型');
  const saved = readFileSync(path, 'utf8');
  assert.ok(saved.includes('前面一句'), '原来的文字要保留');
  assert.equal(validate(path).code, 0, '非行首的 `## ` 不能把文档结构弄坏');
});

test('`## ` 后面还有正文：标题行下面的文字留在新页里，原锚点跟着这段正文', async (t) => {
  const { path } = scratchDoc();
  const server = await openWorkbench(t, path);
  const opened = await getDoc(server.url);

  const receipt = await save(server, opened, 'b:aaaaaa', '## 拆出来的页\n这一段留在新页里');
  assert.equal(receipt.status, 200, JSON.stringify(receipt.body));
  const saved = readFileSync(path, 'utf8');
  assert.ok(saved.includes('## 拆出来的页\n\n这一段留在新页里<!-- b:aaaaaa -->'),
    `前缀后面的正文要接在新页里、锚点贴正文：${JSON.stringify(saved)}`);

  const after = await getDoc(server.url);
  const remainder = blockOf(after, 'b:aaaaaa');
  assert.equal(remainder.type, 'paragraph');
  assert.equal(remainder.raw, '这一段留在新页里');
  assert.equal(remainder.page.title, '拆出来的页', '这一段属于新页');
  assert.equal(blockOf(after, 'b:bbbbbb').raw, '第二块。', '后面的块逐字不动');
});

// ── 标题删空：退回段落，前缀重新出现 ───────────────────────────────────────
test('标题块里把文字删空：退回段落，前缀重新出现，不返回 409', async (t) => {
  const { path } = scratchDoc();
  const server = await openWorkbench(t, path);

  let opened = await getDoc(server.url);
  const heading = await save(server, opened, 'b:aaaaaa', '### 会被删空的标题');
  assert.equal(heading.status, 200, JSON.stringify(heading.body));
  assert.equal(heading.body.block.type, 'heading');

  opened = await getDoc(server.url);
  const emptied = await save(server, opened, 'b:aaaaaa', '### ');
  assert.equal(emptied.status, 200, `删空的标题要能保存：${JSON.stringify(emptied.body)}`);
  assert.notEqual(emptied.body.code, 'block_structure', '前缀回落不是结构错误');
  assert.equal(emptied.body.block.type, 'paragraph', '标题删空后退回段落');
  assert.equal(emptied.body.block.prefix, '', '段落的编辑面里不再有块前缀');
  assert.ok(emptied.body.block.inline.includes('###'), `前缀要重新出现在正文里：${JSON.stringify(emptied.body.block.inline)}`);

  const after = await getDoc(server.url);
  assert.equal(blockOf(after, 'b:aaaaaa').type, 'paragraph');
  assert.equal(validate(path).code, 0, '退回段落后的文档仍应通过契约校验');
});

// ── 保存路径：前缀产生的类型变化放行，别的结构变化仍然拒绝 ──────────────────
test('保存路径只放行前缀产生的类型变化：空行、第二个锚点仍被拒，磁盘不动', async (t) => {
  const { path } = scratchDoc();
  const server = await openWorkbench(t, path);
  const opened = await getDoc(server.url);
  const before = readFileSync(path, 'utf8');

  const blank = await save(server, opened, 'b:aaaaaa', '第一段\n\n第二段');
  assert.equal(blank.status, 409, '空行会把一块变成两块，仍要拒绝');
  assert.equal(blank.body.code, 'block_structure');

  const anchor = await save(server, opened, 'b:aaaaaa', '第一段<!-- b:cccccc -->');
  assert.equal(anchor.status, 409, '一块里写第二个锚点仍要拒绝');
  assert.ok(['block_content_anchor', 'block_structure'].includes(anchor.body.code));

  assert.equal(readFileSync(path, 'utf8'), before, '被拒绝的请求都不能留下写入');
});

// ── 拆块 / 空页第一块也认前缀（页面里回车后新块就是这条路） ────────────────
test('回车分块时后半段带前缀：`### ` 落成标题块，`## ` 落成一页，锚点不跑到标题行里', async (t) => {
  const { path } = scratchDoc();
  const server = await openWorkbench(t, path);

  let opened = await getDoc(server.url);
  const heading = await postJson(server.url, '/api/block/split', {
    anchor: 'b:aaaaaa',
    before: '前半句，',
    after: '### 分出来的小标题',
    keep: 'before',
    base_sha256: opened.sha256,
    base_block_sha256: blockOf(opened, 'b:aaaaaa').sha256,
  });
  assert.equal(heading.status, 200, JSON.stringify(heading.body));
  assert.equal(heading.body.new_block.type, 'heading');
  assert.equal(heading.body.new_block.raw, '### 分出来的小标题');
  assert.equal(blockOf(await getDoc(server.url), 'b:aaaaaa').raw, '前半句，');

  opened = await getDoc(server.url);
  const newAnchor = heading.body.new_block.anchor;
  const page = await postJson(server.url, '/api/block/split', {
    anchor: 'b:bbbbbb',
    before: '第二块前半。',
    after: '## 拆出来的一页',
    keep: 'before',
    base_sha256: opened.sha256,
    base_block_sha256: blockOf(opened, 'b:bbbbbb').sha256,
  });
  assert.equal(page.status, 200, JSON.stringify(page.body));
  assert.equal(page.body.new_block, null, '页标题不是块');
  const saved = readFileSync(path, 'utf8');
  assert.ok(saved.includes('## 拆出来的一页'), '文件里要是真正的 `## 标题` 行');
  assert.ok(!saved.includes('## 拆出来的一页<!--'), '页标题后面不能贴锚点');
  assert.ok((await getDoc(server.url)).pages.some((item) => item.title === '拆出来的一页'), '目录里要出现这一页');
  assert.ok(blockOf(await getDoc(server.url), newAnchor), '先前分出来的标题块还在');
});

test('空页的第一块带前缀：`### ` 落成标题块而不是把锚点写进标题行', async (t) => {
  const { path } = scratchDoc(`# 章一

## 空页
`);
  const server = await openWorkbench(t, path);
  const opened = await getDoc(server.url);

  const receipt = await postJson(server.url, '/api/block', {
    new: true,
    page: { chapter: 1, index: 1 },
    content: '### 空页的第一块',
    base_sha256: opened.sha256,
  });
  assert.equal(receipt.status, 200, JSON.stringify(receipt.body));
  assert.equal(receipt.body.block.type, 'heading');
  assert.equal(receipt.body.block.raw, '### 空页的第一块');
  assert.equal(receipt.body.block.page.title, '空页');
  assert.equal(validate(path).code, 0);
});

test('空页的第一块敲 `## `：空页变出新的一页，标题行不带锚点', async (t) => {
  const { path } = scratchDoc(`# 章一

## 空页
`);
  const server = await openWorkbench(t, path);
  const opened = await getDoc(server.url);

  const receipt = await postJson(server.url, '/api/block', {
    new: true,
    page: { chapter: 1, index: 1 },
    content: '## 空页之后',
    base_sha256: opened.sha256,
  });
  assert.equal(receipt.status, 200, JSON.stringify(receipt.body));
  assert.equal(receipt.body.block, null, '页标题不是块');
  assert.equal(receipt.body.retype?.structure, 'page');
  const saved = readFileSync(path, 'utf8');
  assert.ok(saved.includes('## 空页之后'), '文件里要是真正的 `## 标题` 行');
  assert.ok(!saved.includes('## 空页之后<!--'), '页标题后面不能贴锚点');
  assert.ok((await getDoc(server.url)).pages.some((page) => page.title === '空页之后'), '目录里要出现这一页');
});

// ── 工具栏：只有四个行内格式，不做块按钮 ───────────────────────────────────
test('工具栏只保留加粗、斜体、链接、行内代码四个行内格式，不做块按钮', () => {
  const source = READ('assets/workbench/doc-workbench.js');
  const match = source.match(/const TOOLBAR_HTML = `([\s\S]*?)`;/);
  assert.ok(match, '页面里要能找到工具栏定义');
  const toolbar = match[1];
  const commands = [...toolbar.matchAll(/data-inline="([^"]+)"/g)].map((item) => item[1]).sort();
  assert.deepEqual(commands, ['bold', 'code', 'italic', 'link'], '只有这四个行内格式');
  assert.equal((toolbar.match(/<button/g) ?? []).length, 4, '工具栏就是四个按钮');
  assert.ok(!/data-block|块类型|heading|quote|list|table/.test(toolbar), '不做块按钮');
});
