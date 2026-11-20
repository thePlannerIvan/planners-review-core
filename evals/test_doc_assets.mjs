import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// 只测公开的缝：工作台 HTTP 命令面（打开 / 取图 / 换图）、磁盘上的文档与资产清单、
// 两个校验器的命令行回执。图怎么解析、清单怎么写是实现细节。
const core = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DOC_VALIDATOR = join(core, 'scripts', 'validate-doc.mjs');
const ASSET_VALIDATOR = join(core, 'scripts', 'validate-doc-assets.mjs');
const WORKBENCH_DIR = join(core, 'assets', 'workbench');

const sandboxes = [];
after(() => { for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true }); });

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

// ── 夹具：真实的 PNG 与 SVG 字节 ─────────────────────────────────────────────
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** 1×1 的真 PNG（RGB 各一字节）。像素不同 → 文件字节不同，但仍是合法 PNG。 */
function png(rgb) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // color type: truecolor
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(Buffer.from([0, ...rgb]))),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

const svg = (text, extra = '') => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 160">`
  + `<rect width="320" height="160" fill="#fffdf8"/><text x="16" y="48">${text}</text>${extra}</svg>`;

const FRONT = '---\ncontract: planners-doc/2\ndoc: storyline\nproject: 图块测试\n---\n\n';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'planners-assets-'));
  sandboxes.push(dir);
  mkdirSync(join(dir, 'assets'), { recursive: true });
  writeFileSync(join(dir, 'assets', 'pixel.png'), png([47, 111, 79]));
  writeFileSync(join(dir, 'assets', 'chart.svg'), svg('结构图'));
  const path = join(dir, 'storyline.md');
  writeFileSync(path, `${FRONT}
# 一、图

## 页一

![数据图](assets/pixel.png)
<!-- b:aaaaaa -->

![结构图](assets/chart.svg)
<!-- b:bbbbbb -->

正文块，不受换图影响。<!-- b:cccccc -->
`);
  return { dir, path };
}

async function openWorkbench(t, docPath) {
  const { startDocWorkbench } = await import('../scripts/doc-workbench.mjs');
  const server = await startDocWorkbench({ docPath, port: 0 });
  t.after(() => server.close());
  return server;
}

const getDoc = async (url) => {
  const response = await fetch(`${url}/api/doc`);
  assert.equal(response.status, 200, `GET /api/doc 应返回 200，实际 ${response.status}`);
  return response.json();
};

