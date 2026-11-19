#!/usr/bin/env node
/**
 * `doc-assets/1` 的唯一校验器：正文引用、资产清单、磁盘文件三边必须对得上。
 *
 * 用法：node validate-doc-assets.mjs <storyline.md|by-page.md> [--manifest <path>] [--text]
 *
 * 它只回答一件事：文档里每张图现在指向哪个文件、那个文件是不是清单登记的那一版。
 * 不评价图好不好、该不该用；素材取舍归 bypage 的资产流程（票 09）。
 */
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { ASSET_CONTRACT, manifestPathFor, validateManifest } from './lib/doc-assets.mjs';

const args = process.argv.slice(2);
const textOutput = args.includes('--text');
const manifestFlag = args.indexOf('--manifest');
const manifestArg = manifestFlag >= 0 ? args[manifestFlag + 1] : null;
const file = args.find((value, index) => !value.startsWith('--')
  && !(manifestFlag >= 0 && index === manifestFlag + 1));

if (!file) {
  console.error('用法：node validate-doc-assets.mjs <storyline.md|by-page.md> [--manifest <path>] [--text]');
  process.exit(2);
}
const docPath = resolve(file);
if (!existsSync(docPath) || !statSync(docPath).isFile()) {
  console.error(`找不到文档：${docPath}`);
  process.exit(2);
}
if (manifestFlag >= 0 && !manifestArg) {
  console.error('--manifest 后面要跟一个路径');
  process.exit(2);
}

const manifestPath = manifestArg ? resolve(manifestArg) : manifestPathFor(docPath);
const { valid, errors, checked } = validateManifest(docPath, manifestPath);

if (textOutput) {
  for (const error of errors) {
    const where = error.path ? `${error.path}：` : '';
    console.log(`ERROR [${error.code}] ${where}${error.message}`);
  }
  console.log(valid ? '\n合规：资产清单与正文、磁盘一致' : `\n不合规：${errors.length} 个错误`);
} else {
  console.log(JSON.stringify({ contract: ASSET_CONTRACT, valid, errors, checked }, null, 2));
}
process.exit(valid ? 0 : 1);
