import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
const assets = join(import.meta.dirname, '../assets');
export function reviewUi() {
  const logo = readFileSync(join(assets, 'review-ui/logics-mark.svg'), 'utf8');
  return {
    css: readFileSync(join(assets, 'review-ui.css'), 'utf8') + '\n:root {--review-brand-image:url("data:image/svg+xml;base64,' + Buffer.from(logo).toString('base64') + '");}',
    script: readFileSync(join(assets, 'review-ui/interactions.js'), 'utf8')
      .replace('__REVIEW_ICONS__', () => readFileSync(join(assets, 'review-ui/icons.json'), 'utf8')),
  };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(JSON.stringify(reviewUi()));
