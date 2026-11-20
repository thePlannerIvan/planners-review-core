import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from '../scripts/lib/doc-blocks.mjs';

// 迁移只从命令面测：喂一份 /1 文档，断言盘上的字节、回执与迁移后的校验结果。
// fixture 是硬切前那份真实的 storyline.md —— 它同时是「现有文档迁得动」的证据。
const core = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATE = join(core, 'scripts', 'migrate-doc.mjs');
const VALIDATOR = join(core, 'scripts', 'validate-doc.mjs');
const FIXTURE = join(core, 'evals', 'fixtures', 'storyline-v1.md');
const EXAMPLES = join(core, 'contracts', 'examples');

const sandbox = mkdtempSync(join(tmpdir(), 'planners-migrate-'));
after(() => rmSync(sandbox, { recursive: true, force: true }));

let counter = 0;
/** 把 fixture 与它的图片资产拷进沙箱：迁移 + 校验都在真目录里跑。 */
const sandboxDoc = () => {
  const dir = join(sandbox, `doc-${++counter}`);
  cpSync(join(core, 'contracts', 'examples', 'assets'), join(dir, 'assets'), { recursive: true });
  const path = join(dir, 'storyline.md');
  cpSync(FIXTURE, path);
  return path;
};

const migrate = (args) => spawnSync(process.execPath, [MIGRATE, ...args], { encoding: 'utf8' });
const validate = (path) => {
  const r = spawnSync(process.execPath, [VALIDATOR, path], { encoding: 'utf8' });
  let out = null;
  try { out = JSON.parse(r.stdout); } catch { /* 失败时给断言留原始输出 */ }
  return { code: r.status, out, stdout: r.stdout };
};
const anchorsOf = (text) => [...text.matchAll(/<!--\s*(b:[0-9a-f]{6,12})\s*-->/g)].map((m) => m[1]);
const headingLevel = (raw) => (/^(#{1,6})/.exec(raw) ?? [])[1]?.length ?? 0;

test('把一份 /1 文档整体上移一位：/2 通过校验，锚点与块 raw 逐字不变', () => {
  const path = sandboxDoc();
  const before = readFileSync(path, 'utf8');
  const r = migrate(['1', '2', path]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const receipt = JSON.parse(r.stdout);
  assert.equal(receipt.contract, 'planners-doc/2');
  assert.equal(receipt.valid, true, JSON.stringify(receipt.errors));
  assert.deepEqual(receipt.errors, []);
  assert.equal(receipt.dropped_title, '朗标笔试案 · 主线');

  const after = readFileSync(path, 'utf8');
  assert.match(after, /^contract: planners-doc\/2$/m, '文档头换成 /2');
  assert.match(after, /^project: 朗标笔试案$/m, '文档名仍在 project');
  assert.doesNotMatch(after, /朗标笔试案 · 主线/, '正文不再有文档标题行');

  assert.deepEqual(anchorsOf(after), anchorsOf(before), '块锚点一个不动、顺序不变');

  const parsedAfter = parseDocument(after, { checkImages: false });
  assert.equal(parsedAfter.chapters.length, 3, '# 变成三个章节');
  assert.equal(parsedAfter.pages.length, 8, '页数不变');
  assert.deepEqual(parsedAfter.chapters.map((chapter) => chapter.title), ['一、判断', '二、主线', '三、落地']);
  assert.equal(parsedAfter.blocks.length, 48, '块一个不少：# 文档标题本来就不是块');
  assert.deepEqual(
    parsedAfter.pages.map((page) => page.title),
    ['品类机会不在「解渴」，在「调节状态」', '人群不是「熬夜党」，是「需要准时切换的人」', '竞争空白在「剂量—场景」的交叉处',
      '一句话主线：一支 150ml，把状态调回来', '三条支撑：成分可信、场景明确、价格自洽', '叙事顺序：先场景，再机制，最后证据',
      '首轮只打两个时点，不做全场景铺开', '成功判据：复购与场景提及率'],
    '页标题逐字不变',
  );

  // 每一块的 raw 都逐字来自原文的那一行：标题块只多了「上移一位」这一个变化。
  // raw 不含行尾锚点，核对时把锚点补回去再比。
  const beforeLines = new Set(before.split('\n'));
  const expectedLines = (block) => {
    const lines = block.raw.split('\n');
    if (block.anchor && block.inlineAnchor) lines[lines.length - 1] += `<!-- ${block.anchor} -->`;
    if (block.type === 'heading') lines[0] = `#${lines[0]}`;
    return lines;
  };
  for (const block of parsedAfter.blocks) {
    for (const line of expectedLines(block)) {
      assert.ok(beforeLines.has(line), `块 raw 逐字来自原文：${line}`);
    }
    assert.equal(headingLevel(block.raw), headingLevel(beforeLines.has(`#${block.raw}`) ? `#${block.raw}` : block.raw), `第 ${block.index} 块层级`);
  }

  const check = validate(path);
  assert.equal(check.code, 0, check.stdout);
  assert.equal(check.out.checked.chapters, 3);
  assert.equal(check.out.checked.pages, 8);
});

test('--sources-to-quote：页末「依据与边界 / Sources」小节变成页末引用', () => {
  const path = sandboxDoc();
  const before = readFileSync(path, 'utf8');
  const r = migrate(['1', '2', path, '--sources-to-quote']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const receipt = JSON.parse(r.stdout);
  assert.equal(receipt.valid, true, JSON.stringify(receipt.errors));
  assert.deepEqual(receipt.sources_to_quotes, { sections: 8, blocks: 11 }, '八个小节、十一条条目');

  const after = readFileSync(path, 'utf8');
  assert.doesNotMatch(after, /Sources/, '小节标题被删掉');
  const keptAnchors = anchorsOf(after);
  assert.equal(keptAnchors.length, 40, '八个被删掉的小节标题不再占锚点，其余一个不动');
  const beforeAnchors = new Set(anchorsOf(before));
  for (const anchor of keptAnchors) assert.ok(beforeAnchors.has(anchor), `锚点 ${anchor} 来自原文`);
  const check = validate(path);
  assert.equal(check.code, 0, check.stdout);
  assert.equal(check.out.checked.sources, 13, '页末连续的引用构成出处区');

  const parsed = parseDocument(after, { checkImages: false });
  for (const page of parsed.pages) {
    const titles = page.blocks.filter((block) => block.type === 'heading').map((block) => block.text);
    assert.ok(!titles.some((title) => /^sources$/i.test(title)), `页「${page.title}」的 Sources 小节已转成引用`);
  }
  const firstPage = parsed.pages[0];
  assert.deepEqual(firstPage.sources.map((block) => block.type), ['quote', 'quote']);
  assert.match(firstPage.sources[0].raw, /^> 2026-11 消费者访谈/);
  assert.equal(firstPage.sources[0].anchor, 'b:21dcae', '条目锚点跟着条目走');
  assert.equal(firstPage.sources[0].inlineAnchor, true, '引用块的锚点写在行尾');
  // 条目文字逐字来自原文的列表项，只有块前缀从 `- ` 换成了 `> `。
  const beforeLines = new Set(before.split('\n'));
  for (const page of parsed.pages) {
    for (const block of page.sources) {
      const text = block.raw.replace(/^> /, '');
      const suffix = block.anchor ? `<!-- ${block.anchor} -->` : '';
      // 列表项变成引用（前缀换了），原本就是引用的一个字都不动。
      assert.ok(
        [`- ${text}${suffix}`, `> ${text}${suffix}`].some((line) => beforeLines.has(line)),
        `出处条目的文字逐字不动：> ${text}`,
      );
    }
  }
  assert.equal(parsed.blocks.length, 40, '八个小节标题被删掉');
});

test('不是 /1 的文档不迁移，也不留半截写入', () => {
  const dir = join(sandbox, 'already-v2');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'storyline.md');
  writeFileSync(path, ['---', 'contract: planners-doc/2', 'doc: storyline', 'project: 已经是 /2', '---', '',
    '# 章', '', '## 页', '', '一段话。<!-- b:beef01 -->', ''].join('\n'), 'utf8');
  const before = readFileSync(path, 'utf8');
  const r = migrate(['1', '2', path]);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /不是 planners-doc\/1/);
  assert.equal(readFileSync(path, 'utf8'), before, '盘上一个字节都没动');
});

test('迁移后会跑校验，报错列出但不阻断', () => {
  const dir = join(sandbox, 'broken');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'storyline.md');
  // 一章两页，其中一页是空的：/1 里合法（空页只是校验错误），迁移照样写盘。
  writeFileSync(path, [
    '---',
    'contract: planners-doc/1',
    'doc: storyline',
    'project: 断掉的稿',
    '---',
    '',
    '# 断掉的稿',
    '',
    '## 章',
    '',
    '### 空页',
    '',
    '### 有内容',
    '',
    '一段话。<!-- b:cafe01 -->',
    '',
  ].join('\n'), 'utf8');
  const r = migrate(['1', '2', path]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const receipt = JSON.parse(r.stdout);
  assert.equal(receipt.ok, true);
  assert.equal(receipt.valid, false, '校验会把空页报出来');
  assert.deepEqual(receipt.errors.map((error) => error.code), ['page_empty']);
  assert.match(readFileSync(path, 'utf8'), /^contract: planners-doc\/2$/m, '报错不阻断写盘');
});

test('用法错误退出码是 2', () => {
  assert.equal(migrate([]).status, 2);
  assert.equal(migrate(['1', '2']).status, 2);
  assert.equal(migrate(['2', '1', FIXTURE]).status, 2);
  assert.equal(migrate(['1', '2', join(sandbox, '不存在.md')]).status, 2);
});

test('缺 project 的 /1 文档：被移除的文档标题补成文档名；「依据与边界」小节同样转成引用', () => {
  const dir = join(sandbox, 'no-project');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'storyline.md');
  writeFileSync(path, [
    '---',
    'contract: planners-doc/1',
    'doc: storyline',
    '---',
    '',
    '# 朗标笔试案 · 主线',
    '',
    '## 一、判断',
    '',
    '### 品类机会',
    '',
    '主张：一支就有效。<!-- b:0a0a01 -->',
    '',
    '#### 依据与边界',
    '- 访谈记录 03（内部）。<!-- b:0a0a02 -->',
    '- 只覆盖上海与杭州。<!-- b:0a0a03 -->',
    '',
  ].join('\n'), 'utf8');
  const r = migrate(['1', '2', path, '--sources-to-quote']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const receipt = JSON.parse(r.stdout);
  assert.equal(receipt.dropped_title, '朗标笔试案 · 主线');
  assert.equal(receipt.valid, true, JSON.stringify(receipt.errors));
  assert.deepEqual(receipt.sources_to_quotes, { sections: 1, blocks: 2 });

  const after = readFileSync(path, 'utf8');
  assert.match(after, /^project: 朗标笔试案 · 主线$/m, '文档名由被移除的标题补上');
  assert.match(after, /^# 一、判断$/m, '章节上移一位');
  assert.match(after, /^## 品类机会$/m, '页上移一位');
  assert.match(after, /^> 访谈记录 03（内部）。<!-- b:0a0a02 -->$/m, '依据与边界的小节标题被删、条目转成引用');
  const parsed = parseDocument(after, { checkImages: false });
  assert.equal(parsed.pages[0].sources.length, 2);
});
