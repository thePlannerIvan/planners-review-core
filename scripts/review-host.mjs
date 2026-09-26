#!/usr/bin/env node
/**
 * 审阅宿主的生命周期 —— **唯一实现**（Node CLI）。
 *
 *   write <surface> [--doc <path>|--doc -]   surface 文档落盘（幂等）
 *   validate <surface>                       跑唯一校验器
 *   state <surface>                          上次起的宿主的状态（或 null）
 *   alive <surface> [--state <path>|-]       那个宿主还活着吗（含"是不是我们这个项目"）
 *   start <surface> [--port N]               起一个无插件宿主
 *   stop <surface> | --state <path>|-        停干净（SIGTERM → SIGKILL）
 *   open <surface> [--port N]                起/复用，返回 URL（**不开浏览器**，见下）
 *
 * ## 为什么生命周期在 Node
 *
 * 缝的四块里三块本来就是 Node（契约 JSON、`validate-surface.mjs`、`serve-review.mjs`、桥），
 * 而 **Node 是所有人的底线**：校验器、无插件宿主都是 Node CLI，连 Python 技能也要找 node 才能
 * 用它们。生命周期放 Python，就把纯 `.mjs` 的调用方（planners-bypage 全是 `.mjs`，而且它的运行
 * 契约明确不许假定 `python3` 存在）关在门外；而它们**不能**再写一份 Node 生命周期 —— 那正是
 * 要消灭的"两份副本各自漂移"。**收到 Node，谁都不多一个依赖。**
 *
 * ## 顺手少掉的一个坑
 *
 * 之前 Python 那份要自己防僵尸：`subprocess.Popen` 之后不 `wait()`，子进程会变成僵尸，
 * 而 `os.kill(pid, 0)` 对僵尸返回成功 → "宿主明明关了却报没停掉"（实测踩到）。Node 的
 * libuv 自己收 SIGCHLD，实测子进程退出 400ms 后 `process.kill(pid,0)` 就是 ESRCH ——
 * 这个坑在 Node 侧结构上不存在。`start` 里仍然优先看子进程句柄（`exitCode`），因为那里
 * 需要**退出码**才能把"起不来"和"起来了但没自证"分开报。
 *
 * ## 判据（三条，都是实测换来的，改之前先读）
 *
 * 1. **按内容不按端口。** 宿主是 `--port 0`，端口冲突根本不会发生，端口没有判断力。
 *    `alive` 看：pid 在 + 页面回 200 + **注入点以外逐字节等于磁盘上那一份入口** + 注入点确实被换掉了。
 * 2. **"哪个项目"靠 `watch` 声明的文件。** 页面是几家共用的模板，本来也分不出项目；
 *    项目专属文件才分得出。两个项目的宿主同时开着时，这是唯一的分辨手段。
 * 3. **不端出旧项目。** 起不来就报退出码 + 日志尾；判不出身份就不复用。绝不退回"上一个项目的旧页面"。
 *
 * 本文件**不认识任何 Skill 的业务**：没有各家的单位词汇，入参只有一个 surface 路径，
 * 页面在哪、serve 哪棵树、反馈写哪、盯哪些文件，全部从那份文档里读。
 * 它导出上面那些函数，所以 Node 侧的测试可以直接 import（不必起进程）。
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CONTRACT_VERSION = 'review-surface/2.0.0';
export const BRIDGE_PLACEHOLDER = '{{REVIEW_BRIDGE}}';
export const HOST_STATE_NAME = 'review_host.json';
export const HOST_LOG_NAME = 'review_host.log';
export const WAKE_LOG_NAME = 'wake-log.jsonl';

const HERE = dirname(fileURLToPath(import.meta.url));
const VALIDATE_SCRIPT = resolve(HERE, 'validate-surface.mjs');
const SERVE_SCRIPT = resolve(HERE, 'serve-review.mjs');

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const text = (value) => (value === undefined || value === null ? '' : String(value));

/* ------------------------------------------------------------------ surface */

