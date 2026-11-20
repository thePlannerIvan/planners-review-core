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

/** 找到某个标题行，用来断言插入位置在谁之前 / 谁之后。页标题可能带一个隐藏页锚点（票 38）。 */
const headingLine = (text, heading) => linesOf(text)
  .findIndex((line) => line === heading || line.startsWith(`${heading}<!--`));

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

test('改名拒绝：空标题、找不到章节/页都不落盘；改成同名不算一次写', async (t) => {
  const { path } = scratchDoc();
  const original = readFileSync(path, 'utf8');
  const server = await openWorkbench(t, path);
  const before = await getDoc(server.url);

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

// ── 基线过期：自动重读并重放，不拿 409 拦人，也不覆盖别处的新改动 ──────────────
test('结构操作基线过期时自动重读并重放：别处的新改动不被覆盖，回执说明重放过', async (t) => {
  const { path } = scratchDoc();
  const server = await openWorkbench(t, path);
  const before = await getDoc(server.url);

  // 另一个窗口先改了一页标题：磁盘已经不是 before 那一版。
  const elsewhere = await postStructure(server.url, {
    op: 'rename-page',
    chapter: 1,
    index: 2,
    title: '页二 · 别处改的',
    base_sha256: before.sha256,
  });
  assert.equal(elsewhere.status, 200, JSON.stringify(elsewhere.body));

  // 这个窗口还拿着旧基线改第 1 页：不 409，重读当前全文再重放。
  const replayed = await postStructure(server.url, {
    op: 'rename-page',
    chapter: 1,
    index: 1,
    title: '页一 · 重放',
    base_sha256: before.sha256,
  });
  assert.equal(replayed.status, 200, JSON.stringify(replayed.body));
  assert.equal(replayed.body.ok, true);
  assert.equal(replayed.body.replayed, true, '回执要说明这次是在新版本上重放的');

  const after = await getDoc(server.url);
  assert.deepEqual(after.pages.map((page) => page.title), ['页一 · 重放', '页二 · 别处改的', '页三'],
    '这次改动重放上去了，别处的新改动也还在');
  assert.equal(validate(path).code, 0, `重放后仍是合规文档：${validate(path).stdout}`);

  // 加页与加出处也走同一条语义：过期基线不拒，落点是重读后的结构。
  const addedPage = await postStructure(server.url, {
    op: 'add-page',
    chapter: 1,
    index: 2,
    title: '页二点五',
    base_sha256: before.sha256,
  });
  assert.equal(addedPage.status, 200, JSON.stringify(addedPage.body));
  assert.equal(addedPage.body.replayed, true);
  assert.equal(addedPage.body.page.title, '页二点五');
  assert.equal(addedPage.body.page.index, 3, '新页插在重读后的第 2 页之后');

  const addedChapter = await postStructure(server.url, {
    op: 'add-chapter',
    chapter: 2,
    base_sha256: before.sha256,
  });
  assert.equal(addedChapter.status, 200, JSON.stringify(addedChapter.body));
  assert.equal(addedChapter.body.replayed, true);
  const last = await getDoc(server.url);
  assert.deepEqual(last.chapters.map((chapter) => chapter.title), ['第一章', '第二章', '新章节'],
    '加章落在重读后的第 2 章之后（末尾），不是旧结构的位置');
});

// ── 加页：页尾加一页，落在同章同位置；文件里是真正的空页（没有占位正文） ──────
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
  assert.match(added.body.page.anchor, /^b:[0-9a-f]{6,12}$/, '空页没有块身份，但新页自带页锚点（票 38）');

  const saved = readFileSync(path, 'utf8');
  const lines = linesOf(saved);
  const newHeading = headingLine(saved, '## 新页');
  assert.ok(newHeading > headingLine(saved, '第二段。<!-- b:bbbbbb -->'), '新页在页一最后一块之后');
  assert.ok(newHeading < headingLine(saved, '## 页二'), '新页在页二之前');
  assert.equal(lines[newHeading + 1], '', '页标题下空一行');
  assert.equal(lines[newHeading + 2], '## 页二', '空页里没有正文：标题之后直接是下一页');
  assert.doesNotMatch(saved, /在这里写这一页/, '文件里不能留占位正文');
  const emptyVerdict = validate(path);
  assert.equal(emptyVerdict.code, 1, '真正的空页由交付校验器报出来');
  assert.deepEqual(emptyVerdict.out.errors.map((error) => error.code), ['page_empty']);

  const after = await getDoc(server.url);
  assert.deepEqual(after.pages.map((page) => `${page.chapterIndex}:${page.index}:${page.title}`), [
    '1:1:页一', '1:2:新页', '1:3:页二', '2:1:页三',
  ], '页序按新顺序重排，章节归属不变');
  const newPage = after.pages.find((page) => page.title === '新页');
  assert.equal(newPage.chapter, '第一章');
  assert.equal(newPage.sources, 0, '新页还没有出处区');
  assert.equal(newPage.blocks, 0, '新页是真正的空页');
  assert.equal(after.blocks.length, before.blocks.length, '加页不凭空多出一块');
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
  assert.equal((appendedText.match(/## 新页/g) ?? []).length, 2, '章末又加了一页空页');
  assert.doesNotMatch(appendedText, /在这里写这一页/);
  assert.equal(validate(path).code, 1, '空页仍然由交付校验器报出来');
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
  assert.match(added.body.page.anchor, /^b:[0-9a-f]{6,12}$/, '新章的第一页也是真正的空页，但有页锚点（票 38）');

  const saved = readFileSync(path, 'utf8');
  const chapterLine = headingLine(saved, '# 新章节');
  const pageLine = headingLine(saved, '## 新页');
  assert.ok(chapterLine > headingLine(saved, '## 页二'), '新章在这一章最后一页之后');
  assert.ok(chapterLine < headingLine(saved, '# 第二章'), '新章在下一章之前');
  assert.equal(pageLine, chapterLine + 2, '新章紧跟着自己的第一页（中间空一行）');
  assert.equal(linesOf(saved)[pageLine + 1], '', '页标题下空一行');
  assert.equal(linesOf(saved)[pageLine + 2], '# 第二章', '空页里没有正文');
  assert.doesNotMatch(saved, /在这里写这一页/, '文件里不能留占位正文');
  const emptyVerdict = validate(path);
  assert.equal(emptyVerdict.code, 1, '真正的空页由交付校验器报出来');
  assert.deepEqual(emptyVerdict.out.errors.map((error) => error.code), ['page_empty']);

  const after = await getDoc(server.url);
  assert.deepEqual(after.chapters.map((chapter) => chapter.title), ['第一章', '新章节', '第二章'], '目录里的章节立即更新');
  assert.deepEqual(after.pages.map((page) => `${page.chapterIndex}:${page.index}:${page.title}`), [
    '1:1:页一', '1:2:页二', '2:1:新页', '3:1:页三',
  ], '新章只有一页，后面的章节整体后移');
  assert.equal(after.pages[2].chapter, '新章节');
  assert.deepEqual(
    after.blocks.map((block) => block.anchor).sort(),
    before.blocks.map((block) => block.anchor).sort(),
    '加章不新增块，旧块身份全部保留',
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
  assert.match(appendedText.trimEnd(), /## 新页(?:<!-- b:[0-9a-f]{6,12} -->)?$/, '新章落在文件末尾（最后一页是空页）');
  const last = await getDoc(server.url);
  assert.deepEqual(last.chapters.map((chapter) => chapter.title), ['第一章', '新章节', '第二章', '新章节']);
  assert.equal(validate(path).code, 1, '空页仍然由交付校验器报出来');
});

// ── 页中间加章节 / 加页：落点永远是结构边界，页里的块一个都不被推出去（票 34） ──
// 现场：一页两块列表 + 一组出处，人在页中间点「＋ 新章节」，新章落在第二个列表项之后，
// 该页剩下的列表项与整组出处全成了页外块（校验器报 block_outside_page）。
// 判据只落在公开的缝：磁盘上的文本 + 目录快照 + 校验器。
const MIDDLE_PAGE = `# 第一章

## 页一

主张句。<!-- b:aaaaaa -->

- 列表一。<!-- b:bbbbbb -->

- 列表二。<!-- b:cccccc -->

> 出处一。<!-- b:dddddd -->

> 出处二。<!-- b:eeeeee -->

## 页二

第二页的段落。<!-- b:ffffff -->

# 第二章

## 页三

第三页的段落。<!-- b:999999 -->
`;

const pageOfBlock = (doc, anchor) => doc.blocks.find((block) => block.anchor === anchor)?.page ?? null;

test('在页中间加章节：新章落在章节边界之后，该页原有块全部仍在这一页里', async (t) => {
  const { path } = scratchDoc(MIDDLE_PAGE);
  const server = await openWorkbench(t, path);
  const before = await getDoc(server.url);

  // 人正在第 1 章第 1 页中间点「＋ 新章节」：请求只说明「我在这页」。
  const added = await postStructure(server.url, {
    op: 'add-chapter',
    page: { chapter: 1, index: 1 },
    base_sha256: before.sha256,
  });
  assert.equal(added.status, 200, JSON.stringify(added.body));
  assert.equal(added.body.ok, true);
  assert.deepEqual(
    { index: added.body.chapter.index, title: added.body.chapter.title },
    { index: 2, title: '新章节' },
    '新章插在第 1 章之后，成为第 2 章',
  );

  const saved = readFileSync(path, 'utf8');
  const chapterLine = headingLine(saved, '# 新章节');
  assert.ok(chapterLine > 0, `文件里要有新章节标题行：${saved}`);
  assert.ok(chapterLine > headingLine(saved, '第二页的段落。<!-- b:ffffff -->'),
    '新章在这一章最后一页之后，不是在第 1 页中间');
  assert.ok(chapterLine < headingLine(saved, '# 第二章'), '新章在下一章之前');

  const after = await getDoc(server.url);
  for (const anchor of ['b:aaaaaa', 'b:bbbbbb', 'b:cccccc', 'b:dddddd', 'b:eeeeee']) {
    const page = pageOfBlock(after, anchor);
    assert.ok(page, `块 ${anchor} 不应被推出页外`);
    assert.equal(page.title, '页一', `块 ${anchor} 仍在这一页里`);
  }
  const pageOne = after.pages.find((item) => item.title === '页一');
  assert.equal(pageOne.blocks, 5, '这一页的五个块一个不丢');
  assert.equal(pageOne.sources, 2, '整组出处仍在这一页里');
  assert.deepEqual(after.pages.map((page) => `${page.chapterIndex}:${page.index}:${page.title}`), [
    '1:1:页一', '1:2:页二', '2:1:新页', '3:1:页三',
  ], '新章只有一页，后面的章节整体后移');

  const verdict = validate(path);
  assert.equal(verdict.code, 1, '新章的第一页是空页，由交付校验器报出来');
  assert.deepEqual(verdict.out.errors.map((error) => error.code), ['page_empty'],
    '只有空页这类内容级问题，没有 block_outside_page');
});

test('在页中间加页：新页落在页边界之后，出处区整组仍在这一页里', async (t) => {
  const { path } = scratchDoc(MIDDLE_PAGE);
  const server = await openWorkbench(t, path);
  const before = await getDoc(server.url);

  const added = await postStructure(server.url, {
    op: 'add-page',
    page: { chapter: 1, index: 1 },
    base_sha256: before.sha256,
  });
  assert.equal(added.status, 200, JSON.stringify(added.body));
  assert.equal(added.body.page.chapter, 1);
  assert.equal(added.body.page.index, 2);

  const saved = readFileSync(path, 'utf8');
  const pageLine = headingLine(saved, '## 新页');
  assert.ok(pageLine > headingLine(saved, '> 出处二。<!-- b:eeeeee -->'), '新页在页一最后一块之后');
  assert.ok(pageLine < headingLine(saved, '## 页二'), '新页在页二之前');

  const after = await getDoc(server.url);
  for (const anchor of ['b:aaaaaa', 'b:bbbbbb', 'b:cccccc', 'b:dddddd', 'b:eeeeee']) {
    assert.equal(pageOfBlock(after, anchor)?.title, '页一', `块 ${anchor} 仍在这一页里`);
  }
  assert.equal(after.pages.find((item) => item.title === '页一').blocks, 5, '页一的块一个不丢');

  const verdict = validate(path);
  assert.deepEqual(verdict.out.errors.map((error) => error.code), ['page_empty'],
    '只有空页这类内容级问题，没有 block_outside_page');
});
