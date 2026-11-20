import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// 票 39：删空即消失。只测公开的缝 —— 工作台的 HTTP 命令面（POST /api/structure、
// POST /api/block/save）、盘上的字节、校验器与历史。块怎么安置是落盘规则，
// 断言只看「哪一块 / 哪一页 / 哪一章不见了、它带着的块去了哪、一条都没丢」。
const core = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VALIDATOR = join(core, 'scripts', 'validate-doc.mjs');

const sandboxes = [];
after(() => { for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true }); });

const FRONT = '---\ncontract: planners-doc/2\ndoc: storyline\nproject: 删除测试\n---\n\n';
const ANCHOR_RE = /<!-- b:[0-9a-f]{6,12} -->/g;

/** 两章三页：第 1 章两页（页一、页二），第 2 章一页（页三）；每页各有一块。 */
const TWO_CHAPTERS = `# 第一章

## 页一

第一段。<!-- b:aaaaaa -->

第二段。<!-- b:bbbbbb -->

## 页二

第三段。<!-- b:cccccc -->

# 第二章

## 页三

第四段。<!-- b:dddddd -->
`;

function scratchDoc(body = TWO_CHAPTERS) {
  const dir = mkdtempSync(join(tmpdir(), 'planners-delete-'));
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
  return { code: result.status, out: JSON.parse(result.stdout || 'null'), stdout: result.stdout };
};
const errorCodes = (path) => (validate(path).out?.errors ?? []).map((error) => error.code);

const blockOf = (doc, anchor) => doc.blocks.find((block) => block.anchor === anchor) ?? null;
const anchorsOf = (text) => (text.match(ANCHOR_RE) ?? []);
const read = (path) => readFileSync(path, 'utf8');

async function openWorkbench(t, docPath) {
  const { startDocWorkbench } = await import('../scripts/doc-workbench.mjs');
  const server = await startDocWorkbench({ docPath, port: 0 });
  t.after(() => server.close());
  return server;
}

// ── 块：删空失焦 → 这一块从文件里消失 ───────────────────────────────────────
test('块删空：delete-block 把这一块从文件里拿走，其余块逐字不动', async (t) => {
  const { path } = scratchDoc();
  const original = read(path);
  const server = await openWorkbench(t, path);
  const before = await getDoc(server.url);

  const receipt = await postStructure(server.url, {
    op: 'delete-block',
    anchor: 'b:bbbbbb',
    base_sha256: before.sha256,
  });
  assert.equal(receipt.status, 200, JSON.stringify(receipt.body));
  assert.equal(receipt.body.ok, true);
  assert.equal(receipt.body.changed, true);
  assert.deepEqual(receipt.body.deleted, { kind: 'block', anchor: 'b:bbbbbb' }, '回执要说清删掉了哪一块');

  const after = read(path);
  assert.equal(after, original.replace('第二段。<!-- b:bbbbbb -->\n\n', ''), '只拿走这一块与它的空行，其余字节逐字不动');
  assert.equal(validate(path).code, 0, `删完仍应合规：${validate(path).stdout}`);

  const doc = await getDoc(server.url);
  assert.equal(doc.blocks.length, before.blocks.length - 1, '块少了一个');
  assert.equal(blockOf(doc, 'b:bbbbbb'), null, '被删的块在快照里也不在');
  for (const anchor of ['b:aaaaaa', 'b:cccccc', 'b:dddddd']) {
    assert.equal(blockOf(doc, anchor)?.raw, before.blocks.find((block) => block.anchor === anchor)?.raw, '别的块逐字不动');
  }
  assert.equal(doc.sha256, receipt.body.sha256, '回执与下一次打开是同一版');
});

test('块删空：删除页里唯一一块后那一页变成空页（编辑中间态，不拦）', async (t) => {
  const { path } = scratchDoc();
  const server = await openWorkbench(t, path);
  const before = await getDoc(server.url);

  const receipt = await postStructure(server.url, {
    op: 'delete-block',
    anchor: 'b:cccccc',
    base_sha256: before.sha256,
  });
  assert.equal(receipt.status, 200, JSON.stringify(receipt.body));

  const doc = await getDoc(server.url);
  assert.deepEqual(doc.pages.map((page) => page.title), ['页一', '页二', '页三'], '页标题还在：删的是块，不是页');
  assert.equal(doc.pages.find((page) => page.title === '页二').blocks, 0, '页二成了空页');
  assert.deepEqual(errorCodes(path), ['page_empty'], '空页由交付校验器报，删除本身不拒绝（ADR 0006）');
});