export function readSurface(surface) {
  const path = resolve(surface);
  if (!existsSync(path)) throw new Error('还没有审阅面：先跑生成审阅面那一步，写出 ' + path);
  let doc;
  try {
    doc = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error('审阅面不是合法 JSON（' + path + '）：' + error.message);
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new Error('审阅面的顶层必须是对象：' + path);
  }
  return doc;
}

/** surface 里那些**相对它自己**的路径 → 绝对路径。页面里的 `rel` 才相对 `dir`。 */
export function surfacePaths(surface) {
  const path = resolve(surface);
  const doc = readSurface(path);
  const base = dirname(path);
  const dir = resolve(base, text(doc.dir) || '.');
  return {
    surface: path,
    base,
    dir,
    projectRoot: resolve(base, text(doc.project_root) || '.'),
    entry: resolve(dir, text(doc.entry)),
    feedback: doc.feedback ? resolve(base, text(doc.feedback)) : null,
    watch: (Array.isArray(doc.watch) ? doc.watch : []).map((rel) => resolve(base, text(rel))),
    wakeLog: resolve(base, WAKE_LOG_NAME),
  };
}

export function hostStatePath(surface) {
  return resolve(dirname(resolve(surface)), HOST_STATE_NAME);
}

/** 落盘（幂等：内容没变就不碰 mtime）。**本模组不生产这份文档** —— 该填什么值是各家的业务。 */
export function writeSurface(surface, document) {
  const path = resolve(surface);
  mkdirSync(dirname(path), { recursive: true });
  const payload = JSON.stringify(document, null, 2) + '\n';
  if (!existsSync(path) || readFileSync(path, 'utf8') !== payload) {
    writeFileSync(path, payload, 'utf8');
  }
  return path;
}

export function validateSurface(surface) {
  const path = resolve(surface);
  if (!existsSync(path)) throw new Error('还没有审阅面：先跑生成审阅面那一步，写出 ' + path);
  const result = spawnSync(process.execPath, [VALIDATE_SCRIPT, path, '--text'], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error('审阅面不合规（' + path + '）：\n' + text(result.stdout || result.stderr).trim());
  }
  return true;
}

/* ------------------------------------------------------------------ 宿主状态 */

export function hostState(surface) {
  try {
    return JSON.parse(readFileSync(hostStatePath(surface), 'utf8'));
  } catch {
    return null;
  }
}

/** pid 还在吗。Node 自己收 SIGCHLD，所以这里不存在"僵尸被当成活着"那一档（见文件头）。 */
export function pidAlive(pid) {
  const value = Number(pid);
  if (!Number.isInteger(value) || value <= 0) return false;
  try {
    process.kill(value, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';       // 存在但没权限发信号 = 还活着
  }
}

/* ------------------------------------------------------------------ 身份：按内容 */

/**
 * serve 回来的这一页，是不是**磁盘上这一份入口、且注入点确实被换过了**？
 *
 * 三个条件都不依赖"宿主注入成什么字符串"：
 *   · 注入点**以外**逐字节相同（拿磁盘页面在标记处切开，比前缀与后缀）；
 *   · 中间那一段非空（＝标记真被换掉了，不是原样端出来的静态文件）；
 *   · 回来的页面里**不再有那个标记**本身（`http.server` 直接端目录就是这样）。
 *
 * 反面教材：把"标记该被换成什么"写死在自己这边，宿主一改注入形态判据就**静默**永远为假
 * —— 活着的宿主被判成死的，没有报错，只是每次开审阅多起一个进程。实测踩到过。
 */
export function servedEntryIsOurs(entry, served) {
  let disk;
  try {
    disk = readFileSync(entry, 'utf8');
  } catch {
    return false;
  }
  const at = disk.indexOf(BRIDGE_PLACEHOLDER);
  if (at < 0) return false;                                  // 磁盘上这页没有注入点
  const head = Buffer.from(disk.slice(0, at), 'utf8');
  const tail = Buffer.from(disk.slice(at + BRIDGE_PLACEHOLDER.length), 'utf8');
  const body = Buffer.isBuffer(served) ? served : Buffer.from(served);
  if (body.includes(Buffer.from(BRIDGE_PLACEHOLDER, 'utf8'))) return false;
  if (body.length <= head.length + tail.length) return false;
  if (!body.subarray(0, head.length).equals(head)) return false;
  return body.subarray(body.length - tail.length).equals(tail);
}

async function getBytes(url, timeoutMs = 3000) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  const bytes = Buffer.from(await response.arrayBuffer());
  return { status: response.status, bytes };
}

