/**
 * 工作台写盘的底层原语：旁路目录与原子写。
 *
 * journal、任务板、收件箱、图资产清单与历史存档都写进文档同目录的
 * `.doc-workbench/`，并且都必须「临时文件 fsync 后 rename」，否则进程在
 * 两次写之间被打断会留下半份文件。这两件事只在这里定义一次。
 *
 * 权限跟目标文件走；新文件的默认权限是 0600 —— 工作台旁路目录里既有正文全文
 * （journal / history），也有锁与任务，没有理由让同机其他用户读到。
 */
import { closeSync, existsSync, fsyncSync, openSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';

/** 文档同目录下的工作台旁路目录。 */
export function stateDirFor(docPath) {
  return join(dirname(resolve(docPath)), '.doc-workbench');
}

/** 原子写：临时文件 fsync 后 rename。目标存在时沿用它的权限位。 */
export function atomicWrite(path, data, mode = null) {
  const targetMode = mode ?? (existsSync(path) ? statSync(path).mode & 0o777 : 0o600);
  const temp = `${path}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`;
  if (existsSync(temp)) unlinkSync(temp);
  const descriptor = openSync(temp, 'wx', targetMode);
  try {
    writeFileSync(descriptor, data);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(temp, path);
}