// ── 页：删空失焦 → 页消失，块按 1/2/3 安置，一条不丢 ────────────────────────
test('页删空（规则 1）：块并入同一章的上一页，页消失，一条不丢', async (t) => {
  const { path } = scratchDoc();
  const original = read(path);
  const server = await openWorkbench(t, path);
  const before = await getDoc(server.url);
  const beforeAnchors = anchorsOf(original).join(',');

  const receipt = await postStructure(server.url, {
    op: 'delete-page',
    chapter: 1,
    index: 2,
    base_sha256: before.sha256,
  });
  assert.equal(receipt.status, 200, JSON.stringify(receipt.body));
  assert.deepEqual(receipt.body.deleted, { kind: 'page', chapter: 1, index: 2 }, '回执要说清删了哪一页');

  const after = read(path);
  assert.equal(after, original.replace('## 页二\n\n', ''), '只拿走页标题行与它下面的空行');
  assert.equal(anchorsOf(after).join(','), beforeAnchors, '块身份一个不增一个不减');
  assert.equal(validate(path).code, 0, `删完仍应合规：${validate(path).stdout}`);

  const doc = await getDoc(server.url);
  assert.deepEqual(doc.pages.map((page) => page.title), ['页一', '页三'], '页二没了');
  assert.deepEqual(doc.chapters.map((chapter) => chapter.pages), [1, 1], '第一章只剩一页');
  const pageOne = doc.pages.find((page) => page.title === '页一');
  assert.equal(pageOne.blocks, 3, '页一接住了页二的块');
  assert.deepEqual(
    doc.blocks.filter((block) => block.page.title === '页一').map((block) => block.raw),
    ['第一段。', '第二段。', '第三段。'],
    '三条都还在，顺序不变',
  );
});

test('页删空（规则 2）：本章第一页的块并入下一章的第一页，块顺序与身份都跟走', async (t) => {
  const { path } = scratchDoc();
  const original = read(path);
  const server = await openWorkbench(t, path);
  const before = await getDoc(server.url);

  const receipt = await postStructure(server.url, {
    op: 'delete-page',
    chapter: 1,
    index: 1,
    base_sha256: before.sha256,
  });
  assert.equal(receipt.status, 200, JSON.stringify(receipt.body));
  assert.deepEqual(receipt.body.deleted, { kind: 'page', chapter: 1, index: 1 });

  const after = read(path);
  assert.equal(anchorsOf(after).sort().join(','), anchorsOf(original).sort().join(','), '块身份一个不丢');
  assert.ok(!after.includes('## 页一'), '页一没了');
  assert.equal(errorCodes(path).length, 0, `删完仍应合规：${validate(path).stdout}`);

  const doc = await getDoc(server.url);
  assert.deepEqual(doc.pages.map((page) => page.title), ['页二', '页三'], '只剩两页');
  assert.deepEqual(doc.chapters.map((chapter) => chapter.pages), [1, 1], '第一章只剩页二');
  assert.deepEqual(
    doc.blocks.filter((block) => block.page.title === '页三').map((block) => [block.anchor, block.raw]),
    [['b:dddddd', '第四段。'], ['b:aaaaaa', '第一段。'], ['b:bbbbbb', '第二段。']],
    '页一的块整段跟到下一章第一页，raw 逐字不动',
  );
  assert.equal(blockOf(doc, 'b:cccccc')?.page.title, '页二', '同章后面的页不受影响');
});

// ── 规则 3：前后都没有 → 留在原处，成为页外块 ────────────────────────────────
const ONE_CHAPTER = `# 第一章

## 页一

第一段。<!-- b:aaaaaa -->

## 页二

第二段。<!-- b:bbbbbb -->
`;

const ONE_PAGE = `# 第一章

## 页一

第一段。<!-- b:aaaaaa -->
`;

test('页删空（规则 3）：本章第一页且没有下一章 → 块成为章下的页外块，一条不丢', async (t) => {
  const { path } = scratchDoc(ONE_CHAPTER);
  const server = await openWorkbench(t, path);
  const before = await getDoc(server.url);

  const receipt = await postStructure(server.url, {
    op: 'delete-page',
    chapter: 1,
    index: 1,
    base_sha256: before.sha256,
  });
  assert.equal(receipt.status, 200, JSON.stringify(receipt.body));

  const after = read(path);
  assert.equal(
    after,
    `${FRONT}# 第一章\n\n第一段。<!-- b:aaaaaa -->\n\n## 页二\n\n第二段。<!-- b:bbbbbb -->\n`,
    '只拿走页标题行：块留在原处（章下），别的字节逐字不动',
  );
  assert.deepEqual(errorCodes(path), ['block_outside_page'], '规则 3 明确要留的页外块是唯一允许的越界');

  const doc = await getDoc(server.url);
  assert.deepEqual(doc.pages.map((page) => page.title), ['页二'], '页一没了');
  assert.equal(blockOf(doc, 'b:aaaaaa').page.key, null, '第一段成了页外块（不属于任何页）');
  assert.equal(doc.blocks.find((block) => block.anchor === 'b:bbbbbb').page.title, '页二', '页二的块不受影响');
});

