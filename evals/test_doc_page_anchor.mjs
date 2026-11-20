import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from '../scripts/lib/doc-blocks.mjs';

// 票 38：页标题也可以带一个隐藏锚点（与块锚点同写法、同渲染不可见），页因此成为
// 可批注对象。判据落在两条公开的缝上：`scripts/validate-doc.mjs` 的 JSON 回执，
// 以及工作台的 HTTP 命令面；解析器怎么切块是实现细节，不在这份测试里断言。
const core = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VALIDATOR = join(core, 'scripts', 'validate-doc.mjs');

const sandbox = mkdtempSync(join(tmpdir(), 'planners-page-anchor-'));
after(() => rmSync(sandbox, { recursive: true, force: true }));

const FRONT = '---\ncontract: planners-doc/2\ndoc: storyline\nproject: 页锚点测试\n---\n\n';
let counter = 0;
const docWith = (body) => {
  // 每份文档一个自己的目录：notes.json / baseline.json 都落在文档旁边，不能互相串。
  const dir = join(sandbox, `doc-${++counter}`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'storyline.md');
  writeFileSync(path, `${FRONT}${body}\n`, 'utf8');
  return path;
};

const validate = (path) => {
  const result = spawnSync(process.execPath, [VALIDATOR, path], { encoding: 'utf8' });
  let out = null;
  try { out = JSON.parse(result.stdout); } catch { /* 失败时给断言留原始输出 */ }
  return { code: result.status, out, stdout: result.stdout, stderr: result.stderr };
};
const codesOf = (r) => (r.out?.errors ?? []).map((error) => error.code);
const errorsOf = (r, code) => (r.out?.errors ?? []).filter((error) => error.code === code);

test('页标题可以带隐藏锚点：页有了身份，标题里不含锚点，校验器接受', () => {
  const path = docWith([
    '# 章节',
    '## 页一<!-- b:ab0001 -->',
    '',
    '一段话。<!-- b:ab0002 -->',
  ].join('\n'));

  const parsed = parseDocument(readFileSync(path, 'utf8'), { checkImages: false });
  assert.deepEqual(parsed.errors.map((error) => error.code), [], '页锚点不是错误');
  assert.equal(parsed.pages[0].anchor, 'b:ab0001', '页锚点成为页的身份');
  assert.equal(parsed.pages[0].title, '页一', '标题不含锚点：渲染时看不见');

  const r = validate(path);
  assert.equal(r.code, 0, r.stdout);
  assert.equal(r.out.valid, true);
  assert.deepEqual(codesOf(r), []);
  assert.equal(r.out.checked.pages, 1);
  assert.equal(r.out.checked.anchors, 2, 'anchors 把页锚点与块锚点一起数');
});

test('章节仍然不能带锚点：`#` 不参与可批注这件事', () => {
  const path = docWith([
    '# 章节<!-- b:ac0001 -->',
    '## 页一',
    '',
    '一段话。<!-- b:ac0002 -->',
  ].join('\n'));
  const r = validate(path);
  assert.equal(r.code, 1, r.stdout);
  const [error] = errorsOf(r, 'anchor_on_structure');
  assert.ok(error, JSON.stringify(codesOf(r)));
  assert.equal(error.line, 7);
});

