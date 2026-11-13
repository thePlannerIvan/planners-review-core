#!/usr/bin/env node
/**
 * 给一份已有的 HTML 产物做一个批注面（唯一入口）。
 *
 * 用法：
 *   node open-artifact.mjs --entry <artifact.html>
 *        [--title <标题>] [--id <skill/面>]
 *        [--feedback <相对 entry 的文件>] [--draft <相对 entry 的文件>]
 *        [--project-root <相对 surface 的路径>] [--dir <相对 surface 的路径>]
 *        [--out <surface 写到哪里>] [--no-draft] [--force] [--json]
 *
 * 它只做三件事：把 surface 写到产物旁边、跑官方校验器、给出下一步该调什么。
 * **不碰产物本身** —— 入口 HTML 不用改一行（宿主会把桥与批注层补在 </body> 前）。
 *
 * 为什么需要它：没有这条命令时，每个任务都要手写一份 review-surface.json，
 * 而其中 `dir` / `entry` / `feedback` 的相对基准错了不会报错，只会得到一个
 * "打开成功但永远不落盘"的面。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const VALIDATOR = join(HERE, 'validate-surface.mjs')

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i]
    if (!key.startsWith('--')) continue
    const next = argv[i + 1]
    if (next && !next.startsWith('--')) { out[key.slice(2)] = next; i += 1 } else out[key.slice(2)] = true
  }
  return out
}

function die(message, code = 2) {
  console.error(message)
  process.exit(code)
}

function slug(text) {
  const cleaned = String(text)
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  return cleaned === '' ? 'artifact' : cleaned
}

function titleOf(html, fallback) {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  const text = match ? match[1].replace(/\s+/g, ' ').trim() : ''
  return text === '' ? fallback : text
}

const args = parseArgs(process.argv.slice(2))
if (!args.entry || args.entry === true) {
  die('用法：node open-artifact.mjs --entry <artifact.html> [--title 标题] [--id skill/面] [--feedback annotations.json]')
}
const entryPath = resolve(args.entry)
if (!existsSync(entryPath) || !statSync(entryPath).isFile()) die(`找不到产物：${entryPath}`)
if (!['.html', '.htm'].includes(extname(entryPath).toLowerCase())) {
  die(`只能给 HTML 产物做批注面（收到 ${extname(entryPath) || '无扩展名'}）：${entryPath}`)
}

const entryDir = dirname(entryPath)
const entryName = basename(entryPath)
const html = readFileSync(entryPath, 'utf8')
const title = typeof args.title === 'string' ? args.title : titleOf(html, basename(entryName, extname(entryName)))
const id = typeof args.id === 'string'
  ? args.id
  : `artifact/${slug(entryName)}`
if (!/^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/.test(id)) {
  die(`id 必须形如 <skill>/<面>（小写字母、数字、连字符），收到 ${JSON.stringify(id)}`)
}

const feedback = typeof args.feedback === 'string' ? args.feedback : 'annotations.json'
const draft = args['no-draft'] ? null : (typeof args.draft === 'string' ? args.draft : 'annotations-draft.json')
const outPath = typeof args.out === 'string' ? resolve(args.out) : join(entryDir, 'review-surface.json')
if (existsSync(outPath) && args.force !== true) {
  die(`已经有一份 surface：${outPath}\n确认要覆盖就加 --force（注意：换 id 会顶掉正在审的那个标签）。`)
}

const doc = {
  contract_version: 'review-surface/2.0.0',
  id,
  title,
  description: '在产物上直接改字、点选元素、框选区域',
  project_root: typeof args['project-root'] === 'string' ? args['project-root'] : '.',
  dir: typeof args.dir === 'string' ? args.dir : '.',
  entry: entryName,
  annotate: true,
  // 产物被重新生成时页面会收到「变了」；watch 只盯这一份，别把同目录的反馈文件也算进去。
  watch: [entryName],
  wake: { mode: 'steer', text: '产物上有新批注（artifact-annotations/1），按批注改这一版。' },
  ...(feedback === '' ? {} : { feedback }),
  ...(draft === null ? {} : { draft }),
  ...(draft === null ? {} : { capabilities: ['draft'] }),
}
writeFileSync(outPath, `${JSON.stringify(doc, null, 2)}\n`, 'utf8')

const check = spawnSync(process.execPath, [VALIDATOR, outPath], { encoding: 'utf8' })
let parsed = null
try { parsed = JSON.parse(check.stdout) } catch { /* 校验器没吐 JSON 就是它自己坏了 */ }
if (check.status !== 0 || parsed === null) {
  const detail = check.stdout.trim() || check.stderr.trim() || `退出码 ${check.status}`
  die(`surface 写好了但校验没过：${outPath}\n${detail}`, 1)
}

const result = {
  ok: true,
  surface: outPath,
  id,
  title,
  entry: entryPath,
  feedback: feedback === '' ? null : resolve(entryDir, feedback),
  draft: draft === null ? null : resolve(entryDir, draft),
  annotate: true,
  warnings: (parsed.warnings ?? []).map((warning) => `${warning.code}: ${warning.message}`),
  next: `review_open({ surface: ${JSON.stringify(outPath)} })`,
}

if (args.json) {
  console.log(JSON.stringify(result, null, 2))
} else {
  console.log(`surface：${outPath}`)
  console.log(`产物  ：${entryPath}`)
  console.log(`批注层：开（宿主会把桥与批注层补在 </body> 前，产物不用改）`)
  if (result.warnings.length) {
    console.log('提醒：')
    for (const warning of result.warnings) console.log(`  - ${warning}`)
  }
  console.log(`下一步：${result.next}`)
}