test('页删空（规则 3 · 文末）：章里唯一一页被删 → 章标题跟着消失，块留在文末成为页外块', async (t) => {
  const { path } = scratchDoc(ONE_PAGE);
  const server = await openWorkbench(t, path);
  const before = await getDoc(server.url);

  const receipt = await postStructure(server.url, {
    op: 'delete-page',
    chapter: 1,
    index: 1,
    base_sha256: before.sha256,
  });
  assert.equal(receipt.status, 200, JSON.stringify(receipt.body));

  const after = read(path);
  assert.equal(after, `${FRONT}第一段。<!-- b:aaaaaa -->\n`, '章与页都没了，块留在文末');
  assert.deepEqual(errorCodes(path), ['block_outside_page'], '结构不完整是允许的（规则 3）');

  const doc = await getDoc(server.url);
  assert.deepEqual(doc.chapters, [], '章没了');
  assert.deepEqual(doc.pages, [], '页也没了');
  assert.equal(blockOf(doc, 'b:aaaaaa')?.raw, '第一段。', '块还在，raw 逐字不动');
});

test('规则 3 之外不新产生页外块：删中间页 / 删有下一章的首页都留下完整结构', async (t) => {
  const { path } = scratchDoc();
  const server = await openWorkbench(t, path);
  let doc = await getDoc(server.url);

  const middle = await postStructure(server.url, { op: 'delete-page', chapter: 1, index: 2, base_sha256: doc.sha256 });
  assert.equal(middle.status, 200, JSON.stringify(middle.body));
  assert.deepEqual(errorCodes(path), [], '删中间页（规则 1）不产生页外块');

  doc = await getDoc(server.url);
  const last = await postStructure(server.url, { op: 'delete-page', chapter: 1, index: 1, base_sha256: doc.sha256 });
  assert.equal(last.status, 200, JSON.stringify(last.body));
  assert.ok(!errorCodes(path).includes('block_outside_page'), `删掉第一章第一页（规则 2）也不越界：${validate(path).stdout}`);
  assert.equal(validate(path).code, 0, validate(path).stdout);
});

// ── 造结构删空源页（票 39 · 36 的补充）：空页不该留着 ────────────────────────
const PREFIX_DOC = `# 章一

## 页一

第一块。<!-- b:aaaaaa -->

第二块。<!-- b:bbbbbb -->

## 页二

第三块。<!-- b:cccccc -->
`;

