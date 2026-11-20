import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';

// 票 31（Standards 轴）：一处事实一个来源。这些断言锁的是「定义只有一处」，
// 不是某段实现怎么写——两份定义一旦出现，这里就先红。
const core = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (...parts) => readFileSync(join(core, ...parts), 'utf8');
const LIB = join(core, 'scripts', 'lib');
const libFiles = () => readdirSync(LIB).filter((name) => name.endsWith('.mjs')).map((name) => join(LIB, name));

const sandboxes = [];
after(() => { for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true }); });

const SIMPLE_DOC = `---
contract: planners-doc/2
doc: storyline
project: 单一来源测试
---

# 第一章

## 页一

正文。<!-- b:aa0001 -->
`;

async function openWorkbench(t) {
  const dir = mkdtempSync(join(tmpdir(), 'planners-single-source-'));
  sandboxes.push(dir);
  const docPath = join(dir, 'storyline.md');
  writeFileSync(docPath, SIMPLE_DOC, 'utf8');
  const { startDocWorkbench } = await import('../scripts/doc-workbench.mjs');
  const server = await startDocWorkbench({ docPath, port: 0 });
  t.after(() => server.close());
  return server;
}

// ── 脚本清单：HTML 是唯一的清单，surface 与本地宿主都从它派生 ─────────────────
test('脚本清单只有 HTML 一份：surface 内联与本地宿主放行都从它派生', async () => {
  const html = read('assets', 'workbench', 'doc-workbench.html');
  const tags = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((match) => match[1]);
  assert.ok(tags.length >= 10, `页面脚本清单不该退化成几条：${tags.join('、')}`);
  assert.ok(tags.includes('/doc-layout.js') && tags.includes('/doc-workbench.js'));

  const { DOC_SCRIPTS, DOC_SCRIPT_SOURCES, docScriptFile } = await import('../scripts/lib/doc-scripts.mjs');
  assert.deepEqual(DOC_SCRIPTS.map((script) => script.src), tags, '共享清单就是 HTML 里的顺序，一个不多一个不少');
  for (const script of DOC_SCRIPTS) {
    assert.equal(DOC_SCRIPT_SOURCES.has(script.src), true);
    assert.equal(typeof docScriptFile(script.src), 'string');
  }

  const surface = read('scripts', 'doc-surface.mjs');
  assert.match(surface, /DOC_SCRIPTS/, 'surface 引用唯一清单');
  assert.doesNotMatch(surface, /'\/doc-[a-z-]+\.js'/, 'surface 不许再列一份脚本名');

  const workbench = read('scripts', 'doc-workbench.mjs');
  assert.match(workbench, /DOC_SCRIPT_SOURCES|docScriptFile/, '本地宿主引用唯一清单');
  assert.doesNotMatch(workbench, /url\.pathname === '\/doc-[a-z-]+\.js'/, '本地宿主不许再手列脚本');
});

test('本地宿主真的按共享清单发脚本，清单外的脚本名一律 404', async (t) => {
  const server = await openWorkbench(t);
  const { DOC_SCRIPTS } = await import('../scripts/lib/doc-scripts.mjs');
  for (const script of DOC_SCRIPTS) {
    const response = await fetch(`${server.url}${script.src}`);
    assert.equal(response.status, 200, `${script.src} 应能取到`);
    const type = response.headers.get('content-type') || '';
    assert.match(type, script.src.endsWith('.css') ? /text\/css/ : /javascript/, `${script.src} 的 MIME 要正确`);
    assert.ok((await response.text()).length > 0, `${script.src} 不能是空文件`);
  }
  const missing = await fetch(`${server.url}/doc-not-a-script.js`);
  assert.equal(missing.status, 404, '清单外的脚本名不发给浏览器');
});

// ── 页身份：`${chapter}-${index}` 只在共享 identity 模块里拼 ──────────────────
test('页身份只有一处定义：服务端与页面都从同一个模块取 pageKeyOf', () => {
  const identityPath = join(core, 'assets', 'workbench', 'doc-identity.js');
  const identity = readFileSync(identityPath, 'utf8');
  assert.match(identity, /function pageKeyOf/, '页身份在 identity 模块里定义');

  const offenders = [identityPath, ...libFiles(), join(core, 'assets', 'workbench', 'doc-notes.js'), join(core, 'assets', 'workbench', 'doc-workbench.js')]
    .filter((file) => /\$\{[^}]*chapter[^}]*\}-\$\{[^}]*index/.test(readFileSync(file, 'utf8')))
    .map((file) => file.replace(`${core}/`, ''));
  assert.deepEqual(offenders, ['assets/workbench/doc-identity.js'],
    `页身份只许在 identity 模块里拼，这些地方还有第二份：${offenders.join('、')}`);

  for (const file of ['doc-blocks.mjs', 'doc-session.mjs', 'doc-diff.mjs', 'doc-structure.mjs']) {
    const source = read('scripts', 'lib', file);
    assert.match(source, /pageKeyOf/, `${file} 要用共享的 pageKeyOf`);
  }
  const notes = read('assets', 'workbench', 'doc-notes.js');
  assert.match(notes, /pageKeyOf/, '批注抽屉的页分组也要用同一份页身份');
});

