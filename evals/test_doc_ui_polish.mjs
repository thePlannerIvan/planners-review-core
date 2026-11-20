import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// 票 33 的判据不是「实现了什么」，是「正文里不再出现工程性文字」：
// 页号那行、黄条、抽屉里的分组标签与文件路径、浮层说明、加页加章按钮都不该在。
// 只看得到像素的那几项（字号、对齐、气泡落点）用真实浏览器量可测的那一半。

const core = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = join(core, 'assets', 'workbench');
const read = (name) => readFileSync(join(ASSETS, name), 'utf8');
const layoutModule = async () => {
  const module = await import('../assets/workbench/doc-layout.js');
  return module.default ?? module;
};

function ruleOf(css, selector) {
  const index = css.indexOf(selector);
  assert.notEqual(index, -1, `CSS 里要有 ${selector}`);
  const start = css.indexOf('{', index);
  const end = css.indexOf('}', start);
  return css.slice(start + 1, end);
}

// ── 正文页标题上方那行「章节名 · 第 N 页」整行删掉；目录里的序号保留 ──────────
test('正文页标题只剩标题：没有「章节名 · 第 N 页」那一行，目录序号仍在', () => {
  const page = read('doc-workbench.js');
  const heading = page.match(/function pageHeading\(page[\s\S]*?\n}/);
  assert.ok(heading, 'pageHeading 要能读出来');
  assert.doesNotMatch(heading[0], /page-chapter/, '页标题上方不再有章节 / 页号那一行');
  assert.doesNotMatch(heading[0], /第 \$\{/, '渲染层不再拼「第 N 页」');
  assert.doesNotMatch(heading[0], /不在任何页里/, '页外块不再用工程话当页眉');

  // 目录里的序号是另一条路径：它来自 DocDrag 的 toc-number，不跟着正文一起删。
  const drag = read('doc-drag.js');
  assert.match(drag, /toc-number/, '目录里还保留序号');
  assert.match(page, /dataset\.pageKey = page\.key/, '页身份仍在 page-divider 上，目录才能跳转');
});

// ── 黄条整条删掉：只有一个没有文字的极小圆点，点开才列清单 ────────────────────
test('没有黄条：结构问题只在保存态旁亮一个无字圆点，点开才列页外块 / 空页', () => {
  const html = read('doc-workbench.html');
  const page = read('doc-workbench.js');
  const css = read('doc-workbench.css');

  assert.doesNotMatch(html, /structure-notice|structureNotice/, '黄条那一条整条删掉');
  assert.doesNotMatch(html, /结构提醒|保存不受影响/, '黄条的工程话不再进页面');
  const dot = html.match(/<button[^>]*id="structureDot"[^>]*>/);
  assert.ok(dot, '保存态旁要有一个圆点');
  assert.match(dot[0], /\bhidden\b/, '没问题时什么都不显示');
  assert.doesNotMatch(dot[0].replace(/<[^>]+>/g, ''), /[^\s]/, '圆点本身没有文字');
  assert.match(html, /id="structurePanel"/, '点开才出现清单');

  // 清单里的条目仍是可点的跳转，走的还是拖拽模块那套定位。
  assert.match(page, /data-jump-anchor/);
  assert.match(page, /data-jump-page/);
  assert.match(page, /focusAnchor/);
  assert.match(page, /scrollToPage/);
  assert.match(page, /structureDot/);
  assert.match(page, /structurePanel/);

  // 极小圆点：没有边框、没有文字、只有一个提醒色的小圆。
  const dotRule = ruleOf(css, '.structure-dot {');
  assert.match(dotRule, /border:\s*0/, '圆点没有边框');
  assert.match(dotRule, /border-radius:\s*50%/, '圆点是圆的');
  assert.match(dotRule, /width:\s*6px/);
  assert.match(dotRule, /height:\s*6px/);
  assert.doesNotMatch(css, /\.structure-notice/, '黄条的样式也删干净');
});

// ── 点批注气泡：直接落一条空草稿进抽屉，正文上没有浮层 ────────────────────────
test('点批注气泡直接进抽屉写草稿：浮层组件连同样式删干净，不是 display:none', () => {
  const html = read('doc-workbench.html');
  const page = read('doc-workbench.js');
  const css = read('doc-workbench.css');

  assert.doesNotMatch(html, /feedback-composer|feedbackComposer|feedbackText|feedbackTargetNote/,
    '原来的浮层组件从页面里删掉');
  assert.doesNotMatch(css, /\.feedback-composer/, '浮层的样式一起删，不是藏起来');
  assert.doesNotMatch(css, /\.feedback-target\b/, '浮层里的说明文字样式也删');

  const wiring = page.match(/function attachBlockFeedback[\s\S]*?\n}/);
  assert.ok(wiring, '块尾批注按钮的接线要能读出来');
  assert.match(wiring[0], /startNoteDraft\(/, '点气泡直接在抽屉里开一条空草稿');
  assert.doesNotMatch(wiring[0], /openComposer/, '点气泡不再弹浮层');

  // 草稿在抽屉里就地写：一个正在编辑的行，光标进来就能打字。
  assert.match(page, /note-draft/, '抽屉里有「正在写的草稿」这一行');
  assert.match(page, /function startNoteDraft/, '空草稿有单独一段接线');
  assert.match(page, /transport\.addNote\(/, '写完落盘走同一条批注 route');
});

// ── 抽屉每条只有引用的话、正文、时间、删除；没有页名、章节名、页号与分组标题 ────
test('抽屉每条只有引用的话、正文、时间、删除：页名 / 章节名 / 页号与分组标题都删掉', () => {
  const page = read('doc-workbench.js');
  const css = read('doc-workbench.css');

  const row = page.match(/function noteRow\(note[\s\S]*?\n}/);
  assert.ok(row, 'noteRow 要能读出来');
  assert.match(row[0], /note-quote/, '每条带着它引用的那句话');
  assert.match(row[0], /note-text/);
  assert.match(row[0], /note-time/);
  assert.match(row[0], /note-delete/);
  assert.doesNotMatch(row[0], /note-badge|note-reopen|已提交|模型没动这条/, '状态徽标与重新打开都从这一行删掉');
  assert.doesNotMatch(row[0], /page\.|chapter|第 |页名/, '这一行不碰页身份');
  assert.doesNotMatch(page, /drawerPages|notePageSection|note-page-title|blockPreview/,
    '按页分组那一套整套删掉');
  assert.doesNotMatch(page, /note-bubble/, '同一句引用不再由计数气泡重复');
  assert.doesNotMatch(page, /第 \$\{|\$\{page\.index\}/, '渲染层不再拼「第 N 页」');
  assert.match(css, /\.note-quote\s*\{[^}]*white-space:\s*nowrap/, '引用的话截成一行');
  assert.match(css, /\.note-quote\s*\{[^}]*text-overflow:\s*ellipsis/, '一行放不下就省略');
  assert.doesNotMatch(css, /\.note-page-title|\.note-block-preview|\.note-bubble/, '分组标题与计数气泡的样式删干净');
});

// ── 抓手与气泡按块首行中线对齐 ────────────────────────────────────────────────
test('抓手与批注气泡同一水平线：都按块首行中线算，不再各写一个 top', () => {
  const css = read('doc-workbench.css');
  const icons = ruleOf(css, '.block-handle, .block-feedback {');
  assert.match(icons, /top:\s*calc\(4px \+ \(1lh - 18px\) \/ 2\)/, '两枚图标用同一个首行中线偏移');
  assert.doesNotMatch(ruleOf(css, '\n.block-handle {'), /top:/, '抓手不再自己写一个 top');
  assert.doesNotMatch(ruleOf(css, '\n.block-feedback {'), /top:/, '气泡不再自己写一个 top');
});

// ── 字号：只改 --doc-fs，15–21，默认 16.5，纸宽与留白一个都不动，刷新后保留 ────
test('字号范围与默认值只定义一次：15–21，默认 16.5，半步递增', async () => {
  const { FONT_SIZE_MIN, FONT_SIZE_MAX, FONT_SIZE_DEFAULT, clampFontSize } = await layoutModule();
  assert.equal(FONT_SIZE_MIN, 15);
  assert.equal(FONT_SIZE_MAX, 21);
  assert.equal(FONT_SIZE_DEFAULT, 16.5);
  assert.equal(clampFontSize(14), 15, '低于下限夹到 15');
  assert.equal(clampFontSize(22), 21, '高于上限夹到 21');
  assert.equal(clampFontSize(16.5), 16.5);
  assert.equal(clampFontSize('乱写'), 16.5, '读不出来就退回默认，不让页面变成 NaN');
});

test('字号按钮只改字号变量：纸宽、左右留白、行宽都还是原来那几个数', () => {
  const html = read('doc-workbench.html');
  const css = read('doc-workbench.css');

  const tools = html.match(/<div[^>]*id="paperTools"[\s\S]*?<\/div>/);
  assert.ok(tools, '纸的左上角要有字号控件');
  assert.match(tools[0], /id="fontSmaller"[^>]*>A−</, 'A− 小按钮');
  assert.match(tools[0], /id="fontLarger"[^>]*>A\+</, 'A+ 小按钮');
  assert.ok(html.indexOf('id="paperTools"') < html.indexOf('id="blocks"') + 200,
    '字号控件在纸里，不另起一栏');

  const root = ruleOf(css, ':root {');
  assert.match(root, /--doc-fs:\s*16\.5px/, '默认字号是变量，不是散落的像素');
  assert.match(root, /--paper-w:\s*760px/);
  assert.match(root, /--paper-pad:\s*56px/);
  const paper = ruleOf(css, '.doc {');
  assert.match(paper, /font-size:\s*var\(--doc-fs\)/, '纸的正文只跟字号变量走');
  assert.match(paper, /width:\s*var\(--paper-w\)/, '纸宽仍是固定的 760');
  assert.match(paper, /padding:\s*[^;]*var\(--paper-pad\)/, '左右留白仍是固定的 56');
  assert.doesNotMatch(paper, /font-size:\s*17\.5px/, '默认字号改成 16.5，正文不再写死 17.5');
  assert.match(ruleOf(css, '\n.block-text {'), /flex:\s*1/, '行宽还是纸宽减留白，不随字号变');
});

test('字号选择存在浏览器本地：换一次绑定（等于刷新）后还是那个字号', async () => {
  const { createFontSize, FONT_SIZE_KEY } = await layoutModule();
  const storage = {
    values: new Map(),
    getItem(key) { return this.values.has(key) ? this.values.get(key) : null; },
    setItem(key, value) { this.values.set(key, String(value)); },
  };
  const makeDocument = () => {
    const listeners = { smaller: [], larger: [] };
    const root = {
      style: {
        values: {},
        setProperty(name, value) { this.values[name] = String(value); },
        getPropertyValue(name) { return this.values[name] ?? ''; },
      },
    };
    const buttons = {
      fontSmaller: { disabled: false, addEventListener(type, fn) { listeners.smaller.push(fn); } },
      fontLarger: { disabled: false, addEventListener(type, fn) { listeners.larger.push(fn); } },
    };
    return {
      documentElement: root,
      buttons,
      getElementById: (id) => buttons[id] ?? null,
      listeners,
    };
  };

  const first = makeDocument();
  const font = createFontSize({ document: first, storage });
  font.bind();
  assert.equal(first.documentElement.style.values['--doc-fs'], '16.5px', '打开时是默认 16.5');
  assert.equal(font.size(), 16.5);

  first.listeners.larger[0]();
  assert.equal(font.size(), 17, 'A+ 走半步');
  assert.equal(storage.getItem(FONT_SIZE_KEY), '17', '选择写进浏览器本地');

  for (let i = 0; i < 20; i += 1) first.listeners.larger[0]();
  assert.equal(font.size(), 21, '再点也只到 21');
  assert.equal(first.buttons.fontLarger.disabled, true, '到顶后 A+ 是禁用的');
  assert.equal(first.buttons.fontSmaller.disabled, false, 'A− 还能往下');

  const second = makeDocument();
  const reloaded = createFontSize({ document: second, storage });
  reloaded.bind();
  assert.equal(reloaded.size(), 21, '刷新后读回本地选择');
  assert.equal(second.documentElement.style.values['--doc-fs'], '21px');
});

// ── 页尾「＋ 新页」、章节尾「＋ 新章节」删掉；行首前缀造结构的路径不动 ────────
test('正文没有「＋ 新页」「＋ 新章节」；行首 # / ## 造结构的路径还在', () => {
  const page = read('doc-workbench.js');
  const css = read('doc-workbench.css');
  assert.doesNotMatch(page, /＋ 新页/);
  assert.doesNotMatch(page, /＋ 新章节/);
  assert.doesNotMatch(page, /pageAddButton|chapterAddButton|function addStructure/);
  assert.doesNotMatch(css, /\.page-add|\.chapter-add/);
  // 前缀路径：渲染仍在，服务端仍按行首前缀认结构。
  assert.match(page, /addEventListener\('keydown'/);
  assert.match(page, /splitAtCaret|enqueueSave/);
  assert.match(readFileSync(join(core, 'scripts', 'lib', 'doc-blocks.mjs'), 'utf8'), /add-page|## /,
    '行首 ## 造页的路径还在');
});

// ── 真实浏览器：正文无页号、圆点、气泡直进抽屉、字号改而不动纸宽 ──────────────
test('真实页面：没有页号与黄条，气泡直进抽屉，字号可调且纸宽留白不变', async (t) => {
  const { loadPlaywright } = await import('./acceptance/lib/harness.mjs');
  const browserInfo = await loadPlaywright();
  if (!browserInfo.available) {
    t.skip(`跳过真实页面验收：${browserInfo.reason}`);
    return;
  }

  const dir = mkdtempSync(join(tmpdir(), 'planners-ui-polish-'));
  const docPath = join(dir, 'storyline.md');
  writeFileSync(docPath, '---\ncontract: planners-doc/2\ndoc: storyline\nproject: 界面收口\n---\n\n'
    + '# 第一章\n\n页外的一段。<!-- b:aa0001 -->\n\n## 页一\n\n第一段正文。<!-- b:aa0002 -->\n\n## 空页\n', 'utf8');
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

  // 正文里看不到页号；目录里还有序号。
  const bodyText = await page.locator('#blocks').innerText();
  assert.doesNotMatch(bodyText, /第\s*\d+\s*页/, `正文里不该出现页号：${bodyText}`);
  assert.doesNotMatch(await page.locator('body').innerText(), /保存不受影响|结构提醒/, '没有黄条');
  assert.equal(await page.locator('.toc-number').first().innerText(), '1', '目录序号还在');

  // 结构有问题：保存态旁一个小圆点；点开才列清单，能跳。
  const dot = page.locator('#structureDot');
  await assert.doesNotReject(() => dot.waitFor({ state: 'visible' }), '有页外块 / 空页时圆点出现');
  assert.equal(await page.locator('#structurePanel').isHidden(), true, '没点之前不占正文');
  await dot.click();
  await page.locator('#structurePanel').waitFor({ state: 'visible' });
  const jumps = page.locator('#structurePanel .structure-jump');
  assert.ok(await jumps.count() >= 2, '清单里有页外块与空页两类的跳转');
  await jumps.first().click();
  assert.equal(await page.locator('#structurePanel').isHidden(), true, '跳过去之后清单收起');

  // 点块右侧的批注气泡：抽屉里多一条正在写的空草稿，光标已经进去，正文上没有浮层。
  const bubble = page.locator('.doc-block[data-anchor="b:aa0002"] .block-feedback');
  await bubble.click({ force: true });
  const draft = page.locator('#notesList .note-draft textarea');
  await draft.waitFor({ state: 'visible' });
  assert.equal(await draft.evaluate((node) => document.activeElement === node), true, '光标进入这条草稿');
  assert.equal(await page.locator('.feedback-composer').count(), 0, '正文上没有浮层');
  assert.doesNotMatch(await page.locator('#notesList').innerText(), /将改|草稿 · 1|未归档|草稿保存在/);

  // 字号：默认 16.5，A+ 只改字号；纸宽、留白、行宽一个都不变，刷新后还在。
  const box = () => page.evaluate(() => {
    const paper = document.querySelector('.doc').getBoundingClientRect();
    const text = document.querySelector('.doc-block .block-text').getBoundingClientRect();
    const style = getComputedStyle(document.querySelector('.doc'));
    return { width: paper.width, padding: style.paddingLeft, text: text.width, font: style.fontSize };
  });
  const before = await box();
  assert.equal(before.font, '16.5px', '默认 16.5');
  await page.locator('#fontLarger').click();
  const after = await box();
  assert.equal(after.font, '17px', 'A+ 按半步改字号');
  assert.equal(after.width, before.width, '纸宽不变');
  assert.equal(after.padding, before.padding, '左右留白不变');
  assert.equal(after.text, before.text, '行宽不变');
  const saved = await page.evaluate(() => localStorage.getItem('planners-doc-font-size'));
  assert.equal(saved, '17', '选择写进 localStorage');

  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.body.dataset.layout === 'wide');
  const reloaded = await box();
  assert.equal(reloaded.font, '17px', '刷新后保留');
  assert.equal(reloaded.width, before.width, '刷新后纸宽还是 760');
});