const postBlock = async (url, body) => {
  const response = await fetch(`${url}/api/block`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
};

test('页首块敲 `# 新章节`：章与占位页都在，原页跟着消失，不出现 page_empty / block_outside_page', async (t) => {
  const { path } = scratchDoc(PREFIX_DOC);
  const server = await openWorkbench(t, path);
  const opened = await getDoc(server.url);

  const receipt = await postBlock(server.url, {
    anchor: 'b:aaaaaa',
    content: '# 新章节',
    base_sha256: opened.sha256,
    base_block_sha256: blockOf(opened, 'b:aaaaaa').sha256,
  });
  assert.equal(receipt.status, 200, JSON.stringify(receipt.body));
  assert.equal(receipt.body.retype?.structure, 'chapter');
  assert.equal(receipt.body.ok, true);

  const doc = await getDoc(server.url);
  const auto = receipt.body.retype?.auto_page;
  assert.equal(auto?.title, '标题待修改', '回执要指出自动补的那一页');
  assert.equal(auto?.key, doc.pages.find((page) => page.title === '标题待修改')?.key, '回执里的占位页身份要对得上（页面靠它定位）');

  const saved = read(path);
  assert.ok(saved.includes('# 新章节'), '章节要真的落盘');
  assert.ok(saved.includes('## 标题待修改'), '占位页要真的落盘');
  assert.ok(!saved.includes('## 页一'), '原来那一页一块都不剩，页标题跟着消失');
  assert.deepEqual(errorCodes(path), [], `不该留下空页或页外块：${validate(path).stdout}`);
  assert.deepEqual(doc.pages.map((page) => page.title), ['标题待修改', '页二']);
  assert.equal(blockOf(doc, 'b:bbbbbb').page.title, '标题待修改', '后面的块归占位页');
  assert.equal(blockOf(doc, 'b:cccccc').page.title, '页二', '别的页不受影响');
});

test('页里只有这一块时敲 `## 新页`：原页跟着消失，只有新的那一页', async (t) => {
  const { path } = scratchDoc(PREFIX_DOC);
  const server = await openWorkbench(t, path);
  const opened = await getDoc(server.url);

  const receipt = await postBlock(server.url, {
    anchor: 'b:cccccc',
    content: '## 新页',
    base_sha256: opened.sha256,
    base_block_sha256: blockOf(opened, 'b:cccccc').sha256,
  });
  assert.equal(receipt.status, 200, JSON.stringify(receipt.body));
  assert.equal(receipt.body.retype?.structure, 'page');

  const saved = read(path);
  assert.ok(saved.includes('## 新页'), '新页要真的落盘');
  assert.ok(!saved.includes('## 页二'), '原来那一页一块都不剩，页标题跟着消失');

  // 新的那一页本身还是空的：那是人正在写的第一页（ADR 0006 的编辑中间态），
  // 要报也只得报它，不能把「源页空着」也一起留下。
  const empties = (validate(path).out?.errors ?? []).filter((error) => error.code === 'page_empty');
  assert.deepEqual(empties.map((error) => error.block), ['页「新页」'], `只剩新页自己的空：${validate(path).stdout}`);
});

test('页里还有别的块时不删页标题：源页还没空就照旧留着', async (t) => {
  const { path } = scratchDoc(PREFIX_DOC);
  const server = await openWorkbench(t, path);
  const opened = await getDoc(server.url);

  const receipt = await postBlock(server.url, {
    anchor: 'b:bbbbbb',
    content: '# 新章节',
    base_sha256: opened.sha256,
    base_block_sha256: blockOf(opened, 'b:bbbbbb').sha256,
  });
  assert.equal(receipt.status, 200, JSON.stringify(receipt.body));

  const saved = read(path);
  assert.ok(saved.includes('## 页一'), '页一里还有第一块，页标题不动');
  assert.equal(blockOf(await getDoc(server.url), 'b:aaaaaa').page.title, '页一', '第一块仍在原页');
  assert.deepEqual(errorCodes(path), [], validate(path).stdout);
});

test('页首块上回车敲出 `# 新章节`：同一次写里删掉空掉的原页，validate 干净', async (t) => {
  const { path } = scratchDoc(PREFIX_DOC);
  const server = await openWorkbench(t, path);
  const opened = await getDoc(server.url);

  const response = await fetch(`${server.url}/api/block/split`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      anchor: 'b:aaaaaa',
      before: '# 新章节',
      after: '第一块。',
      keep: 'before',
      base_sha256: opened.sha256,
      base_block_sha256: blockOf(opened, 'b:aaaaaa').sha256,
    }),
  });
  const receipt = await response.json();
  assert.equal(response.status, 200, JSON.stringify(receipt));
  assert.equal(receipt.retype?.structure, 'chapter');

  const saved = read(path);
  assert.ok(saved.includes('# 新章节') && saved.includes('## 标题待修改'), '章与占位页都落盘');
  assert.ok(!saved.includes('## 页一'), '原页一块都不剩，页标题跟着消失');
  assert.deepEqual(errorCodes(path), [], `不该有空页 / 页外块：${validate(path).stdout}`);

  const doc = await getDoc(server.url);
  assert.equal(blockOf(doc, 'b:aaaaaa').page.title, '标题待修改', '原锚点跟着后半块走到占位页');
  assert.deepEqual(doc.pages.map((page) => page.title), ['标题待修改', '页二']);
});

test('页上空页的第一块敲 `# 新章`：那个空页也跟着消失，不留下两个空壳', async (t) => {
  const { path } = scratchDoc(`# 章一

## 空页
`);
  const server = await openWorkbench(t, path);
  const opened = await getDoc(server.url);

  const response = await fetch(`${server.url}/api/block`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ new: true, page: { chapter: 1, index: 1 }, content: '# 新章二', base_sha256: opened.sha256 }),
  });
  const receipt = await response.json();
  assert.equal(response.status, 200, JSON.stringify(receipt));

  const saved = read(path);
  assert.ok(saved.includes('# 新章二'), '章要真的落盘');
  assert.ok(!saved.includes('## 空页'), '空页一块都不剩，页标题跟着消失');
  assert.deepEqual(errorCodes(path), [], `不该留空页：${validate(path).stdout}`);
});

