import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from '../scripts/lib/doc-blocks.mjs';

// 只测公开的缝：`scripts/validate-doc.mjs` 的命令行与它的 JSON 回执，以及契约层的解析结果。
// 解析器怎么切块是实现细节 —— 换实现时这些断言不该跟着改。
const core = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VALIDATOR = join(core, 'scripts', 'validate-doc.mjs');
const EXAMPLES = join(core, 'contracts', 'examples');

const sandbox = mkdtempSync(join(tmpdir(), 'planners-doc-'));
after(() => rmSync(sandbox, { recursive: true, force: true }));

const run = (args) => spawnSync(process.execPath, [VALIDATOR, ...args], { encoding: 'utf8' });
const validate = (path) => {
  const r = run([path]);
  let out = null;
  try { out = JSON.parse(r.stdout); } catch { /* 失败时给断言留原始输出 */ }
  return { code: r.status, out, stdout: r.stdout, stderr: r.stderr };
};
const codesOf = (r) => (r.out?.errors ?? []).map((e) => e.code);
const errorsOf = (r, code) => (r.out?.errors ?? []).filter((e) => e.code === code);

let counter = 0;
const FRONT = '---\ncontract: planners-doc/2\ndoc: storyline\nproject: 测试项目\n---\n\n';
const docWith = (body) => {
  const path = join(sandbox, `doc-${++counter}.md`);
  writeFileSync(path, `${FRONT}${body}\n`, 'utf8');
  return path;
};
const rawDoc = (content) => {
  const path = join(sandbox, `raw-${++counter}.md`);
  writeFileSync(path, content, 'utf8');
  return path;
};

test('两份真实样例都通过 planners-doc/2 校验', () => {
  for (const name of ['storyline.md', 'by-page.md']) {
    const r = validate(join(EXAMPLES, name));
    assert.equal(r.code, 0, `${name} 应当通过：${r.stdout}${r.stderr}`);
    assert.equal(r.out?.valid, true, name);
    assert.deepEqual(codesOf(r), [], name);
    assert.ok(r.out.checked.pages >= 3, `${name} 至少三页，实际 ${r.out.checked.pages}`);
    assert.ok(r.out.checked.blocks >= r.out.checked.pages, `${name} 的块数应当不少于页数`);
    assert.equal(r.out.checked.anchors, r.out.checked.blocks, `${name} 的样例每块都带锚点`);
    assert.ok(r.out.checked.sources > 0, `${name} 的样例应当演示页末出处区`);
  }
});

test('锚点重复被拒，错误带行号与块身份', () => {
  const path = docWith([
    '# 章节',
    '## 页一',
    '',
    '第一块。<!-- b:aaaaaa -->',
    '',
    '第二块。<!-- b:aaaaaa -->',
  ].join('\n'));
  const r = validate(path);
  assert.equal(r.code, 1, r.stdout);
  const [error] = errorsOf(r, 'anchor_duplicate');
  assert.ok(error, `应当报 anchor_duplicate，实际 ${JSON.stringify(codesOf(r))}`);
  assert.equal(error.line, 12);
  assert.equal(error.block, 'b:aaaaaa');
  assert.match(error.page, /第 1 页「页一」/);
  assert.match(error.message, /第 10 行/);
});

test('白名单外的块类型被拒：原始 HTML 与分隔线', () => {
  const html = docWith([
    '# 章节',
    '## 页一',
    '',
    '<div class="callout">这里想要自定义样式</div>',
  ].join('\n'));
  const rHtml = validate(html);
  assert.equal(rHtml.code, 1, rHtml.stdout);
  const [htmlError] = errorsOf(rHtml, 'block_type');
  assert.ok(htmlError, `原始 HTML 应当报 block_type，实际 ${JSON.stringify(codesOf(rHtml))}`);
  assert.equal(htmlError.line, 10);
  assert.match(htmlError.block, /第 1 块（原始 HTML）/);

  const rule = docWith([
    '# 章节',
    '## 页一',
    '',
    '---',
  ].join('\n'));
  const rRule = validate(rule);
  assert.equal(rRule.code, 1, rRule.stdout);
  const [ruleError] = errorsOf(rRule, 'block_type');
  assert.ok(ruleError, `分隔线应当报 block_type，实际 ${JSON.stringify(codesOf(rRule))}`);
  assert.equal(ruleError.line, 10);
  assert.match(ruleError.block, /第 1 块（分隔线）/);
});

