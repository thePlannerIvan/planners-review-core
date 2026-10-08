#!/usr/bin/env node
/**
 * 最小示例：**纯 Node、不碰 python** 走完 write → validate → start → alive → stop。
 *
 * 这是 planners-bypage 那类 `.mjs` 调用方要的用法（它们的运行契约不许假定 `python3` 存在）。
 * 跑法：node evals/review-host-example.mjs
 *
 * 生命周期只有一份，就是 `scripts/review-host.mjs` —— 这里只是 import 它，不重写任何判据。
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CONTRACT_VERSION, startHost, stopHost, hostAlive, validateSurface, writeSurface,
} from '../scripts/review-host.mjs';

const root = mkdtempSync(join(tmpdir(), 'review-host-example-'));
const surface = join(root, 'review', 'review-surface.json');

// ① 一个最小的项目：入口带裸注入点 + 一个项目专属文件给 watch 盯
mkdirSync(join(root, 'review'), { recursive: true });
mkdirSync(join(root, 'timeline'), { recursive: true });
writeFileSync(join(root, 'review', 'index.html'),
  '<!doctype html><html><head>\n{{REVIEW_BRIDGE}}\n</head><body><h1>example</h1></body></html>\n', 'utf8');
writeFileSync(join(root, 'timeline', 'data.json'), JSON.stringify({ tag: 'example' }), 'utf8');

// ② write：文档由调用方建（内容是哪家的业务），模组只负责落盘
writeSurface(surface, {
  contract_version: CONTRACT_VERSION,
  id: 'example/visual',
  title: '示例审阅面',
  project_root: '..',
  dir: '..',
  entry: 'review/index.html',
  feedback: 'submissions.json',
  // 审阅面用 steer（插话，走到下一个步骤边界就取走）；queue 会排到当前回合之后。
  wake: { mode: 'steer', text: '{unit} 已定。' },
  watch: ['../timeline/data.json'],
  capabilities: [],
});
console.log('write    →', surface);

// ③ validate：唯一校验器
console.log('validate →', validateSurface(surface));

// ④ start：起无插件宿主
const state = await startHost(surface);
console.log('start    →', { pid: state.pid, port: state.port, url: state.url });

// ⑤ alive：按内容判身份（页面注入过 + watch 文件逐字节等于磁盘）
console.log('alive    →', (await hostAlive(surface)) ? 'alive（认得出是我们的）' : 'NOT ALIVE');

// ⑥ 死掉之后要判得出来
await stopHost(state);
console.log('stop     →', 'stopped');
console.log('alive    →', (await hostAlive(surface)) ? 'STILL ALIVE（错）' : 'gone（判死）');

rmSync(root, { recursive: true, force: true });