// ── 章：删空失焦 → 章消失，页并入上一章；第一章并入下一章 ────────────────────
test('章删空：页并入上一章，块与页身份一条不丢', async (t) => {
  const { path } = scratchDoc();
  const original = read(path);
  const server = await openWorkbench(t, path);
  const before = await getDoc(server.url);

  const receipt = await postStructure(server.url, { op: 'delete-chapter', chapter: 2, base_sha256: before.sha256 });
  assert.equal(receipt.status, 200, JSON.stringify(receipt.body));
  assert.deepEqual(receipt.body.deleted, { kind: 'chapter', chapter: 2 }, '回执要说清删了哪一章');

  const after = read(path);
  assert.equal(after, original.replace('# 第二章\n\n', ''), '只拿走章标题行与它下面的空行');
  assert.equal(anchorsOf(after).join(','), anchorsOf(original).join(','), '块身份一个不增一个不减');
  assert.equal(validate(path).code, 0, validate(path).stdout);

  const doc = await getDoc(server.url);
  assert.deepEqual(doc.chapters.map((chapter) => chapter.title), ['第一章']);
  assert.equal(doc.chapters[0].pages, 3, '三页都在第一章里');
  assert.deepEqual(doc.pages.map((page) => page.title), ['页一', '页二', '页三']);
  assert.equal(blockOf(doc, 'b:dddddd').page.title, '页三', '原来的页还是那一页');
});

test('章删空（第一章）：页整段并入下一章，成为它的前几页', async (t) => {
  const { path } = scratchDoc();
  const server = await openWorkbench(t, path);
  const before = await getDoc(server.url);

  const receipt = await postStructure(server.url, { op: 'delete-chapter', chapter: 1, base_sha256: before.sha256 });
  assert.equal(receipt.status, 200, JSON.stringify(receipt.body));

  assert.equal(read(path), `${FRONT}# 第二章\n\n## 页一\n\n第一段。<!-- b:aaaaaa -->\n\n第二段。<!-- b:bbbbbb -->\n\n## 页二\n\n第三段。<!-- b:cccccc -->\n\n## 页三\n\n第四段。<!-- b:dddddd -->\n`);
  assert.equal(validate(path).code, 0, validate(path).stdout);

  const doc = await getDoc(server.url);
  assert.deepEqual(doc.chapters.map((chapter) => chapter.title), ['第二章']);
  assert.deepEqual(doc.pages.map((page) => page.title), ['页一', '页二', '页三'], '原来的页整段跟过来');
  assert.deepEqual(doc.blocks.map((block) => block.raw).filter((raw) => raw.startsWith('第')), ['第一段。', '第二段。', '第三段。', '第四段。']);
});

test('唯一一章删空：页留在顶层（没有邻章可并），块一条不丢', async (t) => {
  const { path } = scratchDoc(ONE_CHAPTER);
  const server = await openWorkbench(t, path);
  const before = await getDoc(server.url);

  const receipt = await postStructure(server.url, { op: 'delete-chapter', chapter: 1, base_sha256: before.sha256 });
  assert.equal(receipt.status, 200, JSON.stringify(receipt.body));

  assert.equal(read(path), `${FRONT}## 页一\n\n第一段。<!-- b:aaaaaa -->\n\n## 页二\n\n第二段。<!-- b:bbbbbb -->\n`);
  assert.ok(!errorCodes(path).includes('block_outside_page'), '块仍在页里');

  const doc = await getDoc(server.url);
  assert.deepEqual(doc.chapters, [], '章没了');
  assert.deepEqual(doc.pages.map((page) => page.title), ['页一', '页二']);
});