test('图片路径不存在被拒，错误带行号与块身份', () => {
  const path = docWith([
    '# 章节',
    '## 页一',
    '',
    '![状态地图](assets/nope.svg)',
    '<!-- b:bbbbbb -->',
  ].join('\n'));
  const r = validate(path);
  assert.equal(r.code, 1, r.stdout);
  const [error] = errorsOf(r, 'image_missing');
  assert.ok(error, `应当报 image_missing，实际 ${JSON.stringify(codesOf(r))}`);
  assert.equal(error.line, 10);
  assert.equal(error.block, 'b:bbbbbb');
  assert.match(error.message, /assets\/nope\.svg/);

  const remote = docWith([
    '# 章节',
    '## 页一',
    '',
    '![远程图](https://example.com/a.png)',
    '<!-- b:bbbbbc -->',
  ].join('\n'));
  const rRemote = validate(remote);
  const [remoteError] = errorsOf(rRemote, 'image_not_relative');
  assert.ok(remoteError, `远程图片应当报 image_not_relative，实际 ${JSON.stringify(codesOf(rRemote))}`);
  assert.equal(remoteError.line, 10);
  assert.equal(remoteError.block, 'b:bbbbbc');
});

test('页为空被拒：页标题下一块都没有', () => {
  const path = docWith([
    '# 章节',
    '## 空页',
    '## 有内容',
    '',
    '有内容。<!-- b:cccccc -->',
  ].join('\n'));
  const r = validate(path);
  assert.equal(r.code, 1, r.stdout);
  const [error] = errorsOf(r, 'page_empty');
  assert.ok(error, `应当报 page_empty，实际 ${JSON.stringify(codesOf(r))}`);
  assert.equal(error.line, 8);
  assert.equal(error.block, '页「空页」');
  assert.match(error.page, /第 1 页「空页」/);

  // 只有标题块也算块：页不空，但内容是否写够不归校验器管
  const withSection = docWith([
    '# 章节',
    '## 有内容',
    '',
    '### 正文<!-- b:cccccd -->',
    '',
    '一段话。<!-- b:ccccce -->',
  ].join('\n'));
  const rOk = validate(withSection);
  assert.equal(rOk.code, 0, rOk.stdout);
});

test('退出码区分通过、不合规与用法错误', () => {
  const valid = validate(join(EXAMPLES, 'storyline.md'));
  assert.equal(valid.code, 0, valid.stdout);
  const invalid = validate(docWith(['# 章节', '## 空页'].join('\n')));
  assert.equal(invalid.code, 1, invalid.stdout);

  const missing = run([join(sandbox, '不存在.md')]);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /找不到文档/);

  const usage = run([]);
  assert.equal(usage.status, 2);
  assert.match(usage.stderr, /用法/);
});

test('--text 把行号与块身份写进人读输出', () => {
  const path = docWith([
    '# 章节',
    '## 页一',
    '',
    '第一块。<!-- b:dddddd -->',
    '',
    '第二块。<!-- b:dddddd -->',
  ].join('\n'));
  const r = run([path, '--text']);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /ERROR \[anchor_duplicate\] 行 12 · .*第 1 页「页一」 · b:dddddd/);
});

test('文档头字段按契约校验，/1 不再被兼容读取', () => {
  const body = '# 章节\n## 页一\n\n一段话。<!-- b:eeeeee -->\n';
  // 硬切：只剩 /2。写 /1 的文档按版本不对被拒，不降级读取。
  const oldVersion = validate(rawDoc(`---\ncontract: planners-doc/1\ndoc: storyline\nproject: 测试项目\n---\n\n${body}`));
  assert.ok(errorsOf(oldVersion, 'contract_version').length, JSON.stringify(codesOf(oldVersion)));
  assert.equal(oldVersion.code, 1);

  const wrongKind = validate(rawDoc(`---\ncontract: planners-doc/2\ndoc: slide\nproject: 测试项目\n---\n\n${body}`));
  assert.ok(errorsOf(wrongKind, 'doc_kind').length, JSON.stringify(codesOf(wrongKind)));

  const noProject = validate(rawDoc(`---\ncontract: planners-doc/2\ndoc: storyline\n---\n\n${body}`));
  assert.ok(errorsOf(noProject, 'project_required').length, JSON.stringify(codesOf(noProject)));

  const unknown = validate(rawDoc(`---\ncontract: planners-doc/2\ndoc: by-page\nproject: 测试项目\nclient: 某客户\n---\n\n${body}`));
  assert.equal(unknown.code, 0, unknown.stdout);
  assert.deepEqual((unknown.out?.warnings ?? []).map((w) => w.code), ['front_matter_unknown']);
});

test('文档名来自 project：正文没有文档标题行，第一个 # 就是章节', () => {
  const r = validate(docWith(['# 一、判断', '## 页一', '', '一段话。<!-- b:ab0001 -->'].join('\n')));
  assert.equal(r.code, 0, r.stdout);
  assert.equal(r.out.checked.project, '测试项目', '文档名来自 frontmatter 的 project');
  assert.equal(r.out.checked.chapters, 1);
  assert.equal(r.out.checked.pages, 1);
  assert.equal(Object.hasOwn(r.out.checked, 'title'), false, '回执里没有「文档标题」这个字段');
});

