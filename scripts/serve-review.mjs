#!/usr/bin/env node
/**
 * 没有插件时的审阅宿主（review-surface/2.0.0）。
 *
 * 用法：node serve-review.mjs <review-surface.json> [--port 0] [--no-open] [--idle-hours 4]
 *
 * 做四件事，与 DSH 插件那边**同构**：serve `dir`、写 feedback、收 wake、报版本令牌。
 * 区别只有一个：这里没有 Agent 可以唤醒 —— 人回对话说一声。所以 wake 落一行日志并打印提示。
 *
 * 页面完全不用改：它引用的 review-bridge.js 会自动发现"没有父窗口"，切到 fetch 通道。
 */
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const VALIDATOR = join(HERE, 'validate-surface.mjs');

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};
const surfaceArg = argv.find((a) => !a.startsWith('--') && !/^\d+$/.test(a));
if (!surfaceArg) {
  console.error('用法：node serve-review.mjs <review-surface.json> [--port 0] [--no-open] [--idle-hours 4]');
  process.exit(2);
}
const surfacePath = resolve(surfaceArg);
if (!existsSync(surfacePath)) { console.error(`找不到 surface：${surfacePath}`); process.exit(2); }

// 先校验：宿主不替坏 surface 兜底
const verdict = spawnSync(process.execPath, [VALIDATOR, surfacePath], { encoding: 'utf8' });
if (verdict.status !== 0) {
  console.error(verdict.stdout || verdict.stderr);
  console.error('surface 不合规，拒绝起服务。');
  process.exit(1);
}

const doc = JSON.parse(readFileSync(surfacePath, 'utf8'));
const surfaceDir = dirname(surfacePath);
const ROOT = realpathSync(resolve(surfaceDir, doc.dir));
const ENTRY = doc.entry;
const FEEDBACK = doc.feedback ? resolve(surfaceDir, doc.feedback) : null;
// 草稿：和 feedback 分开两个文件。feedback 是**决定**（人点了提交、模型要收件），
// draft 是**还没提交的草稿**（页面拿它做「刷新不丢」，模型不当它是收件）。
const DRAFT = doc.draft ? resolve(surfaceDir, doc.draft) : null;
const WAKE_LOG = join(surfaceDir, 'wake-log.jsonl');
const idleMs = Number(flag('--idle-hours', 4)) * 60 * 60 * 1000;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.jsonl': 'application/x-ndjson; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav', '.aac': 'audio/aac',
  '.mp4': 'video/mp4', '.webm': 'video/webm',
  // 剪接素材那一族：宿主原先没有这两个 → 会给 application/octet-stream，
  // <video> 拿它就放不出来。真项目现在都是 .mp4，所以这是**潜伏**的一条，一起收。
  '.mov': 'video/quicktime', '.m4v': 'video/x-m4v',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.csv': 'text/csv; charset=utf-8'
};

function resolveInRoot(urlPath) {
  const clean = decodeURIComponent(urlPath.split('?')[0]);
  const target = resolve(normalize(join(ROOT, clean)));
  if (target !== ROOT && !target.startsWith(ROOT + sep)) return null;      // 路径穿越
  if (!existsSync(target)) return null;
  const real = realpathSync(target);                                        // 符号链接
  if (real !== ROOT && !real.startsWith(ROOT + sep)) return null;
  return real;
}

// watch（相对 surface 文件）：有声明就**只盯那几个文件**，与插件侧同义；没声明才按整棵树摘要。
/** 宿主**真的**能做什么。广告出去就等于承诺 —— 页面会照着它摆控件。 */
const HOST_CAPABILITIES = ['asset-upload', 'draft'];
/** surface 声明它**要**什么（可省，默认什么都不要）。 */
const DECLARED_CAPABILITIES = Array.isArray(doc.capabilities) ? doc.capabilities : [];

const WATCH = (Array.isArray(doc.watch) ? doc.watch : []).map((rel) => resolve(surfaceDir, rel));

function versionToken() {
  const hash = createHash('sha256');
  if (WATCH.length) {
    for (const abs of WATCH) {
      try { const st = statSync(abs); hash.update(`${abs}:${st.size}:${st.mtimeMs}\n`); }
      catch { hash.update(`${abs}:absent\n`); }
    }
    return hash.digest('hex');
  }
  const walk = (dir) => {
    for (const name of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = join(dir, name.name);
      if (name.isDirectory()) walk(abs);
      else if (name.isFile()) {
        const st = statSync(abs);
        hash.update(`${abs.slice(ROOT.length)}:${st.size}:${st.mtimeMs}\n`);
      }
    }
  };
  walk(ROOT);
  return hash.digest('hex');
}

const readRaw = (req) => new Promise((done, fail) => {
  const chunks = [];
  let size = 0;
  req.on('data', (chunk) => { size += chunk.length; if (size > 64 * 1024 * 1024) { fail(new Error('上传过大')); req.destroy(); } else chunks.push(chunk); });
  req.on('end', () => done(Buffer.concat(chunks)));
  req.on('error', fail);
});