// ── 删除走 journal 与历史：删错了能恢复 ─────────────────────────────────────
const postJson = async (url, route, body) => {
  const response = await fetch(`${url}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
};
const getJson = async (url, route) => {
  const response = await fetch(`${url}${route}`);
  return { status: response.status, body: await response.json() };
};

test('删除都能从历史里恢复：块 / 页 / 章删完都留着一档旧版', async (t) => {
  const { path } = scratchDoc();
  const original = read(path);
  const server = await openWorkbench(t, path);
  let opened = await getDoc(server.url);

  const deletedBlock = await postStructure(server.url, { op: 'delete-block', anchor: 'b:bbbbbb', base_sha256: opened.sha256 });
  assert.equal(deletedBlock.status, 200, JSON.stringify(deletedBlock.body));
  opened = await getDoc(server.url);
  const deletedPage = await postStructure(server.url, { op: 'delete-page', chapter: 1, index: 2, base_sha256: opened.sha256 });
  assert.equal(deletedPage.status, 200, JSON.stringify(deletedPage.body));
  opened = await getDoc(server.url);
  const deletedChapter = await postStructure(server.url, { op: 'delete-chapter', chapter: 1, base_sha256: opened.sha256 });
  assert.equal(deletedChapter.status, 200, JSON.stringify(deletedChapter.body));

  const listed = await getJson(server.url, '/api/history');
  assert.equal(listed.body.ok, true);
  assert.ok(listed.body.versions.length >= 3, `每次删除都留一档：${JSON.stringify(listed.body.versions.map((item) => item.operation))}`);
  assert.deepEqual(listed.body.versions.map((version) => version.operation).slice(0, 3), ['structure', 'structure', 'structure']);

  const oldest = listed.body.versions.at(-1);
  const restored = await postJson(server.url, '/api/history/restore', { id: oldest.id, base_sha256: (await getDoc(server.url)).sha256 });
  assert.equal(restored.status, 200, JSON.stringify(restored.body));
  assert.equal(restored.body.changed, true);
  assert.equal(read(path), original, '恢复把删掉的一次都不剩地带回来');

  const after = await getDoc(server.url);
  assert.deepEqual(after.chapters.map((chapter) => chapter.title), ['第一章', '第二章']);
  assert.deepEqual(after.pages.map((page) => page.title), ['页一', '页二', '页三']);
  assert.equal(after.blocks.length, 4, '块也一个不少地回来');
});

// ── 删除过程中基线过期：自动重读重放，不弹 409 ──────────────────────────────
test('删除遇到过期基线：自动重读重放，不弹 409', async (t) => {
  const { path } = scratchDoc();
  const original = read(path);
  const server = await openWorkbench(t, path);
  const opened = await getDoc(server.url);

  // 别处刚改过这一份（拦下一个 600ms 自动保存窗口里的编辑）。
  const elsewhere = original.replace('第三段。', '第三段，在别处改过。');
  writeFileSync(path, elsewhere);

  const stale = await postStructure(server.url, { op: 'delete-page', chapter: 1, index: 2, base_sha256: opened.sha256 });
  assert.equal(stale.status, 200, `基线过期不拒人：${JSON.stringify(stale.body)}`);
  assert.equal(stale.body.replayed, true, '回执要说明这是重放过的写');
  assert.equal(read(path), elsewhere.replace('## 页二\n\n', ''), '别处的改动保留，删除被重放到新版本上');

  const other = original.replace('第四段。', '第四段，别处也改过。');
  writeFileSync(path, other);
  const staleBlock = await postStructure(server.url, { op: 'delete-block', anchor: 'b:bbbbbb', base_sha256: opened.sha256 });
  assert.equal(staleBlock.status, 200, JSON.stringify(staleBlock.body));
  assert.equal(read(path), other.replace('第二段。<!-- b:bbbbbb -->\n\n', ''));
});

// ── 批注：目标还在就跟着走；目标真没了进 orphan_notes ───────────────────────
test('删页后批注跟着块走：目标还在，提交照常成功，不进 orphan_notes', async (t) => {
  const { path } = scratchDoc();
  const server = await openWorkbench(t, path);
  const opened = await getDoc(server.url);

  const note = await postJson(server.url, '/api/note', { anchor: 'b:cccccc', text: '这一页的这条批注要跟着走' });
  assert.equal(note.status, 200, JSON.stringify(note.body));

  const deleted = await postStructure(server.url, { op: 'delete-page', chapter: 1, index: 2, base_sha256: opened.sha256 });
  assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
  assert.equal(blockOf(await getDoc(server.url), 'b:cccccc').page.title, '页一', '块挪到上一页，身份不变');

  const submitted = await postJson(server.url, '/api/note/submit', {});
  assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
  assert.deepEqual(submitted.body.diff.orphan_notes, [], '目标还在，批注不算孤儿');
  assert.deepEqual(submitted.body.committed, [note.body.note.id], '原批注照常提交');
  assert.deepEqual(submitted.body.task.blocks.map((block) => block.anchor), ['b:cccccc'], '任务锁的还是那一块');
});

test('删块后那条批注进 orphan_notes：不静默消失', async (t) => {
  const { path } = scratchDoc();
  const server = await openWorkbench(t, path);
  const opened = await getDoc(server.url);

  const doomed = await postJson(server.url, '/api/note', { anchor: 'b:bbbbbb', text: '这一条的块会被删' });
  const kept = await postJson(server.url, '/api/note', { anchor: 'b:aaaaaa', text: '这一条还在' });
  assert.equal(doomed.status, 200, JSON.stringify(doomed.body));
  assert.equal(kept.status, 200, JSON.stringify(kept.body));

  const deleted = await postStructure(server.url, { op: 'delete-block', anchor: 'b:bbbbbb', base_sha256: opened.sha256 });
  assert.equal(deleted.status, 200, JSON.stringify(deleted.body));

  const submitted = await postJson(server.url, '/api/note/submit', {});
  assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
  assert.deepEqual(submitted.body.diff.orphan_notes, [{
    note: doomed.body.note.id,
    text: '这一条的块会被删',
    reason: 'target_block_removed',
  }], '失去目标的批注进 orphan_notes，说清哪一条、为什么');
  assert.deepEqual(submitted.body.committed, [kept.body.note.id], '有目标的那条照常提交');
});

// ── 页面：感知「删空失焦」，把删除交给同一条 structure 命令 ───────────────────
test('页面把删空失焦接成删除动作：块的内容空了发 delete-block，标题空了发 delete-page / delete-chapter', () => {
  const page = readFileSync(join(core, 'assets', 'workbench', 'doc-workbench.js'), 'utf8');
  for (const op of ['delete-block', 'delete-page', 'delete-chapter']) {
    assert.match(page, new RegExp(`op: '${op}'`), `页面要发 ${op}`);
  }
  assert.match(page, /DELETABLE_TYPES/, '哪些块删空即消失有一处清单');
  const del = page.indexOf('deleteBlockContent(node, entry)');
  const emptyMsg = page.indexOf('保存失败 · 块不能为空');
  assert.ok(del > 0 && emptyMsg > del, '删空先走删除，剩下的才轮得到「块不能为空」');
  assert.doesNotMatch(page, /改名失败 · 标题不能为空/, '标题删空不再是「不能为空」，是该删了');
  assert.match(page, /deleteStructureTitle\(spec\)/, '标题删空走删除');
  // 删除回执带整份快照：页面不自己猜块去了哪一页。
  assert.match(page, /applySnapshot\(receipt\)/, '删除之后按快照重画');
});

test('规则 3 留下的页外块也能删：删掉之后结构回到干净状态', async (t) => {
  const { path } = scratchDoc(ONE_CHAPTER);
  const server = await openWorkbench(t, path);
  let opened = await getDoc(server.url);

  const deletedPage = await postStructure(server.url, { op: 'delete-page', chapter: 1, index: 1, base_sha256: opened.sha256 });
  assert.equal(deletedPage.status, 200, JSON.stringify(deletedPage.body));
  opened = await getDoc(server.url);
  assert.equal(blockOf(opened, 'b:aaaaaa').page.key, null, '第一段成了页外块');

  const deletedOrphan = await postStructure(server.url, { op: 'delete-block', anchor: 'b:aaaaaa', base_sha256: opened.sha256 });
  assert.equal(deletedOrphan.status, 200, `页外块也必须能删：${JSON.stringify(deletedOrphan.body)}`);
  assert.deepEqual(errorCodes(path), [], validate(path).stdout);
});

test('空页 / 只有标题的章也能直接删：删的是一条标题行，不连带别的字节', async (t) => {
  const { path } = scratchDoc(`# 章一

## 页一

第一段。<!-- b:aaaaaa -->

## 空页

# 只有标题的章
`);
  const original = read(path);
  const server = await openWorkbench(t, path);
  let opened = await getDoc(server.url);

  const emptyPage = await postStructure(server.url, { op: 'delete-page', chapter: 1, index: 2, base_sha256: opened.sha256 });
  assert.equal(emptyPage.status, 200, JSON.stringify(emptyPage.body));
  assert.equal(read(path), original.replace('## 空页\n\n', ''), '空页只拿走自己那一行');

  opened = await getDoc(server.url);
  const emptyChapter = await postStructure(server.url, { op: 'delete-chapter', chapter: 2, base_sha256: opened.sha256 });
  assert.equal(emptyChapter.status, 200, JSON.stringify(emptyChapter.body));
  assert.equal(read(path), `${FRONT}# 章一\n\n## 页一\n\n第一段。<!-- b:aaaaaa -->\n`, '只有标题的章也只拿走标题行');
});

