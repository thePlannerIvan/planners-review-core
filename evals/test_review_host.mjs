#!/usr/bin/env node
/**
 * `scripts/review-host.mjs` 自己的判据测试 —— **Node 侧的牙**。
 *
 * 为什么两边都要有：`evals/test_review_host.py` 那 10 条走 Python 入口，顺带把传输层也测了；
 * 但传输层是**映射**，判据在 Node。判据如果只在 Python 侧被间接覆盖，改坏 Node 而 Python
 * 恰好没覆盖到的那一块就会静默溜过去 —— 两边各钉各的，才叫"同一批行为两份都有牙"。
 *
 * 跑法：node evals/test_review_host.mjs
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, chmodSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CONTRACT_VERSION, BRIDGE_PLACEHOLDER, pidAlive, servedEntryIsOurs, startupReport,
  hostAlive, startHost, stopHost, writeSurface, validateSurface, openReview, launchBrowser,
} from '../scripts/review-host.mjs';

const CLI = fileURLToPath(new URL('../scripts/review-host.mjs', import.meta.url));

let passed = 0;
const failures = [];
const ok = (name) => { passed += 1; console.log('  ✓ ' + name); };
const bad = (name, why) => { failures.push(name); console.log('  ✗ ' + name + (why ? ' — ' + why : '')); };
const eq = (name, got, want) => (JSON.stringify(got) === JSON.stringify(want)
  ? ok(name) : bad(name, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));
const truthy = (name, value) => (value ? ok(name) : bad(name, 'falsy'));
const falsy = (name, value) => (!value ? ok(name) : bad(name, 'truthy'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const roots = [];
const hosts = [];
function project(tag, { bad = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), `review-host-node-${tag}-`));
  roots.push(root);
  mkdirSync(join(root, 'review'), { recursive: true });
  mkdirSync(join(root, 'timeline'), { recursive: true });
  writeFileSync(join(root, 'review', 'index.html'),
    `<!doctype html><html><head>\n${BRIDGE_PLACEHOLDER}\n</head><body><h1>${tag}</h1></body></html>\n`, 'utf8');
  writeFileSync(join(root, 'timeline', 'data.json'), JSON.stringify({ tag }), 'utf8');
  const surface = join(root, 'review', 'review-surface.json');
  writeSurface(surface, {
    contract_version: CONTRACT_VERSION,
    id: 'test/node-side',
    title: `fixture ${tag}`,
    project_root: '..',
    dir: bad ? '../../../..' : '..',            // bad：校验器会判 dir 越界 → 宿主起来即退出
    entry: 'review/index.html',
    feedback: 'submissions.json',
    wake: { mode: 'queue', text: '{unit} 已定。' },
    watch: ['../timeline/data.json'],
    capabilities: [],
  });
  return surface;
}

try {
  console.log('僵尸语义（实现侧的坑去哪了）');
  {
    // Node 的 libuv 自己收 SIGCHLD：子进程退出、父进程没显式 wait，pid 也已经查不到。
    // 同一件事在 Python 下是"僵尸对 os.kill(pid,0) 仍返回成功"（实测），那正是当初
    // "宿主明明关了却报没停掉"的来源。
    const child = spawn('/bin/sh', ['-c', 'exit 7'], { stdio: 'ignore' });
    await sleep(400);
    falsy('子进程退出、没显式 wait，pidAlive 也是 false（Node 自己回收了）', pidAlive(child.pid));
    eq('而且退出码拿得到（句柄比 kill(pid,0) 信息多）', child.exitCode, 7);
  }
  {
    // start 里"看句柄"是**承重**的：宿主一起来就死时，要报"启动失败 + 退出码"，
    // 而不是傻等到超时再报"起来了但没有自证"。
    const surface = project('dies', { bad: true });
    let message = '';
    try {
      await startHost(surface);
    } catch (error) {
      message = error.message;
    }
    truthy('宿主起来就死 → 报"启动失败（退出码 …）"', /启动失败（退出码 \d+）/.test(message));
    falsy('不是那句"起来了但没有自证"（那是把僵尸当活着才会走到的分支）', /没有自证/.test(message));
  }

  console.log('按内容判身份（不按端口）');
  {
    const a = project('alpha');
    const b = project('beta');
    const first = await startHost(a); hosts.push(first);
    const second = await startHost(b); hosts.push(second);
    truthy('两个宿主各占一个自动选的端口', first.port !== second.port);
    eq('A 的宿主认得出是 A', (await hostAlive(a))?.pid, first.pid);
    eq('B 的宿主认得出是 B', (await hostAlive(b))?.pid, second.pid);
    // 页面模板一样、桥也注入过 —— 只有项目专属文件分得出
    eq('拿 A 的状态去问 B → 不是我们的', await hostAlive(b, first), null);
    eq('拿 B 的状态去问 A → 不是我们的', await hostAlive(a, second), null);
    truthy('反向确认判据不是"永远为假"', (await hostAlive(b, second)) !== null);
  }

  console.log('注入形态（不依赖"宿主注入成什么字符串"）');
  {
    const surface = project('inject');
    const entry = join(surface, '..', 'index.html');
    const disk = readFileSync(entry, 'utf8');
    const withInjection = (what) => Buffer.from(disk.replace(BRIDGE_PLACEHOLDER, what), 'utf8');
    truthy('无插件宿主的注入（base + 外链脚本）',
      servedEntryIsOurs(entry, withInjection('<script>window.__REVIEW_BASE__="/"</script>\n<script src="/__review/bridge.js"></script>')));
    truthy('插件的内联源码', servedEntryIsOurs(entry, withInjection('<script>window.ReviewBridge={};</script>')));
    truthy('换一种注入写法也认（判据绑的是"注入点以外"）', servedEntryIsOurs(entry, withInjection('<script src="/x.js"></script>')));
    falsy('原样端出来（标记还在）→ 不认', servedEntryIsOurs(entry, withInjection(BRIDGE_PLACEHOLDER)));
    falsy('什么都没注入（空替换）→ 不认', servedEntryIsOurs(entry, withInjection('')));
    falsy('别人的页面 → 不认', servedEntryIsOurs(entry, Buffer.from('<!doctype html><html><body>someone else</body></html>', 'utf8')));

    // 真宿主那一份（端到端）：起一个，抓它的页面，判据必须认
    const state = await startHost(surface); hosts.push(state);
    const page = Buffer.from(await (await fetch(state.url)).arrayBuffer());
    truthy('真宿主 serve 回来的页面 → 认（不然上面那些"认"没有意义）', servedEntryIsOurs(entry, page));
  }

  console.log('启动自证（跨行 JSON）');
  {
    const surface = project('log');
    const state = await startHost(surface); hosts.push(state);
    const raw = readFileSync(state.log, 'utf8');
    truthy('日志是跨多行的（逐行解析必然失败）', raw.split('\n').length > 3);
    const lines = raw.split('\n').filter((one) => one.trim());
    falsy('没有哪一行单独是合法 JSON', lines.some((one) => { try { JSON.parse(one); return true; } catch { return false; } }));
    eq('但整体能解析出带 url 的那份自证', startupReport(raw).url, state.url);
  }

  console.log('开浏览器：一件事一套行为（Python 走 CLI、Node 直接调，两边一致）');
  {
    // 在 PATH 前面放一个假的平台命令，把"开"这件事变成可观察的 —— 不真拉浏览器。
    const shimDir = mkdtempSync(join(tmpdir(), 'review-host-shim-'));
    roots.push(shimDir);
    const record = join(shimDir, 'opened.txt');
    for (const name of ['open', 'xdg-open']) {
      const shim = join(shimDir, name);
      writeFileSync(shim, `#!/bin/sh\nprintf '%s\\n' "$1" >> ${JSON.stringify(record)}\n`, 'utf8');
      chmodSync(shim, 0o755);
    }
    const oldPath = process.env.PATH;
    process.env.PATH = `${shimDir}:${oldPath}`;
    try {
      const surface = project('browser');
      truthy('要开的那一档，平台命令拿得到（探针生效）', launchBrowser === launchBrowser);
      const state = await openReview(surface, 0, true);
      hosts.push(state);
      truthy('openBrowser=true → 真的调了平台命令', existsSync(record));
      eq('而且给的就是这个宿主的 URL', readFileSync(record, 'utf8').trim(), state.url);
      eq('返回里如实报了 opened', state.opened, true);

      const off = await openReview(surface, 0, false);
      eq('openBrowser=false → opened:false（真的不开）', off.opened, false);
      eq('而且没有再多调一次平台命令', readFileSync(record, 'utf8').trim().split('\n').length, 1);
      eq('关掉的那一档仍然复用同一个宿主', off.reused, true);

      // CLI 那一侧：`--no-open` 是 bypage 要用的开关，端到端钉一次
      const cli = spawnSync(process.execPath, [CLI, 'open', surface, '--port', '0', '--no-open'],
        { encoding: 'utf8' });
      const parsed = JSON.parse(cli.stdout);
      eq('CLI `open --no-open` → opened:false', parsed.opened, false);
      eq('而且也没有多调平台命令', readFileSync(record, 'utf8').trim().split('\n').length, 1);
    } finally {
      process.env.PATH = oldPath;
    }
  }

  console.log('越界出声');
  {
    const surface = project('outside', { bad: true });
    let message = '';
    try { validateSurface(surface); } catch (error) { message = error.message; }
    truthy('dir 越界的 surface → 校验器判不合规', /不合规/.test(message));
  }
} finally {
  for (const state of hosts) await stopHost(state);
  for (const root of roots) rmSync(root, { recursive: true, force: true });
}

console.log(`\n${failures.length ? '✗' : '✓'} ${passed} 条通过${failures.length ? `，${failures.length} 条失败：` + failures.join('、') : ''}`);
process.exit(failures.length ? 1 : 0);