/** origin 上 serve 的，是不是**这个项目的 `dir`**？拿 surface 自己声明的 `watch` 当指纹。 */
export async function servesThisProject(paths, url) {
  const origin = new URL(url).origin;
  for (const target of paths.watch) {
    if (!existsSync(target)) continue;
    let rel;
    try {
      rel = target.slice(paths.dir.length + 1);
      if (!target.startsWith(paths.dir + '/')) return false;
    } catch {
      return false;
    }
    try {
      const { status, bytes } = await getBytes(`${origin}/${rel}`);
      if (status !== 200 || !bytes.equals(readFileSync(target))) return false;
    } catch {
      return false;
    }
    return true;                                             // 一个项目专属文件对上了就够了
  }
  return true;                                               // 没有可核对的文件：只凭 pid 与页面
}

/**
 * 记下的那个宿主还活着吗？活着 → 那份状态；否则 null。**不看端口。**
 */
export async function hostAlive(surface, state = undefined) {
  const paths = surfacePaths(surface);
  const saved = state === undefined ? hostState(surface) : state;
  if (!saved) return null;
  if (!pidAlive(saved.pid)) return null;
  const url = text(saved.url);
  if (!url) return null;
  let page;
  try {
    const got = await getBytes(url);
    if (got.status !== 200) return null;
    page = got.bytes;
  } catch {
    return null;
  }
  if (!servedEntryIsOurs(paths.entry, page)) return null;
  return (await servesThisProject(paths, url)) ? saved : null;
}

/* ------------------------------------------------------------------ 起停 */

/**
 * 宿主的启动自证是它打印的那个 JSON（**跨多行**，indent=2）；日志里还混着别的输出。
 * 所以按 `{` 逐个位置试解析，而不是"逐行解析" —— 逐行那条路在美化输出上永远失败
 * （实测：宿主明明自证了，这里却报"没有自证"）。
 */
export function startupReport(logText) {
  let index = text(logText).indexOf('{');
  while (index >= 0) {
    try {
      const value = JSON.parse(balancedSlice(logText, index));
      if (value && typeof value === 'object' && value.url) return value;
    } catch { /* 这个 `{` 不是开头，往后找 */ }
    index = text(logText).indexOf('{', index + 1);
  }
  return null;
}

/** 从 `{` 起截一个括号配平的片段（配平不了就返回剩余全部，让 JSON.parse 去失败）。 */
function balancedSlice(raw, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i += 1) {
    const ch = raw[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }
  return raw.slice(start);
}

function logTail(log, chars = 600) {
  try {
    return readFileSync(log, 'utf8').trim().slice(-chars);
  } catch {
    return '';
  }
}

/**
 * 起无插件宿主：`node <本模组>/scripts/serve-review.mjs <surface> --port <port> --no-open`。
 * 用 `process.execPath` —— 不猜 PATH 上有没有 node：我们**就是** node。
 */
