# 文字工作台 · 验收记录（票 10「实测与验收」）

> 生成方式：`node evals/acceptance/run.mjs`。下列时间、sha256、条数、块数均为本次运行的实际输出；重跑会覆盖本文件，并在 `records/` 下留一份同次运行的 JSON。
> 语料不是手搓样例：8 份来自 `01-projects` 与 `07-SkillLab` 的真实项目 Markdown，2 份是仓库内的契约样例（覆盖图片语法）。真实文档按 `planners-doc/2` 做结构适配，原文文字逐行保留、只改结构；来源、源文件 sha256 与适配计数见下表与 `corpus/manifest.json`。


## 结论

| 判据（SPEC 第 12 节） | 结论 | 证据 |
|---|---|---|
| 往返一次不改动未编辑的块 | 通过 | 10 份语料，42/42 条断言通过；每份都做了「打开→不编辑→关闭」字节对比与「改一块」字节区间对比 |
| 块内中文输入、撤销重做、跨块选区 | 通过 | 10/10 条通过；IME 组合 3 次，输入文本「中文输入实测，标点：。！？「引号」；」；未通过项：无 |
| 同块双改只锁该块 | 通过 | 2 遍演练，13/13 条通过；每遍都记录派发、claim、被拒回执、patch 待核对、裁决与磁盘结果 |
| 记录落在仓库内可复用 | 通过 | 本文件 + `evals/acceptance/records/2026-11-20T10-31-48Z.json` + 可执行入口 `evals/acceptance/run.mjs` 与语料 `evals/acceptance/corpus/` |

## 运行环境

- 时间：2026年11月20日星期五 18:31:48（2026-11-20T10:31:48.144Z）
- 分支 / commit：`ticket/20-contract-v2` / `58dc1f988e1d7dec7c036e058b9804c644d0d487`
- Node：v22.22.2
- 浏览器：Playwright（全局安装）/ Chromium 147.0.7727.15
- 平台：darwin arm64

## 与 SPEC 第 12 节的对应关系

| SPEC 第 12 节 | 本记录 |
|---|---|
| 模型改 A 块期间，B 块可正常编辑并保存，不出现整份锁定 | 判据三：A 被 claim 锁住与 A 待核对期间，B 的保存回执都是 200（两遍演练） |
| 同一块双方改过，只有该块待核对，其余块不丢失 | 判据三：patch 只把 A 放进 deferred，磁盘保留人的 A1；裁决后 A 落模型版，其余块逐字不动 |
| 往返一次不改动未编辑的块：锚点、表格、front matter、图片语法原样保留 | 判据一：十份语料的往返字节对比 + 改一块的字节区间与块片段对比 |
| 关掉工作台后模型直接改文件，再打开能按正文重建，不产生幽灵块 | **未纳入本票工作项**（票 10 列的四项是往返、中文输入、同块双改、记录）。本记录不把它写成已验；若要补，应另开用例并回退 #3（打开与块身份）。 |

## 语料（10 份）

| # | 语料文件 | 来源 | 来源 sha256 | 处理 | 块 | 表 | 图 | 引用 | 代码 | 首开补锚点 | 往返字节 | 改一块 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `01-needscope.md` | `01-projects/美津浓项目整理版/美津浓_NeedScope_报告.md` | `1a62c35e93ce` | 结构适配 | 43 | 4 | 0 | 2 | 2 | 43 | 一致 | 只一块 |
| 2 | `02-gwtb.md` | `01-projects/美津浓项目整理版/美津浓_GWTB_新Skill报告.md` | `feb6d8e154fd` | 结构适配 | 52 | 6 | 0 | 3 | 6 | 52 | 一致 | 只一块 |
| 3 | `03-annual-cycle.md` | `01-projects/美津浓项目整理版/04_分析结论与洞察报告/reports/美津浓_年度经营周期压缩版_2026-03-26.md` | `3aa50c28a51a` | 结构适配 | 25 | 1 | 0 | 0 | 0 | 25 | 一致 | 只一块 |
| 4 | `04-model-scene-notes.md` | `01-projects/美津浓项目整理版/04_分析结论与洞察报告/reports/美津浓_型号场景种草与人群洞察_2026-03-16.md` | `d9f53b64e13f` | 结构适配 | 134 | 0 | 0 | 6 | 0 | 134 | 一致 | 只一块 |
| 5 | `05-delivery-notes.md` | `07-SkillLab/AI能力体系与职场定位/成品/交付说明.md` | `d4b4c68a38c6` | 结构适配 | 9 | 1 | 0 | 0 | 0 | 9 | 一致 | 只一块 |
| 6 | `06-planners-form-compatibility.md` | `01-projects/planners-form/COMPATIBILITY.md` | `34178579900c` | 结构适配 | 26 | 3 | 0 | 0 | 0 | 26 | 一致 | 只一块 |
| 7 | `07-plugins-upstream-readme.md` | `01-projects/dsh-plugins-upstream/README.md` | `7fbe1c2ebe59` | 结构适配 | 26 | 1 | 0 | 1 | 1 | 26 | 一致 | 只一块 |
| 8 | `08-workbench-engineering.md` | `07-SkillLab/workbench-redesign/ENGINEERING.md` | `3d3ba0f9e34e` | 结构适配 | 34 | 0 | 0 | 0 | 0 | 34 | 一致 | 只一块 |
| 9 | `09-storyline-example.md` | `contracts/examples/storyline.md` | `3f32bf591ebe` | 原样（仓库样例） | 40 | 0 | 1 | 13 | 0 | 0 | 一致 | 只一块 |
| 10 | `10-by-page-example.md` | `contracts/examples/by-page.md` | `2c589e942139` | 原样（仓库样例） | 48 | 2 | 1 | 8 | 1 | 0 | 一致 | 只一块 |

