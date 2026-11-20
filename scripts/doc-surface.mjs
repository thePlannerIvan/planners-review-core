#!/usr/bin/env node
/**
 * 为一份文字工作稿生成 `review-surface/2.0.0`：同一个工作台页面，第二个入口（DSH 侧栏）。
 *
 * 用法：node scripts/doc-surface.mjs <storyline.md|by-page.md> [--json]
 *
 * 生成什么：
 *   · `.doc-workbench/review-surface.json` —— 宿主据它打开侧栏标签；id 固定，
 *     所以同一份稿子再生成一次 = 刷新那一个面，不是另开一份；
 *   · `.doc-workbench/index.html` —— 自包含入口：内联的是 `assets/workbench/` 里同一份
 *     页面逻辑（transport / 行内格式 / 拖拽 / 图块 / 工作台），不是另写一份侧栏页。
 *     入口里留一行裸的 `{{REVIEW_BRIDGE}}`，宿主在那里注入公共桥；
 *   · `.doc-workbench/binding.json` —— 命令后端据它认领这份稿子。工作稿身份不属于通用
 *     surface 契约（契约不表达审阅语义），所以放在 surface 旁边而不是塞进契约字段。
 *
 * `dir` 是文档所在目录：正文里的图片路径本来就相对它，侧栏通过桥的 asset 通道取图。
 * 生成动作不改工作稿一个字节。
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { VERSION as DOC_CONTRACT, parseDocument } from './lib/doc-blocks.mjs';
import { DOC_BINDING_CONTRACT, DOC_COMMAND_BACKEND } from './doc-command.mjs';

const HERE = fileURLToPath(new URL('..', import.meta.url));
const ASSETS = join(HERE, 'assets', 'workbench');
const ENTRY_NAME = 'index.html';

/**
 * 面 id 按「哪份工作稿」区分：同一份再打开 = 刷新那个标签；不同稿子各占一个标签。
 * basename 给人读，短哈希保证不同目录的同名稿也不互相顶掉。
 */
function surfaceIdFor(file) {
  const slug = basename(file, extname(file)).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'doc';
  return `planners-doc/workbench-${slug}-${createHash('sha256').update(file).digest('hex').slice(0, 6)}`;
}

const fail = (code, message) => { throw Object.assign(Error(message), { code }); };

/** 页面里那几段脚本的磁盘来源：与本地页 serve 的是同一批文件，侧栏只是把它们内联。 */
const SCRIPTS = [
  ['/vendor/marked.js', join(HERE, 'assets', 'content-review', 'marked.umd.js')],
  ['/doc-transport.js', join(ASSETS, 'doc-transport.js')],
  ['/doc-inline.js', join(ASSETS, 'doc-inline.js')],
  ['/doc-drag.js', join(ASSETS, 'doc-drag.js')],
  ['/doc-feedback.js', join(ASSETS, 'doc-feedback.js')],
  ['/doc-images.js', join(ASSETS, 'doc-images.js')],
  ['/doc-workbench.js', join(ASSETS, 'doc-workbench.js')],
];

/** 生成自包含入口：CSS / 脚本全部内联，只留一行裸的桥注入点。 */
export function renderDocSurfaceEntry() {
  let html = readFileSync(join(ASSETS, 'doc-workbench.html'), 'utf8');
  const css = readFileSync(join(ASSETS, 'doc-workbench.css'), 'utf8');
  const link = '<link rel="stylesheet" href="/doc-workbench.css">';
  if (!html.includes(link)) fail('doc_surface_template', '页面模板缺少样式引用，无法生成自包含入口');
  html = html.replace(link, () => `<style>\n${css}\n</style>`);
  for (const [src, file] of SCRIPTS) {
    const tag = `<script src="${src}"></script>`;
    if (!html.includes(tag)) fail('doc_surface_template', `页面模板缺少脚本 ${src}`);
    const source = readFileSync(file, 'utf8').replaceAll('</script', '<\\/script');
    html = html.replace(tag, () => `<script>\n${source}\n</script>`);
  }
  if (!html.includes('</head>')) fail('doc_surface_template', '页面模板缺少 </head>');
  // 桥要早于页面脚本连上：放在 </head> 前，裸着独占一行（宿主原地替换整段）。
  return html.replace('</head>', () => `  {{REVIEW_BRIDGE}}\n</head>`);
}

