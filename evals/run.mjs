#!/usr/bin/env node
/**
 * planners-review-core 回归：契约校验器 + 无插件宿主 + 桥的形状。
 * 用法：node evals/run.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const VALIDATOR = join(ROOT, 'scripts', 'validate-surface.mjs');
const HOST = join(ROOT, 'scripts', 'serve-review.mjs');
const BRIDGE = join(ROOT, 'assets', 'review-bridge.js');

let failed = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const bad = (m) => { failed++; console.log(`  ✗ ${m}`); };

const sandbox = mkdtempSync(join(tmpdir(), 'reviewcore-'));
const projectRoot = join(sandbox, 'project');
const outsideReal = join(sandbox, 'outside-real');
mkdirSync(outsideReal, { recursive: true });
writeFileSync(join(outsideReal, 'index.html'), '<!doctype html><title>外面</title>', 'utf8');
const reviewDir = join(projectRoot, 'work', 'reviews', 'demo');
mkdirSync(reviewDir, { recursive: true });
writeFileSync(join(reviewDir, 'index.html'), '<!doctype html><html><body><h1>审阅</h1><img id="shot" src="shots/a.png">\n{{REVIEW_BRIDGE}}\n</body></html>', 'utf8');
mkdirSync(join(reviewDir, 'shots'), { recursive: true });
writeFileSync(join(reviewDir, 'shots', 'a.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

const surface = (mutate = (d) => d, name = 'surface.json') => {
  const doc = {
    contract_version: 'review-surface/2.0.0',
    id: 'demo/visual',
    title: '演示审阅',
    project_root: '../../..',
    dir: '.',
    entry: 'index.html',
    feedback: 'feedback.json',
    wake: { mode: 'queue', text: '{unit} 已定，只改这一页。' }
  };
  mutate(doc);
  const path = join(reviewDir, name);
  writeFileSync(path, JSON.stringify(doc, null, 2) + '\n', 'utf8');
  return path;
};
const validate = (path) => {
  const r = spawnSync(process.execPath, [VALIDATOR, path], { encoding: 'utf8' });
  let parsed = null;
  try { parsed = JSON.parse(r.stdout); } catch { /* not json */ }
  return { code: r.status, out: parsed, stderr: r.stderr };
};
const codes = (r) => (r.out?.errors ?? []).map((e) => e.code);