## 判据一：往返零字节差异

做法：每份语料先打开一次（契约要求首次打开补锚点）作为基线，再「打开→不编辑→关闭」并逐字节比较；随后在块尾追加一句、只保存这一块，比较改前/改后的块片段与字节差异区间。

- 通过 42/42 条断言。
- 十份语料的往返字节全部一致：10/10。
- 「改一块」全部只动目标块：10/10；差异区间全部落在目标块内：10/10。
- 表格/图片/引用/代码块都在语料里（合计 18 表、2 图、33 引用、10 代码块），未编辑时逐字保留。


## 判据二：中文输入、撤销重做、跨块选区

浏览器：Playwright 驱动 Chromium，块内输入走真实 DOM 与 CDP 输入事件。测试语料：`02-gwtb`，块 `b:1ebbec`。

- 输入方法：CDP Input.imeSetComposition + Input.insertText + keyboard.insertText；组合事件 3 次，随后输入中文标点「中文输入实测，标点：。！？「引号」；」。
- 输入后 DOM 与磁盘都等于「原文 + 输入」：是。
- 撤销：磁盘回到输入前文本（通过）；重做：磁盘恢复被撤销的输入（通过）。
- 跨块选区：选中 3 块，页面吸附 3 块（["b:1ebbec","b:e55fbf","b:3732b5"]），派发回执绑定 3 块，原文 sha 不变：是。

### 块内换行、回车分块与删空合并

| 动作 | 键 | 结论 | 证据 |
|---|---|---|---|
| 块内换行 | Shift+Enter | 通过 | HTTP 200，磁盘块 raw = `"证据：标题端内容母题高度分散，没有单一受众画像。评论端\"通勤\"\"暴走\"\"上班\"高频出现，说明实际购买者偏向实用场景。中文输入实测，标点：。！？「引号」；撤销重做\n换行之后"`，仍是同一块两行 |
| 回车分块 | Enter | 通过 | 新锚点 `b:82ac1c`，新块 raw「分块之后」，块数 52 → 53，原块 raw 逐字不动 |
| 删空合并 | 空块开头 Backspace | 通过 | 被删锚点 `b:82ac1c`，前一块 `b:1ebbec` 的 raw 逐字不动，块数 53 → 52 |

回车分块与删空合并会改变块数量，所以走显式命令（`POST /api/block/split` / `POST /api/block/merge`），
不混进「保存一块」。空块在契约里没有锚点可落（锚点必须贴内容），所以回车时为空的那一半先在页面里待定，
第一次输入才带着内容调一次 split；空块永远不落盘。

## 判据三：同块双改只锁该块（复跑两遍）

每遍演练：人对 A 派发反馈 → 人先改 A 落盘 → 模型 claim（锁 A）→ A 被锁时改 A 被拒、同时改 B 成功 → 模型 patch 过期基线，只有 A 进待核对 → 待核对期间 B 仍可改 → 裁决 model。

| 遍 | A / B | claim 后锁 | 被锁改 A | 改 B（A 锁 / 待核对） | patch 待核对 | 裁决后 A | 其余块 |
|---|---|---|---|---|---|---|---|
| 1 | `b:d66c0d` / `b:d17ded` | A=true B=false | 409 block_locked | 200 / 200 | applied=[] deferred=b:d66c0d:block_changed | 模型版 | 改了 2 块，7/9 块逐字不动 |
| 2 | `b:caa4db` / `b:35c90a` | A=true B=false | 409 block_locked | 200 / 200 | applied=[] deferred=b:caa4db:block_changed | 模型版 | 改了 2 块，7/9 块逐字不动 |

- 两遍结构性结论一致：是。
- 待核对面板里的两版：磁盘版保留了人的 A1，模型版保留 Am；裁决 model 后磁盘落 Am，B 保留人改的两版叠加。完整回执见同次 JSON。

## 未通过项与回退

没有未通过项。

## 无法验证

| 用例 | 断言 | 原因 |
| --- | --- | --- |
| — | 没有无法验证的判据 | — |

## 复跑

```bash
node evals/acceptance/run.mjs
node evals/acceptance/run.mjs --only roundtrip
node evals/acceptance/corpus/build-corpus.mjs --check   # 校验语料仍与来源清单一致
```

- 语料来源与源文件 sha256：`evals/acceptance/corpus/manifest.json`
- 本次机器可读记录：`evals/acceptance/records/2026-11-20T10-31-48Z.json`
- 回退票：见上表；未修实现，只记录事实。