test('层级：## 是页、###–###### 都是合法标题块', () => {
  const r = validate(docWith([
    '# 章节',
    '## 页一',
    '',
    '### 三级标题<!-- b:ac0003 -->',
    '',
    '#### 四级标题<!-- b:ac0004 -->',
    '',
    '##### 五级标题<!-- b:ac0005 -->',
    '',
    '###### 六级标题<!-- b:ac0006 -->',
  ].join('\n')));
  assert.equal(r.code, 0, r.stdout);
  assert.equal(r.out.checked.blocks, 4, '### – ###### 各自是一个标题块');
  assert.deepEqual(codesOf(r), []);

  const parsed = parseDocument(`${FRONT}${['# 章节', '## 页一', '', '##### 五级标题<!-- b:ac0010 -->'].join('\n')}\n`);
  assert.equal(parsed.pages.length, 1, '## 是页');
  assert.equal(parsed.chapters.length, 1, '# 是章节');
  assert.equal(parsed.blocks[0].type, 'heading');
  assert.equal(parsed.blocks[0].level, 5, '标题块保留自己的层级');
  assert.equal(parsed.title, undefined, '# 不再是文档标题');
});

test('层级越界被拒：页写在章节外、块写在页外、章节 / 页带锚点', () => {
  const noChapter = docWith(['## 页一', '', '一段话。<!-- b:ad0001 -->'].join('\n'));
  const rNoChapter = validate(noChapter);
  const [chapterError] = errorsOf(rNoChapter, 'page_without_chapter');
  assert.ok(chapterError, JSON.stringify(codesOf(rNoChapter)));
  assert.equal(chapterError.line, 7);

  const outside = docWith(['# 章节', '', '章节下的导语。<!-- b:ad0002 -->'].join('\n'));
  const rOutside = validate(outside);
  const [outsideError] = errorsOf(rOutside, 'block_outside_page');
  assert.ok(outsideError, JSON.stringify(codesOf(rOutside)));
  assert.equal(outsideError.line, 9);

  const headingOutside = docWith(['# 章节', '', '### 页外标题<!-- b:ad0003 -->'].join('\n'));
  const rHeadingOutside = validate(headingOutside);
  const [headingOutsideError] = errorsOf(rHeadingOutside, 'block_outside_page');
  assert.ok(headingOutsideError, `### 在页外也是一个块越层：${JSON.stringify(codesOf(rHeadingOutside))}`);
  assert.equal(headingOutsideError.line, 9);

  const anchoredChapter = docWith(['# 章节<!-- b:ad0004 -->', '## 页一', '', '一段话。<!-- b:ad0005 -->'].join('\n'));
  const rAnchoredChapter = validate(anchoredChapter);
  const [chapterAnchor] = errorsOf(rAnchoredChapter, 'anchor_on_structure');
  assert.ok(chapterAnchor, JSON.stringify(codesOf(rAnchoredChapter)));
  assert.equal(chapterAnchor.line, 7);

  const anchoredPage = docWith(['# 章节', '## 页一<!-- b:ad0006 -->', '', '一段话。<!-- b:ad0007 -->'].join('\n'));
  const rAnchoredPage = validate(anchoredPage);
  const [structureError] = errorsOf(rAnchoredPage, 'anchor_on_structure');
  assert.ok(structureError, JSON.stringify(codesOf(rAnchoredPage)));
  assert.equal(structureError.line, 8);
});

test('锚点位置：行内锚点必须在块尾，独立锚点必须紧跟元素', () => {
  const midParagraph = docWith([
    '# 章节',
    '## 页一',
    '',
    '第一行带锚点。<!-- b:fffff0 -->',
    '第二行没有锚点。',
  ].join('\n'));
  const rMid = validate(midParagraph);
  const [midError] = errorsOf(rMid, 'anchor_position');
  assert.ok(midError, JSON.stringify(codesOf(rMid)));
  assert.equal(midError.line, 10);

  const orphan = docWith([
    '# 章节',
    '## 页一',
    '',
    '普通段落。<!-- b:fffff1 -->',
    '',
    '<!-- b:fffff2 -->',
  ].join('\n'));
  const rOrphan = validate(orphan);
  const [orphanError] = errorsOf(rOrphan, 'anchor_orphan');
  assert.ok(orphanError, JSON.stringify(codesOf(rOrphan)));
  assert.equal(orphanError.line, 12);
  assert.equal(orphanError.block, 'b:fffff2');
});

