import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// 只测公开的缝：`scripts/validate-doc.mjs` 的命令行与它的 JSON 回执。
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
const FRONT = '---\ncontract: planners-doc/1\ndoc: storyline\nproject: 测试项目\n---\n\n';
const docWith = (body) => {
  const path = join(sandbox, `doc-${++counter}.md`);
  writeFileSync(path, `${FRONT}${body}\n`, 'utf8');
  return path;
};

test('两份真实样例都通过 planners-doc/1 校验', () => {
  for (const name of ['storyline.md', 'by-page.md']) {
    const r = validate(join(EXAMPLES, name));
    assert.equal(r.code, 0, `${name} 应当通过：${r.stdout}${r.stderr}`);
    assert.equal(r.out?.valid, true, name);
    assert.deepEqual(codesOf(r), [], name);
    assert.ok(r.out.checked.pages >= 3, `${name} 至少三页，实际 ${r.out.checked.pages}`);
    assert.ok(r.out.checked.blocks >= r.out.checked.pages, `${name} 的块数应当不少于页数`);
    assert.equal(r.out.checked.anchors, r.out.checked.blocks, `${name} 的样例每块都带锚点`);
  }
});

test('锚点重复被拒，错误带行号与块身份', () => {
  const path = docWith([
    '# 测试文档',
    '## 章节',
    '### 页一',
    '',
    '第一块。<!-- b:aaaaaa -->',
    '',
    '第二块。<!-- b:aaaaaa -->',
  ].join('\n'));
  const r = validate(path);
  assert.equal(r.code, 1, r.stdout);
  const [error] = errorsOf(r, 'anchor_duplicate');
  assert.ok(error, `应当报 anchor_duplicate，实际 ${JSON.stringify(codesOf(r))}`);
  assert.equal(error.line, 13);
  assert.equal(error.block, 'b:aaaaaa');
  assert.match(error.page, /第 1 页「页一」/);
  assert.match(error.message, /第 11 行/);
});

test('白名单外的块类型被拒：原始 HTML 与分隔线', () => {
  const html = docWith([
    '# 测试文档',
    '## 章节',
    '### 页一',
    '',
    '<div class="callout">这里想要自定义样式</div>',
  ].join('\n'));
  const rHtml = validate(html);
  assert.equal(rHtml.code, 1, rHtml.stdout);
  const [htmlError] = errorsOf(rHtml, 'block_type');
  assert.ok(htmlError, `原始 HTML 应当报 block_type，实际 ${JSON.stringify(codesOf(rHtml))}`);
  assert.equal(htmlError.line, 11);
  assert.match(htmlError.block, /第 1 块（原始 HTML）/);

  const rule = docWith([
    '# 测试文档',
    '## 章节',
    '### 页一',
    '',
    '---',
  ].join('\n'));
  const rRule = validate(rule);
  assert.equal(rRule.code, 1, rRule.stdout);
  const [ruleError] = errorsOf(rRule, 'block_type');
  assert.ok(ruleError, `分隔线应当报 block_type，实际 ${JSON.stringify(codesOf(rRule))}`);
  assert.equal(ruleError.line, 11);
  assert.match(ruleError.block, /第 1 块（分隔线）/);
});

test('图片路径不存在被拒，错误带行号与块身份', () => {
  const path = docWith([
    '# 测试文档',
    '## 章节',
    '### 页一',
    '',
    '![状态地图](assets/nope.svg)',
    '<!-- b:bbbbbb -->',
  ].join('\n'));
  const r = validate(path);
  assert.equal(r.code, 1, r.stdout);
  const [error] = errorsOf(r, 'image_missing');
  assert.ok(error, `应当报 image_missing，实际 ${JSON.stringify(codesOf(r))}`);
  assert.equal(error.line, 11);
  assert.equal(error.block, 'b:bbbbbb');
  assert.match(error.message, /assets\/nope\.svg/);

  const remote = docWith([
    '# 测试文档',
    '## 章节',
    '### 页一',
    '',
    '![远程图](https://example.com/a.png)',
    '<!-- b:bbbbbc -->',
  ].join('\n'));
  const rRemote = validate(remote);
  const [remoteError] = errorsOf(rRemote, 'image_not_relative');
  assert.ok(remoteError, `远程图片应当报 image_not_relative，实际 ${JSON.stringify(codesOf(rRemote))}`);
  assert.equal(remoteError.line, 11);
  assert.equal(remoteError.block, 'b:bbbbbc');
});

