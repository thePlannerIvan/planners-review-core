import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// 只测公开的缝：页面源码的顶层结构、三档布局的判定与折叠交互、样式里能被读出的分层规则。
// 不测像素，也不测某个 class 怎么写——测「点上折叠键，那一栏真的收了」与「纸不投外影」。

const core = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = join(core, 'assets', 'workbench');
const read = (name) => readFileSync(join(ASSETS, name), 'utf8');

async function layoutModule() {
  const module = await import('../assets/workbench/doc-layout.js');
  return module.default ?? module;
}

// ── 最小 DOM 形状：只够让布局接线活着，不模拟浏览器排版 ───────────────────────
function classListOf(node) {
  const names = () => String(node.className ?? '').split(/\s+/).filter(Boolean);
  return {
    add: (...added) => { node.className = [...new Set([...names(), ...added])].join(' '); },
    remove: (...removed) => { node.className = names().filter((name) => !removed.includes(name)).join(' '); },
    contains: (name) => names().includes(name),
    toggle: (name, force) => {
      const on = force === undefined ? !names().includes(name) : Boolean(force);
      if (on) node.className = [...new Set([...names(), name])].join(' ');
      else node.className = names().filter((item) => item !== name).join(' ');
      return on;
    },
  };
}

function layoutNode(tag = 'div') {
  const node = {
    tagName: tag.toUpperCase(), className: '', dataset: {}, attrs: {}, style: {},
    listeners: {}, children: [],
    addEventListener(type, fn) { (node.listeners[type] ??= []).push(fn); },
    setAttribute(name, value) { node.attrs[name] = String(value); },
    getAttribute(name) { return node.attrs[name] ?? null; },
    closest(selector) { return selector === '[data-collapse]' && node.dataset.collapse ? node : null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
  node.classList = classListOf(node);
  return node;
}

function layoutDocument(width = 1360) {
  const body = layoutNode('body');
  const workspace = layoutNode('div');
  workspace.getBoundingClientRect = () => ({ width, height: 800 });
  const buttons = ['toc', 'notes'].map((panel) => {
    const button = layoutNode('button');
    button.dataset.collapse = panel;
    return button;
  });
  const doc = {
    body,
    listeners: {},
    defaultView: { scrollY: 0, listeners: {} },
    addEventListener(type, fn) { (doc.listeners[type] ??= []).push(fn); },
    querySelector(selector) { return selector === '#workspace' || selector === '.workbench' ? workspace : null; },
    querySelectorAll(selector) { return selector === '[data-collapse]' ? buttons : []; },
  };
  doc.defaultView.addEventListener = (type, fn) => { (doc.defaultView.listeners[type] ??= []).push(fn); };
  return { doc, body, workspace, buttons };
}

// ── 三档按容器宽度分，不看视口 ────────────────────────────────────────────────
test('布局档位按容器宽度分三档：≥1316 / 900–1316 / <900', async () => {
  const { layoutMode, LAYOUT_WIDE, LAYOUT_MEDIUM } = await layoutModule();
  assert.equal(LAYOUT_WIDE, 1316, '常驻三栏的宽度是算出来的：240 + 760 + 300 + 2×8');
  assert.equal(LAYOUT_MEDIUM, 900);
  assert.equal(layoutMode(1360), 'wide');
  assert.equal(layoutMode(1316), 'wide', '1316 正好放得下 240 + 760 + 300 与两条 8px 间隔');
  assert.equal(layoutMode(1315), 'medium', '差一像素就降一档');
  assert.equal(layoutMode(900), 'medium');
  assert.equal(layoutMode(899), 'narrow', '900 以下批注改滑出层');
  assert.equal(layoutMode(640), 'narrow');
});

// ── 折叠键：点一下左栏真的收、再点一下真的开 ──────────────────────────────────
test('折叠键收起左右两栏：点一下收、再点一下开，aria 跟着走', async () => {
  const { createLayout } = await layoutModule();
  const { doc, body, buttons } = layoutDocument(1360);
  const layout = createLayout({ document: doc });
  layout.bind();

  const [tocButton, notesButton] = buttons;
  assert.equal(body.dataset.layout, 'wide', '容器够宽时是常驻三栏');
  assert.equal(body.classList.contains('is-notes-collapsed'), false, '批注默认展开');
  assert.equal(tocButton.getAttribute('aria-expanded'), 'true');
  assert.equal(notesButton.getAttribute('aria-expanded'), 'true');

  doc.listeners.click[0]({ target: tocButton });
  assert.ok(body.classList.contains('is-toc-collapsed'), '点折叠左，目录收起');
  assert.equal(tocButton.getAttribute('aria-expanded'), 'false');
  assert.equal(body.classList.contains('is-notes-collapsed'), false, '收左栏不碰右栏');

  doc.listeners.click[0]({ target: notesButton });
  assert.ok(body.classList.contains('is-notes-collapsed'), '点折叠右，批注收起');
  assert.equal(notesButton.getAttribute('aria-expanded'), 'false');

  doc.listeners.click[0]({ target: tocButton });
  assert.equal(body.classList.contains('is-toc-collapsed'), false, '再点一次目录回来');
  assert.equal(tocButton.getAttribute('aria-expanded'), 'true');
  doc.listeners.click[0]({ target: notesButton });
  assert.equal(body.classList.contains('is-notes-collapsed'), false, '再点一次批注回来');
  assert.equal(notesButton.getAttribute('aria-expanded'), 'true');
});

// ── 窄容器：批注默认收起，点开是滑出层而不是再挤一列 ──────────────────────────
test('窄容器下批注默认收起，点折叠键改成滑出层打开', async () => {
  const { createLayout } = await layoutModule();
  const { doc, body, buttons } = layoutDocument(1360);
  const layout = createLayout({ document: doc });
  layout.bind();
  const notesButton = buttons[1];

  layout.measure(860);
  assert.equal(body.dataset.layout, 'narrow');
  assert.ok(body.classList.contains('is-notes-collapsed'), '窄了就不占着纸的位置');
  assert.equal(body.classList.contains('is-notes-open'), false);
  assert.equal(notesButton.getAttribute('aria-expanded'), 'false');

  doc.listeners.click[0]({ target: notesButton });
  assert.equal(body.dataset.layout, 'narrow', '滑出层不改变档位');
  assert.ok(body.classList.contains('is-notes-open'), '点开是覆盖在纸上的滑出层');
  assert.equal(body.classList.contains('is-notes-collapsed'), false);
  assert.equal(notesButton.getAttribute('aria-expanded'), 'true');

  doc.listeners.click[0]({ target: notesButton });
  assert.equal(body.classList.contains('is-notes-open'), false, '再点一下滑出层收起');

  layout.measure(1360);
  assert.equal(body.dataset.layout, 'wide', '容器被拖宽后回到常驻三栏');
  assert.equal(body.classList.contains('is-notes-open'), false, '人收起过的批注，拖宽也不会偷偷打开');

  doc.listeners.click[0]({ target: notesButton });
  layout.measure(860);
  layout.measure(1360);
  assert.ok(body.classList.contains('is-notes-open'), '人打开过的批注，拖窄再拖宽仍按人的意思展开');
});

// ── 滚动后顶栏毛玻璃：滚动之前是实的 ──────────────────────────────────────────
test('滚动后顶栏毛玻璃：滚动之前不挂 is-scrolled，滚起来才挂', async () => {
  const { createLayout, SCROLL_THRESHOLD } = await layoutModule();
  const { doc, body } = layoutDocument(1280);
  const layout = createLayout({ document: doc });
  layout.bind();
  const onScroll = doc.defaultView.listeners.scroll[0];
  assert.equal(typeof onScroll, 'function', '页面要真的监听滚动');
  assert.equal(body.classList.contains('is-scrolled'), false, '没滚动时顶栏是实的');

  doc.defaultView.scrollY = SCROLL_THRESHOLD + 40;
  onScroll();
  assert.ok(body.classList.contains('is-scrolled'), '滚起来后顶栏转毛玻璃');

  doc.defaultView.scrollY = 0;
  onScroll();
  assert.equal(body.classList.contains('is-scrolled'), false, '滚回顶部还原，不留半截状态');
});

// ── 顶栏严格五项：logo + 文档名/类型、保存态、折叠左、折叠右、历史批注 ─────────
test('顶栏结构：五项都在；保存态旁只有一颗结构问题圆点，没有第六个按钮', () => {
  const html = read('doc-workbench.html');
  const header = html.match(/<header class="topbar"[\s\S]*?<\/header>/);
  assert.ok(header, '页面要有一层顶栏');
  const bar = header[0];

  // 五项 = 身份区（logo + 文档名 + 类型标签）、保存态、折叠左、折叠右、历史。
  const brand = bar.match(/<div class="brand"[\s\S]*?<\/div>\s*<div class="top-actions"/);
  assert.ok(brand, '顶栏要有一个身份区，把 logo 与文档名放在一起');
  assert.match(brand[0], /<svg[^>]*viewBox="16 16 68 68"/, '用 Logics 标记本体');
  assert.match(brand[0], /width="24"[^>]*height="24"|height="24"[^>]*width="24"/, 'logo 是 24px');
  assert.match(brand[0], /id="projectName"/, '文档名');
  assert.match(brand[0], /class="doc-kind"[^>]*id="docKind"|id="docKind"[^>]*class="doc-kind"/, '文档名后面跟类型标签');

  assert.match(bar, /id="saveState"[^>]*role="status"/, '保存态要可朗读');
  assert.match(bar, /id="tocCollapse"[^>]*data-collapse="toc"/, '折叠左');
  assert.match(bar, /id="notesCollapse"[^>]*data-collapse="notes"/, '折叠右');
  assert.match(bar, /id="historyOpen"/, '历史批注入口');

  // 保存态之外，顶栏的按钮只有折叠左 / 折叠右 / 历史，另加保存态旁那颗结构圆点。
  const topActions = bar.match(/<div class="top-actions"[\s\S]*?<\/header>/);
  assert.ok(topActions, '控件区要在顶栏里');
  const buttons = [...topActions[0].matchAll(/<button\b[^>]*\bid="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(buttons, ['structureDot', 'tocCollapse', 'notesCollapse', 'historyOpen'],
    '结构圆点只占保存态旁的位置；顶栏没有第六个按钮');
  const dot = bar.match(/<button[^>]*id="structureDot"[^>]*>([\s\S]*?)<\/button>/);
  assert.ok(dot, '结构圆点要在顶栏');
  assert.doesNotMatch(dot[1].replace(/<[^>]+>/g, ''), /[^\s]/, '圆点没有文字');
  assert.doesNotMatch(bar, /overall|整体反馈|反馈这一页|反馈整份/, '整体反馈不占顶栏的第六项');

  // 顺序就是顶栏的读法：logo → 文档名 → 保存态 → 折叠左 → 折叠右 → 历史。
  const order = ['class="brand"', 'id="projectName"', 'id="saveState"', 'id="structureDot"', 'id="tocCollapse"', 'id="notesCollapse"', 'id="historyOpen"']
    .map((needle) => bar.indexOf(needle));
  assert.ok(order.every((index) => index >= 0), '顶栏五项都要齐');
  assert.deepEqual([...order].sort((a, b) => a - b), order, '顶栏顺序：logo 在左上，保存态在折叠键前');

  assert.match(html, /<script src="\/doc-layout.js"><\/script>/, '本地页要加载布局接线');
});

test('整体反馈并进批注抽屉：整页 / 整份的入口在抽屉里，走同一条反馈命令', () => {
  const html = read('doc-workbench.html');
  const page = read('doc-workbench.js');
  const notesPanel = html.match(/<aside[^>]*id="notesPanel"[\s\S]*?<\/aside>/);
  assert.ok(notesPanel, '正文右侧要有批注抽屉');
  assert.match(notesPanel[0], /id="notesOverallPage"/, '抽屉里要有「反馈这一页」');
  assert.match(notesPanel[0], /id="notesOverallDoc"/, '抽屉里要有「反馈整份」');

  // 两个入口都接回已有的反馈命令，scope 分别是 page / doc。
  const wiring = page.match(/function wireOverallFeedback[\s\S]*?\n}/);
  assert.ok(wiring, '整体反馈仍有一段接线');
  assert.match(wiring[0], /notesOverallPage/, '页入口接在抽屉按钮上');
  assert.match(wiring[0], /notesOverallDoc/, '整份入口接在抽屉按钮上');
  assert.match(wiring[0], /scope: 'page'/, '整页范围');
  assert.match(wiring[0], /scope: 'doc'/, '整份范围');
  assert.match(wiring[0], /openComposer/, '复用同一个写反馈的输入框');
  assert.doesNotMatch(wiring[0], /overallMenu|overallFeedback/, '不再有顶栏下拉菜单');
});

// ── 样式：三层底色、纸的尺度、纸不投外影 ────────────────────────────────────
function ruleOf(css, selector) {
  const index = css.indexOf(selector);
  assert.notEqual(index, -1, `CSS 里要有 ${selector}`);
  const start = css.indexOf('{', index);
  const end = css.indexOf('}', start);
  return css.slice(start + 1, end);
}

function atBlockOf(css, header) {
  const start = css.indexOf(header);
  assert.notEqual(start, -1, `CSS 里要有 ${header}`);
  const open = css.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    else if (css[i] === '}') {
      depth -= 1;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  throw Error(`${header} 没有闭合`);
}

test('三层底色与暗色令牌：底 / 纸 / 凹槽各一个变量，尺度只写在令牌里', () => {
  const css = read('doc-workbench.css');
  const light = ruleOf(css, ':root {');
  assert.match(light, /--bottom:\s*#F6F7F8/, '底');
  assert.match(light, /--paper:\s*#FFFFFF/, '纸');
  assert.match(light, /--trough:\s*#F6F7F8/, '浅色的凹槽同底');

  const dark = ruleOf(css, 'body[data-ds-dark-theme] {');
  assert.match(dark, /--bottom:\s*#18181A/, '深色底');
  assert.match(dark, /--paper:\s*#242426/, '深色纸');
  assert.match(dark, /--trough:\s*#202024/, '深色的凹槽比底亮一档');

  // 尺度：纸宽 760、左右留白 56、正文 648、圆角 12；正文 17.5 / 1.75。
  assert.match(light, /--paper-w:\s*760px/);
  assert.match(light, /--paper-pad:\s*56px/);
  assert.match(light, /--paper-radius:\s*12px/);
  assert.equal(760 - 2 * 56, 648, '纸宽减两边留白就是正文栏');
  const paper = ruleOf(css, '.doc {');
  assert.match(paper, /background:\s*var\(--paper\)/, '纸色只属于纸');
  assert.match(paper, /border-radius:\s*var\(--paper-radius\)/);
  assert.match(paper, /font-size:\s*var\(--doc-fs\)/);
  assert.match(light, /--doc-fs:\s*16\.5px/, '默认字号 16.5，只写在令牌里');
  assert.match(paper, /line-height:\s*1\.75/);
});

test('纸靠明度差 + 极浅内描边界定，纸本身不投外影；投影只留给临时浮层', () => {
  const css = read('doc-workbench.css');
  const paper = ruleOf(css, '.doc {');
  const shadow = paper.match(/box-shadow\s*:\s*([^;]+)/);
  assert.ok(shadow, '纸要有内描边');
  assert.match(shadow[1], /^inset 0 0 0 1px rgb\(16 18 22 \/ \.04\)$/, '边界只有一条 4% 内描边');

  // 扫一遍所有 box-shadow：不只是纸，任何常驻表面都不许投外影。
  const transient = new Set([
    '.inline-toolbar', '.history-panel', '.structure-panel',
    '.drag-ghost-card', '.drop-line .drop-label', '.image-viewer-image',
    '.note-bubble:hover, .note-bubble:focus-visible', '.notes-panel.is-overlay',
    'body[data-ds-dark-theme] .notes-panel.is-overlay',
  ]);
  const outer = [];
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const [, rawSelector, body] = match;
    const declaration = body.match(/box-shadow\s*:\s*([^;]+)/);
    if (!declaration) continue;
    if (/^\s*inset/.test(declaration[1])) continue;
    outer.push(rawSelector.split('\n').pop().trim());
  }
  const stray = outer.filter((selector) => !transient.has(selector));
  assert.deepEqual(stray, [], `只有临时浮层能投外影，这些不是：${stray.join(' / ')}`);
  assert.ok(outer.length > 0, '幽灵、气泡、下拉、历史面板、滑出层都要有投影');
});

// ── 三栏按容器宽度降级：断点只在 doc-layout 里定义一次，宽度由浏览器真实排版量 ──
test('三栏断点只有一个定义：doc-layout 生成 @container，CSS 里不再写第二份数字', async () => {
  const css = read('doc-workbench.css');
  const { containerCSS, LAYOUT_WIDE, LAYOUT_MEDIUM } = await layoutModule();

  const workspace = ruleOf(css, '.workspace {');
  assert.match(workspace, /container-type:\s*inline-size/, '工作台容器自己当查询容器');
  assert.match(workspace, /container-name:\s*workbench/);

  // 断点数字只在 doc-layout 里：CSS 文件里出现任何 @container 的像素值都是第二份。
  assert.doesNotMatch(css, /@container workbench \(\s*(?:min|max)-width:\s*\d/,
    '断点不许再在 CSS 里写一份；由 doc-layout 按同一组常量生成');
  assert.doesNotMatch(css, /@media[^{]*\{[^}]*\.(toc-panel|notes-panel)\s*\{/, '三栏不许看视口宽度');

  const generated = containerCSS();
  assert.match(generated, new RegExp(`@container workbench \\(min-width: ${LAYOUT_WIDE}px\\)`),
    '宽档断点就是 240 + 760 + 300 + 2×8');
  assert.match(generated, /\.toc-panel\s*\{[^}]*240px/, '宽档目录 240');
  assert.match(generated, /\.doc\s*\{[^}]*760px/, '宽档纸 760');
  assert.match(generated, /\.notes-panel\s*\{[^}]*300px/, '宽档批注 300');
  assert.match(generated, new RegExp(`@container workbench \\(max-width: ${LAYOUT_WIDE - 0.02}px\\)`),
    '中档从宽档差一像素开始');
  assert.match(generated, /\.toc-panel\s*\{[^}]*48px/, '中档目录折成 48 图标条');
  assert.match(generated, /\.doc\s*\{[^}]*min-width:\s*520px/, '纸不低于 520');
  assert.match(generated, /\.notes-panel\s*\{[^}]*280px/, '中档批注 280');
  assert.match(generated, /\.toc-title\s*\{\s*display:\s*none/, '图标条只留页号');
  assert.match(generated, new RegExp(`@container workbench \\(max-width: ${LAYOUT_MEDIUM - 0.02}px\\)`),
    '窄档从 900 以下开始');
  assert.match(generated, /\.notes-panel:not\(\.is-overlay\)\s*\{\s*display:\s*none/, '窄档不再给批注留列');

  const drawer = ruleOf(css, '.notes-panel.is-overlay {');
  assert.match(drawer, /position:\s*fixed/, '滑出层覆盖在纸上');
  assert.match(drawer, /transform:\s*translateX\(100%\)/, '默认滑在纸外');
  assert.match(drawer, /box-shadow:/, '浮起来的临时层才有投影');
  assert.match(css, /body\.is-notes-open \.notes-panel\.is-overlay\s*\{[^}]*transform:\s*none/,
    '点开才滑进来');
});

// 真实渲染宽度：把容器钉在断点上，量三栏各自的 border-box 宽度。
// 不读 CSS 字面量：断点算错了、间距漏掉了、某栏被挤扁，都会在这里露出来。
test('三栏宽度用真实渲染量：1316 是 240 + 760 + 300 + 两条 8px 间隔', async (t) => {
  const { loadPlaywright } = await import('./acceptance/lib/harness.mjs');
  const browserInfo = await loadPlaywright();
  if (!browserInfo.available) {
    t.skip(`跳过真实排版测量：${browserInfo.reason}`);
    return;
  }

  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'planners-layout-'));
  const docPath = join(dir, 'storyline.md');
  writeFileSync(docPath, '---\ncontract: planners-doc/2\ndoc: storyline\nproject: 布局测量\n---\n\n'
    + '# 第一章\n\n## 页一\n\n正文。<!-- b:aa0001 -->\n', 'utf8');
  const { startDocWorkbench } = await import('../scripts/doc-workbench.mjs');
  const server = await startDocWorkbench({ docPath, port: 0 });

  const browser = await browserInfo.playwright.chromium.launch({ headless: true });
  t.after(async () => {
    await browser.close();
    await server.close();
  });
  const browserPage = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await browserPage.goto(server.url, { waitUntil: 'networkidle' });
  await browserPage.waitForFunction(() => document.body.dataset.layout === 'wide');

  const measure = (width) => browserPage.evaluate(async (value) => {
    const workspace = document.querySelector('#workspace');
    workspace.style.maxWidth = 'none';
    workspace.style.width = `${value}px`;
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
    const box = (selector) => {
      const node = document.querySelector(selector);
      if (!node) return null;
      const rect = node.getBoundingClientRect();
      return { width: Math.round(rect.width), display: getComputedStyle(node).display };
    };
    return {
      container: Math.round(workspace.getBoundingClientRect().width),
      toc: box('.toc-panel'),
      doc: box('.doc'),
      notes: box('.notes-panel'),
      layout: document.body.dataset.layout,
    };
  }, width);

  const wide = await measure(1316);
  assert.equal(wide.container, 1316);
  assert.equal(wide.toc.width, 240, `宽档目录真实宽度应为 240，实际 ${wide.toc.width}`);
  assert.equal(wide.doc.width, 760, `宽档纸真实宽度应为 760，实际 ${wide.doc.width}`);
  assert.equal(wide.notes.width, 300, `宽档批注真实宽度应为 300，实际 ${wide.notes.width}`);
  assert.equal(wide.toc.width + wide.doc.width + wide.notes.width + 2 * 8, 1316,
    '三栏加两条 8px 间隔刚好等于 1316，不多不少');

  const medium = await measure(1315);
  assert.equal(medium.layout, 'medium', '1315 差一像素就降一档');
  assert.equal(medium.toc.width, 48, '中档目录折成 48 图标条');
  assert.equal(medium.notes.width, 280, '中档批注 280');
  assert.ok(medium.doc.width >= 520, `中档纸不低于 520，实际 ${medium.doc.width}`);

  const narrow = await measure(899);
  assert.equal(narrow.layout, 'narrow', '900 以下批注改滑出层');
  assert.equal(narrow.toc.width, 48, '窄档目录仍是 48 图标条');
});

// ── 悬停：不铺灰底，只亮两枚同一套的图标 ────────────────────────────────────
test('悬停一块不铺灰底：只亮左缘抓手与右缘批注，两枚图标同一套', () => {
  const css = read('doc-workbench.css');
  const page = read('doc-workbench.js');

  assert.doesNotMatch(css, /[\n}]\s*\.doc-block:hover\s*\{[^}]*background:/, '悬停不铺灰底');
  assert.match(css, /body\.is-reordering \.doc-block:hover\s*\{\s*background:\s*transparent/,
    '拖动经过时也不铺灰底（已合的拖动手感不动）');

  const icons = ruleOf(css, '.block-handle, .block-feedback {');
  assert.match(icons, /width:\s*18px/, '同一尺寸：同一块 18px 热区');
  assert.match(icons, /height:\s*18px/);
  assert.match(icons, /opacity:\s*0/, '默认不显形');
  assert.match(icons, /transition:\s*opacity \.12s ease/, '同一出现时机、同一条过渡');
  assert.match(css, /\.doc-block:hover > \.block-handle,\s*\.doc-block:hover > \.block-feedback/,
    '两枚图标一起亮');
  assert.match(css, /\.block-handle svg\s*\{[^}]*height:\s*14px/, '抓手 14px 高');
  const feedbackIcon = ruleOf(css, '.block-feedback svg {');
  assert.match(feedbackIcon, /width:\s*14px; height:\s*14px/, '批注图标 14px，同一套尺码');
  assert.match(feedbackIcon, /stroke-width:\s*1\.7/, '同一套笔画');
  assert.match(feedbackIcon, /stroke-linecap:\s*round/);

  assert.match(page, /button\.innerHTML = FEEDBACK_ICON/, '批注入口是图标，不是「反馈」两个字');
  assert.doesNotMatch(page, /button\.textContent = '反馈'/, '旧的文字胶囊不能再回来');
  assert.match(page, /const FEEDBACK_ICON = '<svg viewBox="0 0 14 14"/);
  assert.match(page, /stroke-width="1\.7"/);
  assert.match(page, /height="14"/);
});

// ── 顶栏：52px、零底线、滚动后毛玻璃 ────────────────────────────────────────
test('顶栏 52px 五项，滚动后毛玻璃；没滚动时先是一块实底', () => {
  const css = read('doc-workbench.css');
  assert.match(css, /--topbar-h:\s*52px/);
  const bar = ruleOf(css, '.topbar {');
  assert.match(bar, /height:\s*var\(--topbar-h\)/);
  assert.doesNotMatch(bar, /border-bottom/, '顶栏不画底线');
  assert.doesNotMatch(bar, /backdrop-filter/, '没滚动时不糊');
  const scrolled = ruleOf(css, 'body.is-scrolled .topbar {');
  assert.match(scrolled, /backdrop-filter:\s*blur\(/);
  assert.match(scrolled, /background:\s*color-mix\([^;]*transparent\)/, '滚动后透出下面的纸');
});
