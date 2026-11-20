import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// 票 23「编辑器不拦人」：只测公开的缝——工作台的 HTTP 命令面与磁盘上的文本。
// 结构不合规不再是写不进去的理由；结构问题降级成快照里的提示，校验器留在交付口。
// 判据（ADR 0006）：保存永远成功；文件在别处变了就重读重放，只有重放到同一块才停下来问人；
// 锁只锁模型正在写的那几块。
const core = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VALIDATOR = join(core, 'scripts', 'validate-doc.mjs');

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

const sandboxes = [];
after(() => { for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true }); });

const FRONT = '---\ncontract: planners-doc/2\ndoc: storyline\nproject: 不拦人测试\n---\n\n';

/** 两章两页：页一有两块，页二只有一块（方便把页清空、把章节清空）。 */
const TWO_CHAPTERS = `# 第一章

## 页一

块一。<!-- b:aaaaaa -->

块二。<!-- b:bbbbbb -->

# 第二章

## 页二

块三。<!-- b:cccccc -->
`;

function scratchDoc(body = TWO_CHAPTERS) {
  const dir = mkdtempSync(join(tmpdir(), 'planners-never-block-'));
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

const postJson = async (url, path, body) => {
  const response = await fetch(`${url}${path}`, {
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
const pageOf = (doc, chapterIndex, index) => doc.pages.find((page) => page.chapterIndex === chapterIndex && page.index === index) ?? null;

async function openWorkbench(t, docPath, options = {}) {
  const { startDocWorkbench } = await import('../scripts/doc-workbench.mjs');
  const server = await startDocWorkbench({ docPath, port: 0, ...options });
  t.after(() => server.close());
  return server;
}

// ── 越界不再拒写：块可以搬到页外、页可以被清空、章节可以被清空 ──────────────
test('块拖到页外、页被清空、章节被清空都照样落盘，结构问题只进快照提示', async (t) => {
  const { path } = scratchDoc();
  const server = await openWorkbench(t, path);
  const opened = await getDoc(server.url);

  // ① 页里最后一块拖到「页外」（章节标题下）：不再 409 page_would_be_empty。
  const emptied = await postJson(server.url, '/api/reorder', {
    op: 'move-block',
    base_sha256: opened.sha256,
    anchor: 'b:cccccc',
    to: { chapter: 2, outside: true },
  });
  assert.equal(emptied.status, 200, JSON.stringify(emptied.body));
  assert.equal(emptied.body.ok, true);
  assert.equal(emptied.body.changed, true, '块确实被搬到了页外');

  const afterEmpty = await getDoc(server.url);
  assert.equal(blockOf(afterEmpty, 'b:cccccc').page.key, null, '这一块不再属于任何页');
  const emptyPage = pageOf(afterEmpty, 2, 1);
  assert.ok(emptyPage, '空页仍然留在目录里（页的身份是章节 + 顺序 + 标题）');
  assert.equal(emptyPage.blocks, 0, '快照要能直接看出哪一页是空的');
  assert.ok(
    afterEmpty.errors.some((error) => error.code === 'page_empty' && error.block === '页「页二」'),
    `快照要说明哪一页是空的：${JSON.stringify(afterEmpty.errors)}`,
  );
  assert.ok(
    afterEmpty.errors.some((error) => error.code === 'block_outside_page' && error.block === 'b:cccccc'),
    `快照要说明哪几块不在任何页里：${JSON.stringify(afterEmpty.errors)}`,
  );

  // 校验器仍在交付口：编辑时不被调用，交付时照样说清楚哪里越界。
  const verdict = validate(path);
  assert.equal(verdict.code, 1, '越界的文档在交付校验时仍应报错');
  assert.deepEqual(
    verdict.out.errors.map((error) => error.code).sort(),
    ['block_outside_page', 'page_empty'],
    '交付校验列出同一组问题，而不是被编辑器静默改写',
  );
  assert.match(readFileSync(path, 'utf8'), /块三。<!-- b:cccccc -->/, '被搬走的块一个字节都没丢');

  // 页外的块本身照常可编辑——越界只是「不归属任何页」，不是「不能写」。
  const orphanEdit = await postJson(server.url, '/api/block', {
    anchor: 'b:cccccc',
    content: '块三，在页外改过。',
    base_sha256: afterEmpty.sha256,
    base_block_sha256: blockOf(afterEmpty, 'b:cccccc').sha256,
  });
  assert.equal(orphanEdit.status, 200, JSON.stringify(orphanEdit.body));

  // ② 页外的块还能拖回页里：这不是一条单行道。
  const back = await postJson(server.url, '/api/reorder', {
    op: 'move-block',
    base_sha256: orphanEdit.body.sha256,
    anchor: 'b:cccccc',
    to: { chapter: 2, index: 1, before: null },
  });
  assert.equal(back.status, 200, JSON.stringify(back.body));
  const restored = await getDoc(server.url);
  assert.equal(blockOf(restored, 'b:cccccc').page.key, '2-1', '拖回页里后重新归属这一页');
  assert.equal(pageOf(restored, 2, 1).blocks, 1);
  assert.equal(validate(path).code, 0, '搬回去以后文档重新合规');

  // ③ 章节里最后一页拖到别的章节：章节空了也照样保存。
  const chapterCleared = await postJson(server.url, '/api/reorder', {
    op: 'move-page',
    base_sha256: restored.sha256,
    page: { chapter: 1, index: 1 },
    to: { chapter: 2, index: 1, position: 'before' },
  });
  assert.equal(chapterCleared.status, 200, JSON.stringify(chapterCleared.body));
  assert.equal(chapterCleared.body.changed, true);
  const afterChapter = await getDoc(server.url);
  assert.equal(afterChapter.pages.filter((page) => page.chapterIndex === 1).length, 0, '第一章已经没有页');
  assert.equal(validate(path).code, 0, '章节空了本身不是文档错误（错误只在页里没有块）');
});

// ── 校验器只在交付与 CI 跑：保存路径不看它 ─────────────────────────────────
test('结构问题存在时编辑仍然成功：保存不看校验器，只把问题带进快照', async (t) => {
  const { path } = scratchDoc(`# 章节

## 页一

块一。<!-- b:aaaaaa -->

## 页二
`);
  const server = await openWorkbench(t, path);
  const opened = await getDoc(server.url);
  assert.ok(opened.errors.some((error) => error.code === 'page_empty'), '打开时能看到空页');

  // 空页存在、整份文档不合规，改另一页的块照样成功。
  const saved = await postJson(server.url, '/api/block', {
    anchor: 'b:aaaaaa',
    content: '块一，改过了。',
    base_sha256: opened.sha256,
    base_block_sha256: blockOf(opened, 'b:aaaaaa').sha256,
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.ok, true);
  assert.match(readFileSync(path, 'utf8'), /块一，改过了。<!-- b:aaaaaa -->/);

  const after = await getDoc(server.url);
  assert.ok(after.errors.some((error) => error.code === 'page_empty'), '保存后仍然如实带回结构问题');
  assert.equal(validate(path).code, 1, '交付校验仍然拦得住');
});

// ── 文件在别处变了：自动重读、把本次改动重放到新版本上 ─────────────────────
test('整份基线过期时按块重放：别的块在别处改过，这次改动照样落在新版本上', async (t) => {
  const { path } = scratchDoc();
  const server = await openWorkbench(t, path);
  const opened = await getDoc(server.url);

  // 另一个进程改了第二块；第一块没动。
  writeFileSync(path, readFileSync(path, 'utf8').replace('块二。<!-- b:bbbbbb -->', '块二，别处改过。<!-- b:bbbbbb -->'), 'utf8');

  // 人保存第一块：基线整份过期，但这一块没变 → 重读后重放，不弹错。
  const saved = await postJson(server.url, '/api/block', {
    anchor: 'b:aaaaaa',
    content: '块一，人改过。',
    base_sha256: opened.sha256,
    base_block_sha256: blockOf(opened, 'b:aaaaaa').sha256,
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.ok, true);
  assert.equal(saved.body.merged, true, '回执要说明这是按块合并到新版本上的');
  let disk = readFileSync(path, 'utf8');
  assert.match(disk, /块一，人改过。<!-- b:aaaaaa -->/, '本次改动落盘');
  assert.match(disk, /块二，别处改过。<!-- b:bbbbbb -->/, '别处的新版本不被覆盖');

  // 分块：整份基线仍然过期（上一次保存后本地快照没跟上），这一块指纹对得上 → 重放。
  const current = await getDoc(server.url);
  const split = await postJson(server.url, '/api/block/split', {
    anchor: 'b:aaaaaa',
    before: '块一，人改过。',
    after: '后半。',
    base_sha256: opened.sha256,
    base_block_sha256: blockOf(current, 'b:aaaaaa').sha256,
  });
  assert.equal(split.status, 200, JSON.stringify(split.body));
  assert.equal(split.body.replayed, true, '分块要声明自己重放在了新版本上');
  disk = readFileSync(path, 'utf8');
  assert.match(disk, /块二，别处改过。<!-- b:bbbbbb -->/, '分块重放不动别的块');

  // 合并：还拿最开始的基线；被并掉的这一块指纹对得上 → 重放。
  const merged = await postJson(server.url, '/api/block/merge', {
    anchor: split.body.new_block.anchor,
    previous: 'b:aaaaaa',
    content: '',
    base_sha256: opened.sha256,
    base_block_sha256: split.body.new_block.sha256,
  });
  assert.equal(merged.status, 200, JSON.stringify(merged.body));
  assert.equal(merged.body.replayed, true);
  disk = readFileSync(path, 'utf8');
  assert.match(disk, /块二，别处改过。<!-- b:bbbbbb -->/, '合并重放不动别的块');
  assert.doesNotMatch(disk, /<!-- b:aaaaaa -->\n\n后半。/, '被合并的块确实删掉了');
});

test('重排重放：文件在别处变了，也把这次移动打到当前版本上', async (t) => {
  const { path } = scratchDoc();
  const server = await openWorkbench(t, path);
  const opened = await getDoc(server.url);

  writeFileSync(path, readFileSync(path, 'utf8').replace('块三。<!-- b:cccccc -->', '块三，别处改过。<!-- b:cccccc -->'), 'utf8');

  const moved = await postJson(server.url, '/api/reorder', {
    op: 'move-block',
    base_sha256: opened.sha256,
    anchor: 'b:bbbbbb',
    to: { chapter: 2, index: 1, before: 'b:cccccc' },
  });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.equal(moved.body.ok, true);
  assert.equal(moved.body.replayed, true, '重排要声明自己重放在了新版本上');
  assert.equal(blockOf(moved.body, 'b:bbbbbb').page.key, '2-1', '落点按当前版本的页算');
  assert.match(readFileSync(path, 'utf8'), /块三，别处改过。<!-- b:cccccc -->/, '别处的新版本不被覆盖');
});

test('重放到同一块才停下来问人：两块都变了返回 block_conflict，磁盘不动', async (t) => {
  const { path } = scratchDoc();
  const server = await openWorkbench(t, path);
  const opened = await getDoc(server.url);

  // 第一块在另一个窗口里也改了。
  writeFileSync(path, readFileSync(path, 'utf8').replace('块一。<!-- b:aaaaaa -->', '块一，别处改过。<!-- b:aaaaaa -->'), 'utf8');
  const before = readFileSync(path, 'utf8');

  const saved = await postJson(server.url, '/api/block', {
    anchor: 'b:aaaaaa',
    content: '块一，这个窗口改的。',
    base_sha256: opened.sha256,
    base_block_sha256: blockOf(opened, 'b:aaaaaa').sha256,
  });
  assert.equal(saved.status, 409, JSON.stringify(saved.body));
  assert.equal(saved.body.code, 'block_conflict', '同一块两边都改过，不能静默覆盖');
  assert.match(saved.body.error, /b:aaaaaa/, '要说明是哪一块');
  assert.equal(saved.body.details?.disk_raw, '块一，别处改过。', '停下来问人时要能看到磁盘上的那一版');
  assert.equal(saved.body.details?.your_content, '块一，这个窗口改的。', '也要能看到这个窗口改的那一版');

  const split = await postJson(server.url, '/api/block/split', {
    anchor: 'b:aaaaaa',
    before: '块一，这个窗口改的。',
    after: '后半。',
    base_sha256: opened.sha256,
    base_block_sha256: blockOf(opened, 'b:aaaaaa').sha256,
  });
  assert.equal(split.status, 409, JSON.stringify(split.body));
  assert.equal(split.body.code, 'block_conflict');
  assert.equal(readFileSync(path, 'utf8'), before, '被拦下的重放不得留下写入');
});

// ── 锁只锁模型正在写的那几块，被挡时点名 ───────────────────────────────────
test('模型只锁自己正在写的那几块：被挡时点名是哪一块，其余块照常编辑', async (t) => {
  const { path } = scratchDoc();
  const server = await openWorkbench(t, path);
  const opened = await getDoc(server.url);

  const feedback = await postJson(server.url, '/api/feedback', {
    scope: 'blocks', anchors: ['b:bbbbbb'], text: '模型只改这一块。',
  });
  assert.equal(feedback.status, 200, JSON.stringify(feedback.body));
  const claim = await postJson(server.url, '/api/task/claim', { task_id: feedback.body.task.id });
  assert.equal(claim.status, 200, JSON.stringify(claim.body));

  const lockedDoc = await getDoc(server.url);
  assert.equal(blockOf(lockedDoc, 'b:bbbbbb').locked, true);
  assert.equal(blockOf(lockedDoc, 'b:aaaaaa').locked, false, '别的块不锁');

  for (const [label, response] of [
    ['保存', await postJson(server.url, '/api/block', {
      anchor: 'b:bbbbbb', content: '想改被锁的块。', base_sha256: lockedDoc.sha256,
      base_block_sha256: blockOf(lockedDoc, 'b:bbbbbb').sha256,
    })],
    ['拆分', await postJson(server.url, '/api/block/split', {
      anchor: 'b:bbbbbb', before: '块', after: '二。', base_sha256: lockedDoc.sha256,
    })],
    ['拖动', await postJson(server.url, '/api/reorder', {
      op: 'move-block', base_sha256: lockedDoc.sha256, anchor: 'b:bbbbbb',
      to: { chapter: 2, index: 1, before: null },
    })],
  ]) {
    assert.equal(response.status, 409, `${label}：${JSON.stringify(response.body)}`);
    assert.equal(response.body.code, 'block_locked', `${label}被挡`);
    assert.match(response.body.error, /b:bbbbbb/, `${label}被挡时要说明是哪一块：${response.body.error}`);
  }

  // 其余块照常可编辑。
  const other = await postJson(server.url, '/api/block', {
    anchor: 'b:aaaaaa',
    content: '别的块照常改。',
    base_sha256: lockedDoc.sha256,
    base_block_sha256: blockOf(lockedDoc, 'b:aaaaaa').sha256,
  });
  assert.equal(other.status, 200, JSON.stringify(other.body));
  assert.match(readFileSync(path, 'utf8'), /别的块照常改。<!-- b:aaaaaa -->/);
});

// ── 结构问题只剩一个小圆点：只提示、不拦人；点开才列清单，每条能跳 ───────────
test('结构问题只在保存态旁亮一个无字圆点，点开才列页外块与空页并跳过去', () => {
  const page = readFileSync(join(core, 'assets', 'workbench', 'doc-workbench.js'), 'utf8');
  const html = readFileSync(join(core, 'assets', 'workbench', 'doc-workbench.html'), 'utf8');
  const css = readFileSync(join(core, 'assets', 'workbench', 'doc-workbench.css'), 'utf8');
  const drag = readFileSync(join(core, 'assets', 'workbench', 'doc-drag.js'), 'utf8');

  // 圆点：没有文字、默认不显示；清单里有页外块与空页两组，各自是可点的跳转。
  assert.doesNotMatch(html, /structure-notice|结构提醒|保存不受影响/, '黄条整条删掉');
  const dot = html.match(/<button[^>]*id="structureDot"[^>]*>/);
  assert.ok(dot, '保存态旁有一颗圆点');
  assert.match(dot[0], /\bhidden\b/, '没问题时什么都不显示');
  assert.match(page, /不在任何页/, '清单要说明哪几块不在任何页里');
  assert.match(page, /空页/, '清单要说明哪一页是空的');
  assert.match(page, /data-jump-anchor/, '页外块要能点着跳到那一块');
  assert.match(page, /data-jump-page/, '空页要能点着跳到那一页');
  assert.match(page, /focusAnchor/, '跳到块用拖拽模块的定位函数');
  assert.match(page, /scrollToPage/, '跳到页用目录同一套滚动定位');

  // 空页与页外块在正文里也要有落点，否则「跳过去」无处可去。
  assert.match(page, /is-empty/, '空页要画出来（否则没有跳转目标）');
  assert.match(page, /is-orphan/, '页外块要有自己的分段');
  assert.match(drag, /focusAnchor,/, '定位函数要由拖拽模块导出，圆点清单与拖拽共用同一份');
  assert.match(drag, /scrollToPage,/, '滚动定位要由拖拽模块导出');

  // 圆点是提醒色的小圆，不是一条黄条；正文不被它占走一行。
  const dotRule = css.match(/\.structure-dot\s*\{([^}]*)\}/);
  assert.ok(dotRule, '圆点要有样式');
  assert.match(dotRule[1], /width:\s*6px/);
  assert.match(dotRule[1], /height:\s*6px/);
  assert.match(dotRule[1], /border-radius:\s*50%/);
  assert.doesNotMatch(css, /\.structure-notice/, '黄条的样式一起删掉');
  assert.match(css, /\.page-divider\.is-empty/, '空页要有明确样式');
});

// ── 拖动落点：页外是可达的落点，页外块也还能再拖回去 ───────────────────────
test('拖动落点：页外块没有页内落点，每章留一个「搬到页外」的落点', async () => {
  const module = await import('../assets/workbench/doc-drag.js');
  const drag = module.default ?? module;

  const items = [
    { anchor: 'b:aaaaaa', page: '1-1', top: 100, bottom: 120 },
    { anchor: 'b:bbbbbb', page: '', top: 140, bottom: 160 }, // 页外块
    { anchor: 'b:cccccc', page: '1-1', top: 180, bottom: 200 },
  ];
  const gaps = drag.blockGaps(items);
  assert.equal(gaps.some((gap) => !gap.page), false, '页外块不产生页内落点');
  assert.equal(gaps.some((gap) => gap.before === 'b:bbbbbb'), false, '不能把块插到一个页外块之前');
  assert.equal(gaps.filter((gap) => gap.page === '1-1').length, 4, '页外块两侧各自仍落到所属页的边界');

  const pages = [
    { key: '1-1', chapterIndex: 1, chapter: '第一章', index: 1, blocks: 2 },
    { key: '1-2', chapterIndex: 1, chapter: '第一章', index: 2, blocks: 0 },
    { key: '2-1', chapterIndex: 2, chapter: '第二章', index: 1, blocks: 1 },
  ];
  const tops = { '1-1': 100, '1-2': 300, '2-1': 500 };
  const outside = drag.outsideGaps(pages, (key) => tops[key] ?? null);
  assert.deepEqual(outside.map((gap) => [gap.chapter, gap.before, gap.outside]), [[1, null, true], [2, null, true]],
    '每一章一个页外落点（同一章只留第一个）');
  assert.equal(outside[0].chapterTitle, '第一章');

  const flat = [
    { anchor: 'b:aaaaaa', page: { key: '1-1' } },
    { anchor: 'b:bbbbbb', page: null }, // Alt+↑↓ 不能把块挪到页外块上下
    { anchor: 'b:cccccc', page: { key: '1-1' } },
  ];
  assert.equal(drag.stepGap(flat, 2, 'up'), null, '上一块是页外块时不猜归属');
});

// ── 加页写真正的空页：文件里没有占位正文，提示只在渲染层 ──────────────────
test('加页是真正的空页：文件里没有占位正文，提示只在渲染层，空页只进结构提醒', async (t) => {
  const { path } = scratchDoc();
  const server = await openWorkbench(t, path);
  const before = await getDoc(server.url);
  const anchorCount = (text) => (text.match(/<!-- b:[0-9a-f]{6,12} -->/g) ?? []).length;
  const anchorsBefore = anchorCount(readFileSync(path, 'utf8'));

  const added = await postJson(server.url, '/api/structure', {
    op: 'add-page', chapter: 1, index: 1, base_sha256: before.sha256,
  });
  assert.equal(added.status, 200, JSON.stringify(added.body));

  const saved = readFileSync(path, 'utf8');
  assert.doesNotMatch(saved, /在这里写这一页/, '文件里不能留占位正文');
  assert.equal(anchorCount(saved), anchorsBefore, '空页不该凭空多出一块身份');

  const after = await getDoc(server.url);
  const newPage = after.pages.find((page) => page.title === '新页');
  assert.ok(newPage, '新页进入目录');
  assert.equal(newPage.blocks, 0, '新页一个块都没有');
  assert.equal(after.blocks.length, before.blocks.length, '加页不新增块');
  assert.ok(after.errors.some((error) => error.code === 'page_empty' && /新页/.test(error.block)),
    `空页只进快照提醒：${JSON.stringify(after.errors)}`);
  assert.equal(validate(path).code, 1, '交付校验仍然看得见空页（编辑时保存不拦）');

  // 提示在渲染层：第一块是一个内存里的 pending 块，靠 CSS 的 :empty::before 出字。
  const page = readFileSync(join(core, 'assets', 'workbench', 'doc-workbench.js'), 'utf8');
  const css = readFileSync(join(core, 'assets', 'workbench', 'doc-workbench.css'), 'utf8');
  assert.match(page, /在这里写这一页。/, '空页的第一块提示只在页面源码里');
  assert.match(page, /is-pending/, '空页第一块复用待定块那一套');
  assert.match(css, /is-pending \.block-text:empty::before/, '提示是渲染层的伪元素，不落进文件');
});

// ── 空页的第一块：渲染层的待定块输入后才落盘 ───────────────────────────────
test('空页的第一块：输入前文件里没有块，输入后按页身份落成真正的第一块', async (t) => {
  const { path } = scratchDoc();
  const server = await openWorkbench(t, path);
  const before = await getDoc(server.url);
  const added = await postJson(server.url, '/api/structure', {
    op: 'add-page', chapter: 1, index: 1, base_sha256: before.sha256,
  });
  assert.equal(added.status, 200, JSON.stringify(added.body));
  const empty = await getDoc(server.url);
  const page = empty.pages.find((item) => item.title === '新页');
  assert.equal(page.blocks, 0);
  assert.equal(empty.blocks.filter((block) => block.page.key === page.key).length, 0, '空页里一个块都没有');

  const created = await postJson(server.url, '/api/block', {
    new: true,
    page: { chapter: 1, index: page.index },
    content: '这一页的第一块正文。',
    base_sha256: empty.sha256,
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.match(created.body.block.anchor, /^b:[0-9a-f]{6}$/);
  assert.equal(created.body.block.raw, '这一页的第一块正文。');
  assert.equal(created.body.block.page.key, page.key, '第一块落在这一页里');
  assert.match(readFileSync(path, 'utf8'), /这一页的第一块正文。<!-- b:[0-9a-f]{6} -->/);
  assert.equal(validate(path).code, 0, '有了第一块以后文档重新合规');

  // 另一个窗口已经先写了第一块：停下来，不覆盖别人写的。
  const again = await postJson(server.url, '/api/block', {
    new: true,
    page: { chapter: 1, index: page.index },
    content: '想再写一个第一块。',
    base_sha256: created.body.sha256,
  });
  assert.equal(again.status, 409, JSON.stringify(again.body));
  assert.equal(again.body.code, 'page_not_empty');
  assert.doesNotMatch(readFileSync(path, 'utf8'), /想再写一个第一块/);
});
