import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import vm from 'node:vm';
import {reviewUi} from '../scripts/review-ui.mjs';

const editor = readFileSync(new URL('../assets/content-review/workbench-editor.js', import.meta.url), 'utf8');
const shell = readFileSync(new URL('../assets/content-review/shell.html', import.meta.url), 'utf8');

test('content workbench boot guards optional DSH page action and hides wordmark text', () => {
  assert.doesNotMatch(editor, /\bpageButton\.hidden\b/);
  assert.match(editor, /const pageTaskButton = \$\('\#pageTaskButton'\)/);
  assert.doesNotMatch(shell, /<span>Logics<\/span>/);
});

test('every vendored icon is renderable by the actual review UI', () => {
  const icons = JSON.parse(readFileSync(new URL('../assets/review-ui/icons.json', import.meta.url), 'utf8'));
  assert.ok(icons.Search?.length);
  const document = {
    querySelectorAll: () => [],
    createElementNS: (namespaceURI, tag) => ({namespaceURI, tag, children: [], attributes: {},
      setAttribute(key, value) {this.attributes[key] = value;},
      append(node) {this.children.push(node);},
    }),
  };
  const window = {};
  vm.runInNewContext(reviewUi().script, {document, window, get ReviewUI() {return window.ReviewUI;}});
  for (const [name, nodes] of Object.entries(icons)) {
    const svg = window.ReviewUI.icon(name);
    assert.ok(svg.children.length > 0, name);
    assert.equal(svg.children.length, nodes.length, name);
    assert.ok(svg.children.every(node => ['path','circle','rect','line','polyline','polygon','ellipse'].includes(node.tag)), name);
  }
});

// 工作台的可编辑面必须是「点哪改哪」的行内编辑，而不是展开面板 + 旧 bullet 列表。
test('workbench storyline is inline-editable: one claim per row, supports edited in place', () => {
  assert.match(shell, /id="pageTitle"/);
  assert.match(shell, /id="saveButton"/);
  assert.match(shell, /id="pageTaskButton"/);
  assert.match(shell, /id="feedback"/);
  assert.match(shell, /id="notice"/);
  assert.match(shell, /class="[^"]*page-list/);
  assert.match(shell, /data-mode="storyline"/);
  assert.match(shell, /data-mode="bypage"/);
  assert.match(shell, /class="thesis"/);
  assert.match(shell, /class="[^"]*story-stream/);

  assert.match(editor, /data-outline-title=/);
  assert.match(editor, /class="line-title"/);
  assert.match(editor, /class="support-text" data-support-index=/);
  assert.match(editor, /class="support-add"/);
  // 旧 UI 的「点手柄展开 + block-bullet」已被行内编辑取代
  assert.doesNotMatch(editor, /block-bullet/);
  assert.doesNotMatch(editor, /data-block-text/);
  assert.doesNotMatch(editor, /outline-detail/);
  // 支撑回车增、退格删，仍然保留
  assert.match(editor, /event\.key === 'Enter'[\s\S]{0,200}list\.splice\(index \+ 1, 0, ''\)/);
  assert.match(editor, /event\.key === 'Backspace'[\s\S]{0,240}list\.splice\(index, 1\)/);
});

test('workbench comments are an inline card opened from the row action', () => {
  assert.match(editor, /data-outline-note=/);
  assert.match(editor, /<textarea data-note-input=/);
  assert.match(editor, /data-comment-submit=/);
  assert.match(editor, /class="line-comment" data-comment-card=/);
  assert.match(shell, /\.line-comment/);
  // 旧 UI 的 outline-note-editor / outline-note-summary 已去掉
  assert.doesNotMatch(editor, /outline-note-editor/);
  assert.doesNotMatch(editor, /outline-note-summary/);
});

test('workbench drag handles are hover-revealed pointer drags, with Alt+arrow as the keyboard path', () => {
  // 故事线行用手柄拖动，页面导航也保留手柄；都是 pointer 事件，不是 HTML5 draggable 列表赋值
  assert.match(editor, /class="outline-grip"/);
  assert.match(editor, /class="drag-handle"/);
  assert.match(editor, /addEventListener\('pointerdown'/);
  assert.match(editor, /event\.altKey[\s\S]{0,120}ArrowUp/);
  assert.doesNotMatch(editor, /draggable="' \+ writable/);
  assert.match(shell, /\.outline-grip[^}]*opacity: 0/);
  assert.match(shell, /\.outline-line:hover \.outline-grip/);
});

test('workbench save/feedback flow is per-page: autosave, deferred pages and explicit conflict cards', () => {
  assert.match(editor, /status\('已自动保存'\)/);
  assert.match(editor, /页待核对/);
  assert.match(editor, /status\('已提交'\)/);
  assert.match(editor, /status\('待刷新', true\)/);
  assert.match(editor, /data-conflict=/);
  assert.match(editor, /data-keep-mine=/);
  assert.match(editor, /data-use-model=/);
  assert.match(editor, /force_pages/);
  assert.match(editor, /deferred_pages/);
  // 工作台按页同步，不再整份文件锁死成 revision_conflict 就停手
  assert.match(editor, /head\.revision|result\.revision/);
  assert.match(editor, /external_pages/);
  // 握手不落地时要在 2.5s 内说清只读原因，而不是静默白等或把 JS 错误抛给用户
  assert.match(editor, /2500/);
  assert.match(editor, /暂时无法保存修改/);
  assert.match(editor, /status\('未连接'/);
  assert.match(editor, /没有连上审阅宿主/);
});