test('页锚点与块锚点共用全局身份：页面之间或页与块之间重复都报 anchor_duplicate', () => {
  const pageThenBlock = docWith([
    '# 章节',
    '## 页一<!-- b:ad0101 -->',
    '',
    '一段话。<!-- b:ad0101 -->',
  ].join('\n'));
  const rBlock = validate(pageThenBlock);
  assert.equal(rBlock.code, 1, rBlock.stdout);
  const [blockDup] = errorsOf(rBlock, 'anchor_duplicate');
  assert.ok(blockDup, JSON.stringify(codesOf(rBlock)));
  assert.equal(blockDup.line, 10, '后出现的块被拒');
  assert.equal(blockDup.block, 'b:ad0101');
  assert.match(blockDup.message, /第 8 行/, '错误里给出页锚点首次出现的行号');

  const twoPages = docWith([
    '# 章节',
    '## 页一<!-- b:ad0102 -->',
    '',
    '一段话。<!-- b:ad0103 -->',
    '',
    '## 页二<!-- b:ad0102 -->',
    '',
    '另一段。<!-- b:ad0104 -->',
  ].join('\n'));
  const rPages = validate(twoPages);
  assert.equal(rPages.code, 1, rPages.stdout);
  const [pageDup] = errorsOf(rPages, 'anchor_duplicate');
  assert.ok(pageDup, JSON.stringify(codesOf(rPages)));
  assert.equal(pageDup.line, 12, '后出现的页被拒');
  assert.equal(pageDup.block, '页「页二」');
  assert.match(pageDup.message, /第 8 行/);
});

test('页锚点写法或位置不合契约照旧报错，不会被当成标题文字吞掉', () => {
  const malformed = docWith([
    '# 章节',
    '## 页一<!-- b:XYZ -->',
    '',
    '一段话。<!-- b:ad0201 -->',
  ].join('\n'));
  const rMalformed = validate(malformed);
  assert.equal(rMalformed.code, 1, rMalformed.stdout);
  const [formatError] = errorsOf(rMalformed, 'anchor_format');
  assert.ok(formatError, JSON.stringify(codesOf(rMalformed)));
  assert.equal(formatError.line, 8);

  const notAtEnd = docWith([
    '# 章节',
    '## 页一<!-- b:ad0202 --> 尾巴',
    '',
    '一段话。<!-- b:ad0203 -->',
  ].join('\n'));
  const rPosition = validate(notAtEnd);
  assert.equal(rPosition.code, 1, rPosition.stdout);
  const [positionError] = errorsOf(rPosition, 'anchor_position');
  assert.ok(positionError, JSON.stringify(codesOf(rPosition)));
  assert.equal(positionError.line, 8);
});

test('页锚点往返不丢：补块锚点时避开页锚点，重复的页锚点重建而标题不动', async () => {
  const { repairAnchors } = await import('../scripts/lib/doc-blocks.mjs');
  const raw = [
    '---',
    'contract: planners-doc/2',
    'doc: storyline',
    'project: 页锚点往返',
    '---',
    '',
    '# 章节',
    '',
    '## 页一<!-- b:aaaaaa -->',
    '',
    '没有锚点的一段。',
    '',
  ].join('\n');
  const pool = ['b:aaaaaa', 'b:bbbbbb'];
  const repaired = repairAnchors(raw, {
    // 只在实现把页锚点也当成「已用身份」时，才会跳过 b:aaaaaa 拿到 b:bbbbbb。
    generate: (seen) => pool.find((anchor) => !seen.has(anchor)),
  });
  assert.equal(repaired.changed, true);
  const after = parseDocument(repaired.raw, { checkImages: false });
  assert.equal(after.pages[0].anchor, 'b:aaaaaa', '页锚点原样保留');
  assert.equal(after.pages[0].title, '页一');
  assert.equal(after.blocks[0].anchor, 'b:bbbbbb', '补出来的块锚点不能与页锚点撞');
  assert.deepEqual(after.errors.map((error) => error.code), []);

  const duplicate = [
    '---',
    'contract: planners-doc/2',
    'doc: storyline',
    'project: 页锚点往返',
    '---',
    '',
    '# 章节',
    '',
    '## 页一<!-- b:cccccc -->',
    '',
    '一段话。<!-- b:cccccd -->',
    '',
    '## 页二<!-- b:cccccc -->',
    '',
    '另一段。<!-- b:ccccce -->',
    '',
  ].join('\n');
  const rebuilt = repairAnchors(duplicate, { generate: () => 'b:dddddd' });
  const rest = parseDocument(rebuilt.raw, { checkImages: false });
  assert.equal(rest.errors.length, 0, JSON.stringify(rest.errors));
  assert.equal(rest.pages[0].anchor, 'b:cccccc', '第一次出现的保留');
  assert.equal(rest.pages[1].anchor, 'b:dddddd', '后出现的页锚点重建');
  assert.equal(rest.pages[1].title, '页二', '重建锚点不动标题');
});