test('页为空被拒：页标题下一块都没有', () => {
  const path = docWith([
    '# 测试文档',
    '## 章节',
    '### 空页',
    '### 有内容',
    '',
    '有内容。<!-- b:cccccc -->',
  ].join('\n'));
  const r = validate(path);
  assert.equal(r.code, 1, r.stdout);
  const [error] = errorsOf(r, 'page_empty');
  assert.ok(error, `应当报 page_empty，实际 ${JSON.stringify(codesOf(r))}`);
  assert.equal(error.line, 9);
  assert.equal(error.block, '页「空页」');
  assert.match(error.page, /第 1 页「空页」/);

  // 只有 #### 小节标题也算块：页不空，但内容是否写够不归校验器管
  const withSection = docWith([
    '# 测试文档',
    '## 章节',
    '### 有内容',
    '',
    '#### 正文<!-- b:cccccd -->',
    '',
    '一段话。<!-- b:ccccce -->',
  ].join('\n'));
  const rOk = validate(withSection);
  assert.equal(rOk.code, 0, rOk.stdout);
});

test('退出码区分通过、不合规与用法错误', () => {
  const valid = validate(join(EXAMPLES, 'storyline.md'));
  assert.equal(valid.code, 0, valid.stdout);
  const invalid = validate(docWith(['# 测试文档', '## 章节', '### 空页'].join('\n')));
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
    '# 测试文档',
    '## 章节',
    '### 页一',
    '',
    '第一块。<!-- b:dddddd -->',
    '',
    '第二块。<!-- b:dddddd -->',
  ].join('\n'));
  const r = run([path, '--text']);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /ERROR \[anchor_duplicate\] 行 13 · .*第 1 页「页一」 · b:dddddd/);
});

const rawDoc = (content) => {
  const path = join(sandbox, `raw-${++counter}.md`);
  writeFileSync(path, content, 'utf8');
  return path;
};

test('文档头字段按契约校验', () => {
  const body = '# 测试文档\n## 章节\n### 页一\n\n一段话。<!-- b:eeeeee -->\n';
  const wrongVersion = validate(rawDoc(`---\ncontract: planners-doc/2\ndoc: storyline\nproject: 测试项目\n---\n\n${body}`));
  assert.ok(errorsOf(wrongVersion, 'contract_version').length, JSON.stringify(codesOf(wrongVersion)));

  const wrongKind = validate(rawDoc(`---\ncontract: planners-doc/1\ndoc: slide\nproject: 测试项目\n---\n\n${body}`));
  assert.ok(errorsOf(wrongKind, 'doc_kind').length, JSON.stringify(codesOf(wrongKind)));

  const noProject = validate(rawDoc(`---\ncontract: planners-doc/1\ndoc: storyline\n---\n\n${body}`));
  assert.ok(errorsOf(noProject, 'project_required').length, JSON.stringify(codesOf(noProject)));

  const unknown = validate(rawDoc(`---\ncontract: planners-doc/1\ndoc: by-page\nproject: 测试项目\nclient: 某客户\n---\n\n${body}`));
  assert.equal(unknown.code, 0, unknown.stdout);
  assert.deepEqual((unknown.out?.warnings ?? []).map((w) => w.code), ['front_matter_unknown']);
});

