#!/usr/bin/env node
/**
 * planners-doc/1 的唯一校验器。
 *
 * 用法：node validate-doc.mjs <storyline.md|by-page.md> [--text]
 *
 * 它挡的是**契约层面的结构漂移**：
 *   · 文档头缺字段、版本不对、doc 不认识
 *   · 页与章节的层级顺序不对（# 文档 / ## 章节 / ### 页 / #### 页内小节）
 *   · 锚点写法、位置、重复
 *   · 七种块之外的块（原始 HTML、分隔线、嵌套块……）
 *   · 图片不是相对路径、或相对路径指向的文件不存在
 *   · 页为空
 *
 * 它**不评价**内容：判断好不好、来源可不可信、表格排得好不好看，都不归它管。
 * 切块规则只有一份，在工作台共用的 `lib/doc-blocks.mjs` 里。
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseDocument, VERSION } from './lib/doc-blocks.mjs';

const args = process.argv.slice(2);
const textOutput = args.includes('--text');
const file = args.find((a) => !a.startsWith('--'));
if (!file) {
  console.error('用法：node validate-doc.mjs <storyline.md|by-page.md> [--text]');
  process.exit(2);
}
const docPath = resolve(file);
if (!existsSync(docPath) || !statSync(docPath).isFile()) {
  console.error(`找不到文档：${docPath}`);
  process.exit(2);
}

const raw = readFileSync(docPath, 'utf8');
const parsed = parseDocument(raw, { docDir: dirname(docPath), checkImages: true });
const { front, chapters, pages, blocks, errors, warnings } = parsed;

const valid = errors.length === 0;
const checked = {
  path: docPath,
  contract: front.contract ?? null,
  doc: front.doc ?? null,
  project: front.project ?? null,
  chapters: chapters.length,
  pages: pages.length,
  blocks: blocks.length,
  anchors: blocks.filter((block) => block.anchor).length,
};

if (textOutput) {
  for (const warning of warnings) {
    const where = [warning.line ? `行 ${warning.line}` : null, warning.page, warning.block].filter(Boolean).join(' · ');
    console.log(`WARN  [${warning.code}] ${where ? `${where}：` : ''}${warning.message}`);
  }
  for (const error of errors) {
    const where = [error.line ? `行 ${error.line}` : null, error.page, error.block].filter(Boolean).join(' · ');
    console.log(`ERROR [${error.code}] ${where ? `${where}：` : ''}${error.message}`);
  }
  console.log(valid ? `\n合规：${warnings.length} 个警告` : `\n不合规：${errors.length} 个错误、${warnings.length} 个警告`);
} else {
  console.log(JSON.stringify({ contract: VERSION, valid, errors, warnings, checked }, null, 2));
}
process.exit(valid ? 0 : 1);