// ── 页锚点在三条结构路径上保持：新增页 / 改名 / 移动 ─────────────────────────
const THREE_PAGES = `# 第一章

## 页一

第一段。<!-- b:b10001 -->

## 页二

第二段。<!-- b:b10002 -->

# 第二章

## 页三

第三段。<!-- b:b10003 -->
`;

async function openWorkbench(t, body = THREE_PAGES) {
  const { startDocWorkbench } = await import('../scripts/doc-workbench.mjs');
  const path = docWith(body);
  const server = await startDocWorkbench({ docPath: path, port: 0 });
  t.after(() => server.close());
  return { path, server, url: server.url };
}

const getDoc = async (url) => {
  const response = await fetch(`${url}/api/doc`);
  assert.equal(response.status, 200);
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

const postStructure = (url, body) => postJson(url, '/api/structure', body);

test('新增页自带页锚点：改名与移动后锚点跟着走，页还是同一个可批注对象', async (t) => {
  const { path, server, url } = await openWorkbench(t);
  const opened = await getDoc(url);

  const added = await postStructure(url, {
    op: 'add-page', chapter: 1, index: 1, title: '页一点五', base_sha256: opened.sha256,
  });
  assert.equal(added.status, 200, JSON.stringify(added.body));
  const pageAnchor = added.body.page.anchor;
  assert.match(pageAnchor, /^b:[0-9a-f]{6,12}$/, '新页也要有页身份，不能等下一次打开才补');
  assert.ok(readFileSync(path, 'utf8').includes(`## 页一点五<!-- ${pageAnchor} -->`), '锚点真的写进标题行');

  // 空页先落一块，之后移动才是完整的一页。
  const empty = await getDoc(url);
  const created = await postJson(url, '/api/block', {
    new: true,
    page: { chapter: 1, index: 2 },
    content: '新页的正文。',
    base_sha256: empty.sha256,
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));

  const renamed = await postStructure(url, {
    op: 'rename-page', chapter: 1, index: 2, title: '页一点五 · 改过',
    base_sha256: created.body.sha256,
  });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
  assert.equal(renamed.body.page.anchor, pageAnchor, '改名不换页身份');
  assert.ok(readFileSync(path, 'utf8').includes(`## 页一点五 · 改过<!-- ${pageAnchor} -->`));

  const moved = await postJson(url, '/api/reorder', {
    op: 'move-page',
    page: { chapter: 1, index: 2 },
    to: { chapter: 2, index: 1, position: 'before' },
    base_sha256: renamed.body.sha256,
  });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  const afterMove = await getDoc(url);
  const movedPage = afterMove.pages.find((page) => page.title === '页一点五 · 改过');
  assert.equal(movedPage?.chapterIndex, 2, '页挪到了第二章');
  assert.equal(movedPage?.anchor, pageAnchor, '移动后锚点跟着走');
  assert.ok(readFileSync(path, 'utf8').includes(`## 页一点五 · 改过<!-- ${pageAnchor} -->`));
  assert.equal(validate(path).code, 0, validate(path).stdout);

  // 页被删掉之后，这个身份才消失：挂在上面的批注由 orphan_notes 兜住（见下一条）。
});

test('没有页锚点的旧页：批注入口按需补一个，已有锚点时幂等', async (t) => {
  const { path, server, url } = await openWorkbench(t, THREE_PAGES);
  const opened = await getDoc(url);
  assert.equal(opened.pages[0].anchor, null, '旧页没有页锚点：不趁打开偷偷改盘');

  const ensured = await postStructure(url, {
    op: 'add-page-anchor', chapter: 1, index: 1, base_sha256: opened.sha256,
  });
  assert.equal(ensured.status, 200, JSON.stringify(ensured.body));
  assert.equal(ensured.body.changed, true);
  const pageAnchor = ensured.body.page.anchor;
  assert.match(pageAnchor, /^b:[0-9a-f]{6,12}$/);
  assert.ok(readFileSync(path, 'utf8').includes(`## 页一<!-- ${pageAnchor} -->`));
  assert.equal(validate(path).code, 0, '带页锚点的文档仍然合规');

  const beforeAgain = readFileSync(path, 'utf8');
  const again = await postStructure(url, {
    op: 'add-page-anchor', chapter: 1, index: 1, base_sha256: ensured.body.sha256,
  });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(again.body.changed, false, '已经有页锚点就不再改盘');
  assert.equal(again.body.page.anchor, pageAnchor);
  assert.equal(readFileSync(path, 'utf8'), beforeAgain);
});

// ── 页是可批注对象：页锚点走和块同一条批注 / 提交 / 孤儿回执 ─────────────────
const NOTE_DOC = `# 第一章

## 页一<!-- b:c10001 -->

第一段。<!-- b:c10002 -->

## 页二<!-- b:c10003 -->

第二段。<!-- b:c10004 -->
`;

test('页锚点往返不丢：只打开不改盘，改别的块也不动页标题行', async (t) => {
  const { path, url } = await openWorkbench(t, NOTE_DOC);
  const before = readFileSync(path, 'utf8');
  const opened = await getDoc(url);
  assert.equal(readFileSync(path, 'utf8'), before, '打开一份每处都有锚点的文档，一个字节都不该改');

  const saved = await postJson(url, '/api/block', {
    anchor: 'b:c10002', content: '第一段改过。', base_sha256: opened.sha256,
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const after = readFileSync(path, 'utf8');
  assert.ok(after.includes('## 页一<!-- b:c10001 -->'), '页一锚点原样在');
  assert.ok(after.includes('## 页二<!-- b:c10003 -->'), '页二锚点原样在');
  assert.ok(after.includes('第一段改过。<!-- b:c10002 -->'), '只改了那一块');
});

test('页锚点可以批注：草稿挂在这一页上，提交时作为任务目标一起走', async (t) => {
  const { url } = await openWorkbench(t, NOTE_DOC);
  const opened = await getDoc(url);
  assert.equal(opened.pages[0].anchor, 'b:c10001', '页视图带自己的锚点');

  const added = await postJson(url, '/api/note', { anchor: 'b:c10001', text: '这一页的标题换个说法' });
  assert.equal(added.status, 200, JSON.stringify(added.body));
  assert.equal(added.body.note.anchor, 'b:c10001');
  assert.deepEqual(added.body.note.page, { chapter: 1, index: 1 }, '页批注记在自己这一页上');

  const submitted = await postJson(url, '/api/note/submit', {});
  assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
  assert.deepEqual(submitted.body.committed, [added.body.note.id], '页批注和块批注进同一批');
  assert.deepEqual(submitted.body.orphaned, []);
  assert.ok(submitted.body.task.blocks.some((block) => block.anchor === 'b:c10001'), '任务绑定页锚点');
  assert.match(submitted.body.task.text, /这一页的标题换个说法/);
});

test('页被删掉时，挂在上面的批注进 orphan_notes：留在草稿里，不静默消失', async (t) => {
  const { path, url } = await openWorkbench(t, NOTE_DOC);
  const pageNote = await postJson(url, '/api/note', { anchor: 'b:c10003', text: '页二的批注' });
  const blockNote = await postJson(url, '/api/note', { anchor: 'b:c10002', text: '块上的批注' });
  assert.equal(pageNote.status, 200, JSON.stringify(pageNote.body));
  assert.equal(blockNote.status, 200, JSON.stringify(blockNote.body));

  // 页被删掉：连同它的标题行与唯一一块（模拟 39 号票的删除语义 / 外部工具改稿）。
  const before = readFileSync(path, 'utf8');
  writeFileSync(path, before.replace(/## 页二<!-- b:c10003 -->[\s\S]*$/, ''), 'utf8');

  const submitted = await postJson(url, '/api/note/submit', {});
  assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
  assert.deepEqual(submitted.body.orphaned.map((entry) => entry.anchor), ['b:c10003']);
  assert.equal(submitted.body.orphaned[0].reason, 'target_page_removed', '说清失去的是一页');
  assert.deepEqual(submitted.body.diff.orphan_notes, [{
    note: pageNote.body.note.id,
    text: '页二的批注',
    reason: 'target_page_removed',
  }], '结构 diff 里一并给模型');

  const listed = await fetch(`${url}/api/notes`).then((response) => response.json());
  const kept = listed.notes.find((note) => note.id === pageNote.body.note.id);
  assert.equal(kept.state, 'draft', '失去目标的页批注留在草稿里');
  assert.equal(kept.batch, null);
});

test('页改名之后，页锚点上的批注仍然有效，不会变成孤儿', async (t) => {
  const { url } = await openWorkbench(t, NOTE_DOC);
  const opened = await getDoc(url);
  const added = await postJson(url, '/api/note', { anchor: 'b:c10003', text: '这一页再收一收' });
  assert.equal(added.status, 200, JSON.stringify(added.body));

  const renamed = await postStructure(url, {
    op: 'rename-page', chapter: 1, index: 2, title: '页二 · 改过', base_sha256: opened.sha256,
  });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
  assert.equal(renamed.body.page.anchor, 'b:c10003', '改名不换页身份');

  const submitted = await postJson(url, '/api/note/submit', {});
  assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
  assert.deepEqual(submitted.body.orphaned, [], '改名不是删除');
  assert.deepEqual(submitted.body.committed, [added.body.note.id]);
});

// ── 页标题右侧的批注气泡：与块同一套交互，点了直接落草稿进抽屉 ──────────────
async function openBrowser(t) {
  const { loadPlaywright } = await import('./acceptance/lib/harness.mjs');
  const browserInfo = await loadPlaywright();
  if (!browserInfo.available) {
    t.skip(`跳过真实页面验收：${browserInfo.reason}`);
    return null;
  }
  const dir = join(sandbox, `browser-${++counter}`);
  mkdirSync(dir, { recursive: true });
  const docPath = join(dir, 'storyline.md');
  writeFileSync(docPath, `${FRONT}# 一、判断

## 有锚点的页<!-- b:e10001 -->

这一段正常。<!-- b:e10002 -->

## 没锚点的页

这一段也正常。<!-- b:e10003 -->
`, 'utf8');

  const { startDocWorkbench } = await import('../scripts/doc-workbench.mjs');
  const server = await startDocWorkbench({ docPath, port: 0 });
  const browser = await browserInfo.playwright.chromium.launch({ headless: true });
  t.after(async () => {
    await browser.close();
    await server.close();
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(server.url, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.body.dataset.layout === 'wide');
  return { page, docPath };
}

test('页标题右侧也有批注气泡：点击直接落草稿进抽屉，不弹浮层', async (t) => {
  const opened = await openBrowser(t);
  if (!opened) return;
  const { page, docPath } = opened;

  assert.equal(await page.locator('.page-divider[data-page-key="1-1"] .page-title').innerText(), '有锚点的页',
    '锚点不进渲染：页标题读不到那段注释');
  const bubble = page.locator('.page-divider[data-page-key="1-1"] .page-feedback');
  assert.equal(await bubble.count(), 1, '页标题右侧有一个批注气泡');
  assert.equal(await bubble.locator('svg').count(), 1, '用的是与块同一套图标');
  assert.equal(await page.locator('.chapter-divider .page-feedback').count(), 0, '章节没有批注气泡');
  assert.equal(await page.locator('.doc-block[data-anchor="b:e10002"] .block-feedback').count(), 1,
    '块的批注气泡照旧');

  await bubble.click({ force: true });
  const draft = page.locator('#notesList .note-draft textarea');
  await draft.waitFor({ state: 'visible' });
  assert.equal(await draft.evaluate((node) => document.activeElement === node), true, '光标进入这条草稿');
  assert.equal(await page.locator('.feedback-composer').count(), 0, '正文上没有浮层');
  assert.equal(await page.locator('#notesList .note-draft .note-quote').innerText(), '有锚点的页',
    '页批注引用的就是这一页的标题');

  await draft.fill('这一页的标题再直白一点');
  await draft.blur();
  await page.waitForFunction(() => {
    const textarea = document.querySelector('#notesList .note-draft textarea');
    return !textarea;
  }, { timeout: 5000 });

  const saved = JSON.parse(readFileSync(join(dirname(docPath), '.doc-workbench', 'notes.json'), 'utf8'));
  const note = saved.notes.find((item) => item.anchor === 'b:e10001');
  assert.ok(note, `页批注要落盘到页锚点：${JSON.stringify(saved.notes)}`);
  assert.equal(note.target, 'page');
  assert.equal(note.text, '这一页的标题再直白一点');

  // 点抽屉里这一条：正文滚到页标题、短暂高亮（和块批注同一条跳转路径）。
  await page.locator('#notesList .note-row .note-jump').first().click();
  await page.waitForFunction(() => document.querySelector('.page-divider[data-page-key="1-1"]').classList.contains('is-note-flash'),
    { timeout: 3000 });
});

test('旧页没有页锚点：点它的批注气泡先补一个隐藏锚点，再落草稿', async (t) => {
  const opened = await openBrowser(t);
  if (!opened) return;
  const { page, docPath } = opened;

  assert.doesNotMatch(readFileSync(docPath, 'utf8'), /## 没锚点的页<!--/, '前提：这一页还没有页锚点');
  const bubble = page.locator('.page-divider[data-page-key="1-2"] .page-feedback');
  await bubble.click({ force: true });
  const draft = page.locator('#notesList .note-draft textarea');
  await draft.waitFor({ state: 'visible' });

  const savedText = readFileSync(docPath, 'utf8');
  const match = savedText.match(/## 没锚点的页<!-- (b:[0-9a-f]{6,12}) -->/);
  assert.ok(match, `点批注入口时补上页锚点：${savedText}`);
  assert.equal(await page.locator('#notesList .note-draft .note-quote').innerText(), '没锚点的页');
});

test('结构 diff 认页锚点：页改名只说改名，不说「删一页再加一页」', async (t) => {
  const { path, url } = await openWorkbench(t, NOTE_DOC);
  const { buildDocSurface } = await import('../scripts/doc-surface.mjs');
  const { runDocCommand } = await import('../scripts/doc-command.mjs');
  const built = buildDocSurface({ docPath: path });
  const data = JSON.parse(readFileSync(built.surfacePath, 'utf8'));
  const base = dirname(built.surfacePath);
  const surface = {
    file: built.surfacePath,
    base,
    data,
    dir: resolve(base, data.dir),
    projectRoot: resolve(base, data.project_root),
  };
  // 模型侧取稿：基准记下它当时看到的结构（含页锚点）。
  const fetched = await runDocCommand(surface, { route: 'tasks' }, { browser: false });
  assert.equal(fetched.ok, true, JSON.stringify(fetched));
  const opened = await getDoc(url);

  const renamed = await postStructure(url, {
    op: 'rename-page', chapter: 1, index: 2, title: '页二 · 改过', base_sha256: opened.sha256,
  });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.body));

  const note = await postJson(url, '/api/note', { anchor: 'b:c10003', text: '这一页再收一收' });
  assert.equal(note.status, 200, JSON.stringify(note.body));
  const submitted = await postJson(url, '/api/note/submit', {});
  assert.equal(submitted.status, 200, JSON.stringify(submitted.body));

  assert.deepEqual(submitted.body.diff.pages, [{
    action: 'renamed',
    from: [{ chapter: 1, index: 2, title: '页二' }],
    to: { chapter: 1, index: 2, title: '页二 · 改过' },
  }], '页锚点还在同一页：只说改名，不说删一页再加一页');
});