test('CRLF 的文档删完仍是 CRLF：行手术不顺手把换行改掉', async (t) => {
  const { path } = scratchDoc();
  writeFileSync(path, read(path).replace(/\n/g, '\r\n'), 'utf8');
  const original = read(path);
  const server = await openWorkbench(t, path);
  const opened = await getDoc(server.url);

  const receipt = await postStructure(server.url, {
    op: 'delete-block',
    anchor: 'b:bbbbbb',
    base_sha256: opened.sha256,
  });
  assert.equal(receipt.status, 200, JSON.stringify(receipt.body));
  const after = read(path);
  assert.equal(after, original.replace('第二段。<!-- b:bbbbbb -->\r\n\r\n', ''));
  assert.ok(!/[^\r]\n/.test(after), '一个单独的 \\n 都不能留下');
});

test('删掉整份文档里唯一一块：页变空页，不拦（ADR 0006 的编辑中间态）', async (t) => {
  const { path } = scratchDoc(`# 章一

## 页一

唯一一块。<!-- b:aaaaaa -->
`);
  const server = await openWorkbench(t, path);
  const opened = await getDoc(server.url);

  const receipt = await postStructure(server.url, { op: 'delete-block', anchor: 'b:aaaaaa', base_sha256: opened.sha256 });
  assert.equal(receipt.status, 200, JSON.stringify(receipt.body));
  assert.deepEqual(errorCodes(path), ['page_empty'], '页还在、成了空页，交给交付校验器说');
  assert.equal(read(path), `${FRONT}# 章一\n\n## 页一\n`, '块没了，标题都还在');
});

