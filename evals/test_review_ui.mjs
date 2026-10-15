import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import vm from 'node:vm';
import {reviewUi} from '../scripts/review-ui.mjs';

test('content workbench boot guards optional DSH page action and hides wordmark text', () => {
  const editor = readFileSync(new URL('../assets/content-review/workbench-editor.js', import.meta.url), 'utf8');
  const shell = readFileSync(new URL('../assets/content-review/shell.html', import.meta.url), 'utf8');
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
