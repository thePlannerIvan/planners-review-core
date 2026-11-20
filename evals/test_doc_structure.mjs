import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// 只测公开的缝：工作台的 HTTP 命令面（POST /api/structure）与磁盘上的文本 + 校验器。
// 结构怎么定位、插在第几行是实现细节；断言只落在「标题行变了、其余逐字不动、目录视图跟着变」。
const core = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VALIDATOR = join(core, 'scripts', 'validate-doc.mjs');

const sandboxes = [];
after(() => { for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true }); });

const FRONT = '---\ncontract: planners-doc/2\ndoc: storyline\nproject: 结构测试\n---\n\n';
const ANCHOR = /^b:[0-9a-f]{6,12}$/;

/** 两章三页：第 1 章两页，第 2 章一页；每页各有一块，锚点齐全。 */
const THREE_PAGES = `# 第一章

## 页一

第一段。<!-- b:aaaaaa -->

第二段。<!-- b:bbbbbb -->

## 页二

第三段。<!-- b:cccccc -->

# 第二章

## 页三

第四段。<!-- b:dddddd -->
`;

function scratchDoc(body = THREE_PAGES) {
  const dir = mkdtempSync(join(tmpdir(), 'planners-structure-'));
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

const blockOf = (doc, anchor) => doc.blocks.find((block) => block.anchor === anchor) ?? null;
const linesOf = (text) => text.split(/\r?\n/);
const anchorCount = (text) => (text.match(/<!-- b:[0-9a-f]{6,12} -->/g) ?? []).length;

async function openWorkbench(t, docPath) {
  const { startDocWorkbench } = await import('../scripts/doc-workbench.mjs');
  const server = await startDocWorkbench({ docPath, port: 0 });
  t.after(() => server.close());
  return server;
}

/** 找到某个标题行，用来断言插入位置在谁之前 / 谁之后。 */
const headingLine = (text, heading) => linesOf(text).findIndex((line) => line === heading);

// ── 改名：点进去能改，失焦写回；只有标题行变化 ──────────────────────────────
test('改章节名与页名：只有标题行变化，块 raw 与锚点逐字不动，回执与磁盘一致', async (t) => {
  const { path } = scratchDoc();
  const original = readFileSync(path, 'utf8');
  const server = await openWorkbench(t, path);
  const before = await getDoc(server.url);

  const renamedChapter = await postStructure(server.url, {
    op: 'rename-chapter',
    chapter: 1,
    title: '一、重新判断',
    base_sha256: before.sha256,
  });
  assert.equal(renamedChapter.status, 200, JSON.stringify(renamedChapter.body));
  assert.equal(renamedChapter.body.ok, true);
  assert.equal(renamedChapter.body.changed, true);
  assert.deepEqual(
    { index: renamedChapter.body.chapter.index, title: renamedChapter.body.chapter.title },
    { index: 1, title: '一、重新判断' },
    '回执要说清改了哪一章',
  );

  const afterChapter = await getDoc(server.url);
  assert.equal(afterChapter.sha256, renamedChapter.body.sha256, '回执与下一次打开是同一版');
  assert.deepEqual(afterChapter.chapters.map((chapter) => chapter.title), ['一、重新判断', '第二章'], '章节标题跟着变');
  assert.deepEqual(afterChapter.pages.map((page) => page.title), ['页一', '页二', '页三'], '页名没有被顺手改掉');
  for (const block of before.blocks) {
    const now = blockOf(afterChapter, block.anchor);
    assert.ok(now, `块 ${block.anchor} 不应消失`);
    assert.equal(now.raw, block.raw, `块 ${block.anchor} 的 raw 必须逐字不变`);
    assert.equal(now.sha256, block.sha256, `块 ${block.anchor} 的指纹必须不变`);
  }
  assert.equal(anchorCount(readFileSync(path, 'utf8')), anchorCount(original), '锚点一个不增一个不减');

  const renamedPage = await postStructure(server.url, {
    op: 'rename-page',
    chapter: 1,
    index: 1,
    title: '页一 · 改过',
    base_sha256: renamedChapter.body.sha256,
  });
  assert.equal(renamedPage.status, 200, JSON.stringify(renamedPage.body));
  assert.equal(renamedPage.body.page.chapter, 1);
  assert.equal(renamedPage.body.page.index, 1);
  assert.equal(renamedPage.body.page.title, '页一 · 改过');

  const saved = readFileSync(path, 'utf8');
  assert.ok(saved.includes('# 一、重新判断\n'), '章节标题行按新名字写回');
  assert.ok(saved.includes('## 页一 · 改过\n'), '页标题行按新名字写回');
  assert.ok(saved.includes('## 页二\n') && saved.includes('## 页三\n'), '别的页标题不动');
  // 除去两行标题，其余字节与原来完全一致。
  const withoutChapterTitle = (text, chapterTitle) => text.replace(`# ${chapterTitle}\n`, '# 第一章\n');
  const withoutPageTitle = (text, pageTitle) => text.replace(`## ${pageTitle}\n`, '## 页一\n');
  assert.equal(
    withoutPageTitle(withoutChapterTitle(saved, '一、重新判断'), '页一 · 改过'),
    original,
    '改名只换标题文字，其余字节逐字不动',
  );

  const after = await getDoc(server.url);
  assert.deepEqual(after.pages.map((page) => page.title), ['页一 · 改过', '页二', '页三'], '目录读到的页名立即更新');
  assert.equal(after.pages[0].chapter, '一、重新判断', '目录里的章节名也立即更新');
  assert.equal(validate(path).code, 0, `改名后仍合规：${validate(path).stdout}`);
});

test('改名拒绝：过期基线、空标题、找不到章节/页都不落盘；改成同名不算一次写', async (t) => {
  const { path } = scratchDoc();
  const original = readFileSync(path, 'utf8');
  const server = await openWorkbench(t, path);
  const before = await getDoc(server.url);

  const stale = await postStructure(server.url, {
    op: 'rename-page',
    chapter: 1,
    index: 1,
    title: '不该落盘',
    base_sha256: '0'.repeat(64),
  });
  assert.equal(stale.status, 409, JSON.stringify(stale.body));
  assert.equal(stale.body.code, 'stale_document', '过期基线要和重排同码');

  const empty = await postStructure(server.url, {
    op: 'rename-chapter',
    chapter: 1,
    title: '   ',
    base_sha256: before.sha256,
  });
  assert.equal(empty.status, 400, JSON.stringify(empty.body));
  assert.equal(empty.body.code, 'structure_title', '空标题不写盘');

  const missingChapter = await postStructure(server.url, {
    op: 'rename-chapter',
    chapter: 9,
    title: '第九章',
    base_sha256: before.sha256,
  });
  assert.equal(missingChapter.status, 409, JSON.stringify(missingChapter.body));
  assert.equal(missingChapter.body.code, 'chapter_missing');

  const missingPage = await postStructure(server.url, {
    op: 'rename-page',
    chapter: 1,
    index: 9,
    title: '第九页',
    base_sha256: before.sha256,
  });
  assert.equal(missingPage.status, 409, JSON.stringify(missingPage.body));
  assert.equal(missingPage.body.code, 'page_missing');

  const unknown = await postStructure(server.url, {
    op: 'rename-doc',
    title: '整份改名',
    base_sha256: before.sha256,
  });
  assert.equal(unknown.status, 400, JSON.stringify(unknown.body));
  assert.equal(unknown.body.code, 'structure_op', '结构操作只有四个动作名');

  assert.equal(readFileSync(path, 'utf8'), original, '被拒绝的结构操作一个字节都不写');

  const same = await postStructure(server.url, {
    op: 'rename-chapter',
    chapter: 1,
    title: '第一章',
    base_sha256: before.sha256,
  });
  assert.equal(same.status, 200, JSON.stringify(same.body));
  assert.equal(same.body.changed, false, '改成同名不算一次写');
  assert.equal(readFileSync(path, 'utf8'), original);
});

// ── 加页：页尾加一页，落在同章同位置，新页有可写的第一块 ────────────────────
test('页尾加页：新页插在这一页之后，仍在同一章；目录与页序立即更新', async (t) => {
  const { path } = scratchDoc();
  const server = await openWorkbench(t, path);
  const before = await getDoc(server.url);

  const added = await postStructure(server.url, {
    op: 'add-page',
    chapter: 1,
    index: 1,
    base_sha256: before.sha256,
  });
  assert.equal(added.status, 200, JSON.stringify(added.body));
  assert.equal(added.body.ok, true);
  assert.equal(added.body.changed, true);
  assert.equal(added.body.page.chapter, 1, '新页留在同一章');
  assert.equal(added.body.page.index, 2, '新页插在页一之后，成为这一章第 2 页');
  assert.equal(added.body.page.title, '新页');
  assert.match(added.body.page.anchor, ANCHOR, '新页的第一块有独立锚点');

  const saved = readFileSync(path, 'utf8');
  const lines = linesOf(saved);
  const newHeading = headingLine(saved, '## 新页');
  assert.ok(newHeading > headingLine(saved, '第二段。<!-- b:bbbbbb -->'), '新页在页一最后一块之后');
  assert.ok(newHeading < headingLine(saved, '## 页二'), '新页在页二之前');
  assert.equal(lines[newHeading + 1], '', '页标题下空一行');
  assert.match(lines[newHeading + 2], /^在这里写这一页。<!-- b:[0-9a-f]{6,12} -->$/, '新页第一块与锚点在同一行');
  assert.equal(lines[newHeading + 3], '', '新页与下一页之间空一行');
  assert.equal(validate(path).code, 0, `加页后仍合规：${validate(path).stdout}`);

  const after = await getDoc(server.url);
  assert.deepEqual(after.pages.map((page) => `${page.chapterIndex}:${page.index}:${page.title}`), [
    '1:1:页一', '1:2:新页', '1:3:页二', '2:1:页三',
  ], '页序按新顺序重排，章节归属不变');
  const newPage = after.pages.find((page) => page.title === '新页');
  assert.equal(newPage.chapter, '第一章');
  assert.equal(newPage.sources, 0, '新页还没有出处区');
  const pageBlocks = after.blocks.filter((block) => block.page.key === newPage.key);
  assert.equal(pageBlocks.length, 1, '新页有一个可写的第一块');
  assert.equal(pageBlocks[0].anchor, added.body.page.anchor);
  assert.equal(pageBlocks[0].type, 'paragraph');
  for (const block of before.blocks) {
    const now = blockOf(after, block.anchor);
    assert.ok(now, `块 ${block.anchor} 不应消失`);
    assert.equal(now.raw, block.raw, `块 ${block.anchor} 的 raw 必须逐字不变`);
  }

  // 页尾也成立：一章最后一页加页，落在本章末尾、下一章标题之前。
  const appended = await postStructure(server.url, {
    op: 'add-page',
    chapter: 1,
    index: 3,
    base_sha256: after.sha256,
  });
  assert.equal(appended.status, 200, JSON.stringify(appended.body));
  const last = await getDoc(server.url);
  assert.deepEqual(last.pages.map((page) => `${page.chapterIndex}:${page.index}:${page.title}`), [
    '1:1:页一', '1:2:新页', '1:3:页二', '1:4:新页', '2:1:页三',
  ], '章末加页不进下一章');
  const appendedText = readFileSync(path, 'utf8');
  assert.ok(headingLine(appendedText, '## 新页') >= 0);
  assert.equal(validate(path).code, 0, `章末加页仍合规：${validate(path).stdout}`);
});

// ── 加章：章节尾加一章（带第一页），目录立即多一级 ──────────────────────────
test('章节尾加章：新章带第一页插在这一章之后，章末加章落在文件末尾', async (t) => {
  const { path } = scratchDoc();
  const server = await openWorkbench(t, path);
  const before = await getDoc(server.url);

  const added = await postStructure(server.url, {
    op: 'add-chapter',
    chapter: 1,
    base_sha256: before.sha256,
  });
  assert.equal(added.status, 200, JSON.stringify(added.body));
  assert.deepEqual(
    { index: added.body.chapter.index, title: added.body.chapter.title },
    { index: 2, title: '新章节' },
    '回执要说清加的是第几章',
  );
  assert.equal(added.body.page.chapter, 2);
  assert.equal(added.body.page.index, 1);
  assert.match(added.body.page.anchor, ANCHOR);

  const saved = readFileSync(path, 'utf8');
  const chapterLine = headingLine(saved, '# 新章节');
  const pageLine = headingLine(saved, '## 新页');
  assert.ok(chapterLine > headingLine(saved, '## 页二'), '新章在这一章最后一页之后');
  assert.ok(chapterLine < headingLine(saved, '# 第二章'), '新章在下一章之前');
  assert.equal(pageLine, chapterLine + 2, '新章紧跟着自己的第一页（中间空一行）');
  assert.match(linesOf(saved)[pageLine + 2], /^在这里写这一页。<!-- b:[0-9a-f]{6,12} -->$/, '新章第一页有可写的第一块');
  assert.equal(validate(path).code, 0, `加章后仍合规：${validate(path).stdout}`);

  const after = await getDoc(server.url);
  assert.deepEqual(after.chapters.map((chapter) => chapter.title), ['第一章', '新章节', '第二章'], '目录里的章节立即更新');
  assert.deepEqual(after.pages.map((page) => `${page.chapterIndex}:${page.index}:${page.title}`), [
    '1:1:页一', '1:2:页二', '2:1:新页', '3:1:页三',
  ], '新章只有一页，后面的章节整体后移');
  assert.equal(after.pages[2].chapter, '新章节');
  assert.deepEqual(
    after.blocks.map((block) => block.anchor).sort(),
    [...before.blocks.map((block) => block.anchor), added.body.page.anchor].sort(),
    '加章只新增一块，旧块身份全部保留',
  );
  for (const block of before.blocks) {
    assert.equal(blockOf(after, block.anchor).raw, block.raw, `块 ${block.anchor} 的 raw 必须逐字不变`);
  }

  // 最后一章加章：落在文件末尾，后面没有别的章节可夹。
  const appended = await postStructure(server.url, {
    op: 'add-chapter',
    chapter: 3,
    base_sha256: after.sha256,
  });
  assert.equal(appended.status, 200, JSON.stringify(appended.body));
  assert.equal(appended.body.chapter.index, 4);
  const appendedText = readFileSync(path, 'utf8');
  assert.ok(appendedText.trimEnd().endsWith(`<!-- ${appended.body.page.anchor} -->`), '新章落在文件末尾');
  const last = await getDoc(server.url);
  assert.deepEqual(last.chapters.map((chapter) => chapter.title), ['第一章', '新章节', '第二章', '新章节']);
  assert.equal(validate(path).code, 0, `章末加章仍合规：${validate(path).stdout}`);
});