// ---------- 1. 契约校验器 ----------
console.log('契约校验器');
{
  const r = validate(surface());
  if (r.code === 0 && r.out?.valid) ok('干净 surface → 合规');
  else bad(`干净 surface 被拦：${JSON.stringify(codes(r))}`);
}
const cases = [
  ['版本号不对', (d) => { d.contract_version = 'review-surface/1.0.0'; }, 'contract_version'],
  ['id 形状不对', (d) => { d.id = 'DemoVisual'; }, 'id_pattern'],
  ['wake.text 为空', (d) => { d.wake.text = ''; }, 'wake_text'],
  ['wake.mode 非法', (d) => { d.wake.mode = 'blocking'; }, 'wake_mode'],
  ['缺 wake', (d) => { delete d.wake; }, 'required'],
  ['dir 落在 project_root 之外', (d) => { d.dir = '../../../../outside-real'; }, 'dir_outside_project'],
  ['entry 不存在', (d) => { d.entry = 'nope.html'; }, 'entry_missing'],
  ['feedback 落在 project_root 之外', (d) => { d.feedback = '../../../../../../etc/feedback.json'; }, 'feedback_outside_project'],
  ['watch 项落在 dir 之外', (d) => { d.watch = ['../../../../../../etc/passwd']; }, 'watch_outside_dir']
];
for (const [label, mutate, expect] of cases) {
  const r = validate(surface(mutate, `bad-${expect}.json`));
  if (r.code !== 0 && codes(r).includes(expect)) ok(`${label} → ${expect}`);
  else bad(`${label} → 期望 ${expect}，实际 ${JSON.stringify(codes(r))}`);
}
{
  writeFileSync(join(reviewDir, 'no-slot.html'), '<!doctype html><html><body>没有注入点</body></html>', 'utf8');
  const r = validate(surface((d) => { d.entry = 'no-slot.html'; }, 'no-slot.json'));
  if (r.code !== 0 && codes(r).includes('bridge_placeholder')) ok('入口没有 {{REVIEW_BRIDGE}} → bridge_placeholder');
  else bad(`缺注入点没拦住：${JSON.stringify(codes(r))}`);
}
{
  // 注入点写法的三条闸门 —— 这两种写法真把页面打挂过（第三方与自家页面各一次）
  const wrong = [
    ['放进 src="" 里', '<script src="{{REVIEW_BRIDGE}}"></script>'],
    ['塞进 <script> 里', '<script>{{REVIEW_BRIDGE}}</script>'],
  ];
  for (const [label, markup] of wrong) {
    const name = `slot-${label.length}.html`;
    writeFileSync(join(reviewDir, name), `<!doctype html><html><body><h1>审阅</h1>${markup}</body></html>`, 'utf8');
    const rr = validate(surface((d) => { d.entry = name; }, `slot-${label.length}.json`));
    if (rr.code !== 0 && codes(rr).includes('bridge_placeholder_not_bare')) {
      ok(`注入点${label} → bridge_placeholder_not_bare（以前只查 includes，这两种都能过）`);
    } else bad(`注入点${label} 没拦住：${JSON.stringify(codes(rr))}`);
  }
  writeFileSync(join(reviewDir, 'slot-twice.html'),
    '<!doctype html><html><body>\n{{REVIEW_BRIDGE}}\n{{REVIEW_BRIDGE}}\n</body></html>', 'utf8');
  const r2 = validate(surface((d) => { d.entry = 'slot-twice.html'; }, 'slot-twice.json'));
  if (r2.code !== 0 && codes(r2).includes('bridge_placeholder_multiple')) ok('注入点出现两次 → bridge_placeholder_multiple');
  else bad(`重复注入点没拦住：${JSON.stringify(codes(r2))}`);
}
{
  // watch 相对 surface 文件（不是相对 dir）。构造一条只有"相对 surface"才合法的路径：
  // surface 在 work/reviews/demo/ 下、dir = '../..'（＝ work）、watch = '../state.json'
  //   surface 相对 → work/reviews/state.json   ✓ 在 dir(work) 内
  //   dir 相对     → <root>/state.json         ✗ 出 dir（旧实现会报 watch_outside_dir）
  writeFileSync(join(projectRoot, 'work', 'reviews', 'state.json'), '{}', 'utf8');
  const r = validate(surface((d) => { d.dir = '../..'; d.entry = 'reviews/demo/index.html'; d.watch = ['../state.json']; }, 'watch-base.json'));
  if (r.code === 0) ok('watch 按"相对 surface 文件"解析（旧实现会把这条判成越界）');
  else bad(`watch 基准仍不对：${JSON.stringify(codes(r))}`);
}
{
  const linkDir = join(projectRoot, 'work', 'reviews', 'link-out');
  symlinkSync(outsideReal, linkDir);
  const d = { contract_version: 'review-surface/2.0.0', id: 'demo/link', title: 'x', project_root: '../../..', dir: '../link-out', entry: 'index.html', wake: { mode: 'queue', text: 'x' } };
  const p = join(reviewDir, 'link.json'); writeFileSync(p, JSON.stringify(d), 'utf8');
  const r = validate(p);
  if (r.code !== 0 && codes(r).includes('dir_outside_project')) ok('dir 是符号链接指到项目外 → dir_outside_project（realpath 防御）');
  else bad(`符号链接 dir 没拦住：${JSON.stringify(codes(r))}`);
}

