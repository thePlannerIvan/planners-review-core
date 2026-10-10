import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {createRequire} from 'node:module';

const [branding, lucide] = process.argv.slice(2);
if (!branding || !lucide) throw Error('Usage: vendor-review-ui.mjs <logics-branding> <lucide-package>');
const assets = resolve(import.meta.dirname, '../assets');
const require = createRequire(import.meta.url);
const library = require(join(resolve(lucide), 'dist/cjs/lucide.js'));
const names = ['ArrowUp', 'ArrowDown', 'ChevronUp', 'ChevronDown', 'ChevronLeft', 'ChevronRight', 'Plus',
  'Trash2', 'GripVertical', 'Save', 'RefreshCw', 'PanelRightClose', 'PanelRightOpen', 'ImagePlus',
  'MessageSquare', 'Send', 'Download', 'MousePointer2', 'SquareDashed', 'Undo2', 'History', 'X', 'Check', 'Search'];
mkdirSync(join(assets, 'review-ui'), {recursive:true});
const icons = Object.fromEntries(names.map(name => {
  const exported = library[name];
  const nodes = exported?.[0] === 'svg' ? exported[2] : exported;
  if (!Array.isArray(nodes) || nodes.some(node => !Array.isArray(node) || typeof node[0] !== 'string' || !node[1] || typeof node[1] !== 'object')) {
    throw Error('Unsupported Lucide node format: ' + name);
  }
  return [name, nodes];
}));
writeFileSync(join(assets, 'review-ui/icons.json'), JSON.stringify(icons));
writeFileSync(join(assets, 'review-ui/lucide.LICENSE'), readFileSync(join(lucide, 'LICENSE')));
writeFileSync(join(assets, 'review-ui/logics-mark.svg'), readFileSync(join(branding, 'svg/alt-geo-mark-accent.svg')));
writeFileSync(join(assets, 'review-ui/logics.LICENSE.txt'), 'Logics mark: project-owned geometric alternate. Letter outlines derived from Inter (SIL OFL 1.1).\n' + readFileSync(join(branding, 'fonts/inter-OFL.txt'), 'utf8'));
console.log('Vendored Logics geometric mark and selected Lucide icon nodes.');