export async function startHost(surface, port = 0) {
  const paths = surfacePaths(surface);
  const log = resolve(paths.base, HOST_LOG_NAME);
  mkdirSync(dirname(log), { recursive: true });
  if (existsSync(log)) unlinkSync(log);
  const fd = openSync(log, 'w');
  let child;
  try {
    child = spawn(process.execPath,
      [SERVE_SCRIPT, paths.surface, '--port', String(port), '--no-open'],
      { detached: true, stdio: ['ignore', fd, fd] });
  } finally {
    closeSync(fd);                                           // 子进程已拿到它自己那份
  }
  child.unref();
  const startedAt = new Date().toISOString();
  for (let i = 0; i < 80; i += 1) {
    await sleep(100);
    // **先看句柄**：这里要的是退出码（把"起不来"和"起来了但没自证"分开报），
    // 而不是"pid 还在不在"。裸 kill(pid,0) 在别的运行时里会把僵尸当活着（见文件头）。
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error('审阅宿主启动失败（退出码 ' + child.exitCode + '）；日志：' + log
        + '\n' + logTail(log));
    }
    const report = startupReport(readFileSync(log, 'utf8'));
    if (report && report.url) {
      const state = {
        pid: report.pid || child.pid,
        port: portOf(report.url),
        url: String(report.url),
        surface: paths.surface,
        log,
        feedback_path: paths.feedback ? String(paths.feedback) : null,
        wake_log: String(paths.wakeLog),
        started_at: startedAt,
      };
      writeFileSync(hostStatePath(paths.surface), JSON.stringify(state, null, 2) + '\n', 'utf8');
      return state;
    }
  }
  throw new Error('审阅宿主起来了但没有自证（日志里没有带 url 的启动报告）：' + log);
}

export function portOf(url) {
  try {
    const value = Number(String(url).split(':').pop().split('/')[0]);
    return Number.isInteger(value) ? value : 0;
  } catch {
    return 0;
  }
}

/**
 * 停掉一个宿主。**报 true 才算收干净。**
 * 先 SIGTERM，等；没走就升级 SIGKILL —— `serve-review.mjs` 的 SIGTERM 处理器要等已有连接
 * 关干净，浏览器留着 keep-alive 时就可能一直不返回。
 */
export async function stopHost(state, timeout = 5.0) {
  const pid = (state || {}).pid;
  if (!pid) return false;
  if (!pidAlive(pid)) return true;                           // 已经走了
  try {
    process.kill(Number(pid), 'SIGTERM');
  } catch {
    return !pidAlive(pid);
  }
  let deadline = Date.now() + timeout * 1000;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return true;
    await sleep(100);
  }
  try {
    process.kill(Number(pid), 'SIGKILL');
  } catch { /* 已经没了 */ }
  deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return true;
    await sleep(100);
  }
  return false;
}

/**
 * 真的去开浏览器。平台分派**只有这一处**。
 *
 * 以前这件事有两套行为：CLI 的 `open` 不开，Python 的 `open_review` 开（`webbrowser`）——
 * 于是 bypage（纯 `.mjs`）只得在自己 Skill 侧再写一遍平台开关绕过去。**同一件事一套行为**：
 * 开在这里，`--no-open` 关在这里。
 */
export function launchBrowser(url) {
  const [command, args] = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
      : ['xdg-open', [url]];
  const result = spawnSync(command, args, { stdio: 'ignore', timeout: 5000 });
  return !result.error && result.status === 0;
}

/**
 * surface 合规、宿主活着就复用，死了/没有就现在起一个，然后（默认）**把浏览器打开**。
 * `openBrowser=false` 走 `--no-open`：测试与无头环境必须能关掉。
 * 调它之前 surface 必须已经写好（各家自己建文档 → `write`）。
 */
export async function openReview(surface, port = 0, openBrowser = true) {
  const paths = surfacePaths(surface);
  validateSurface(paths.surface);
  const live = await hostAlive(paths.surface);
  const started = live === null;
  const state = started ? await startHost(paths.surface, port) : live;
  let opened = false;
  if (openBrowser) {
    opened = launchBrowser(state.url);
    if (!opened) throw new Error('无法自动打开审阅页面：' + state.url);
  }
  return { ...state, started, reused: !started, opened, surface: String(paths.surface), path: state.url };
}

/* ------------------------------------------------------------------ CLI */