// ---------- 2. 无插件宿主 ----------
console.log('\n无插件宿主');
const good = surface((d) => d, 'good.json');
const ready = await new Promise((done, fail) => {
  const child = spawn(process.execPath, [HOST, good, '--port', '0', '--no-open'], { encoding: 'utf8' });
  let buffer = '';
  const timer = setTimeout(() => fail(new Error(`宿主没就绪：${buffer}`)), 15000);
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    const match = buffer.match(/\{[\s\S]*"url"[\s\S]*\}/);
    if (match) {
      clearTimeout(timer);
      try { done({ child, info: JSON.parse(match[0]) }); } catch { /* keep reading */ }
    }
  });
  child.on('exit', (code) => { clearTimeout(timer); fail(new Error(`宿主提前退出 ${code}：${buffer}`)); });
});
const { child, info } = ready;
const base = info.url.replace(/\/index\.html$/, '');
try {
  const page = await fetch(info.url);
  const html = await page.text();
  if (page.status === 200 && html.includes('审阅') && html.includes('/__review/bridge.js') && !html.includes('{{REVIEW_BRIDGE}}')) {
    ok(`GET 入口 → 200，且注入点已被换成桥的地址（${html.length} 字节）`);
  } else bad(`入口不对：${page.status} / 注入点未替换`);
  if (html.includes('window.__REVIEW_BASE__')) ok('注入时顺带给出了 base（页面在子目录时，`./` 不等于 `dir`）');
  else bad('没有注入 __REVIEW_BASE__ —— 页面在子目录里时 rel 会解析错');

  // 三种注入写法宿主都要能出**同一个可用页面**。规范是裸标记；另两种旧写法在生产里出现过，
  // 而"两个宿主支持不相交的写法"这件事真的打出过死页面（桥 404 / 嵌套 script）。
  const forms = [
    ['裸标记（规范）', '\n{{REVIEW_BRIDGE}}\n'],
    ['旧：<script src="{{…}}">', '<script src="{{REVIEW_BRIDGE}}"></script>'],
    ['旧：<script>{{…}}</script>', '<script>{{REVIEW_BRIDGE}}</script>'],
  ];
  for (const [label, markup] of forms) {
    writeFileSync(join(reviewDir, 'index.html'),
      `<!doctype html><html><body><h1>审阅</h1><img id="shot" src="shots/a.png">${markup}</body></html>`, 'utf8');
    const r = await (await fetch(`${base}/index.html`)).text();
    const bridged = r.includes('/__review/bridge.js') && !r.includes('{{REVIEW_BRIDGE}}') && r.includes('window.__REVIEW_BASE__');
    if (bridged) ok(`注入写法「${label}」→ 出的是同一个可用页面`);
    else bad(`注入写法「${label}」没被正确处理`);
  }

  const bridgeJs = await fetch(`${base}/__review/bridge.js`);
  const bridgeText = await bridgeJs.text();
  if (bridgeJs.status === 200 && bridgeText.includes('window.ReviewBridge')) ok('GET /__review/bridge.js → 桥本体');
  else bad(`桥没端出来：${bridgeJs.status}`);

  const asset = await fetch(`${base}/shots/a.png`);
  if (asset.status === 200 && asset.headers.get('content-type') === 'image/png') ok('GET 资产 → 200 + image/png');
  else bad(`资产不对：${asset.status} ${asset.headers.get('content-type')}`);

  const traversal = await fetch(`${base}/%2e%2e/%2e%2e/%2e%2e/%2e%2e/etc/passwd`);
  if (traversal.status === 404) ok('编码的路径穿越 → 404');
  else bad(`路径穿越没拦住：${traversal.status}`);

  symlinkSync('/etc/passwd', join(reviewDir, 'escape.txt'));
  const viaLink = await fetch(`${base}/escape.txt`);
  if (viaLink.status === 404) ok('符号链接指到项目外 → 404（realpath 校验生效）');
  else bad(`符号链接逃逸没拦住：${viaLink.status}`);

  // Range：剪接预演那一面逼出来的（它在 SOURCE 时间轴上拖 `<video>`，素材 0.5–1.8 GB、在 dir 之外）。
  // **"看着像支持"不算** —— 下面每一条都对**实收字节数**。
  {
    const big = Buffer.alloc(102400);
    for (let i = 0; i < big.length; i += 1) big[i] = i & 0xff;
    writeFileSync(join(reviewDir, 'clip.mp4'), big);

    const noRange = await fetch(`${base}/clip.mp4`);
    const noRangeBody = Buffer.from(await noRange.arrayBuffer());
    if (noRange.status === 200 && noRangeBody.length === big.length
        && noRange.headers.get('accept-ranges') === 'bytes') {
      ok(`无 Range → 200 + 整份 ${noRangeBody.length} B，且**仍带** accept-ranges: bytes`);
    } else {
      bad(`无 Range 那一档不对：${noRange.status} / ${noRangeBody.length} B / accept-ranges=${noRange.headers.get('accept-ranges')}`);
    }

    const one = await fetch(`${base}/clip.mp4`, { headers: { range: 'bytes=0-1023' } });
    const oneBody = Buffer.from(await one.arrayBuffer());
    if (one.status === 206 && oneBody.length === 1024 && oneBody.length !== big.length
        && one.headers.get('content-range') === `bytes 0-1023/${big.length}`
        && one.headers.get('content-length') === '1024'
        && one.headers.get('accept-ranges') === 'bytes') {
      ok(`单区间 → 206，实收 ${oneBody.length} B（不是整个 ${big.length} B），Content-Range 格式对`);
    } else {
      bad(`单区间不对：${one.status} / 实收 ${oneBody.length} B / content-range=${one.headers.get('content-range')} / content-length=${one.headers.get('content-length')}`);
    }
    if (oneBody.equals(big.subarray(0, 1024))) ok('单区间取回的是**那一段真字节**（不是从 0 截了个长度对的东西）');
    else bad('区间字节内容不对');

    const open = await fetch(`${base}/clip.mp4`, { headers: { range: 'bytes=102400-' } });
    const openBody = Buffer.from(await open.arrayBuffer());
    if (open.status === 206 && openBody.length === 4096
        && open.headers.get('content-range') === `bytes 102400-${102399 + 0}/${big.length}`) {
      ok('开区间 `bytes=N-` 落在文件尾之内也算得对');
    } else if (open.status === 416) {
      ok('`bytes=N-`（N == 文件大小）→ 416（起点就是末尾，没有可给的字节）');
    } else {
      bad(`开区间不对：${open.status} / ${openBody.length} B / ${open.headers.get('content-range')}`);
    }

    const suffix = await fetch(`${base}/clip.mp4`, { headers: { range: 'bytes=-500' } });
    const suffixBody = Buffer.from(await suffix.arrayBuffer());
    if (suffix.status === 206 && suffixBody.length === 500
        && suffix.headers.get('content-range') === `bytes ${big.length - 500}-${big.length - 1}/${big.length}`
        && suffixBody.equals(big.subarray(big.length - 500))) {
      ok('后缀区间 `bytes=-500` → 最后 500 B（不是"前 500 B"）');
    } else {
      bad(`后缀区间不对：${suffix.status} / ${suffixBody.length} B / ${suffix.headers.get('content-range')}`);
    }

    const beyond = await fetch(`${base}/clip.mp4`, { headers: { range: 'bytes=999999-' } });
    const beyondBody = Buffer.from(await beyond.arrayBuffer());
    if (beyond.status === 416 && beyond.headers.get('content-range') === `bytes */${big.length}`
        && beyondBody.length === 0) {
      ok('不可满足 → 416 + `bytes */<total>`，且不发字节');
    } else {
      bad(`416 那一档不对：${beyond.status} / content-range=${beyond.headers.get('content-range')} / ${beyondBody.length} B`);
    }

    // 多区间**故意不支持**：<video> seek 只用单区间，multipart/byteranges 写错会静默截断。
    // 回 200 整份是允许的 —— 这条测试就是那句"有意"的凭据。
    const multi = await fetch(`${base}/clip.mp4`, { headers: { range: 'bytes=0-99,200-299' } });
    const multiBody = Buffer.from(await multi.arrayBuffer());
    if (multi.status === 200 && multiBody.length === big.length) {
      ok('多区间 → 200 整份（**故意不支持** multipart：宁可多给，不许静默截断）');
    } else {
      bad(`多区间应当是 200 整份：${multi.status} / ${multiBody.length} B`);
    }

    const head = await fetch(`${base}/clip.mp4`, { method: 'HEAD' });
    if (head.status === 200 && head.headers.get('accept-ranges') === 'bytes') ok('HEAD 也带 accept-ranges（浏览器先探这个）');
    else bad(`HEAD 不对：${head.status}`);

    // .mov 那一族：宿主原先没有 → application/octet-stream → <video> 放不出来
    writeFileSync(join(reviewDir, 'take.mov'), Buffer.from('MOVMOV'));
    const mov = await fetch(`${base}/take.mov`);
    if (mov.headers.get('content-type') === 'video/quicktime') ok('.mov → video/quicktime（原先会给 octet-stream）');
    else bad(`.mov 的 content-type 不对：${mov.headers.get('content-type')}`);

    // 注入了桥的页面**不认** Range：切一半会把注入点切坏
    const htmlRange = await fetch(`${base}/index.html`, { headers: { range: 'bytes=0-99' } });
    const htmlBody = await htmlRange.text();
    if (htmlRange.status === 200 && htmlBody.includes('/__review/bridge.js')) {
      ok('页面（注入过桥的 HTML）**不认** Range → 200 整份，注入点不会被切坏');
    } else {
      bad(`页面被 Range 切了：${htmlRange.status} / 有桥=${htmlBody.includes('bridge.js')}`);
    }
  }

  // 断言用**深度相等**：宿主必须原样落盘 payload。抽查"某个字段在不在"漏掉过真 bug
  // （插件曾经套了一层 {receivedAt, payload} 信封，Skill 就读不懂自己页面写的东西了）
  const payload = { overall: 'revise', items: [{ id: 'page-01', note: '这里改一下' }] };
  const written = await (await fetch(`${base}/__review/write`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload)
  })).json();
  const feedbackFile = join(reviewDir, 'feedback.json');
  const saved = existsSync(feedbackFile) ? JSON.parse(readFileSync(feedbackFile, 'utf8')) : null;
  if (written.ok && JSON.stringify(saved) === JSON.stringify(payload)) ok('POST write → 原样落盘（与发出去的深度相等，不套信封）');
  else bad(`write 不是原样落盘：落的是 ${JSON.stringify(saved)?.slice(0, 120)}`);

  const woke = await (await fetch(`${base}/__review/wake`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ unit: 'page-03' })
  })).json();
  const log = existsSync(join(reviewDir, 'wake-log.jsonl')) ? readFileSync(join(reviewDir, 'wake-log.jsonl'), 'utf8') : '';
  if (woke.ok && woke.woke === false && log.includes('page-03 已定')) ok('POST wake → 落日志 + 明说"没有插件可唤醒"');
  else bad(`wake 不对：${JSON.stringify(woke)} / ${log.slice(0, 80)}`);

  await fetch(`${base}/__review/wake`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ unit: '整套', text: '整套已定，可以进入下一步。' })
  });
  const wakeLog = readFileSync(join(reviewDir, 'wake-log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  if (wakeLog[wakeLog.length - 1].text === '整套已定，可以进入下一步。') ok('wake 支持整句覆盖（整套提交说另一句）');
  else bad(`整句覆盖没生效：${JSON.stringify(wakeLog[wakeLog.length - 1])}`);

  // capabilities = 宿主支持 ∩ surface 声明（"这个面现在真正能用的"）。这个 fixture 什么
  // 都没声明 → 必须是空的。旧断言写的是"包含 asset-upload"，那是把 bug 当成规范写进了测试。
  const caps = await (await fetch(`${base}/__review/capabilities`)).json();
  if (Array.isArray(caps.capabilities) && caps.capabilities.length === 0) {
    ok('surface 没声明能力 → capabilities 为空（不广告它没要的东西）');
  } else bad(`capabilities 不对：${JSON.stringify(caps)}`);

  const up = await (await fetch(`${base}/__review/upload?rel=shots/new.png`, { method: 'POST', body: Buffer.from([9, 9, 9]) })).json();
  const uploaded = join(reviewDir, 'shots', 'new.png');
  if (up.ok && existsSync(uploaded) && readFileSync(uploaded).length === 3) ok('POST upload → 字节落盘');
  else bad(`上传不对：${JSON.stringify(up)}`);

  const escapeUp = await fetch(`${base}/__review/upload?rel=${encodeURIComponent('../../../escaped.png')}`, { method: 'POST', body: Buffer.from([1]) });
  if (escapeUp.status === 403 && !existsSync(join(sandbox, 'escaped.png'))) ok('上传越界 → 403 且没写出去');
  else bad(`上传越界没拦住：${escapeUp.status}`);

  const token1 = (await (await fetch(`${base}/__review/version`)).json()).token;
  await new Promise((r) => setTimeout(r, 20));
  writeFileSync(join(reviewDir, 'shots', 'b.png'), Buffer.from([1, 2, 3]));
  const token2 = (await (await fetch(`${base}/__review/version`)).json()).token;
  if (token1 !== token2) ok('版本令牌随目录内容变化（页面靠它发现新版本）');
  else bad('版本令牌没随目录变化');

  await fetch(`${base}/__review/shutdown`);
  const exited = await new Promise((r) => { child.on('exit', () => r(true)); setTimeout(() => r(false), 5000); });
  if (exited) ok('POST shutdown → 服务退出');
  else bad('shutdown 没让服务退出');
} finally {
  try { child.kill(); } catch { /* already gone */ }
}

// ---------- 2b. 第二个形状的面：证明宿主对"审什么"一无所知 ----------
console.log('\n第二个形状的面');
{
  const otherDir = join(projectRoot, 'work', 'reviews', 'margin');
  mkdirSync(otherDir, { recursive: true });
  writeFileSync(join(otherDir, 'index.html'), '<!doctype html><html><body><h1>批注</h1>\n{{REVIEW_BRIDGE}}\n</body></html>', 'utf8');
  writeFileSync(join(otherDir, 'state.json'), JSON.stringify({ shots: [{ id: 'shot-03', seconds: 4.2 }] }), 'utf8');
  const doc2 = {
    contract_version: 'review-surface/2.0.0', id: 'demo/margin-notes', title: '批注（另一种形状）',
    project_root: '../../..', dir: '.', entry: 'index.html', feedback: 'notes.json',
    watch: ['state.json'],
    capabilities: ['asset-upload', 'video-scrub'],
    wake: { mode: 'steer', text: '批注已提交。' }
  };
  const p2 = join(otherDir, 'shape2.json');
  writeFileSync(p2, JSON.stringify(doc2), 'utf8');
  const v2 = validate(p2);
  if (v2.code === 0) ok('另一种形状的 surface 同样合规（没有单位版本语义也能过）');
  else bad(`第二种形状被判不合规：${JSON.stringify(codes(v2))}`);

  const start = (surfacePath) => new Promise((done, fail) => {
    const proc = spawn(process.execPath, [HOST, surfacePath, '--port', '0', '--no-open'], { encoding: 'utf8' });
    let buffer = '';
    const timer = setTimeout(() => fail(new Error(`宿主没就绪：${buffer}`)), 15000);
    proc.stdout.on('data', (chunk) => {
      buffer += chunk;
      const match = buffer.match(/\{[\s\S]*"url"[\s\S]*\}/);
      if (match) { clearTimeout(timer); try { done({ proc, info: JSON.parse(match[0]) }); } catch { /* 继续读 */ } }
    });
    proc.on('exit', (code) => { clearTimeout(timer); fail(new Error(`宿主提前退出 ${code}：${buffer}`)); });
  });

  const other = await start(p2);
  const base2 = other.info.url.replace(/\/index\.html$/, '');
  try {
    // 形状完全不同的 payload：没有 review_id、没有 pages、没有版本
    const weird = { kind: 'margin-notes', notes: [{ anchor: 'shot-03', decision: 'cut', why: '这一段多余' }] };
    const w2 = await (await fetch(`${base2}/__review/write`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(weird)
    })).json();
    const back = JSON.parse(readFileSync(join(otherDir, 'notes.json'), 'utf8'));
    if (w2.ok && JSON.stringify(back) === JSON.stringify(weird)) ok('另一种形状的 payload 也原样落盘（宿主不认识它的字段）');
    else bad(`第二种形状落盘不对：${JSON.stringify(back)}`);

    const caps2 = await (await fetch(`${base2}/__review/capabilities`)).json();
    if (JSON.stringify(caps2.capabilities) === JSON.stringify(['asset-upload'])) {
      ok('声明了宿主做不到的能力 → 交集里没有它（不广告做不到的事）');
    } else bad(`capabilities 交集不对：${JSON.stringify(caps2)}`);

    const state = await (await fetch(`${base2}/state.json`)).json();
    if (state.shots?.[0]?.id === 'shot-03') ok('页面能通过普通 HTTP 取到自己的 state.json（无插件时）');
    else bad(`state.json 取不到：${JSON.stringify(state)}`);

    // watch 语义：只盯声明的文件 —— 动 watched → 令牌变；动同棵树里没被 watch 的 → 令牌不变
    const tokenBefore = (await (await fetch(`${base2}/__review/version`)).json()).token;
    writeFileSync(join(otherDir, 'unwatched.txt'), 'x', 'utf8');
    const tokenAfterUnwatched = (await (await fetch(`${base2}/__review/version`)).json()).token;
    if (tokenBefore === tokenAfterUnwatched) ok('动同棵树里没被 watch 的文件 → 令牌不变（不再整棵树摘要）');
    else bad('没声明 watch 语义：动无关文件也发戳（旧实现按整棵树摘要）');

    await new Promise((r) => setTimeout(r, 20));
    writeFileSync(join(otherDir, 'state.json'), JSON.stringify({ shots: [{ id: 'shot-03', seconds: 9.9 }] }), 'utf8');
    const tokenAfterWatched = (await (await fetch(`${base2}/__review/version`)).json()).token;
    if (tokenAfterWatched !== tokenBefore) ok('动 watch 声明的文件 → 令牌变（戳会发出）');
    else bad('watch 声明的文件变了却没发戳');

    await fetch(`${base2}/__review/shutdown`);
  } finally { try { other.proc.kill(); } catch { /* 已退出 */ } }
}