function frontMatterOf(docPath) {
  // 只看头部，不补锚点、不写盘：生成 surface 不改工作稿一个字节。
  const parsed = parseDocument(readFileSync(docPath, 'utf8'), { checkImages: false });
  return parsed.front ?? {};
}

/**
 * 为 `docPath` 生成侧栏审阅面。返回的 `surface` 就是写进 review-surface.json 的对象，
 * 测试与调用方不用再读一遍文件才知道里面是什么。
 */
export function buildDocSurface({ docPath } = {}) {
  if (!docPath) fail('doc_surface_doc', '需要一份工作稿路径');
  const file = realpathSync(resolve(docPath));
  if (!statSync(file).isFile()) fail('doc_surface_doc', `不是文件：${file}`);
  const directory = dirname(file);
  const stateDir = join(directory, '.doc-workbench');
  mkdirSync(stateDir, { recursive: true });

  const front = frontMatterOf(file);
  if (front.contract !== DOC_CONTRACT) {
    fail('doc_surface_contract', `侧栏工作台只认 ${DOC_CONTRACT}，实际 ${JSON.stringify(front.contract)}`);
  }

  const entryPath = join(stateDir, ENTRY_NAME);
  writeFileSync(entryPath, renderDocSurfaceEntry(), 'utf8');

  const surfacePath = join(stateDir, 'review-surface.json');
  const bindingPath = join(stateDir, 'binding.json');
  writeFileSync(bindingPath, `${JSON.stringify({
    contract: DOC_BINDING_CONTRACT,
    doc: `../${basename(file)}`,
  }, null, 2)}\n`, 'utf8');

  const surface = {
    contract_version: 'review-surface/2.0.0',
    id: surfaceIdFor(file),
    title: `${front.project || basename(file)} · 文字工作台`,
    description: `块级工作稿：${basename(file)}`,
    project_root: '..',
    dir: '..',
    entry: `.doc-workbench/${ENTRY_NAME}`,
    wake: {
      mode: 'steer',
      text: '文字工作台派发了一条块级反馈（{unit}）：请读工作稿，只改任务里绑定的块。',
    },
    command_backend: DOC_COMMAND_BACKEND,
    capabilities: ['command'],
  };
  writeFileSync(surfacePath, `${JSON.stringify(surface, null, 2)}\n`, 'utf8');

  return { docPath: file, surfacePath, entryPath, bindingPath, surface };
}

const isCli = (() => {
  try {
    return process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
  } catch {
    return false;
  }
})();

if (isCli) {
  const args = process.argv.slice(2);
  const docArg = args.find((arg) => !arg.startsWith('--'));
  if (!docArg) {
    console.error('用法：node scripts/doc-surface.mjs <storyline.md|by-page.md> [--json]');
    process.exit(2);
  }
  try {
    const built = buildDocSurface({ docPath: docArg });
    if (args.includes('--json')) {
      process.stdout.write(`${JSON.stringify({ ok: true, ...built }, null, 2)}\n`);
    } else {
      console.log(`侧栏审阅面已生成：${built.surfacePath}`);
      console.log(`入口：${built.entryPath}`);
      console.log(`用 review_open 打开 ${built.surfacePath}（同一个 id 再打开 = 刷新）。`);
    }
  } catch (error) {
    console.error(`[${error?.code ?? 'doc_surface'}] ${error?.message ?? error}`);
    process.exit(1);
  }
}
