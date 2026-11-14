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

<details>
<summary>Skill 开发者说明：`review-surface/2.0.0` 契约、桥 API、命令通道与回归测试</summary>

### 给自己的 Skill 接入双宿主审阅（4 步）

1. **准备审阅页面目录**：入口 HTML 推荐保留裸标记 `{{REVIEW_BRIDGE}}` 独占一行（允许省略以兼容普通 HTML 产物——两个宿主都会兜底追加到 `</body>` 前，仅校验器给出 `bridge_placeholder_absent` 警告；不要写进 `<script src>` 或 `<script>` 标签内，免得替换嵌套破损）。也不要在页面目录复制 `review-bridge.js`。
2. **编写 `review-surface.json`**：遵循 `contracts/review-surface.schema.json`（**7 个必填字段 + 7 个可选字段**，宿主只读契约字段，不解释任何业务审阅语义）：
   - **必填 7 项**：`contract_version`（`"review-surface/2.0.0"`）、`id`（`<skill>/<面>`，同一对话按 `id` 复用/刷新标签）、`title`、`project_root`、`dir`、`entry`、`wake`（`mode`: `queue | steer` + `text`）。
   - **可选 7 项**：`description`、`feedback`（提交落盘路径，省略则只靠 `wake` 回传）、`draft`（未提交草稿恢复文件）、`watch`（监听元数据变更推 `review/changed`）、`annotate`（`true` 时注入 `assets/annotate/annotate.js` 产 `artifact-annotations/1`）、`command_backend`（`svg-workbench/1` 或 `content-workbench/1`）、`capabilities`。
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

### 目录结构

```text
planners-review-core/
├── SKILL.md
├── GOTCHAS.md
├── SECURITY.md
├── contracts/
│   └── review-surface.schema.json      # review-surface/2.0.0 权威契约
├── assets/
│   ├── review-bridge.js                # 双宿主运行时桥
│   ├── dsh-tokens.css                  # DSH 共享视觉令牌唯一源
│   └── annotate/                       # 无依赖 HTML 产物批注层
├── scripts/
│   ├── open-artifact.mjs               # 任意 HTML 一键建批注面入口
│   ├── validate-surface.mjs            # surface 结构与包含性校验器
│   ├── review-host.mjs                 # 本地宿主生命周期唯一 CLI
│   ├── serve-review.mjs                # 无 DSH 插件时的本地浏览器宿主
│   ├── content-workbench.mjs           # 通用内容/结构审阅工作台后端
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