// ---------- 3. 桥的线协议（假 DOM，直接驱真实源码）----------
console.log('\n桥的线协议');
{
  const source = readFileSync(BRIDGE, 'utf8');
  const makeFrame = () => {
    const listeners = [];
    const sent = [];
    const warnings = [];
    const parent = { postMessage: (msg) => sent.push(msg) };
    const win = {
      parent,
      addEventListener: (type, fn) => { if (type === 'message') listeners.push(fn); },
      setTimeout, clearTimeout, crypto: globalThis.crypto,
      console: { warn: (m) => warnings.push(String(m)), error: () => {}, log: () => {} }
    };
    win.window = win;
    const Bridge = new Function('window', 'fetch', `${source}\nreturn window.ReviewBridge;`)(win, () => Promise.reject(new Error('这条用例不该发 fetch')));
    return { Bridge, sent, warnings, deliver: (data) => listeners.forEach((fn) => fn({ data, source: parent })) };
  };

  const f = makeFrame();
  const ready = f.Bridge.connect();
  const hello = f.sent.find((m) => m && m.type === 'hello');
  if (!hello || !hello.nonce) bad('桥没有发出 hello（拿不到 nonce）');
  else {
    f.deliver({ __review: true, type: 'init', nonce: hello.nonce, capabilities: ['asset-upload'], surface: { id: 'demo/x' } });
    const review = await ready;
    let fired = 0;
    review.on('changed', () => { fired += 1; });

    f.deliver({ __review: true, type: 'review/changed', nonce: hello.nonce });
    if (fired === 1) ok('规范拼法 review/changed → 页面收到戳');
    else bad(`review/changed 没触发（fired=${fired}）—— 这正是插件实测踩到的那个静默失败`);

    f.deliver({ __review: true, type: 'changed', nonce: hello.nonce });
    if (fired === 2 && f.warnings.some((w) => w.includes('旧拼法'))) ok('旧拼法 changed 容忍但出声（不再静默）');
    else bad(`旧拼法处理不对：fired=${fired} warnings=${JSON.stringify(f.warnings)}`);

    f.deliver({ __review: true, type: 'review/changed', nonce: 'wrong-nonce' });
    if (fired === 2) ok('nonce 不对 → 不触发');
    else bad(`错误 nonce 竟然触发了：fired=${fired}`);

    f.deliver({ __review: true, type: 'review/unknown-thing', nonce: hello.nonce });
    if (f.warnings.some((w) => w.includes('不认识的宿主消息类型'))) ok('不认识的 review/* 类型 → 出声');
    else bad('不认识的消息类型保持沉默（下一个静默失败就藏在这里）');

    if (review.capabilities.includes('asset-upload')) ok('connect 后 capabilities 就是对的（不是空数组）');
    else bad(`capabilities 不对：${JSON.stringify(review.capabilities)}`);
  }
}

