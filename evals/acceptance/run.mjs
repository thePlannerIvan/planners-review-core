#!/usr/bin/env node
/**
 * 文字工作台验收套件（SPEC 第 12 节四条判据 + 票 10 的记录要求）。
 *
 * 用法：
 *   node evals/acceptance/run.mjs                  # 跑全部，写 REPORT.md 与 records/<时间>.json
 *   node evals/acceptance/run.mjs --only roundtrip # 只跑一条判据
 *   node evals/acceptance/run.mjs --no-write       # 只打印，不写记录（调试用）
 *
 * 退出码：全部通过 0；有未通过 1；某条判据无法验证但其余通过 0（报告里单列）。
 * 这是独立命令，不并进 `node --test evals/test_*.mjs` 的 147 条回归：
 * 浏览器验收更慢、依赖本机 Chromium，不该拖住每次回归。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { ACCEPTANCE, ROOT, gitInfo, loadCorpus, sha256 } from './lib/harness.mjs';
import { runRoundtrip } from './lib/criterion-roundtrip.mjs';
import { runTyping } from './lib/criterion-typing.mjs';
import { runConflict } from './lib/criterion-conflict.mjs';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
};
const only = flag('--only', null)?.split(',').map((item) => item.trim()).filter(Boolean) ?? null;
const write = !args.includes('--no-write');
const reportPath = resolve(flag('--report', join(ACCEPTANCE, 'REPORT.md')));
const recordsDir = resolve(flag('--records', join(ACCEPTANCE, 'records')));

const FALLBACKS = [
  [/^typing\/newline$/, { ticket: 3, title: '02 打开文档、就地编辑、只改一块', why: '块内换行落盘属于就地编辑内核：换行后仍是同一块，且不能被块结构比较误判。' }],
  [/^typing\/enter-split$/, { ticket: 3, title: '02 打开文档、就地编辑、只改一块', why: '回车分块（新块新锚点）属于就地编辑内核。' }],
  [/^typing\/backspace-merge$/, { ticket: 3, title: '02 打开文档、就地编辑、只改一块', why: '删空合并与锚点归属属于就地编辑内核。' }],
  [/^typing\//, { ticket: 3, title: '02 打开文档、就地编辑、只改一块', why: '块内输入/选区/撤销属于就地编辑内核。' }],
  [/^roundtrip\/.*\/readback$/, { ticket: 2, title: '01 文档契约与校验器', why: '读回与锚点属于文档契约；若只是块保存问题则回退 #3。' }],
  [/^roundtrip\//, { ticket: 3, title: '02 打开文档、就地编辑、只改一块', why: '往返与改一块属于打开、编辑、只改一块这条链路。' }],
  [/^conflict\//, { ticket: 5, title: '04 待核对与并发', why: '锁、待核对与并发合并由这张票实现。' }],
  [/^corpus\//, { ticket: 11, title: '10 实测与验收（本票）', why: '语料完整性与十个真实文档的清单由本票维护。' }],
  [/^record\//, { ticket: 11, title: '10 实测与验收（本票）', why: '验收记录本身由本票维护。' }],
];
const fallbackFor = (id) => FALLBACKS.find(([pattern]) => pattern.test(id))?.[1]
  ?? { ticket: 11, title: '10 实测与验收（本票）', why: '未归类的验收失败，先由本票定位。' };

const STATUS_LABEL = { pass: '通过', fail: '未通过', blocked: '无法验证' };

/** 记录会提交进仓库：把本机绝对路径收成占位，证据里的数字与结论不受影响。 */
function sanitize(value) {
  if (typeof value === 'string') {
    return value
      .replaceAll(ROOT, '<repo>')
      .replaceAll(homedir(), '~')
      .replace(/\/private\/var\/folders\/[^"'\s]+/g, '<tmp>')
      .replace(/\/var\/folders\/[^"'\s]+/g, '<tmp>');
  }
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitize(item)]));
  }
  return value;
}

const stamp = new Date().toISOString().replace(/:/g, '-').replace(/\.\d+Z$/, 'Z');
const localTime = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', dateStyle: 'full', timeStyle: 'medium', hour12: false,
}).format(new Date());

function summarize(criterion) {
  const cases = criterion.cases ?? [];
  const failed = cases.filter((item) => !item.ok && !item.blocked);
  const blocked = cases.filter((item) => item.blocked);
  const passed = cases.filter((item) => item.ok);
  const status = failed.length ? 'fail' : (blocked.length ? 'blocked' : 'pass');
  return { status, total: cases.length, passed: passed.length, failed: failed.length, blocked: blocked.length, failed_cases: failed, blocked_cases: blocked };
}