test('表格可省首尾管道，锚点仍写在元素下一行', () => {
  const path = docWith([
    '# 章节',
    '## 页一',
    '',
    '元素 | 规格',
    '---|---',
    '瓶身 | 150ml',
    '<!-- b:ababab -->',
  ].join('\n'));
  const r = validate(path);
  assert.equal(r.code, 0, r.stdout);
  assert.equal(r.out.checked.blocks, 1);
  assert.equal(r.out.checked.anchors, 1);

  const setext = docWith(['# 章节', '## 页一', '', '标题', '===='].join('\n'));
  const rSetext = validate(setext);
  const [error] = errorsOf(rSetext, 'heading_syntax');
  assert.ok(error, JSON.stringify(codesOf(rSetext)));
  assert.equal(error.line, 11);
});

test('行内代码与代码块里的锚点/图片示例不算真锚点、真图片', () => {
  const path = docWith([
    '# 章节',
    '## 页一',
    '',
    '下面这段是写法示例：',
    '',
    '```md',
    '文字<!-- b:123456 -->',
    '![图](assets/nope.png)',
    '```',
    '<!-- b:ababac -->',
    '',
    '行内示例 `![图](assets/nope.png)` 不是图片。<!-- b:ababad -->',
  ].join('\n'));
  const r = validate(path);
  assert.equal(r.code, 0, r.stdout);
  assert.deepEqual(codesOf(r), []);
  assert.equal(r.out.checked.blocks, 3);
  assert.equal(r.out.checked.anchors, 2);
});

test('锚点写法不合契约被拒，不吞成普通段落', () => {
  const standalone = docWith([
    '# 章节',
    '## 页一',
    '',
    '<!-- b:XYZ -->',
  ].join('\n'));
  const r = validate(standalone);
  const [error] = errorsOf(r, 'anchor_format');
  assert.ok(error, `应当报 anchor_format，实际 ${JSON.stringify(codesOf(r))}`);
  assert.equal(error.line, 10);

  const inline = docWith([
    '# 章节',
    '## 页一',
    '',
    '一段话。<!-- b:12345 -->',
  ].join('\n'));
  const rInline = validate(inline);
  const [inlineError] = errorsOf(rInline, 'anchor_format');
  assert.ok(inlineError, `应当报 anchor_format，实际 ${JSON.stringify(codesOf(rInline))}`);
  assert.equal(inlineError.line, 10);
  assert.match(inlineError.block, /第 1 块（段落）/);
});

test('出处区按位置认定：页末连续引用', () => {
  const doc = rawDoc(`${FRONT}${[
    '# 章一',
    '## 有出处',
    '',
    '一句主张。<!-- b:ae0001 -->',
    '',
    '> 依据：访谈记录 03。<!-- b:ae0002 -->',
    '',
    '> 边界：只覆盖上海与杭州。<!-- b:ae0003 -->',
    '',
    '## 页中引用不算出处',
    '',
    '> 这是一句引人注意的引文，不是出处。<!-- b:ae0004 -->',
    '',
    '正文接着写。<!-- b:ae0005 -->',
    '',
    '## 没有出处',
    '',
    '只有正文。<!-- b:ae0006 -->',
    '',
    '## 整页都是引用',
    '',
    '> 只有一条依据。<!-- b:ae0007 -->',
  ].join('\n')}\n`);

  const r = validate(doc);
  assert.equal(r.code, 0, `没有出处的页合法：${r.stdout}`);
  assert.equal(r.out.checked.sources, 3, '页末连续的三条引用构成出处区，页中与页末之间的不算');
  assert.equal(r.out.checked.pages, 4);

  const parsed = parseDocument(`${FRONT}${[
    '# 章一',
    '## 有出处',
    '',
    '一句主张。<!-- b:ae1001 -->',
    '',
    '> 依据：访谈记录 03。<!-- b:ae1002 -->',
    '',
    '> 边界：只覆盖上海与杭州。<!-- b:ae1003 -->',
    '',
    '## 页中引用不算出处',
    '',
    '> 这是一句引人注意的引文，不是出处。<!-- b:ae1004 -->',
    '',
    '正文接着写。<!-- b:ae1005 -->',
    '',
    '## 没有出处',
    '',
    '只有正文。<!-- b:ae1006 -->',
    '',
    '## 整页都是引用',
    '',
    '> 只有一条依据。<!-- b:ae1007 -->',
  ].join('\n')}\n`);
  assert.deepEqual(parsed.pages.map((page) => page.sources.length), [2, 0, 0, 1], '页末引用即出处，条数不设限');
  assert.deepEqual(parsed.pages[0].sources.map((block) => block.anchor), ['b:ae1002', 'b:ae1003']);
  assert.equal(parsed.pages[1].blocks[0].inSources, undefined, '页中段的引用照常是普通引用');
});