// ── 页末落点判据：只定义一次，页面与重排共用 ───────────────────────────────────
test('页末落点判据只有一处定义：isPageEnd 由共享模块提供，重排与拖动都用它', () => {
  const identity = read('assets', 'workbench', 'doc-identity.js');
  assert.match(identity, /function isPageEnd/, '页末判据在 identity 模块里定义一次');

  const offenders = [];
  for (const file of [...libFiles(), ...readdirSync(join(core, 'assets', 'workbench')).map((name) => join(core, 'assets', 'workbench', name))]) {
    if (!file.endsWith('.js') && !file.endsWith('.mjs')) continue;
    const source = readFileSync(file, 'utf8');
    const hits = source.match(/before\s*===\s*null\s*\|\|\s*before\s*===\s*undefined/g) ?? [];
    if (hits.length) offenders.push(file.replace(`${core}/`, ''));
  }
  assert.deepEqual(offenders, ['assets/workbench/doc-identity.js'],
    `页末判据不许在别处再写一遍：${offenders.join('、')}`);

  assert.match(read('scripts', 'lib', 'doc-blocks.mjs'), /isPageEnd/, '重排用共享判据');
  assert.match(read('assets', 'workbench', 'doc-drag.js'), /isPageEnd/, '拖动落点也用共享判据');
});

// ── 块级重放判据：保存 / 拆分 / 合并共用同一个判定 ───────────────────────────
test('块级重放判据只有一处定义：保存、拆分、合并共用 replayVerdict', () => {
  const session = read('scripts', 'lib', 'doc-session.mjs');
  assert.match(session, /function replayVerdict/, '判据有一个具名实现');
  assert.equal((session.match(/!documentMatches && !blockMatches/g) ?? []).length, 1,
    '「整份变了、这块也变了」只判一次');
  assert.equal((session.match(/= replayVerdict\(\{/g) ?? []).length, 3,
    '三个写命令都调同一个判据，不各写一份');
  assert.equal((session.match(/无法安全重放/g) ?? []).length, 1,
    '「没带基线指纹」的提示也只写一次');
});

// ── 出处拼写：只认契约里的 in_sources ────────────────────────────────────────
test('出处只认一种拼写：in_sources', () => {
  const sources = read('assets', 'workbench', 'doc-sources.js');
  assert.match(sources, /in_sources/, '认契约字段 in_sources');
  assert.doesNotMatch(sources, /inSources/, '不许再兼容第二种拼写');
  const session = read('scripts', 'lib', 'doc-session.mjs');
  assert.match(session, /in_sources:/, '服务端照契约发 in_sources');
});

// ── 未改动标注：结构化字段，页面不靠文本相等 ─────────────────────────────────
test('「模型没动这条」是结构化字段：服务端只写 model_state，页面只按它渲染', () => {
  const notes = read('scripts', 'lib', 'doc-notes.mjs');
  assert.match(notes, /model_state/, '批注带结构化的 model_state');
  assert.doesNotMatch(notes, /note\.note\s*=/, '服务端不再写自由文本标注');
  assert.doesNotMatch(notes, /NOTE_UNTOUCHED\s*=/, '旧的文案常量不再存在');

  const page = read('assets', 'workbench', 'doc-workbench.js');
  assert.match(page, /model_state === 'untouched'/, '页面按结构化状态判');
  assert.doesNotMatch(page, /note\.note ===/, '页面不靠文本相等判状态');
  assert.doesNotMatch(page, /note\.note\b/, '页面不再读自由文本字段');
});

// ── 派发出口：一个 try/catch，两条路由共用 ───────────────────────────────────
test('派发出口只有一处：两条路由共用同一个 deliver', () => {
  const workbench = read('scripts', 'doc-workbench.mjs');
  const dispatchCalls = workbench.match(/await dispatch\(/g) ?? [];
  assert.equal(dispatchCalls.length, 1,
    `派发只许在一个函数里 await dispatch，实际 ${dispatchCalls.length} 处`);
  const tryCatch = workbench.match(/try\s*\{[\s\S]{0,80}await dispatch\(/g) ?? [];
  assert.equal(tryCatch.length, 1, '只有一处把派发包进 try/catch');
  assert.match(workbench, /function deliver\(/, '两条路由调同一个 deliver');
  assert.equal((workbench.match(/deliver\(receipt\.task/g) ?? []).length, 2,
    '块级反馈与批注提交都走同一个 deliver');
});