function mdTable(headers, rows) {
  const cell = (value) => String(value).replace(/\|/g, '\\|');
  return [
    `| ${headers.map(cell).join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.map(cell).join(' | ')} |`),
  ].join('\n');
}

function renderReport(record) {
  const c1 = record.criteria.roundtrip;
  const c2 = record.criteria.typing;
  const c3 = record.criteria.conflict;
  const s1 = summarize(c1);
  const s2 = summarize(c2);
  const s3 = summarize(c3);
  const s4 = record.criteria.record ? summarize(record.criteria.record) : { status: 'pass', passed: 0, total: 0 };
  const corpusRows = record.corpus.documents.map((doc, index) => {
    const detail = c1.documents.find((item) => item.id === doc.id) ?? {};
    return [
      String(index + 1),
      `\`${doc.file}\``,
      `\`${doc.source.scope === 'repo' ? doc.source.path : doc.source.path}\``,
      `\`${doc.source.sha256.slice(0, 12)}\``,
      doc.handling === 'verbatim' ? '原样（仓库样例）' : '结构适配',
      String(doc.output.blocks),
      String(doc.output.tables),
      String(doc.output.images),
      String(doc.output.quotes),
      String(doc.output.code),
      detail.adoption_repairs === null || detail.adoption_repairs === undefined ? '—' : String(detail.adoption_repairs),
      detail.noop_equal ? '一致' : '不一致',
      detail.edited?.only_target_changed ? '只一块' : '未通过',
    ];
  });
  const failureRows = record.failures.map((item) => [
    `\`${item.id}\``,
    item.name,
    item.summary,
    `#${item.fallback.ticket} ${item.fallback.title}`,
  ]);
  const blockedRows = record.unverified.length
    ? record.unverified.map((item) => [`\`${item.id}\``, item.name, item.reason])
    : [['—', '没有无法验证的判据', '—']];
  const roundtripFailures = c1.documents.filter((doc) => doc.noop_equal === false
    || (doc.edited && doc.edited.only_target_changed === false));
  const typing = c2.details ?? {};
  const typingPhases = typing.phases ?? {};
  const newline = typingPhases.newline ?? {};
  const selection = typingPhases.selection ?? {};
  const caseOf = (id) => c2.cases.find((item) => item.id === id) ?? null;
  const newlineCase = caseOf('typing/newline');
  const splitCase = caseOf('typing/enter-split');
  const mergeCase = caseOf('typing/backspace-merge');
  const count = (value) => (value === null || value === undefined ? '—' : String(value));
  /** 块内换行的结论段：通过时写清三种键的实际结果，失败时保留原来的回退说明。 */
  const newlineSection = !newlineCase
    ? ''
    : (newlineCase.ok
      ? `### 块内换行、回车分块与删空合并

| 动作 | 键 | 结论 | 证据 |
|---|---|---|---|
| 块内换行 | Shift+Enter | 通过 | HTTP ${count(newline.response_status)}，磁盘块 raw = \`${JSON.stringify(newline.disk_raw ?? null)}\`，仍是同一块两行 |
| 回车分块 | Enter | ${splitCase?.ok ? '通过' : '见未通过项'} | 新锚点 \`${count(splitCase?.evidence?.new_anchor)}\`，新块 raw「${count(splitCase?.evidence?.new_block_raw)}」，块数 ${count(splitCase?.evidence?.block_count?.before)} → ${count(splitCase?.evidence?.block_count?.after)}，原块 raw 逐字不动 |
| 删空合并 | 空块开头 Backspace | ${mergeCase?.ok ? '通过' : '见未通过项'} | 被删锚点 \`${count(mergeCase?.evidence?.removed_anchor)}\`，前一块 \`${count(mergeCase?.evidence?.kept_anchor)}\` 的 raw 逐字不动，块数 ${count(mergeCase?.evidence?.block_count?.before)} → ${count(mergeCase?.evidence?.block_count?.after)} |

回车分块与删空合并会改变块数量，所以走显式命令（\`POST /api/block/split\` / \`POST /api/block/merge\`），
不混进「保存一块」。空块在契约里没有锚点可落（锚点必须贴内容），所以回车时为空的那一半先在页面里待定，
第一次输入才带着内容调一次 split；空块永远不落盘。`
      : `### 未通过：块内换行

按 \`${newline.key ?? 'Enter'}\` 后继续输入「${newline.dom_after?.includes('换行之后') ? '换行之后' : '—'}」，页面保留了文字，但自动保存收到 **HTTP ${newline.response_status ?? '—'}**：

\`\`\`json
${JSON.stringify(newline.receipt ?? {}, null, 2)}
\`\`\`

- 请求里的块内容是：\`${JSON.stringify(newline.request_payload?.content ?? null)}\`
- 磁盘没有被改写：${newline.disk_raw && newline.inserted && !String(newline.disk_raw).includes(newline.inserted) ? '是（新文本没有保存）' : '否'}
- 页面状态：${newline.status_text ? `「${newline.status_text}」` : '—'}

这不是输入丢字，而是「块内换行」这一编辑保存不下来。按边界不修实现，回退到 #3。`);

  return `# 文字工作台 · 验收记录（票 10「实测与验收」）

> 生成方式：\`node evals/acceptance/run.mjs\`。下列时间、sha256、条数、块数均为本次运行的实际输出；重跑会覆盖本文件，并在 \`records/\` 下留一份同次运行的 JSON。
> 语料不是手搓样例：8 份来自 \`01-projects\` 与 \`07-SkillLab\` 的真实项目 Markdown，2 份是仓库内的契约样例（覆盖图片语法）。真实文档按 \`planners-doc/1\` 做结构适配，原文文字逐行保留、只改结构；来源、源文件 sha256 与适配计数见下表与 \`corpus/manifest.json\`。
${record.partial ? `> 本次只跑了 ${record.partial.join('、')}，其余判据的结论不完整。` : ''}

## 结论

| 判据（SPEC 第 12 节） | 结论 | 证据 |
|---|---|---|
| 往返一次不改动未编辑的块 | ${STATUS_LABEL[s1.status]} | ${c1.documents.length} 份语料，${s1.passed}/${s1.total} 条断言通过；每份都做了「打开→不编辑→关闭」字节对比与「改一块」字节区间对比 |
| 块内中文输入、撤销重做、跨块选区 | ${STATUS_LABEL[s2.status]} | ${s2.passed}/${s2.total} 条通过；IME 组合 ${typingPhases.typing?.composition_events ?? '—'} 次，输入文本「${typingPhases.typing?.typed ?? '—'}」；未通过项：${s2.failed_cases.map((item) => `\`${item.id}\``).join('、') || '无'} |
| 同块双改只锁该块 | ${STATUS_LABEL[s3.status]} | ${c3.passes?.length ?? 0} 遍演练，${s3.passed}/${s3.total} 条通过；每遍都记录派发、claim、被拒回执、patch 待核对、裁决与磁盘结果 |
| 记录落在仓库内可复用 | ${STATUS_LABEL[s4.status]} | 本文件 + \`${record.record_path}\` + 可执行入口 \`evals/acceptance/run.mjs\` 与语料 \`evals/acceptance/corpus/\` |

## 运行环境

- 时间：${record.generated_at_local}（${record.generated_at}）
- 分支 / commit：\`${record.git.branch}\` / \`${record.git.head}\`${record.git.dirty ? '（工作区有未提交改动）' : ''}
- Node：${record.environment.node}
- 浏览器：${record.environment.browser ?? '—'}
- 平台：${record.environment.platform}

## 与 SPEC 第 12 节的对应关系

| SPEC 第 12 节 | 本记录 |
|---|---|
| 模型改 A 块期间，B 块可正常编辑并保存，不出现整份锁定 | 判据三：A 被 claim 锁住与 A 待核对期间，B 的保存回执都是 200（两遍演练） |
| 同一块双方改过，只有该块待核对，其余块不丢失 | 判据三：patch 只把 A 放进 deferred，磁盘保留人的 A1；裁决后 A 落模型版，其余块逐字不动 |
| 往返一次不改动未编辑的块：锚点、表格、front matter、图片语法原样保留 | 判据一：十份语料的往返字节对比 + 改一块的字节区间与块片段对比 |
| 关掉工作台后模型直接改文件，再打开能按正文重建，不产生幽灵块 | **未纳入本票工作项**（票 10 列的四项是往返、中文输入、同块双改、记录）。本记录不把它写成已验；若要补，应另开用例并回退 #3（打开与块身份）。 |

## 语料（10 份）

${mdTable(['#', '语料文件', '来源', '来源 sha256', '处理', '块', '表', '图', '引用', '代码', '首开补锚点', '往返字节', '改一块'], corpusRows)}

## 判据一：往返零字节差异

做法：每份语料先打开一次（契约要求首次打开补锚点）作为基线，再「打开→不编辑→关闭」并逐字节比较；随后在块尾追加一句、只保存这一块，比较改前/改后的块片段与字节差异区间。

- 通过 ${s1.passed}/${s1.total} 条断言。
- 十份语料的往返字节全部一致：${c1.documents.filter((doc) => doc.noop_equal).length}/${c1.documents.length}。
- 「改一块」全部只动目标块：${c1.documents.filter((doc) => doc.edited?.only_target_changed).length}/${c1.documents.length}；差异区间全部落在目标块内：${c1.documents.filter((doc) => doc.edited?.diff_inside_target).length}/${c1.documents.length}。
- 表格/图片/引用/代码块都在语料里（合计 ${record.corpus.totals.tables} 表、${record.corpus.totals.images} 图、${record.corpus.totals.quotes} 引用、${record.corpus.totals.code} 代码块），未编辑时逐字保留。
${roundtripFailures.length ? `\n未通过的语料：${roundtripFailures.map((doc) => `\`${doc.file}\`（${doc.edited ? '改一块' : '往返字节'}）`).join('、')}。\n` : ''}

## 判据二：中文输入、撤销重做、跨块选区

浏览器：Playwright 驱动 Chromium，块内输入走真实 DOM 与 CDP 输入事件。测试语料：\`${typing.target?.doc ?? '—'}\`，块 \`${typing.target?.anchor ?? '—'}\`。

- 输入方法：${typingPhases.typing?.method ?? '—'}；组合事件 ${typingPhases.typing?.composition_events ?? '—'} 次，随后输入中文标点「${typingPhases.typing?.typed ?? '—'}」。
- 输入后 DOM 与磁盘都等于「原文 + 输入」：${s2.passed > 0 && c2.cases.find((item) => item.id === 'typing/no-loss')?.ok ? '是' : '否'}。
- 撤销：磁盘回到输入前文本（${typingPhases.undo?.after_undo === `${typing.target?.original_raw ?? ''}${typingPhases.typing?.typed ?? ''}` ? '通过' : '见记录'}）；重做：磁盘恢复被撤销的输入（${c2.cases.find((item) => item.id === 'typing/redo')?.ok ? '通过' : '未通过'}）。
- 跨块选区：选中 ${selection.anchors?.length ?? '—'} 块，页面吸附 ${selection.highlighted?.length ?? '—'} 块（${JSON.stringify(selection.highlighted ?? [])}），派发回执绑定 ${selection.feedback_receipt?.task?.blocks?.length ?? '—'} 块，原文 sha 不变：${selection.doc_sha_unchanged ? '是' : '否'}。

${newlineSection}

## 判据三：同块双改只锁该块（复跑两遍）

每遍演练：人对 A 派发反馈 → 人先改 A 落盘 → 模型 claim（锁 A）→ A 被锁时改 A 被拒、同时改 B 成功 → 模型 patch 过期基线，只有 A 进待核对 → 待核对期间 B 仍可改 → 裁决 model。

| 遍 | A / B | claim 后锁 | 被锁改 A | 改 B（A 锁 / 待核对） | patch 待核对 | 裁决后 A | 其余块 |
|---|---|---|---|---|---|---|---|
${(c3.passes ?? []).map((pass) => [
    String(pass.pass),
    `\`${pass.anchor_a}\` / \`${pass.anchor_b}\``,
    `A=${pass.disk.lock_state.a_locked} B=${pass.disk.lock_state.b_locked}`,
    `${pass.receipts.blocked_edit_a.status} ${pass.receipts.blocked_edit_a.code}`,
    `${pass.receipts.edit_b_while_a_locked.status} / ${pass.receipts.edit_b_while_a_deferred.status}`,
    `applied=${JSON.stringify(pass.receipts.patch.applied)} deferred=${(pass.receipts.patch.deferred_blocks ?? []).map((item) => `${item.anchor}:${item.reason}`).join(',') || '无'}`,
    pass.receipts.decide.written ? '模型版' : '人的版本',
    `改了 ${(pass.disk.final.changed_anchors ?? []).length} 块，${pass.disk.final.untouched_blocks}/${pass.disk.final.total_blocks} 块逐字不动`,
  ].join(' | ')).map((row) => `| ${row} |`).join('\n')}

