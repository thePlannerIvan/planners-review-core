#!/usr/bin/env node
/**
 * review-surface/2.0.0 的唯一校验器。
 *
 * 用法：node validate-surface.mjs <review-surface.json> [--text]
 *
 * 它挡的是**任何宿主都必须在意的**东西：
 *   · 契约版本不对（不让半新半旧混跑）
 *   · id / wake 形状不对
 *   · project_root / dir / entry 不存在
 *   · **dir 落在 project_root 之外**（宿主 serve 的就是 dir，出了树就是把项目外的文件挂出去）
 *   · feedback 落在 project_root 之外
 *   · 入口里没有 {{REVIEW_BRIDGE}} 注入点（桥由宿主注入，页面不能自带副本）
 * 它**不评价**审什么、怎么审 —— 那是 Skill 的事。
 */
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const VERSION = 'review-surface/2.0.0';

const errors = [];
const warnings = [];
const err = (code, message) => errors.push({ code, message });
const warn = (code, message) => warnings.push({ code, message });

const args = process.argv.slice(2);
const text = args.includes('--text');
const file = args.find((a) => !a.startsWith('--'));
if (!file) {
  console.error('用法：node validate-surface.mjs <review-surface.json> [--text]');
  process.exit(2);
}
const surfacePath = resolve(file);
if (!existsSync(surfacePath)) {
  console.error(`找不到 surface 文件：${surfacePath}`);
  process.exit(2);
}

let doc = null;
try {
  doc = JSON.parse(readFileSync(surfacePath, 'utf8'));
} catch (error) {
  err('invalid_json', `不是合法 JSON：${error.message}`);
}

const isBlank = (v) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
const inTree = (child, parent) => child === parent || child.startsWith(parent + sep);
/** 对可能还不存在的路径，向上找到最近的存在祖先再 realpath（避免"文件还没建就报越界"） */
const realAncestor = (target) => {
  let cursor = target;
  for (let i = 0; i < 40; i += 1) {
    if (existsSync(cursor)) return realpathSync(cursor);
    const up = dirname(cursor);
    if (up === cursor) break;
    cursor = up;
  }
  return null;
};