// ---------- 3b. 无插件通道：轮询与基准 ----------
console.log('\n桥的轮询通道');
{
  const source = readFileSync(BRIDGE, 'utf8');
  const build = (tokens) => {
    const listeners = [];
    const warnings = [];
    let i = 0;
    const win = {
      parent: null,   // 顶层文档：走 http 通道
      addEventListener: (type, fn) => { if (type === 'message') listeners.push(fn); },
      setTimeout, clearTimeout, crypto: globalThis.crypto,
      console: { warn: (m) => warnings.push(String(m)), error: () => {}, log: () => {} },
      setInterval: () => 0,
      fetch: (url) => {
        if (String(url).includes('capabilities')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ capabilities: ['asset-upload'] }) });
        if (String(url).includes('version')) {
          const token = tokens[Math.min(i, tokens.length - 1)];
          i += 1;
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ token }) });
        }
        return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
      }
    };
    win.window = win;
    const Bridge = new Function('window', 'fetch', `${source}\nreturn window.ReviewBridge;`)(win, win.fetch);
    return { Bridge, warnings };
  };

  const f = build(['t1', 't1', 't2']);
  const review = await f.Bridge.connect();
  const events = [];
  review.on('baseline', () => events.push('baseline'));
  review.on('changed', () => events.push('changed'));
  await new Promise((r) => setTimeout(r, 10));   // 让第一次采样跑完
  if (events.filter((e) => e === 'baseline').length === 1 && !events.includes('changed')) {
    ok('第一次采样立刻做，且只报 baseline（不误报「变了」）—— 粘性，晚订阅也收得到');
  } else bad(`采样事件不对：${JSON.stringify(events)}`);
  if (review.capabilities.includes('asset-upload')) ok('http 通道 connect 后 capabilities 正确');
  else bad(`http capabilities 不对：${JSON.stringify(review.capabilities)}`);
}