const assetResponse = (url, path) => fetch(`${url}/asset?path=${encodeURIComponent(path)}`);
const replaceAsset = (url, body) => fetch(`${url}/api/asset/replace`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});
const postJson = (url, path, body) => fetch(`${url}${path}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

const validateDoc = (path) => {
  const result = spawnSync(process.execPath, [DOC_VALIDATOR, path], { encoding: 'utf8' });
  return { code: result.status, out: JSON.parse(result.stdout || 'null'), stdout: result.stdout, stderr: result.stderr };
};

const validateAssets = (path, extra = []) => {
  const result = spawnSync(process.execPath, [ASSET_VALIDATOR, path, ...extra], { encoding: 'utf8' });
  let out = null;
  try { out = JSON.parse(result.stdout); } catch { /* --text 时给人读输出 */ }
  return { code: result.status, out, stdout: result.stdout, stderr: result.stderr };
};

const manifestOf = (dir) => JSON.parse(readFileSync(join(dir, 'storyline.assets.json'), 'utf8'));

// ── 显示：位图与 SVG 都能取到；SVG 只当图片，不执行脚本 ──────────────────────
test('文档里的位图与 SVG 都能就地加载；SVG 作为图片隔离，脚本不执行', async (t) => {
  const { dir, path } = fixture();
  writeFileSync(join(dir, 'assets', 'evil.html'), '<script>alert(1)</script>');
  const outside = mkdtempSync(join(tmpdir(), 'planners-assets-outside-'));
  sandboxes.push(outside);
  writeFileSync(join(outside, 'outside.svg'), svg('目录外'));
  symlinkSync(join(outside, 'outside.svg'), join(dir, 'assets', 'link.svg'));
  const server = await openWorkbench(t, path);
  const doc = await getDoc(server.url);

  const images = doc.blocks.filter((block) => block.type === 'image');
  assert.equal(images.length, 2, '文档里应该有两张图块');
  assert.deepEqual(images.map((block) => block.image.path), ['assets/pixel.png', 'assets/chart.svg']);
  assert.deepEqual(images.map((block) => block.image.alt), ['数据图', '结构图']);
  assert.equal(images[0].editable, false, '图块不可当文字改，只换文件');
  assert.match(images[1].reason, /换文件/, '图块的说明要指向换文件');

  const pngResponse = await assetResponse(server.url, 'assets/pixel.png');
  assert.equal(pngResponse.status, 200);
  assert.equal(pngResponse.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await pngResponse.arrayBuffer()), readFileSync(join(dir, 'assets', 'pixel.png')));

  const svgResponse = await assetResponse(server.url, 'assets/chart.svg');
  assert.equal(svgResponse.status, 200);
  assert.equal(svgResponse.headers.get('content-type'), 'image/svg+xml');
  const svgBody = await svgResponse.text();
  assert.match(svgBody, /<svg/, 'SVG 原样返回，工作台只把它当图片');
  const csp = svgResponse.headers.get('content-security-policy') ?? '';
  assert.match(csp, /sandbox/, 'SVG 必须带 sandbox 的 CSP：即使被单独打开也不执行脚本');
  assert.match(csp, /script-src 'none'/, 'SVG 的脚本源必须显式关掉');

  // 页面把它放进 <img>，不是 object / iframe / innerHTML；页面脚本来自工作台自己。
  const page = await (await fetch(`${server.url}/`)).text();
  assert.match(page, /src="\/doc-images\.js"/, '页面要加载图块显示模块');
  const imagesSource = readFileSync(join(WORKBENCH_DIR, 'doc-images.js'), 'utf8');
  assert.match(imagesSource, /createElement\('img'\)/);
  assert.doesNotMatch(imagesSource, /createElement\('(?:object|iframe|embed)'\)/);
  assert.doesNotMatch(imagesSource, /innerHTML\s*=\s*[^;]*svg/i, 'SVG 不能被内联进 DOM');
  assert.match(imagesSource, /addEventListener\('error'/, '取不到图要有失败分支');
  assert.match(imagesSource, /未能加载/, '失败时就说明白，不编造');
  assert.match(imagesSource, /image-viewer/, '点开有放大浮层');
  assert.match(imagesSource, /Escape/, '浮层可以用 Esc 关掉');
  assert.match(imagesSource, /naturalWidth/, '放大按图片真实像素算，能看清细节');
  assert.doesNotMatch(imagesSource, /fetch\(/, '缩放只读：显示模块不发写请求');
  assert.doesNotMatch(imagesSource, /__compose/, '缩放不参与块保存');

  // 同源 /asset 只放图片：HTML 不能借它变成可执行页面。
  const evil = await assetResponse(server.url, 'assets/evil.html');
  assert.equal(evil.status, 404, '/asset 绝不能把 HTML 当资产发出去');
  const linked = await assetResponse(server.url, 'assets/link.svg');
  assert.equal(linked.status, 404, '符号链接指到文档目录外时也不能当资产发出去');
});

test('页面按 Markdown 引用就地显示：取不到时标「未能加载 · 路径」', async () => {
  const module = await import('../assets/workbench/doc-images.js');
  const images = module.default ?? module;
  assert.equal(images.failureText({ path: 'assets/missing.png' }), '未能加载 · assets/missing.png');
  assert.equal(images.assetUrl('assets/a b.png', 'abcdef1234567890'), '/asset?path=assets%2Fa%20b.png&v=abcdef123456');
  assert.equal(images.clampZoom(99), 8);
  assert.equal(images.clampZoom(0.01), 0.25);
  assert.equal(images.zoomStep(1, 1), 1.25);
  assert.equal(images.zoomStep(1, -1), 0.8);
});

test('图块加载失败时标「未能加载」，恢复后重新显示；整个过程不碰块内容', async () => {
  const module = await import('../assets/workbench/doc-images.js');
  const images = module.default ?? module;
  // 最小 DOM 形状：只够 render 接线，不模拟浏览器排版。
  const fakeNode = (tag) => {
    const listeners = new Map();
    const classes = new Set();
    return {
      tagName: tag.toUpperCase(), className: '', hidden: false, style: {}, dataset: {}, children: [],
      classList: { add: (name) => classes.add(name), remove: (name) => classes.delete(name), contains: (name) => classes.has(name) },
      append(...nodes) { this.children.push(...nodes); },
      setAttribute() {},
      addEventListener(type, handler) { listeners.set(type, handler); },
      emit(type) { listeners.get(type)?.({ type }); },
    };
  };
  const previous = globalThis.document;
  globalThis.document = { createElement: fakeNode };
  try {
    const figure = images.render({ path: 'assets/missing.png', alt: '缺图' }, {});
    const button = figure.children[0];
    const img = button.children[0];
    const failed = figure.children[1];
    assert.equal(img.src, '/asset?path=assets%2Fmissing.png');
    assert.equal(failed.hidden, true);

    img.emit('error');
    assert.equal(figure.classList.contains('is-failed'), true, '取不到图要标失败态');
    assert.equal(button.hidden, true, '失败时不再假装能点开');
    assert.equal(failed.hidden, false);
    assert.equal(failed.children[0].textContent, '未能加载 · assets/missing.png', '失败文案带路径，不编造');

    img.emit('load');
    assert.equal(figure.classList.contains('is-failed'), false, '文件补上后回到可显示状态');
    assert.equal(button.hidden, false);
    assert.equal(failed.hidden, true);
    assert.equal(figure.children[2].textContent, '缺图', '说明文字来自正文 alt');
  } finally {
    globalThis.document = previous;
  }
});

// ── 清单：打开时按正文登记；换文件只换指纹，正文引用不动 ──────────────────────
test('打开文档即把图登记进资产清单，清单可被校验器独立核对', async (t) => {
  const { dir, path } = fixture();
  const server = await openWorkbench(t, path);
  await getDoc(server.url);

  const manifest = manifestOf(dir);
  assert.equal(manifest.contract, 'doc-assets/1');
  assert.equal(manifest.doc, 'storyline.md', '清单属于这一份文档');
  assert.deepEqual(manifest.assets.map((asset) => [asset.path, asset.kind]), [
    ['assets/pixel.png', 'bitmap'],
    ['assets/chart.svg', 'svg'],
  ]);
  assert.deepEqual(manifest.assets[0].anchors, ['b:aaaaaa'], '清单按锚点绑定图块身份');
  assert.equal(manifest.assets[0].bytes, readFileSync(join(dir, 'assets', 'pixel.png')).length);
  assert.equal(manifest.assets[0].sha256, sha256(readFileSync(join(dir, 'assets', 'pixel.png'))));
  assert.ok(!('replaced_from_sha256' in manifest.assets[0]), '第一次登记没有「上一版」');

  const verdict = validateAssets(path);
  assert.equal(verdict.code, 0, `清单应当通过校验：${verdict.stdout}${verdict.stderr}`);
  assert.equal(verdict.out?.valid, true);
  assert.equal(verdict.out?.checked?.assets, 2);

  // 正文校验器仍然只管文档本身，不受清单影响。
  assert.equal(validateDoc(path).code, 0);
});

test('换掉位图文件后：引用路径不变、文档逐字不动、其他块逐字不动，清单记下上一版指纹', async (t) => {
  const { dir, path } = fixture();
  const before = readFileSync(path, 'utf8');
  const oldPng = readFileSync(join(dir, 'assets', 'pixel.png'));
  const nextPng = png([180, 66, 48]);
  const server = await openWorkbench(t, path);
  const opened = await getDoc(server.url);

  const response = await replaceAsset(server.url, {
    anchor: 'b:aaaaaa',
    base_sha256: opened.sha256,
    content_base64: nextPng.toString('base64'),
  });
  const receipt = await response.json();
  assert.equal(response.status, 200, JSON.stringify(receipt));
  assert.equal(receipt.ok, true);
  assert.equal(receipt.asset.path, 'assets/pixel.png', '换图不改引用路径：路径由正文决定，请求里根本没有路径');
  assert.equal(receipt.asset.sha256, sha256(nextPng));

  assert.deepEqual(readFileSync(join(dir, 'assets', 'pixel.png')), nextPng, '文件被换成新内容');
  assert.equal(readFileSync(path, 'utf8'), before, '换图一个字节都不许动正文');
  const after = await getDoc(server.url);
  for (const block of opened.blocks) {
    assert.equal(after.blocks.find((item) => item.anchor === block.anchor).raw, block.raw,
      `块 ${block.anchor} 的 raw 必须逐字不动`);
  }
  assert.match(before, /!\[数据图\]\(assets\/pixel\.png\)/, '正文里的 Markdown 引用原样保留');

  const served = await assetResponse(server.url, 'assets/pixel.png');
  assert.deepEqual(Buffer.from(await served.arrayBuffer()), nextPng, '刷新后取到的是新图');

  const manifest = manifestOf(dir);
  const entry = manifest.assets.find((asset) => asset.path === 'assets/pixel.png');
  assert.equal(entry.sha256, sha256(nextPng));
  assert.equal(entry.replaced_from_sha256, sha256(oldPng), '清单保留上一版指纹，便于追溯换过');
  assert.equal(validateDoc(path).code, 0, '换图后文档仍过 validate-doc');
  assert.equal(validateAssets(path).code, 0, '换图后清单仍自洽');
});

test('模型直接换掉 SVG 文件、正文引用不变：重开工作台即登记新指纹', async (t) => {
  const { dir, path } = fixture();
  const before = readFileSync(path, 'utf8');
  const oldSvg = readFileSync(join(dir, 'assets', 'chart.svg'));
  const server = await openWorkbench(t, path);
  await getDoc(server.url);

  // 模型按工作流的常态是直接改文件（user story 30）；正文一行都不碰。
  const nextSvg = Buffer.from(svg('结构图 · 重画', '<path d="M16 96h288" stroke="#2f6b4f"/>'));
  writeFileSync(join(dir, 'assets', 'chart.svg'), nextSvg);
  const reopened = await getDoc(server.url);

  assert.equal(reopened.blocks.find((block) => block.anchor === 'b:bbbbbb').raw,
    '![结构图](assets/chart.svg)', '重开后图块的 raw 仍是同一句引用');
  assert.equal(readFileSync(path, 'utf8'), before, '换文件不改正文');
  const served = await assetResponse(server.url, 'assets/chart.svg');
  assert.deepEqual(Buffer.from(await served.arrayBuffer()), nextSvg);

  const entry = manifestOf(dir).assets.find((asset) => asset.path === 'assets/chart.svg');
  assert.equal(entry.sha256, sha256(nextSvg));
  assert.equal(entry.replaced_from_sha256, sha256(oldSvg));
  assert.equal(validateDoc(path).code, 0);
  assert.equal(validateAssets(path).code, 0);
});

test('新增一张图：正文引用出现后，打开工作台即登记，旧条目与校验都不受影响', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'planners-assets-'));
  sandboxes.push(dir);
  mkdirSync(join(dir, 'assets'), { recursive: true });
  writeFileSync(join(dir, 'assets', 'chart.svg'), svg('结构图'));
  writeFileSync(join(dir, 'assets', 'later.png'), png([20, 20, 20]));
  const path = join(dir, 'storyline.md');
  writeFileSync(path, `${FRONT}
# 一、图

## 页一

![结构图](assets/chart.svg)
<!-- b:bbbbbb -->
`);
  const server = await openWorkbench(t, path);
  await getDoc(server.url);
  assert.deepEqual(manifestOf(dir).assets.map((asset) => asset.path), ['assets/chart.svg'],
    '没被正文引用的文件不进清单（不替人做决定）');

  writeFileSync(path, `${readFileSync(path, 'utf8')}\n![新图](assets/later.png)\n<!-- b:dddddd -->\n`);
  const reopened = await getDoc(server.url);
  assert.equal(reopened.blocks.find((block) => block.anchor === 'b:dddddd').type, 'image');
  const manifest = manifestOf(dir);
  assert.deepEqual(manifest.assets.map((asset) => asset.path), ['assets/chart.svg', 'assets/later.png']);
  assert.deepEqual(manifest.assets[1].anchors, ['b:dddddd']);
  assert.equal(validateDoc(path).code, 0);
  assert.equal(validateAssets(path).code, 0);
});

test('资产清单校验器挡住漂移：哈希、漏登记、多余条目、文档名不符', async (t) => {
  const { dir, path } = fixture();
  const server = await openWorkbench(t, path);
  await getDoc(server.url);
  const clean = manifestOf(dir);
  const write = (manifest) => writeFileSync(join(dir, 'storyline.assets.json'), JSON.stringify(manifest, null, 2) + '\n');
  const codes = (result) => (result.out?.errors ?? []).map((error) => error.code);

  const tampered = structuredClone(clean);
  tampered.assets[0].sha256 = '0'.repeat(64);
  write(tampered);
  let result = validateAssets(path);
  assert.equal(result.code, 1, result.stdout);
  assert.ok(codes(result).includes('asset_hash_mismatch'), JSON.stringify(result.out?.errors));

  const unregistered = structuredClone(clean);
  unregistered.assets = unregistered.assets.filter((asset) => asset.path !== 'assets/chart.svg');
  write(unregistered);
  result = validateAssets(path);
  assert.equal(result.code, 1);
  assert.ok(codes(result).includes('asset_unregistered'), JSON.stringify(result.out?.errors));

  const extra = structuredClone(clean);
  extra.assets.push({ path: 'assets/pixel.png', kind: 'bitmap', sha256: sha256(readFileSync(join(dir, 'assets', 'pixel.png'))), bytes: 1, anchors: ['b:cccccc'], alt: '不是正文里的图' });
  write(extra);
  result = validateAssets(path, ['--text']);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /asset_duplicate|asset_unreferenced/, result.stdout);

  const wrongDoc = structuredClone(clean);
  wrongDoc.doc = 'by-page.md';
  write(wrongDoc);
  result = validateAssets(path);
  assert.equal(result.code, 1);
  assert.ok(codes(result).includes('doc_mismatch'), JSON.stringify(result.out?.errors));
});

// ── 锁：票 03 的锁定块不许被换图绕过 ────────────────────────────────────────
test('锁定中的图块不可替换；任务完成后才放行，正文始终不动', async (t) => {
  const { dir, path } = fixture();
  const before = readFileSync(path, 'utf8');
  const oldPng = readFileSync(join(dir, 'assets', 'pixel.png'));
  const nextPng = png([9, 9, 9]);
  const server = await openWorkbench(t, path);
  const opened = await getDoc(server.url);

  const feedback = await postJson(server.url, '/api/feedback', {
    scope: 'blocks', anchors: ['b:aaaaaa'], text: '这张图重画一版',
  });
  const receipt = await feedback.json();
  assert.equal(feedback.status, 200, JSON.stringify(receipt));
  const claimed = await postJson(server.url, '/api/task/claim', { task_id: receipt.task.id });
  assert.equal(claimed.status, 200);
  assert.equal((await getDoc(server.url)).blocks.find((block) => block.anchor === 'b:aaaaaa').locked, true);

  const denied = await replaceAsset(server.url, {
    anchor: 'b:aaaaaa', base_sha256: opened.sha256, content_base64: nextPng.toString('base64'),
  });
  const deniedBody = await denied.json();
  assert.equal(denied.status, 409, JSON.stringify(deniedBody));
  assert.equal(deniedBody.code, 'block_locked', '锁定的图块不能被换图绕过');
  assert.deepEqual(readFileSync(join(dir, 'assets', 'pixel.png')), oldPng, '被拒的替换不得写文件');
  assert.equal(readFileSync(path, 'utf8'), before);

  const completed = await postJson(server.url, '/api/task/complete', { task_id: receipt.task.id });
  assert.equal(completed.status, 200);
  const allowed = await replaceAsset(server.url, {
    anchor: 'b:aaaaaa', base_sha256: opened.sha256, content_base64: nextPng.toString('base64'),
  });
  assert.equal(allowed.status, 200, await allowed.clone().text());
  assert.deepEqual(readFileSync(join(dir, 'assets', 'pixel.png')), nextPng);
  assert.equal(readFileSync(path, 'utf8'), before);
  assert.equal(validateDoc(path).code, 0);
});

// ── 真实语料：两份样例的清单也是可交付的 ─────────────────────────────────────
test('两份真实样例的资产清单与正文、磁盘一致', () => {
  const examples = join(core, 'contracts', 'examples');
  for (const name of ['storyline.md', 'by-page.md']) {
    const result = validateAssets(join(examples, name));
    assert.equal(result.code, 0, `${name} 的清单应当通过：${result.stdout}${result.stderr}`);
    assert.equal(result.out?.checked?.assets, 1, `${name} 的样例各引用一张图`);
  }
});