- 两遍结构性结论一致：${c3.cases.find((item) => item.id === 'conflict/repeatable')?.ok ? '是' : '否'}。
- 待核对面板里的两版：磁盘版保留了人的 A1，模型版保留 Am；裁决 model 后磁盘落 Am，B 保留人改的两版叠加。完整回执见同次 JSON。

## 未通过项与回退

${failureRows.length ? mdTable(['用例', '断言', '现象', '回退'], failureRows) : '没有未通过项。'}

## 无法验证

${mdTable(['用例', '断言', '原因'], blockedRows)}

## 复跑

\`\`\`bash
node evals/acceptance/run.mjs
node evals/acceptance/run.mjs --only roundtrip
node evals/acceptance/corpus/build-corpus.mjs --check   # 校验语料仍与来源清单一致
\`\`\`

- 语料来源与源文件 sha256：\`evals/acceptance/corpus/manifest.json\`
- 本次机器可读记录：\`${record.record_path}\`
- 回退票：见上表；未修实现，只记录事实。
`;
}

// ── 跑 ──────────────────────────────────────────────────────────────────────
const started = new Date();
const corpus = loadCorpus();
const git = gitInfo();
const record = {
  contract: 'acceptance-record/1',
  ticket: '10 实测与验收',
  spec: '07-SkillLab/workbench-redesign/SPEC.md 第 12 节',
  generated_at: started.toISOString(),
  generated_at_local: localTime,
  git,
  environment: {
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    browser: null,
  },
  corpus: {
    documents: corpus.documents,
    totals: {
      documents: corpus.documents.length,
      tables: corpus.documents.reduce((sum, doc) => sum + doc.output.tables, 0),
      images: corpus.documents.reduce((sum, doc) => sum + doc.output.images, 0),
      quotes: corpus.documents.reduce((sum, doc) => sum + doc.output.quotes, 0),
      code: corpus.documents.reduce((sum, doc) => sum + doc.output.code, 0),
      blocks: corpus.documents.reduce((sum, doc) => sum + doc.output.blocks, 0),
    },
  },
  partial: only ?? null,
  criteria: {},
  failures: [],
  unverified: [],
};

