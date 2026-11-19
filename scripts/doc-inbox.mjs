#!/usr/bin/env node
/**
 * 模型侧的收件箱命令：没有侧栏插件时，人派发的任务攒在本地文件里，由模型来读。
 *
 * 用法：
 *   node scripts/doc-inbox.mjs list <文档路径> [--all]
 *   node scripts/doc-inbox.mjs take <文档路径> [--id <任务 id>]
 *
 * `list` 只列还没被取走的任务（`--all` 连处理中/已完成一起列），每条带任务的完整形状：
 * 块身份 `blocks[].anchor`、提交时的内容指纹 `blocks[].sha256`、人的意见 `text`、以及
 * `doc.path`（模型据此读工作稿）。stdout 只出 JSON 结果，诊断走 stderr。
 *
 * `take` 把 `pending` 改成 `processing` 并写 `started_at` / `locked_blocks`，
 * 这样「派发 → 被取走」在文件里看得见；重复取走不重复取。
 */
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { INBOX_CONTRACT, inboxDirFor, listTasks, takeTasks } from './lib/doc-inbox.mjs';

const USAGE = `用法：
  node scripts/doc-inbox.mjs list <文档路径> [--all]
  node scripts/doc-inbox.mjs take <文档路径> [--id <任务 id>]`;

const fail = (message, code = 1) => {
  console.error(message);
  process.exit(code);
};

const args = process.argv.slice(2);
const command = args[0];
if (command !== 'list' && command !== 'take') fail(USAGE, 2);

const flagValue = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] ?? null : null;
};
const docArg = args.slice(1).find((arg) => !arg.startsWith('--') && arg !== flagValue('--id'));
if (!docArg) fail(USAGE, 2);

/** 工作台按 realpath 记 doc.path；命令也用 realpath，落在同一个收件箱目录。 */
const docPath = (() => {
  const absolute = resolve(docArg);
  try {
    return realpathSync(absolute);
  } catch {
    fail(`找不到文档：${absolute}`, 2);
  }
})();

try {
  if (command === 'list') {
    const requested = args.includes('--all') ? null : 'pending';
    const tasks = listTasks(docPath, { status: requested });
    process.stdout.write(JSON.stringify({
      ok: true,
      contract: INBOX_CONTRACT,
      doc: docPath,
      inbox: inboxDirFor(docPath),
      task_count: tasks.length,
      tasks,
    }, null, 2) + '\n');
  } else {
    const id = flagValue('--id');
    const taken = takeTasks(docPath, { id });
    process.stdout.write(JSON.stringify({
      ok: true,
      contract: INBOX_CONTRACT,
      doc: docPath,
      inbox: inboxDirFor(docPath),
      taken,
    }, null, 2) + '\n');
  }
} catch (error) {
  console.error(`${error?.code ? `[${error.code}] ` : ''}${error?.message ?? error}`);
  process.exit(1);
}
