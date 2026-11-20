# Planners Review Core

[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-2563eb)](LICENSE)
[![Contract](https://img.shields.io/badge/contract-review--surface%2F2.0.0-0f766e)](contracts/review-surface.schema.json)
[![Node](https://img.shields.io/badge/node-%3E%3D20-339933)](https://nodejs.org)

**一套让 AI 交付“先经过人类网页点选/修改/确认、再继续往下跑”的公共底座——在 DSH 侧栏和普通浏览器里都能无缝使用，还支持对任意现成 HTML 一条命令加上直接批注功能。**

> 作者：阿祖不看 TVC（小红书同名）· [demyth.info](https://demyth.info) · [Lawyif@163.com](mailto:Lawyif@163.com)

---

## 一句话看懂：对普通用户 vs 对 Skill 作者各自有什么用

### 对普通用户：两件立刻能用上的事

1. **没有装 DSH，其他 Skill 的可视化审阅页也能照常打开**：像 `planners-proposal-system` 的 Storyline 拖曳板、`planners-bypage` 的逐页审阅台、`video-idea-system` 的念稿改字面、`planners-ppt-hell` 的返修工作台、`video-craft` 的成片时间轴审阅，背后全都依靠本底座在**没有 DSH 时本地拉起浏览器宿主**，审完保存再回对话继续即可。
2. **给任意现成 HTML 网页一键加“直接改字 + 圈选批注”**（`open-artifact.mjs`）：手里有一份生成好的网页、报告或原型 HTML，一条命令就能加上批注栏——直接在网页正文改字、点选某个元素、框选一块区域并写批注，完全不用改动原 HTML 代码一字节，改完把批注 JSON 丢给 Agent 返修。

```text
有 DSH（配合 dsh-review-dock 插件） → 直接嵌进 DSH 右侧栏原生标签页，点提交自动唤醒对话
没有 DSH（纯命令行 / Codex / Claude）→ 本底座自动在 127.0.0.1 起本地网页，审完落盘后在对话里说一声继续
```

### 哪些 Skill 依赖本底座？

`Planners-Proposal-System` · `planners-bypage` · `planners-ppt-hell` · `video-idea-system` · `video-craft` · `planners-method-wiki` · `editor`（使用上述 Skill 时一般会自动拉取本底座，无需单独操心）。

*(定性/定量分析 `planners-quali-box` 与 `planners-quanti-box` 不走审阅面，直接在对话确认方案。)*

---

## 单独使用：给任意 HTML 产物开启批注模式

当你手里有一份现成 HTML 文件想边看边圈改时：

### 1. 安装

```bash
npx skills add https://github.com/thePlannerIvan/planners-review-core --skill planners-review-core
```

或克隆至本地 Skill 目录：

```bash
git clone https://github.com/thePlannerIvan/planners-review-core.git ~/.codex/skills/planners-review-core
# 或
git clone https://github.com/thePlannerIvan/planners-review-core.git ~/.claude/skills/planners-review-core
```

### 2. 一条命令生成并打开批注面

```bash
# 为已有 HTML 生成配套 review-surface.json（不改动原 HTML 文件）
node scripts/open-artifact.mjs --entry path/to/your-page.html

# 启动本地审阅宿主并在浏览器打开（无 DSH 环境）
node scripts/review-host.mjs start path/to/review-surface.json
```

你也可以直接在对话里对 Agent 说：

```text
用 planners-review-core 把这份 HTML 打开成可批注页面，我想在网页里直接点选修改意见后再让你改。
```

---

## 单独使用：打开一份工作稿

`planners-doc/2` 工作稿（`.planners/storyline.md`、`.planners/by-page.md`）可以直接用工作台打开：

```bash
node scripts/doc-workbench.mjs path/to/.planners/storyline.md --open
```

按块渲染，点进任意块就地改；加粗、斜体、行内代码、链接在块内直接排版。保存自动发生，磁盘上只替换被编辑的那一块，其余块逐字不动。缺锚点会在打开时补写，重复锚点会重建；超出七种块或行内子集的写法按原文显示，不静默改写。

**编辑器不拦人**：结构不合规也照样落盘——块拖到页外、页被清空、章节被清空都只是中间态。结构问题只在保存态旁显示一个没有文字的极小圆点，点开才列出「不在任何页里的块」与「空页」两组，每条都能点着跳过去；它不阻断任何操作。`validate-doc` 不在保存路径上跑，只在交付与 CI 显式调用。文件在别处变了就自动重读、把这次改动重放到新版本上；只有重放到同一块才停下让人核对。

要模型改哪里就选哪里：选中半句也会吸成整块，提交前高亮「将改的块」；块尾的批注气泡点一下就**直接在右侧抽屉里落一条空草稿、光标进入**，正文上不再弹任何浮层；抽屉底部只有「整篇反馈」与「提交模型」两枚按钮——整份稿子的一条意见也写在抽屉里，不再有「按页」这个范围。派发出去的任务只带块身份与 `sha256(block.raw)`，不带全文；模型处理中的块显示「模型正在改这一段」并锁定，其余块照常可写，完成后自动解锁。

批注可以攒成一批：右侧抽屉默认展开，是**一张跟正文顺序走的单子**——不按页分组，没有页名 / 章节名 / 页号，每条只有它**引用的那句话**（截成一行、放不下就省略）、你写的那句话、时间与删除。点一条批注，正文滚到那一块、光标落进可编辑块并短暂高亮，抽屉保持打开。草稿写在文档同目录的 `.doc-workbench/notes.json`（`planners-doc-notes/1`），跨页、跨天、关掉浏览器都还在；每条可单独删除，底部「提交模型 · N」把整批装成**一条**任务（同块多条只绑一块），空白时按钮禁用，提交后草稿清空，这批进「已提交」；模型看了却没动的批注退回历史批注面板并如实标出来。失去目标的草稿不静默消失：留在草稿里并在回执 `orphaned` 里说明原因。「整篇反馈」也是同一条草稿：`scope: "doc"`、`anchor` 为 `null`，排在最前、带一个「整份」标签，条数算进「提交模型 · N」，按一次就随整批进任务——任务里它的目标写成「整份」，不伪造锚点；模型写回后它和块级批注走同一条归档路径（快照是整份文档的改前 / 改后）。接口是 `GET /api/notes`、`POST /api/note`、`POST /api/note/delete`、`POST /api/note/reopen`、`POST /api/note/submit`，形状见 [`planners-doc-notes/1`](contracts/planners-doc-notes.md)。

每次提交批次还附一份**结构 diff**（`planners-doc-diff/1`）：章节与页的新增 / 删除 / 改名 / 移动 / 合并 / 拆分，块的跨页移动与删除，以及目标块已被删掉的批注（`orphan_notes`）。基准是模型上一次取稿时看到的版本，落在 `.doc-workbench/state/baseline.json`；模型侧读 `tasks` 或 `open` 时刷新，页面每 3 秒轮询锁不刷新。diff 只说结构哪里动了、不带正文，随任务一起落盘，模型读 `tasks` 就拿到 —— 没有第二条命令。结构没变时 diff 为空，提交照常成功。形状与判定规则见 [`planners-doc-diff/1`](contracts/planners-doc-diff.md)。

模型一次写回多块（`POST /api/patch`）。服务端按块比对任务提交时的指纹与磁盘当前版本：没变过的块直接落盘并解锁；在这之后被人改过的那一块只标「待核对」、保持锁定、磁盘不动，其余块照常落盘。人可以选择「保留我的」「用模型版」或「放弃该块」，裁决后解锁。两个人改不同块时按块合并，同一块才会停下来：后保存的那个标签页拿到磁盘版与自己这一版，两版都写进待核对队列（刷新、重开工作台都还在），并排选一版落盘，两边随后看到同一份结果。所有写盘走 journal，进程在两次 rename 之间被打断，重启时能恢复未提交的改动，也不会多出幽灵块。任务形状、回执与 journal 判据见 [`planners-doc-task/1`](contracts/planners-doc-task.md)。

图片按正文里的 `![说明](相对路径)` 就地显示，点开是只读放大层（滚轮 / 按钮缩放，可切「适应窗口」与「1:1」看裁切）；文件取不到时块内标「未能加载 · 路径」，不画占位图。SVG 与位图一样只经 `<img>` 加载，`/asset` 只发图片 MIME 并给 SVG 带 `sandbox; script-src 'none'` 的 CSP，图里的脚本不执行。换图只换文件字节：`POST /api/asset/replace` 的请求里没有路径，用哪张图始终由正文引用决定；锁定的图块会被拒绝，正文与其他块一个字节都不动。文档引用的图登记在同名清单（`storyline.md` → `storyline.assets.json`，`doc-assets/1`），打开时按正文与磁盘重建，换过文件会留下 `replaced_from_sha256`；`node scripts/validate-doc-assets.mjs <doc>` 独立核对三边是否一致。

结构就在正文里改：`#` 章节与 `##` 页的标题点进去就能改，失焦写回文件；加页加章不再有按钮，用行首 `## ` / `# ` 造结构（见下一段），新页是**真正的空页**（文件里没有正文，提示只在渲染层出现）。左侧目录与正文从同一份快照重画，改完立刻同步。结构操作走 `POST /api/structure`（`rename-chapter` / `rename-page` / `add-page` / `add-chapter` / `add-source`），与本地页、侧栏桥共用同一个 `structure` 动作名；改结构只换标题行或插入结构行，其余字节逐字不动。

块的类型不靠菜单，靠**行首前缀**：块首敲 `## ` 得到一页（文件里是真正的 `## 标题` 行）、`# ` 得到一章、`### `–`###### ` 得到对应层级的标题块，`- ` / `1. ` 列表、`> ` 引用、围栏代码、`|` 起表格；写入后前缀从正文隐去，只留排版。只有块首且前缀后紧跟空格才转换，输入法组字期间不转换；标题块里把文字删空会退回段落、前缀重新出现。保存路径对「前缀产生的类型变化」放行，其他结构变化（空行拆块、第二个锚点）仍然拒绝。工具栏只有加粗、斜体、链接、行内代码四个行内格式，不做块按钮。

依据、边界、来源写成页末连续的引用：工作台默认把它们收成一条 32px 的「出处 · N」，两端 `›` / `‹`、中间一条虚线，**整条都是点击区**。点开后每条引用按块编辑，组尾「＋ 出处」在页尾接一条（`add-source`）；再点组首收起。页中段的普通引用照常显示，不会被当作出处。

左侧目录按「章节 → 页」两级列出，页号只在目录里，点页跳转，滚动时高亮当前页。纸的左上角有 `A−` / `A+`：只改正文字号（15–21，默认 16.5），纸宽、左右留白与行宽都不动，选择存在浏览器本地，刷新后还在。块前缀的六点句柄可拖，落点用一条提示线说明「插到哪两块之间」；拖页标题移动整页（连同其下所有块），页号随新顺序重排；`Alt+↑↓` 移动光标所在的块。拖动与页重排走同一个显式重排操作 `POST /api/reorder`（`move-block` / `move-page`），未参与重排的块逐字不动；拖到章节标题下是「搬到页外」（`to.outside`），之后还能再拖回任一页。锁定（模型正在改）与待核对的块不是可编辑块：不给拖柄，`Alt+↑↓` 也不动；页里只要有一块被占住，整页也不能拖，服务端同样按 `block_locked` 拒绝。

历史按次记录：每次写盘前把上一版整份存进 `.doc-workbench/history/<文档文件名>/`，顶部「历史」列出时间、操作、指纹与摘要；「恢复这一版」把旧档作为一次新的编辑落盘，恢复前的那一版也会再存一档，旧记录一个不删。接口是 `GET /api/history` 与 `POST /api/history/restore`（`{id, base_sha256}`）。

**没有侧栏插件时**，派发不丢：同一条任务会落进文档同目录的 `.doc-workbench/inbox/t-<任务 id>.json`，等人说一声「去看看」，模型用一条命令读回块身份、提交时的指纹与意见原文，再把它标记为已取走。有插件时同一条任务交给唤醒；两条路径消费同一个任务形状。派发不写正文，也不等于批准。

```bash
node scripts/doc-inbox.mjs list path/to/.planners/storyline.md          # 未处理任务
node scripts/doc-inbox.mjs take path/to/.planners/storyline.md          # pending → processing
```

### 同一个工作台挂进 DSH 侧栏

同一份工作稿也能生成一个审阅面，直接挂进 DSH 侧栏；保存、重排、派发、锁与待核对的行为与本地页一致：

```bash
node scripts/doc-surface.mjs path/to/.planners/storyline.md
```

生成 `.doc-workbench/review-surface.json`（`command_backend: "doc-workbench/1"`）与一份自包含入口，用它走 `review_open` 即可。侧栏宿主只 serve 静态文件、不转发页面的 `/api/*`，所以页面把每次写入都交给桥的 `command(...)`；命令后端与本地页共用 `scripts/lib/doc-session.mjs`（解析、块级写、journal、锁判定只有一份），页面本身也共用 `assets/workbench/` 下同一批文件。同一个 surface `id` 再次打开就是刷新那一个标签。

派发按宿主分流：有插件时页面拿回执里的文案调用 `review.wake(...)` 唤醒模型；没有插件（本地宿主）同一条任务落本地收件箱，页面状态如实写明「已写入收件箱」。任务、锁与待核对落在 `.doc-workbench/state/`，所以侧栏命令、本地页与模型侧的下一条命令即使不在一个进程里，也看到同一组锁：

```bash
node scripts/doc-command.mjs path/to/.planners/.doc-workbench/review-surface.json tasks
node scripts/doc-command.mjs path/to/.planners/.doc-workbench/review-surface.json claim <任务 id>
echo '{"task_id":"<任务 id>","patches":[{"anchor":"b:7b057d","content":"新的一版。"}]}' \
  | node scripts/doc-command.mjs path/to/.planners/.doc-workbench/review-surface.json patch
```

旧的 `.proposal-work/page-architecture.json` / `.bypage-work/page-architecture.json` 也能打开，但**只读**：页面顶部写明原因，保存、重排、派发都被拒绝，磁盘一个字节都不动。旧项目不迁移，新的工作稿要按 `planners-doc/2` 重建。


---

<details>
<summary>Skill 开发者说明：`review-surface/2.0.0` 契约、桥 API、命令通道与回归测试</summary>

### 给自己的 Skill 接入双宿主审阅（4 步）

1. **准备审阅页面目录**：入口 HTML 推荐保留裸标记 `{{REVIEW_BRIDGE}}` 独占一行（允许省略以兼容普通 HTML 产物——两个宿主都会兜底追加到 `</body>` 前，仅校验器给出 `bridge_placeholder_absent` 警告；不要写进 `<script src>` 或 `<script>` 标签内，免得替换嵌套破损）。也不要在页面目录复制 `review-bridge.js`。
2. **编写 `review-surface.json`**：遵循 `contracts/review-surface.schema.json`（**7 个必填字段 + 7 个可选字段**，宿主只读契约字段，不解释任何业务审阅语义）：
   - **必填 7 项**：`contract_version`（`"review-surface/2.0.0"`）、`id`（`<skill>/<面>`，同一对话按 `id` 复用/刷新标签）、`title`、`project_root`、`dir`、`entry`、`wake`（`mode`: `queue | steer` + `text`）。
   - **可选 7 项**：`description`、`feedback`（提交落盘路径，省略则只靠 `wake` 回传）、`draft`（未提交草稿恢复文件）、`watch`（监听元数据变更推 `review/changed`）、`annotate`（`true` 时注入 `assets/annotate/annotate.js` 产 `artifact-annotations/1`）、`command_backend`（`svg-workbench/1`、`content-workbench/1` 或 `doc-workbench/1`）、`capabilities`。
3. **页面调用桥接口**：
   ```js
   const review = await ReviewBridge.connect()
   const url = await review.asset('shots/page-03.png', { v: 'v2' })
   const txt = await review.readText('snapshot.json')
   await review.command({ op: 'save', ...payload }) // 内容/结构审阅工作台推荐走命令通道
   await review.draft(payload)                      // 刷新可恢复草稿
   await review.write(document)                     // 原样写 feedback 文件
   await review.wake({ unit: 'page-03' })           // 需要唤醒模型处理再调
   review.on('changed', ({ units }) => { /* 更新局部视图 */ })
   ```
4. **校验与启动**：
   ```bash
   node scripts/validate-surface.mjs "<surface.json>" --text
   node scripts/review-host.mjs start "<surface.json>"
   ```

更多规范见：`references/architecture.md`、`references/content-review.md`、`references/annotate.md`、`references/command-transport.md`。

### 环境要求与双向测试

- **运行环境**：Node.js 20+（零第三方依赖，绑定 `127.0.0.1` 随机端口）。Python 类 Skill（如 `planners-ppt-hell`、`video-craft`）可通过 `scripts/lib/review_host.py` 薄传输层调用同一 Node 宿主 CLI。
- **回归测试（两条入口都要跑）**：
  ```bash
  node evals/run.mjs                                     # JS 校验器、本地宿主、线协议与桥回归
  python3 -m unittest discover -s evals -p 'test_*.py'   # Python 传输层与宿主生命周期回归
  ```
- **验收（票 10，独立入口）**：
  ```bash
  node evals/acceptance/run.mjs                          # 十份真实语料往返、块内中文输入、同块双改
  ```
  它不并进上面两条回归：更慢，中文输入那一项还需要本机 Playwright 的 Chromium（没有就记「无法验证」，不伪造通过）。做法、语料来源与最近一次记录见 [`evals/acceptance/README.md`](evals/acceptance/README.md) 与 [`evals/acceptance/REPORT.md`](evals/acceptance/REPORT.md)。

### 目录结构

```text
planners-review-core/
├── SKILL.md
├── GOTCHAS.md
├── SECURITY.md
├── contracts/
│   ├── review-surface.schema.json      # review-surface/2.0.0 权威契约
│   ├── planners-doc.md                 # planners-doc/2 文档契约（工作稿结构）
│   ├── doc-assets.md                   # doc-assets/1 图资产清单契约（派生索引）
│   ├── planners-doc-task.md            # planners-doc-task/1 块级反馈任务形状
│   ├── planners-doc-notes.md           # planners-doc-notes/1 批注：块级 / 整份（anchor 为 null）、批次与归档
│   ├── planners-doc-diff.md            # planners-doc-diff/1 结构 diff 与基准刷新时机
│   └── examples/                       # 两份真实样例：storyline / by-page
├── assets/
│   ├── review-bridge.js                # 双宿主运行时桥
│   ├── dsh-tokens.css                  # DSH 共享视觉令牌唯一源
│   ├── workbench/                      # 文字工作台页面、transport 与行内格式序列化
│   └── annotate/                       # 无依赖 HTML 产物批注层
├── scripts/
│   ├── open-artifact.mjs               # 任意 HTML 一键建批注面入口
│   ├── validate-surface.mjs            # surface 结构与包含性校验器
│   ├── validate-doc.mjs                # planners-doc/2 文档校验器
│   ├── migrate-doc.mjs                 # /1 → /2 迁移器（标题层级上移一位）
│   ├── validate-doc-assets.mjs         # doc-assets/1 资产清单校验器
│   ├── review-host.mjs                 # 本地宿主生命周期唯一 CLI
│   ├── serve-review.mjs                # 无 DSH 插件时的本地浏览器宿主
│   ├── content-workbench.mjs           # 通用内容/结构审阅工作台后端
│   ├── doc-workbench.mjs               # 本地页入口：HTTP 路由，块级逻辑在 lib/doc-session
│   ├── doc-surface.mjs                 # 为工作稿生成侧栏 review-surface 与自包含入口
│   ├── doc-command.mjs                 # doc-workbench/1 命令后端；同时是模型侧 tasks/claim/patch CLI
│   ├── doc-inbox.mjs                   # 模型侧读收件箱：list 未处理任务 / take 取走任务
│   ├── lib/doc-session.mjs             # 两个入口共用的块级内核：解析、写盘、journal、锁、裁决
│   ├── lib/doc-boards.mjs              # 任务板与待核对的落盘（本地页 / 侧栏 / 模型 CLI 共享）
│   ├── lib/doc-blocks.mjs              # 文档切块/锚点修补唯一实现（校验器共用）
│   ├── lib/doc-assets.mjs              # 图资产清单：派生、换文件守卫与三边校验
│   ├── lib/doc-history.mjs             # 每次写盘前存上一版；列出与按档恢复
│   ├── lib/doc-io.mjs                  # 旁路目录与原子写（fsync + rename）唯一实现
│   ├── lib/doc-diff.mjs                # 结构 diff：基准落盘、页 / 章节 / 块变化判定与 orphan_notes
│   ├── lib/doc-tasks.mjs               # 块级反馈任务与块锁
│   ├── lib/doc-inbox.mjs               # 无插件派发的本地收件箱（一条任务一个文件）
│   ├── lib/doc-dispatch.mjs            # 派发唯一出口：有插件唤醒 / 无插件落收件箱
│   ├── lib/doc-legacy.mjs              # 旧 JSON 主稿的只读快照，不进入新契约的读写
│   ├── lib/doc-conflicts.mjs           # 同块双改的待核对队列（两个版本 + 裁决）
│   ├── lib/doc-journal.mjs             # 写盘 journal、跨进程写锁与崩溃恢复
│   └── lib/review_host.py              # Python 侧宿主传输封装
├── evals/                              # JS + Python 回归测试集
└── references/                         # 接缝架构、Workbench 与批注规范
```

</details>

---

## 品牌边界、开源协议与商业合作

- **许可协议**：以 [AGPL-3.0-only](LICENSE) 发布；可商用，修改版或通过网络提供的服务须公开对应源码。
- **署名边界**：承载其他 Skill 审阅面时无需额外为本底座加水印；归属声明见 [NOTICE](NOTICE)，名称使用边界见 [TRADEMARK.md](TRADEMARK.md)，安全说明见 [SECURITY.md](SECURITY.md)。
- **商业合作**：私有化集成、定制工作台或闭源授权，请联系 `Lawyif@163.com` 或访问 [demyth.info](https://demyth.info)，详见 [COMMERCIAL.md](COMMERCIAL.md)。

## 相关项目

- [DSH Review Dock](https://github.com/thePlannerIvan/dsh-review-dock) —— DSH 右侧栏宿主插件（与本底座无缝配合）
- [Planners Proposal System](https://github.com/thePlannerIvan/Planners-Proposal-System) —— 在线可拖曳 Storyline 共创工作台
- [Planners Bypage](https://github.com/thePlannerIvan/planners-bypage) —— 逐页 PPT 文案、配图与审阅
- [Planner's PPT Hell](https://github.com/thePlannerIvan/planners-ppt-hell) —— SVG / PPTX 制作与看图返修工作台