const USAGE = [
  '用法：node review-host.mjs <子命令> <surface> [选项]',
  '',
  '  write <surface> [--doc <path>|-]   surface 文档落盘（幂等；--doc 省掉时读 stdin）',
  '  validate <surface>                 跑唯一校验器',
  '  state <surface>                    上次起的宿主的状态（或 null）',
  '  alive <surface> [--state <path>|-] 那个宿主还活着吗',
  '  start <surface> [--port N] [--open]  起一个无插件宿主（默认不开浏览器）',
  '  stop <surface> | --state <path>|-  停干净（SIGTERM → SIGKILL）',
  '  open <surface> [--port N] [--no-open]  起/复用并**打开浏览器**（--no-open 关掉）',
  '',
  '  pid <pid>                          那个 pid 还在吗（判据在这边，不在调用方的运行时里）',
  '  report <log>                       从宿主日志里解析启动自证（跨行 JSON）；没有则 null',
  '  match <entry> --served <path>      这份 serve 回来的页面，是不是磁盘上那一份入口',
].join('\n');

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      out[key] = argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    } else {
      out._.push(token);
    }
  }
  return out;
}

function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

/** `--state <path>|-` → 一个 state 对象；没给就返回 undefined（让调用方去读状态文件）。 */
function stateFromArg(value) {
  if (value === undefined) return undefined;
  const raw = value === true || value === '-' ? readStdin() : readFileSync(resolve(value), 'utf8');
  return JSON.parse(raw);
}

async function main(argv) {
  const args = parseArgs(argv);
  const command = args._[0];
  const surface = args._[1];
  const stdinDoc = () => JSON.parse(readStdin());

  switch (command) {
    case 'write': {
      const doc = args.doc !== undefined && args.doc !== '-' && args.doc !== true
        ? JSON.parse(readFileSync(resolve(args.doc), 'utf8'))
        : stdinDoc();
      const path = writeSurface(surface, doc);
      return { ok: true, surface: String(path) };
    }
    case 'validate':
      validateSurface(surface);
      return { ok: true, valid: true };
    case 'state':
      return hostState(surface);
    case 'alive': {
      const state = await hostAlive(surface, stateFromArg(args.state));
      return { alive: state !== null, state };
    }
    case 'start': {
      const state = await startHost(surface, args.port === undefined ? 0 : Number(args.port));
      let opened = false;
      if (args.open === true) {                       // `start` 默认不开；要开就明说
        opened = launchBrowser(state.url);
        if (!opened) throw new Error('无法自动打开审阅页面：' + state.url);
      }
      return { ...state, opened };
    }
    case 'stop': {
      const state = stateFromArg(args.state) ?? hostState(surface);
      return { stopped: await stopHost(state) };
    }
    case 'open':
      // `open` 的默认就是"打开"——名字就是这么承诺的；无头/测试传 `--no-open`
      return openReview(surface, args.port === undefined ? 0 : Number(args.port),
        !(args['no-open'] === true || args['no-open'] === 'true'));
    case 'pid':
      // 判据在这边：僵尸语义、权限语义都归 Node（调用方只拿一个布尔）
      return { alive: pidAlive(Number(surface)) };
    case 'report':
      return { report: startupReport(readFileSync(resolve(surface), 'utf8')) };
    case 'match':
      return { match: servedEntryIsOurs(resolve(surface), readFileSync(resolve(args.served), '')) };
    case 'constants':
      // 让调用方（Python 传输层）能**核对自己镜像的那几个名字**，而不是各说各话
      return { CONTRACT_VERSION, BRIDGE_PLACEHOLDER, HOST_STATE_NAME, HOST_LOG_NAME, WAKE_LOG_NAME };
    default:
      process.stderr.write(USAGE + '\n');
      process.exitCode = 2;
      return null;
  }
}

const invokedDirectly = (() => {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((result) => {
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    })
    .catch((error) => {
      process.stdout.write(JSON.stringify({ ok: false, error: error.message }, null, 2) + '\n');
      process.exitCode = 1;
    });
}