// ---------- 4. 桥的形状 ----------
console.log('\n桥的形状');
{
  const source = readFileSync(BRIDGE, 'utf8');
  const checks = [
    [source.includes('window.ReviewBridge'), '暴露 window.ReviewBridge'],
    [source.includes("'postMessage'") && source.includes('window.parent.postMessage'), '有 postMessage 通道'],
    [source.includes("'__review/'"), '有 fetch 通道（无插件时）'],
    [source.includes("event.source !== window.parent"), '反向消息比对 source（不透明源的 origin 不可鉴权）'],
    [source.includes("'asset-upload'"), '上传能力按 capabilities 声明走'],
    [source.includes("URL.createObjectURL(blob)"), '资产由子帧自造 blob（父页面代取字节）'],
    [source.includes('readText: function') && source.includes("call('read'"), '有 read/readText（给非图片资产，如 snapshot.json）'],
    [/var capabilitiesReady = fetch\(base \+ '__review\/capabilities'/.test(source) && /return capabilitiesReady\.then/.test(source),
     'http 通道先问 capabilities 再交出对象（否则 review.capabilities 永远是空数组）'],
    [!/\b(localStorage|sessionStorage)\s*[.[]/.test(source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')), '不碰 localStorage（不透明源下会抛）']
  ];
  const bads = checks.filter(([pass]) => !pass).map(([, label]) => label);
  if (!bads.length) ok('九条形状断言全过');
  else bad(`桥的形状不对：${bads.join('、')}`);
}

rmSync(sandbox, { recursive: true, force: true });
console.log(failed ? `\n${failed} 条失败` : '\n全部通过（校验器 15 条 + 宿主 29 条 + 第二形状 3 条 + 线协议 5 条 + 轮询 2 条 + 桥 9 条）');
process.exit(failed ? 1 : 0);
