/**
 * 浏览器侧的脚本必须真的能被解析。
 *
 * 起因：一次 `git merge` 解掉一处冲突后 `git add -A`，把另外两个文件里的
 * `<<<<<<<` 一起提交了。`npm test` 全绿——因为那些断言只把工作台脚本当**文本**读，
 * 从来没把它当代码解析过。页面实际上白屏，是靠另一个子代理撞见才发现的。
 *
 * `node --check` 对冲突标记就是语法错误，几十毫秒就能挡住这一整类事故。
 * 它和「仓库里不许出现冲突标记」那条是两道闸：那条防标记，这条防任何语法坏掉。
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
// 第三方产物不检查：它们自带构建产物，改不了，也不该由我们背语法。
const SKIP_DIRS = new Set(['node_modules', '.git', 'vendor', 'content-review']);
const SKIP_FILES = new Set(['marked.umd.js']);

function walk(dir, found = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name) || SKIP_FILES.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, found);
    else if (extname(name) === '.js') found.push(path);
  }
  return found;
}

test('浏览器脚本逐个过 node --check', () => {
  const files = walk(join(ROOT, 'assets'));
  assert.ok(files.length >= 5, `assets 下应有一批脚本，实际找到 ${files.length} 个`);
  const broken = [];
  for (const file of files) {
    try {
      execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    } catch (error) {
      broken.push(`${file.slice(ROOT.length)}：${String(error.stderr ?? error.message).split('\n')[0]}`);
    }
  }
  assert.deepEqual(broken, [], `这些脚本解析不过：\n${broken.join('\n')}`);
});
