/**
 * 仓库里不许出现冲突标记。
 *
 * 起因：一次 `git merge` 只报了 `doc-structure.mjs` 一处冲突，随后 `git add -A`
 * 把 `doc-workbench.js` 与 `README.md` 里另外两处一起提交了。测试全绿——因为
 * 工作台脚本不进 Node 的解析路径，没人发现页面已经白屏。
 *
 * 这条检查比任何"合并时记得看 status"的叮嘱都可靠：它不依赖人记得。
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SKIP = new Set(['node_modules', '.git', '.doc-workbench', 'records']);
const EXTS = new Set(['.js', '.mjs', '.css', '.md', '.json', '.html', '.yml', '.yaml']);
const MARKERS = [/^<<<<<<< /m, /^>>>>>>> /m, /^=======$/m];

function walk(dir, found = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, found);
    else if (EXTS.has(extname(name))) found.push(path);
  }
  return found;
}

test('仓库里没有冲突标记', () => {
  const dirty = [];
  for (const path of walk(ROOT)) {
    const text = readFileSync(path, 'utf8');
    if (MARKERS.some((marker) => marker.test(text))) dirty.push(path.slice(ROOT.length));
  }
  assert.deepEqual(dirty, [], `这些文件里还留着冲突标记：${dirty.join('、')}`);
});