const corpusCases = [];
{
  const integrity = [];
  for (const doc of corpus.documents) {
    const path = join(ACCEPTANCE, 'corpus', doc.file);
    const actual = existsSync(path) ? sha256(readFileSync(path)) : null;
    if (actual !== doc.output.sha256) integrity.push({ file: doc.file, expected: doc.output.sha256, actual });
  }
  corpusCases.push({
    id: 'corpus/integrity',
    ok: integrity.length === 0,
    name: '语料文件与 manifest 的 sha256 一致',
    evidence: { mismatches: integrity },
  });
  const projectDocs = corpus.documents.filter((doc) => doc.source.scope === 'project');
  const repoDocs = corpus.documents.filter((doc) => doc.source.scope === 'repo');
  corpusCases.push({
    id: 'corpus/ten-real-docs',
    ok: corpus.documents.length === 10 && projectDocs.length + repoDocs.length === 10
      && projectDocs.length >= 8
      && corpus.documents.every((doc) => doc.handling === 'verbatim' || doc.handling === 'structural-adaptation'),
    name: '十份语料：至少 8 份真实项目文档 + 仓库样例补齐，不含生成假文',
    evidence: {
      total: corpus.documents.length,
      project: projectDocs.length,
      repo: repoDocs.length,
      sources: corpus.documents.map((doc) => ({ file: doc.file, source: doc.source.path, scope: doc.source.scope })),
    },
  });
}

