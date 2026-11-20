import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { DOC_BROWSER_OPERATIONS, DOC_MODEL_OPERATIONS } from '../scripts/doc-command.mjs';
import { BLOCK_TYPES, TYPE_NAMES } from '../scripts/lib/doc-blocks.mjs';

/**
 * 文档与代码的口径漂移只靠人眼发现，代价是每次都要重读一遍。
 * 这两条把它变成可复跑的比较：文档里列出的操作与块类型，必须与代码常量一致。
 * 文档侧用 <!-- ops:browser --> 这类标记圈出会被比较的片段。
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

function markedTokens(text, name) {
  const match = text.match(new RegExp(`<!--\\s*${name}\\s*-->([\\s\\S]*?)<!--\\s*/\\s*${name}\\s*-->`));
  assert.ok(match, `文档里缺少 <!-- ${name} --> … <!-- /${name} --> 标记`);
  return [...match[1].matchAll(/`([a-z_]+)`/g)].map((m) => m[1]).sort();
}

test('command-transport 文档列出的操作与后端白名单一致', () => {
  const doc = read('references/command-transport.md');
  assert.deepEqual(markedTokens(doc, 'ops:browser'), [...DOC_BROWSER_OPERATIONS].sort());
  assert.deepEqual(markedTokens(doc, 'ops:model'), [...DOC_MODEL_OPERATIONS].sort());
});

test('planners-doc 契约列出的块类型与解析器一致', () => {
  const contract = read('contracts/planners-doc.md');
  const chinese = [...contract.matchAll(/^\|\s*([^|]+?)\s*\|/gm)]
    .map((m) => m[1].trim())
    .filter((name) => Object.values(TYPE_NAMES).includes(name));
  const fromDoc = chinese.map((name) => Object.keys(TYPE_NAMES).find((key) => TYPE_NAMES[key] === name));
  assert.deepEqual([...new Set(fromDoc)].sort(), [...BLOCK_TYPES].sort());
});