const readBody = (req) => new Promise((done, fail) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; if (body.length > 32 * 1024 * 1024) { fail(new Error('body 过大')); req.destroy(); } });
  req.on('end', () => done(body));
  req.on('error', fail);
});

const json = (res, code, value) => {
  const body = JSON.stringify(value);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
};

let lastTouch = Date.now();
const server = createServer(async (req, res) => {
  lastTouch = Date.now();
  const url = req.url || '/';

  if (url.startsWith('/__review/')) {
    if (url.startsWith('/__review/version')) return json(res, 200, { token: versionToken() });
    if (url.startsWith('/__review/shutdown')) { json(res, 200, { ok: true }); return setTimeout(() => process.exit(0), 50); }
    if (url.startsWith('/__review/write') && req.method === 'POST') {
      if (FEEDBACK === null) return json(res, 409, { ok: false, error: '这个面没有 feedback 文件（surface 里没写 feedback）' });
      try {
        const payload = JSON.parse(await readBody(req));
        mkdirSync(dirname(FEEDBACK), { recursive: true });
        // 接入日志（append-only）：**先记这一行，再写整份状态**。状态那一笔写失败、
        // 或写完之后被别的进程盖掉时，人的字还在这一行里。Skill 侧读它
        // （`review_feedback.unrecorded_writes`）。记不上也不拦提交。
        try {
          appendFileSync(join(dirname(FEEDBACK), 'wake-log.jsonl'), JSON.stringify({
            at: new Date().toISOString(), kind: 'write', id: randomUUID(),
            review_id: String(payload?.review_id ?? ''),
            submitted_at: String(payload?.provenance?.submitted_at ?? ''),
            unit: null,
            overall_feedback: String(payload?.overall_feedback ?? ''),
            pages: payload?.pages ?? {},
          }) + '\n', 'utf8');
        } catch { /* 兜底，不是主路径 */ }
        writeFileSync(FEEDBACK, JSON.stringify(payload, null, 2) + '\n', 'utf8');
        console.log(`反馈已写入 ${FEEDBACK}`);
        return json(res, 200, { ok: true, path: FEEDBACK, persisted: true });
      } catch (error) { return json(res, 400, { ok: false, error: error.message }); }
    }
    if (url.startsWith('/__review/draft') && req.method === 'POST') {
      if (DRAFT === null) return json(res, 409, { ok: false, error: '这个面没有 draft 文件（surface 里没写 draft）' });
      try {
        const payload = JSON.parse(await readBody(req));
        mkdirSync(dirname(DRAFT), { recursive: true });
        writeFileSync(DRAFT, JSON.stringify(payload, null, 2) + '\n', 'utf8');
        return json(res, 200, { ok: true, path: DRAFT });
      } catch (error) { return json(res, 400, { ok: false, error: error.message }); }
    }
    if (url.startsWith('/__review/capabilities')) {
      // `capabilities` 的含义是「**这个面现在真正能用的**」= 宿主支持 ∩ surface 声明。
      // 只报宿主支持什么（或只报 surface 要什么）都会让页面摆出一个必然失败的控件 ——
      // 两个宿主以前对同一个字段各说一套，已统一。
      return json(res, 200, { capabilities: HOST_CAPABILITIES.filter((c) => DECLARED_CAPABILITIES.includes(c)) });
    }
    if (url.startsWith('/__review/bridge.js')) {
      const bridge = readFileSync(join(HERE, '..', 'assets', 'review-bridge.js'));
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'content-length': bridge.length, 'cache-control': 'no-store' });
      return res.end(bridge);
    }
    if (url.startsWith('/__review/upload') && req.method === 'POST') {
      const rel = new URL(url, 'http://127.0.0.1').searchParams.get('rel') || '';
      const target = resolve(normalize(join(ROOT, rel)));
      if (target === ROOT || !target.startsWith(ROOT + sep)) return json(res, 403, { ok: false, error: '上传目标落在 dir 之外' });
      if (existsSync(target) && realpathSync(target) !== target) return json(res, 403, { ok: false, error: '上传目标是符号链接' });
      try {
        const bytes = await readRaw(req);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, bytes);
        return json(res, 200, { ok: true, path: target, sha256: createHash('sha256').update(bytes).digest('hex') });
      } catch (error) { return json(res, 400, { ok: false, error: error.message }); }
    }
    if (url.startsWith('/__review/wake') && req.method === 'POST') {
      try {
        const payload = JSON.parse((await readBody(req)) || '{}');
        // 页面可以用整句覆盖（例如"整套提交"要说的不是"只重出这一页"）
        const template = payload.text ? String(payload.text) : String(doc.wake.text);
        const text = template.replace('{unit}', String(payload.unit ?? ''));
        appendFileSync(WAKE_LOG, JSON.stringify({ at: new Date().toISOString(), kind: 'wake', unit: payload.unit ?? null, text }) + '\n', 'utf8');
        console.log(`\n>>> 这一页定了（${payload.unit ?? '未指名'}）：${text}\n>>> 没有插件可唤醒，请回到对话说一声「已完成」。\n`);
        return json(res, 200, { ok: true, woke: false, note: '没有插件：请回到对话告诉模型', log: WAKE_LOG });
      } catch (error) { return json(res, 400, { ok: false, error: error.message }); }
    }
    return json(res, 404, { ok: false, error: 'unknown review endpoint' });
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { ok: false, error: 'method not allowed' });
  const target = resolveInRoot(req.url === '/' ? `/${ENTRY}` : url);
  if (target === null || !statSync(target).isFile()) { res.writeHead(404); res.end('not found'); return; }
  let bytes = readFileSync(target);
  const type = MIME[extname(target).toLowerCase()] ?? 'application/octet-stream';
  if (type.startsWith('text/html')) {
    // 桥由宿主注入：页面里那个注入点在这一步被换掉
    // 规范写法是**裸标记独占一行**；另两种旧写法（`<script src="{{…}}">` 与
    // `<script>{{…}}</script>`）在生产里出现过，所以把**整个元素**一并换掉 —— 换成什么由宿主
    // 决定，但必须是一段完整合法的标签，不能把标记留在一个被撑破的标签里。
    const block = '<script>window.__REVIEW_BASE__="/"</script>\n<script src="/__review/bridge.js"></script>';
    const html = bytes.toString('utf8');
    const legacyTag = /<script\b[^>]*\bsrc\s*=\s*["']\{\{REVIEW_BRIDGE\}\}["'][^>]*>\s*<\/script>/i;
    const legacyInner = /<script\b[^>]*>\s*\{\{REVIEW_BRIDGE\}\}\s*<\/script>/i;
    bytes = Buffer.from(
      legacyTag.test(html) ? html.replace(legacyTag, block)
        : legacyInner.test(html) ? html.replace(legacyInner, block)
          : html.replaceAll('{{REVIEW_BRIDGE}}', block),
      'utf8'
    );
  }
  const size = bytes.length;
  const rangeHeader = String(req.headers.range ?? '').trim();
  // 注入了桥的 HTML **不认** Range：字节偏移对应的是磁盘上那一份，切一半会把注入点切坏。
  // 浏览器导航取页面本来也不发 Range。
  const single = type.startsWith('text/html') ? null : /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
  if (single) {
    // 单区间。多区间（`bytes=0-9,20-29` → multipart/byteranges）**故意不支持**：
    // <video> seek 只用单区间，而 multipart 写错会静默截断 —— 见 evals 里那条"多区间回整份是有意的"。
    let start;
    let end;
    if (single[1] === '' && single[2] !== '') {
      start = Math.max(0, size - Number(single[2]));        // `bytes=-N` → 最后 N 字节
      end = size - 1;
    } else {
      start = single[1] === '' ? 0 : Number(single[1]);
      end = single[2] === '' ? size - 1 : Number(single[2]);
    }
    if (!Number.isFinite(start) || !Number.isFinite(end) || start >= size || start > end) {
      // 不可满足：**必须**回 416 + `bytes */<total>`，浏览器据此知道真实长度并放弃
      res.writeHead(416, {
        'content-type': type,
        'content-range': `bytes */${size}`,
        'accept-ranges': 'bytes',
        'cache-control': 'no-store',
      });
      res.end();
      return;
    }
    const last = Math.min(end, size - 1);
    const slice = bytes.subarray(start, last + 1);
    res.writeHead(206, {
      'content-type': type,
      'content-length': slice.length,                      // **实发字节数**，不是文件大小
      'content-range': `bytes ${start}-${last}/${size}`,
      'accept-ranges': 'bytes',
      'cache-control': 'no-store',                         // 素材是**原地改写**的：路径不变内容变，缓存会骗人
    });
    res.end(req.method === 'HEAD' ? undefined : slice);
    return;
  }
  res.writeHead(200, {
    'content-type': type,
    'content-length': size,
    'accept-ranges': 'bytes',          // 整份也要声明：否则浏览器不知道这个资源能分段取
    'cache-control': 'no-store',
  });
  res.end(req.method === 'HEAD' ? undefined : bytes);
});

const idleTimer = setInterval(() => {
  if (Date.now() - lastTouch > idleMs) {
    console.log(`空闲超过 ${idleMs / 3600000} 小时，关闭审阅服务。`);
    server.close(() => process.exit(0));
  }
}, 60000);
idleTimer.unref?.();

const portArg = Number(flag('--port', 0));
server.listen(portArg, '127.0.0.1', () => {
  const actual = server.address().port;
  const url = `http://127.0.0.1:${actual}/${ENTRY}`;
  let opened = false;
  if (!argv.includes('--no-open')) {
    const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
    const cmdArgs = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
    opened = spawn(cmd, cmdArgs, { detached: true, stdio: 'ignore' }).unref() !== null;
  }
  console.log(JSON.stringify({
    valid: true, status: 'waiting_for_human', opened, url,
    surface: doc.id, feedback_path: FEEDBACK, wake_log: WAKE_LOG,
    next_action_zh: '人审完之后回到对话说一声「已完成」；模型读 feedback 文件继续。'
  }, null, 2));
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