const selected = (name) => !only || only.includes(name);
console.log(`验收：${corpus.documents.length} 份语料，${git.branch}@${git.head?.slice(0, 8)}，${localTime}`);
console.log(`\n语料完整性`);
for (const item of corpusCases) console.log(`  ${item.ok ? '✓' : '✗'} ${item.name}`);

const roundtrip = selected('roundtrip') ? await runRoundtrip(corpus) : { id: 'roundtrip', title: '往返零字节差异', cases: [], documents: [] };
const typing = selected('typing') ? await runTyping(corpus) : { id: 'typing', title: '中文输入、跨块选区、撤销重做', cases: [], details: {} };
const conflict = selected('conflict') ? await runConflict(corpus) : { id: 'conflict', title: '同块双改只锁该块', cases: [], passes: [] };

record.criteria.roundtrip = roundtrip;
record.criteria.typing = typing;
record.criteria.conflict = conflict;
record.corpus.cases = corpusCases;
record.environment.browser = typing.environment
  ? `Playwright（${typing.environment.playwright === 'global' ? '全局安装' : '本仓'}）/ Chromium ${typing.environment.chromium_version ?? '—'}`
  : (typing.blocked ? `不可用：${typing.blocked_reason}` : null);

for (const [name, criterion] of [['roundtrip', roundtrip], ['typing', typing], ['conflict', conflict]]) {
  console.log(`\n${criterion.title}`);
  for (const item of criterion.cases ?? []) {
    if (item.blocked) console.log(`  ! ${item.name} —— ${item.evidence?.reason ?? '无法验证'}`);
    else console.log(`  ${item.ok ? '✓' : '✗'} ${item.name}`);
  }
  if (criterion.blocked) record.unverified.push({ criterion: name, id: 'typing/blocked', name: '中文输入无法验证', reason: criterion.blocked_reason });
}
// 语料断言也计入结果（判据一的前置）。
record.criteria.roundtrip.cases = [...corpusCases, ...(roundtrip.cases ?? [])];

