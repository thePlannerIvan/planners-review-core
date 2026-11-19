# 验收套件（文字工作台）

SPEC 第 12 节的实测：十份真实语料的往返、块内中文输入、同块双改的锁与待核对，以及一份可复跑的记录。

```bash
node evals/acceptance/run.mjs                  # 跑全部，写 REPORT.md 与 records/<时间>.json
node evals/acceptance/run.mjs --only roundtrip # 只跑一条判据（roundtrip / typing / conflict）
node evals/acceptance/corpus/build-corpus.mjs --check  # 语料是否仍与来源清单一致
```

退出码：全部通过 0，有未通过 1。中文输入一项需要本机有 Playwright 的 Chromium；找不到浏览器时该项记「无法验证」，不伪造通过，其余判据照跑。

## 目录

```text
evals/acceptance/
├── run.mjs                     # 唯一入口：跑判据、生成 REPORT.md 与 JSON 记录
├── lib/                        # 判据实现与公共工具（沙箱、工作台进程、块级字节对比）
├── corpus/                     # 十份语料 + 来源清单 sources.json + manifest.json
│   └── build-corpus.mjs        # 从真实项目 Markdown 生成 planners-doc/1（结构适配，正文不动）
├── records/                    # 每次运行的机器可读记录
└── REPORT.md                   # 最近一次运行的人可读记录（生成物）
```

## 语料

- 8 份来自 `01-projects` 与 `07-SkillLab` 的真实项目 Markdown：美津浓 NeedScope、GWTB、年度经营周期、型号场景洞察、AI 像素工厂交付说明、planners-form 兼容性、DSH 插件上游 README、文字工作台工程拆解。
- 2 份仓库内的契约样例（`contracts/examples/storyline.md`、`by-page.md`），覆盖图片语法与已有锚点。
- 真实文档不是 `planners-doc/1` 格式。`build-corpus.mjs` 只做结构适配：补文档头、把标题映射到章节/页、去掉 `---` 分隔线、把嵌套列表项去掉缩进、把行首原始 HTML 转义、给没有页的章节补「概览」页；**原文文字逐行保留、只改结构**，每处的来源路径与源文件 sha256 记在 `corpus/sources.json` / `corpus/manifest.json`。
- 语料本身不带锚点：首次打开时由工作台按契约补写。验收把「补完锚点的文件」当作往返基线，因为契约明确要求首次打开补锚点，这不是一次编辑。
- 生成的十份语料已提交，跑验收不依赖原始项目文档。`build-corpus.mjs --check` 需要原始文档在场（默认按 `CodexProject` 根解析，可用 `--source-root` 指过去）——它只用于核对语料没有手改过。

## 三条判据各验什么

**往返（roundtrip）**：每份语料先打开一次形成基线 → 再打开、不编辑、关闭，逐字节比较；然后在块尾追加一句、只保存这一块，断言只有该块的片段与字节区间变化，front matter、其余块、表格、图片语法逐字不动。

**中文输入（typing）**：Playwright 驱动真实 Chromium。用 CDP `Input.imeSetComposition` 触发中文组合，再 `Input.insertText` 提交；输入中文标点；`Shift+Enter` 测块内换行（落盘后仍是同一块）、`Enter` 测回车分块（新块拿新锚点）、空块开头 `Backspace` 测删空合并（前一块锚点保留、后一块锚点删除）；`Meta/Ctrl+Z`、`Meta/Ctrl+Shift+Z` 测撤销重做，每一步都等自动保存落盘后看磁盘。最后跨三个块做选区，断言吸附到三块整块、派发回执绑定三块、原文 sha 不变。

**同块双改（conflict）**：复跑两遍。人对 A 派发反馈 → 人先改 A → 模型 claim（锁 A）→ A 被锁时改 A 被拒、同时改 B 成功 → 模型用过期基线 patch A，只有 A 进待核对 → 待核对期间 B 仍能改 → 裁决 model。每步的回执与磁盘块内容都进 JSON 记录。

## 记录

`REPORT.md` 与 `records/<UTC 时间>.json` 都由 `run.mjs` 生成，数字来自本次运行。JSON 里有每份语料的来源 sha256、补锚点数、往返结果、改块证据，以及冲突演练的完整回执；`REPORT.md` 是人读版，末尾列未通过项、回退票与无法验证项。

## 已修复（票 12）

- `typing/newline` 曾红过：块结构比较用 `type@page.line` 的绝对行号，块内多一行会让后续页行号整体位移，被误判成「结构变了」而返回 409。票 12 把判据改成页身份（章节号 + 页序号 + 块类型序列），并把 Enter 改为回车分块、Shift+Enter 保留块内换行、空块 Backspace 合并；本目录记录由 `node evals/acceptance/run.mjs` 重新生成。

## 加一份语料

1. 在 `corpus/sources.json` 里加一条：输出文件名、相对 `CodexProject` 根的来源路径、项目名、`doc` 类型。
2. 跑 `node evals/acceptance/corpus/build-corpus.mjs`，确认 `node scripts/validate-doc.mjs evals/acceptance/corpus/<新文件> --text` 合规。
3. 跑一遍 `node evals/acceptance/run.mjs`，把新的 `REPORT.md` 与记录一起提交。

不要手改 `corpus/*.md`：`build-corpus.mjs --check` 会发现语料与来源清单不一致。
