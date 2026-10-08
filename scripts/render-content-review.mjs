import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { reviewUi } from './review-ui.mjs';

const assets = join(dirname(fileURLToPath(import.meta.url)), '../assets/content-review');

/** Optional content shell. Producers own the data, feedback contract, and intake. */
export function renderContentReview(options) {
  const data = {
    feedbackContractVersion: '1.1.0', sections: [], thesis: '', allowUploads: false,
    ...options,
  };
  const shell = readFileSync(join(assets, 'shell.html'), 'utf8');
  const ui = reviewUi();
  const scripts = ui.script + '\n' + readFileSync(join(assets, 'marked.umd.js'), 'utf8') + '\n'
    + readFileSync(join(assets, data.workbench ? 'workbench-editor.js' : 'interactions.js'), 'utf8');
  const tokens = readFileSync(join(assets, '../dsh-tokens.css'), 'utf8');
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  return shell.replace('__REVIEW_DATA__', () => json)
    .replace('__REVIEW_UI__', () => ui.css)
    .replace('__REVIEW_SCRIPT__', () => scripts.replace(/<\/script/gi, '<\\/script'))
    .replace('__DSH_TOKENS__', () => tokens);
}
