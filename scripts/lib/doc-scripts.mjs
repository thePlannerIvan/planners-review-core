/**
 * 页面脚本清单的唯一来源：`assets/workbench/doc-workbench.html` 里的 `<script src>`。
 *
 * 以前这份清单有三份：页面模板一份、`doc-surface.mjs` 内联一份、本地宿主放行一份。
 * 加一个模块时最容易漏掉其中一份——侧栏打不开、本地页却全绿。现在模板是唯一清单：
 * 本地宿主按它放行静态文件，侧栏入口按它内联源码；两边都从 `DOC_SCRIPTS` 取。
 */
import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const LIB = dirname(fileURLToPath(import.meta.url));
const HERE = dirname(dirname(LIB));
const WORKBENCH = join(HERE, 'assets', 'workbench');
export const DOC_TEMPLATE = join(WORKBENCH, 'doc-workbench.html');

/** `/vendor/...` 来自共享资产；其余 `/xxx.js` 都是工作台自己的模块。 */
function fileForSource(src) {
  if (src === '/vendor/marked.js') return join(HERE, 'assets', 'content-review', 'marked.umd.js');
  if (/^\/[a-z0-9-]+\.js$/.test(src)) return join(WORKBENCH, src.slice(1));
  throw Object.assign(Error(`页面脚本清单里有不认识的地址：${src}`), { code: 'doc_scripts_template' });
}

const SOURCES = [...readFileSync(DOC_TEMPLATE, 'utf8').matchAll(/<script src="([^"]+)"><\/script>/g)]
  .map((match) => match[1]);

if (!SOURCES.length) {
  throw Object.assign(Error('页面模板里没有任何脚本，清单不会退化成空'), { code: 'doc_scripts_template' });
}

/** `[{src, file}]`，顺序就是页面加载顺序。 */
export const DOC_SCRIPTS = SOURCES.map((src) => ({ src, file: fileForSource(src) }));

/** 本地宿主放行用的地址集合。 */
export const DOC_SCRIPT_SOURCES = new Set(DOC_SCRIPTS.map((script) => script.src));

/** 地址 → 磁盘文件；不在清单里返回 null（本地宿主据此 404）。 */
export function docScriptFile(src) {
  return DOC_SCRIPTS.find((script) => script.src === src)?.file ?? null;
}

/** 生成入口前先确认每个脚本都在盘上，缺一个就明确报错，不生成半个页面。 */
export function assertDocScripts() {
  for (const script of DOC_SCRIPTS) {
    try {
      if (!statSync(script.file).isFile()) throw Error('不是文件');
    } catch {
      throw Object.assign(Error(`页面脚本缺失：${script.src} → ${script.file}`), { code: 'doc_scripts_template' });
    }
  }
  return DOC_SCRIPTS;
}