for (const [name, criterion] of Object.entries(record.criteria)) {
  for (const item of criterion.cases ?? []) {
    if (item.ok || item.blocked) continue;
    const fallback = fallbackFor(item.id);
    record.failures.push({
      criterion: name,
      id: item.id,
      name: item.name,
      summary: item.id === 'typing/newline'
        ? `Enter 后自动保存返回 HTTP ${item.evidence?.response_status ?? '—'}（${item.evidence?.receipt?.code ?? '—'}），换行后的文字没有落盘`
        : JSON.stringify(item.evidence ?? {}).slice(0, 300),
      fallback,
    });
  }
}

const statuses = Object.fromEntries(Object.entries(record.criteria).map(([name, criterion]) => [name, summarize(criterion).status]));
record.summary = {
  statuses,
  overall: record.failures.length ? 'fail' : (record.unverified.length ? 'blocked' : 'pass'),
  counts: Object.fromEntries(Object.entries(record.criteria).map(([name, criterion]) => [name, summarize(criterion)])),
};

// 判据四：记录本身。先在内存里核对模板包含时间、语料、结论与回退入口，再写盘。
const recordPath = join(recordsDir, `${stamp}.json`);
record.record_path = write ? `evals/acceptance/records/${stamp}.json` : '（本次 --no-write，未写盘）';
const report = renderReport(record);
const recordChecks = [
  ['record/report-sections', ['判据一', '判据二', '判据三', '未通过项与回退', '语料（10 份）'].every((marker) => report.includes(marker)), '报告含四条判据、语料与回退段'],
  ['record/run-time', report.includes(record.generated_at_local), '报告含本次运行时间'],
  ['record/corpus-10', corpus.documents.length === 10 && report.includes('01-needscope.md') && report.includes('10-by-page-example.md'), '报告列出十份语料'],
];
const recordCases = recordChecks.map(([id, ok, name]) => ({ id, ok, name, evidence: { report_path: reportPath, record_path: recordPath } }));
record.criteria.record = { id: 'record', title: '验收记录落进仓库', cases: recordCases };
record.summary.statuses.record = summarize(record.criteria.record).status;
for (const item of recordCases) {
  console.log(`\n验收记录\n  ${item.ok ? '✓' : '✗'} ${item.name}`);
  if (!item.ok) {
    const fallback = fallbackFor(item.id);
    record.failures.push({ criterion: 'record', id: item.id, name: item.name, summary: '报告模板缺少必需段落', fallback });
  }
}
record.summary.overall = record.failures.length ? 'fail' : (record.unverified.length ? 'blocked' : 'pass');

if (write) {
  mkdirSync(recordsDir, { recursive: true });
  const safe = sanitize(record);
  writeFileSync(recordPath, JSON.stringify(safe, null, 2) + '\n', 'utf8');
  // 回写最终状态后再生成一次报告（判据四的结果要出现在报告里）。
  writeFileSync(reportPath, renderReport(safe), 'utf8');
}

console.log(`\n总体：${STATUS_LABEL[record.summary.overall]}（${record.failures.length} 项未通过，${record.unverified.length} 项无法验证）`);
if (write) console.log(`记录：${reportPath}\n      ${recordPath}`);
process.exit(record.summary.overall === 'fail' ? 1 : 0);