test('层级越界被拒：五级标题、页标题带锚点、块写在页外', () => {
  const deep = docWith(['# 测试文档', '## 章节', '### 页一', '', '##### 五级标题'].join('\n'));
  const rDeep = validate(deep);
  const [deepError] = errorsOf(rDeep, 'heading_level');
  assert.ok(deepError, JSON.stringify(codesOf(rDeep)));
  assert.equal(deepError.line, 11);

  const anchoredPage = docWith(['# 测试文档', '## 章节', '### 页一<!-- b:eeeeef -->', '', '一段话。<!-- b:eeeeeg -->'].join('\n'));
  const rAnchoredPage = validate(anchoredPage);
  const [structureError] = errorsOf(rAnchoredPage, 'anchor_on_structure');
  assert.ok(structureError, JSON.stringify(codesOf(rAnchoredPage)));
  assert.equal(structureError.line, 9);

  const outside = docWith(['# 测试文档', '## 章节', '', '章节下的导语。<!-- b:eeeeeh -->'].join('\n'));
  const rOutside = validate(outside);
  const [outsideError] = errorsOf(rOutside, 'block_outside_page');
  assert.ok(outsideError, JSON.stringify(codesOf(rOutside)));
  assert.equal(outsideError.line, 10);
});

test('锚点位置：行内锚点必须在块尾，独立锚点必须紧跟元素', () => {
  const midParagraph = docWith([
    '# 测试文档',
    '## 章节',
    '### 页一',
    '',
    '第一行带锚点。<!-- b:fffff0 -->',
    '第二行没有锚点。',
  ].join('\n'));
  const rMid = validate(midParagraph);
  const [midError] = errorsOf(rMid, 'anchor_position');
  assert.ok(midError, JSON.stringify(codesOf(rMid)));
  assert.equal(midError.line, 11);

  const orphan = docWith([
    '# 测试文档',
    '## 章节',
    '### 页一',
    '',
    '普通段落。<!-- b:fffff1 -->',
    '',
    '<!-- b:fffff2 -->',
  ].join('\n'));
  const rOrphan = validate(orphan);
  const [orphanError] = errorsOf(rOrphan, 'anchor_orphan');
  assert.ok(orphanError, JSON.stringify(codesOf(rOrphan)));
  assert.equal(orphanError.line, 13);
  assert.equal(orphanError.block, 'b:fffff2');
});

test('表格可省首尾管道，锚点仍写在元素下一行', () => {
  const path = docWith([
    '# 测试文档',
    '## 章节',
    '### 页一',
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

  const setext = docWith(['# 测试文档', '## 章节', '### 页一', '', '标题', '===='].join('\n'));
  const rSetext = validate(setext);
  const [error] = errorsOf(rSetext, 'heading_syntax');
  assert.ok(error, JSON.stringify(codesOf(rSetext)));
  assert.equal(error.line, 12);
});

test('行内代码与代码块里的锚点/图片示例不算真锚点、真图片', () => {
  const path = docWith([
    '# 测试文档',
    '## 章节',
    '### 页一',
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
    '# 测试文档',
    '## 章节',
    '### 页一',
    '',
    '<!-- b:XYZ -->',
  ].join('\n'));
  const r = validate(standalone);
  const [error] = errorsOf(r, 'anchor_format');
  assert.ok(error, `应当报 anchor_format，实际 ${JSON.stringify(codesOf(r))}`);
  assert.equal(error.line, 11);

  const inline = docWith([
    '# 测试文档',
    '## 章节',
    '### 页一',
    '',
    '一段话。<!-- b:12345 -->',
  ].join('\n'));
  const rInline = validate(inline);
  const [inlineError] = errorsOf(rInline, 'anchor_format');
  assert.ok(inlineError, `应当报 anchor_format，实际 ${JSON.stringify(codesOf(rInline))}`);
  assert.equal(inlineError.line, 11);
  assert.match(inlineError.block, /第 1 块（段落）/);
});