test('造章让源页消失时，挂在那块上的批注进 orphan_notes：不静默消失', async (t) => {
  const { path } = scratchDoc(PREFIX_DOC);
  const server = await openWorkbench(t, path);
  const opened = await getDoc(server.url);

  const doomed = await postJson(server.url, '/api/note', { anchor: 'b:aaaaaa', text: '这一块要变成章节标题' });
  const kept = await postJson(server.url, '/api/note', { anchor: 'b:cccccc', text: '这一条还在' });
  assert.equal(doomed.status, 200, JSON.stringify(doomed.body));

  const typed = await postBlock(server.url, {
    anchor: 'b:aaaaaa',
    content: '# 新章节',
    base_sha256: opened.sha256,
    base_block_sha256: blockOf(opened, 'b:aaaaaa').sha256,
  });
  assert.equal(typed.status, 200, JSON.stringify(typed.body));

  const submitted = await postJson(server.url, '/api/note/submit', {});
  assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
  assert.deepEqual(submitted.body.diff.orphan_notes, [{
    note: doomed.body.note.id,
    text: '这一块要变成章节标题',
    reason: 'target_block_removed',
  }], '块身份随着结构行消失，批注进 orphan_notes');
  assert.deepEqual(submitted.body.committed, [kept.body.note.id], '别的批注照常提交');
});

// ── 真实页面：删空、失焦这两个手势真的把块 / 页删掉 ──────────────────────────
test('真实页面：把一块的文字删空再失焦，这一块从文件里消失；把页标题删空再失焦，这一页消失', async (t) => {
  const { loadPlaywright } = await import('./acceptance/lib/harness.mjs');
  const browserInfo = await loadPlaywright();
  if (!browserInfo.available) {
    t.skip(`跳过真实页面验收：${browserInfo.reason}`);
    return;
  }
  const { path } = scratchDoc();
  const server = await openWorkbench(t, path);
  const browser = await browserInfo.playwright.chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(server.url, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.body.dataset.layout === 'wide');

  const selectAllIn = async (selector) => {
    await page.locator(selector).click();
    await page.evaluate((target) => {
      const node = document.querySelector(target);
      node.focus();
      const range = document.createRange();
      range.selectNodeContents(node);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    }, selector);
  };

  // 块：删空 + 失焦
  await selectAllIn('.doc-block[data-anchor="b:aaaaaa"] .block-text');
  const blockSaved = page.waitForResponse((response) => response.url().endsWith('/api/structure'), { timeout: 10000 });
  await page.keyboard.press('Backspace');
  await page.evaluate(() => document.activeElement?.blur());
  const blockResponse = await blockSaved;
  const blockReceipt = await blockResponse.json();
  assert.equal(blockResponse.status(), 200, JSON.stringify(blockReceipt));
  assert.deepEqual(blockReceipt.deleted, { kind: 'block', anchor: 'b:aaaaaa' }, '页面要发 delete-block');
  assert.ok(!read(path).includes('b:aaaaaa'), '这一块从文件里消失了');
  assert.equal(await page.locator('.doc-block[data-anchor="b:aaaaaa"]').count(), 0, '页面上这一块也没了');
  assert.ok(read(path).includes('第二段。'), '同一页别的块逐字不动');

  // 页标题：删空 + 失焦
  await selectAllIn('.page-divider[data-page-key="1-2"] .page-title');
  const pageSaved = page.waitForResponse((response) => response.url().endsWith('/api/structure'), { timeout: 10000 });
  await page.keyboard.press('Backspace');
  await page.evaluate(() => document.activeElement?.blur());
  const pageResponse = await pageSaved;
  const pageReceipt = await pageResponse.json();
  assert.equal(pageResponse.status(), 200, JSON.stringify(pageReceipt));
  assert.deepEqual(pageReceipt.deleted, { kind: 'page', chapter: 1, index: 2 }, '页面要发 delete-page');
  assert.ok(!read(path).includes('## 页二'), '这一页从文件里消失了');
  assert.equal(await page.locator('.page-divider[data-page-key="1-2"]').count(), 0, '页面上这一页也没了');
  assert.ok(read(path).includes('第三段。'), '页里的块按规则 1 并进上一页，没有丢');
  assert.deepEqual(errorCodes(path), [], validate(path).stdout);
});