const checked = { surface: surfacePath };
if (doc !== null) {
  const surfaceDir = dirname(surfacePath);

  // 1) 版本与必需字段
  if (doc.contract_version !== VERSION) {
    err('contract_version', `contract_version 必须是 "${VERSION}"，实际 ${JSON.stringify(doc.contract_version)}`);
  }
  for (const key of ['id', 'title', 'project_root', 'dir', 'entry', 'wake']) {
    if (isBlank(doc[key])) err('required', `缺必需字段 ${key}`);
  }
  if (!isBlank(doc.id) && !/^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/.test(doc.id)) {
    err('id_pattern', `id 必须形如 <skill>/<面>（小写字母、数字、连字符），实际 ${JSON.stringify(doc.id)}`);
  }
  if (doc.wake && typeof doc.wake === 'object') {
    if (!['queue', 'steer'].includes(doc.wake.mode)) err('wake_mode', `wake.mode 只能是 queue 或 steer，实际 ${JSON.stringify(doc.wake.mode)}`);
    if (isBlank(doc.wake.text)) err('wake_text', 'wake.text 不能为空（人的决定要靠它回到模型）');
  } else if (!isBlank(doc.wake)) {
    err('wake_shape', 'wake 必须是 { mode, text }');
  }
  const KNOWN_CAPABILITIES = ['asset-upload'];
  if (Array.isArray(doc.capabilities) && doc.capabilities.length) {
    const unknown = doc.capabilities.filter((c) => !KNOWN_CAPABILITIES.includes(c));
    if (unknown.length) {
      warn('capabilities_unknown', `capabilities 里有未定义的值 ${JSON.stringify(unknown)}；宿主会忽略（前向兼容），但页面不要依赖它`);
    }
  }

  // 2) 路径与包含性（只在必需字段齐了才查，避免刷噪音）
  if (!isBlank(doc.project_root) && !isBlank(doc.dir) && !isBlank(doc.entry)) {
    const projectRoot = resolve(surfaceDir, doc.project_root);
    const dirAbs = resolve(surfaceDir, doc.dir);
    checked.project_root = projectRoot;
    checked.dir = dirAbs;

    const rootReal = existsSync(projectRoot) ? realpathSync(projectRoot) : null;
    if (rootReal === null || !statSync(projectRoot).isDirectory()) {
      err('project_root_missing', `project_root 不存在或不是目录：${projectRoot}`);
    }
    if (!existsSync(dirAbs) || !statSync(dirAbs).isDirectory()) {
      err('dir_missing', `dir 不存在或不是目录：${dirAbs}`);
    } else if (rootReal !== null) {
      const dirReal = realpathSync(dirAbs);
      if (!inTree(dirReal, rootReal)) {
        err('dir_outside_project', `dir 的 realpath 落在 project_root 之外：${dirReal} 不在 ${rootReal} 内`);
      }
    }

    if (existsSync(dirAbs)) {
      const entryAbs = join(dirAbs, doc.entry);
      checked.entry = entryAbs;
      if (!existsSync(entryAbs) || !statSync(entryAbs).isFile()) {
        err('entry_missing', `entry 不存在：${entryAbs}`);
      } else {
        const dirReal = realpathSync(dirAbs);
        if (!inTree(realpathSync(entryAbs), dirReal)) err('entry_outside_dir', `entry 的 realpath 落在 dir 之外：${entryAbs}`);

        // 桥由宿主注入：入口里必须有注入点。**不能在页面里放副本** —— 插件模式下页面地址是
        // 一个路由（/api/review.page?…）而不是文件路径，相对引用的副本会 404；而 <script src>
        // 又必须早于桥连上，先有鸡先有蛋。
        const entryHtml = readFileSync(entryAbs, 'utf8');
        const MARK = '{{REVIEW_BRIDGE}}';
        const occurrences = entryHtml.split(MARK).length - 1;
        if (occurrences === 0) {
          err('bridge_placeholder', 'entry HTML 里没有 {{REVIEW_BRIDGE}} —— 桥由宿主注入，页面必须留这个注入点');
        } else if (occurrences > 1) {
          err('bridge_placeholder_multiple', `{{REVIEW_BRIDGE}} 出现了 ${occurrences} 次 —— 只能有一个（多了会把桥注入两遍）`);
        } else if (!entryHtml.split('\n').some((line) => line.trim() === MARK)) {
          // **标记必须裸着独占一行。** 宿主是把这个标记**原地换掉**，换成什么由宿主决定
          // （插件内联桥的源码；无插件宿主给 base + 一个外链脚本）。所以它不能待在属性里、
          // 也不能待在标签内部 —— 宿主的整段替换会把那个标签撑破。这两种写法都真的发生过：
          //   <script src="{{REVIEW_BRIDGE}}"></script>  → 整段塞进 src=""，桥 404
          //   <script>{{REVIEW_BRIDGE}}</script>        → 变成 <script><script>…</script></script>
          // 以前只查 includes，所以这两种都能过 —— 规则写下了，但闸门没装上。
          const where = (entryHtml.split('\n').find((line) => line.includes(MARK)) ?? '').trim().slice(0, 80);
          err('bridge_placeholder_not_bare',
            `{{REVIEW_BRIDGE}} 必须裸着独占一行（现在长这样：${where}）。宿主会把这个标记原地换成整段标签，`
            + '放进 src="" 里或 <script> 里都会把标签撑破。正确写法就是单独一行：{{REVIEW_BRIDGE}}');
        }
      }
    }

    // 2b) watch：宿主只会 stat 它们，但路径同样不能出 dir（出了就是把目录外的东西当信号源）
    // **相对 surface 文件**（与 schema 的描述、与插件侧一致）。这是本契约里唯一
    // 不相对 `dir` 的路径字段 —— 页面里的资产引用相对 `dir`，而 surface 自己声明的
    // 文件路径相对自己。第二条数据点（video-craft，页面在子目录里）把这个不一致暴露了出来。
    if (Array.isArray(doc.watch)) {
      for (const rel of doc.watch) {
        if (typeof rel !== 'string' || rel.trim() === '') { err('watch_shape', 'watch 只能是非空字符串数组'); continue; }
        const target = resolve(surfaceDir, rel);
        if (target !== dirAbs && !target.startsWith(dirAbs + sep)) {
          err('watch_outside_dir', `watch 项解析后落在 dir 之外：${rel} → ${target}`);
        }
      }
    }

    // 3) 反馈文件：可以还不存在，但它的祖先必须在 project_root 内
    if (!isBlank(doc.feedback)) {
      const feedbackAbs = resolve(surfaceDir, doc.feedback);
      checked.feedback = feedbackAbs;
      if (rootReal !== null) {
        const ancestorReal = realAncestor(dirname(feedbackAbs));
        if (ancestorReal === null || !inTree(ancestorReal, rootReal)) {
          err('feedback_outside_project', `feedback 的位置落在 project_root 之外：${feedbackAbs}`);
        }
      }
    }

    // 3b) 草稿文件：同一条约束。它和 feedback 是两个文件、两件事（决定 vs 未提交的草稿），
    // 但落点规则一模一样 —— 都在 project_root 内，宿主才允许写。
    if (!isBlank(doc.draft)) {
      const draftAbs = resolve(surfaceDir, doc.draft);
      checked.draft = draftAbs;
      if (rootReal !== null) {
        const ancestorReal = realAncestor(dirname(draftAbs));
        if (ancestorReal === null || !inTree(ancestorReal, rootReal)) {
          err('draft_outside_project', `draft 的位置落在 project_root 之外：${draftAbs}`);
        }
      }
      if (!isBlank(doc.feedback) && resolve(surfaceDir, doc.feedback) === draftAbs) {
        err('draft_same_as_feedback', 'draft 和 feedback 是同一个文件：草稿会顶掉决定，模型会把没提交的东西当收件');
      }
    }
  }
}

const valid = errors.length === 0;
if (text) {
  for (const w of warnings) console.log(`WARN  [${w.code}] ${w.message}`);
  for (const e of errors) console.log(`ERROR [${e.code}] ${e.message}`);
  console.log(valid ? `\n合规：${warnings.length} 个警告` : `\n不合规：${errors.length} 个错误、${warnings.length} 个警告`);
} else {
  console.log(JSON.stringify({ contract: VERSION, valid, errors, warnings, checked }, null, 2));
}
process.exit(valid ? 0 : 1);
