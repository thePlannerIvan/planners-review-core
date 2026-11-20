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

function layoutDocument(width = 1280) {
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
test('布局档位按容器宽度分三档：≥1180 / 900–1180 / <900', async () => {
  const { layoutMode } = await layoutModule();
  assert.equal(layoutMode(1360), 'wide');
  assert.equal(layoutMode(1180), 'wide', '1180 正好进常驻三栏');
  assert.equal(layoutMode(1179), 'medium', '差一像素就降一档');
  assert.equal(layoutMode(900), 'medium');
  assert.equal(layoutMode(899), 'narrow', '900 以下批注改滑出层');
  assert.equal(layoutMode(640), 'narrow');
});

// ── 折叠键：点一下左栏真的收、再点一下真的开 ──────────────────────────────────
test('折叠键收起左右两栏：点一下收、再点一下开，aria 跟着走', async () => {
  const { createLayout } = await layoutModule();
  const { doc, body, buttons } = layoutDocument(1280);
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
  const { doc, body, buttons } = layoutDocument(1280);
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

  layout.measure(1280);
  assert.equal(body.dataset.layout, 'wide', '容器被拖宽后回到常驻三栏');
  assert.equal(body.classList.contains('is-notes-open'), false, '人收起过的批注，拖宽也不会偷偷打开');

  doc.listeners.click[0]({ target: notesButton });
  layout.measure(860);
  layout.measure(1280);
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

// ── 顶栏五项：logo、文档名 + 类型标签、保存态、折叠左、折叠右、历史批注 ────────
test('顶栏结构：logo 在左上，文档名 + 类型标签、保存态、两个折叠键、历史批注都在', () => {
  const html = read('doc-workbench.html');
  const header = html.match(/<header class="topbar"[\s\S]*?<\/header>/);
  assert.ok(header, '页面要有一层顶栏');
  const bar = header[0];

  const logo = bar.match(/<svg[^>]*class="brand-mark"|<svg[^>]*aria-label="Logics"[\s\S]*?<\/svg>/);
  assert.ok(logo, 'logo 是内联 SVG，不是外链图片');
  assert.match(bar, /<svg[^>]*viewBox="16 16 68 68"/, '用 Logics 标记本体');
  assert.match(bar, /width="24"[^>]*height="24"|height="24"[^>]*width="24"/, 'logo 是 24px');
  assert.match(bar, /id="projectName"/, '文档名');
  assert.match(bar, /class="doc-kind"[^>]*id="docKind"|id="docKind"[^>]*class="doc-kind"/, '文档名后面跟类型标签');
  assert.match(bar, /id="saveState"[^>]*role="status"/, '保存态要可朗读');
  assert.match(bar, /id="tocCollapse"[^>]*data-collapse="toc"/, '折叠左');
  assert.match(bar, /id="notesCollapse"[^>]*data-collapse="notes"/, '折叠右');
  assert.match(bar, /id="historyOpen"/, '历史批注入口');

  // 顺序就是顶栏的读法：logo → 文档名 → 保存态 → 折叠左 → 折叠右 → 历史。
  const order = ['brand-mark', 'id="projectName"', 'id="saveState"', 'id="tocCollapse"', 'id="notesCollapse"', 'id="historyOpen"']
    .map((needle) => bar.indexOf(needle));
  assert.ok(order.every((index) => index >= 0), '顶栏五项都要齐');
  assert.deepEqual([...order].sort((a, b) => a - b), order, '顶栏顺序：logo 在左上，保存态在折叠键前');

  assert.match(html, /<script src="\/doc-layout.js"><\/script>/, '本地页要加载布局接线');
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
  assert.match(paper, /font-size:\s*17\.5px/);
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
    '.inline-toolbar', '.history-panel', '.overall-menu', '.feedback-composer',
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

// ── 三栏按容器宽度降级 ──────────────────────────────────────────────────────
test('三栏按 @container 降级：≥1180 常驻、900–1180 目录折成 48、<900 批注改滑出层', () => {
  const css = read('doc-workbench.css');
  const workspace = ruleOf(css, '.workspace {');
  assert.match(workspace, /container-type:\s*inline-size/, '工作台容器自己当查询容器');
  assert.match(workspace, /container-name:\s*workbench/);

  const wide = atBlockOf(css, '@container workbench (min-width: 1180px)');
  assert.match(wide, /\.toc-panel\s*\{[^}]*240px/, '宽档目录 240');
  assert.match(wide, /\.doc\s*\{[^}]*760px/, '宽档纸 760');
  assert.match(wide, /\.notes-panel\s*\{[^}]*300px/, '宽档批注 300');

  const medium = atBlockOf(css, '@container workbench (max-width: 1179.98px)');
  assert.match(medium, /\.toc-panel\s*\{[^}]*48px/, '中档目录折成 48 图标条');
  assert.match(medium, /\.doc\s*\{[^}]*min-width:\s*520px/, '纸不低于 520');
  assert.match(medium, /\.notes-panel\s*\{[^}]*280px/, '中档批注 280');
  assert.match(medium, /\.toc-title\s*\{\s*display:\s*none/, '图标条只留页号');

  const narrow = atBlockOf(css, '@container workbench (max-width: 899.98px)');
  assert.match(narrow, /\.notes-panel:not\(\.is-overlay\)\s*\{\s*display:\s*none/, '窄档不再给批注留列');

  const drawer = ruleOf(css, '.notes-panel.is-overlay {');
  assert.match(drawer, /position:\s*fixed/, '滑出层覆盖在纸上');
  assert.match(drawer, /transform:\s*translateX\(100%\)/, '默认滑在纸外');
  assert.match(drawer, /box-shadow:/, '浮起来的临时层才有投影');
  assert.match(css, /body\.is-notes-open \.notes-panel\.is-overlay\s*\{[^}]*transform:\s*none/,
    '点开才滑进来');

  assert.doesNotMatch(css, /@media[^{]*\{[^}]*\.(toc-panel|notes-panel)\s*\{/, '三栏不许再看视口宽度');
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
