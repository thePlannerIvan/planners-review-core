# Planners Review Core

[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-2563eb)](LICENSE)
[![Contract](https://img.shields.io/badge/contract-review--surface%2F2.0.0-0f766e)](contracts/review-surface.schema.json)
[![Node](https://img.shields.io/badge/node-%3E%3D20-339933)](https://nodejs.org)
[![Runtime](https://img.shields.io/badge/runtime-DSH%20%7C%20plain%20Node-6b7280)](references/architecture.md)

人工审阅的公共接缝：**一个 surface 契约 + 一份桥 + 一个「没有插件时」的本地宿主**，让任何 Skill 的审阅页面都能挂进 DSH 侧栏，也能在没有 DSH 时照常跑。

> 作者：阿祖不看 TVC（小红书同名）· [demyth.info](https://demyth.info) · [Lawyif@163.com](mailto:Lawyif@163.com)

## 它解决什么

「人看过并点了确认」这件事，过去每个 Skill 各写一遍：各写一份消息协议、各写一个本地服务器、各自处理落盘和唤醒模型。于是同一份审阅页面在插件里能跑、换个宿主就断，或者反过来 —— 页面代码被迫写两份，然后两份各自漂移。

本模组把这层收敛成一条缝，并只留一个实现：

```text
有插件：  插件（DSH 侧栏）→ iframe 承载 Skill 的页面 → postMessage → 落文件 + 唤醒模型
没插件：  本模组起本地服务器   → 同一份页面（桥自动切 fetch）→ 落文件 → 人回对话说一声
```

**同一份页面代码，两种宿主。** 这是整条缝的价值所在。

它不管审什么、也不管页面长什么样，只管**人的决定怎么到模型手里**。契约只有 7 个必填 + 4 个可选字段，其余一概不解释 —— 反馈文件的形状、单位怎么定义、版本怎么算、批准算不算「门」，全部留在调用它的 Skill 手里。

## 核心工作流

1. **Skill 侧造审阅目录**：入口 HTML（里面留一个裸的 `{{REVIEW_BRIDGE}}` 注入点）+ 资产；
2. **写 `review-surface.json`**：页面在哪、serve 哪棵树、反馈写哪、盯哪些文件；
3. **校验**：`validate-surface.mjs` —— 结构 + 路径包含性 + 桥的哈希一致性；
4. **页面用桥说话**：`review.write(payload)` 落反馈、`review.wake({unit})` 唤醒模型、`assetUrl` / `readText` / `upload` 取资产、`on('changed')` 接版本变化；
5. **宿主接管**：有 DSH 时由插件承载；没有时 `review-host.mjs start` 起本地宿主，页面一个字都不用改。

生命周期 CLI（`scripts/review-host.mjs`）是**唯一实现**：`write` / `validate` / `state` / `alive` / `start` / `stop` / `open`（＋ `pid` / `report` / `match` / `constants`）。判据三条，都是实测换来的：**按内容不按端口**判身份、**靠 `watch` 声明的文件**分项目、**绝不端出旧项目**。

## 适合 / 不适合

适合：

- Skill 需要一个人工审阅环节，且希望页面同时能跑在 DSH 侧栏和纯浏览器里；
- 需要逐单位决定、单位级版本戳、追加式反馈日志、或「在板子上挑完回对话」；
- 需要**没有 DSH 也能跑**的审阅（本地服务器形态）；
- 只想校验一份已有的 `review-surface.json`。

不适合：

- 只需要「整体批准 + 一句备注」—— 那种面不需要上这条缝，对话就够；
- 想让宿主替你判断「批准算不算门」——**宿主只当信使，权威永远在产出方那一侧**；
- 想用同一个 UI 覆盖所有审阅任务：本模组只提供可选的内容/结构审阅壳，不替代 PPT、视频等专用审阅面。用法见 `references/content-review.md`。

## 安装

通用 Skills CLI：

```bash
npx skills add https://github.com/thePlannerIvan/planners-review-core --skill planners-review-core
```

也可直接放入 Codex 或 Claude 的 Skill 目录：

```bash
git clone https://github.com/thePlannerIvan/planners-review-core.git ~/.codex/skills/planners-review-core
# 或
git clone https://github.com/thePlannerIvan/planners-review-core.git ~/.claude/skills/planners-review-core
```

环境要求：**Node.js 20+**（零依赖，只用内置模块）。Python 侧只有一份薄传输层 `scripts/lib/review_host.py`，供 ppt-hell / video-craft 那类 Python 技能直接调用，可选。

回归测试要跑**两条入口**，只跑一条等于没跑：

```bash
node evals/run.mjs                                     # JS：校验器 15 + 宿主 29 + 第二形状 3 + 线协议 5 + 轮询 2 + 桥 9
python3 -m unittest discover -s evals -p 'test_*.py'   # Python：11 条（生命周期 + 传输层）
```

## 典型 prompt

本模组**不由用户直接触发**，通常是被别的 Skill 调用。只有两种情况直接用它：

```text
我手上有一份 review-surface.json，帮我校验它合不合契约：
node scripts/validate-surface.mjs <surface.json> --text
```

```text
没有 DSH，我想把这个审阅面跑起来：
node scripts/review-host.mjs start <surface.json>
```

宿主 Skill 侧的调用姿势是「按名字找到兄弟目录再执行它的 CLI」，解析约定与那 25 行适配器见 `references/architecture.md`。

## 目录结构

```text
planners-review-core/
├── SKILL.md
├── GOTCHAS.md
├── contracts/
│   └── review-surface.schema.json      # review-surface/2.0.0 契约（唯一真相源）
├── assets/
│   └── review-bridge.js                # 桥。由宿主注入，页面只留 {{REVIEW_BRIDGE}} 注入点
├── scripts/
│   ├── validate-surface.mjs            # 唯一校验器（结构 + 包含性 + 桥哈希）
│   ├── serve-review.mjs                # 没有插件时的宿主（serve + write + wake + 版本令牌）
│   ├── review-host.mjs                 # 宿主生命周期，唯一实现（Node CLI）
│   └── lib/review_host.py              # 只是传输层：spawn CLI + 解析 JSON，判据一条都没有
├── evals/
│   ├── run.mjs                         # JS 回归
│   ├── test_review_host.mjs            # Node 侧的牙
│   ├── test_review_host.py             # Python 侧的牙
│   └── review-host-example.mjs         # 纯 Node 走完 write → validate → start → alive → stop
└── references/
    ├── architecture.md                 # module 表、缝、DSH 侧接入要求
    └── design-and-porting-rules.md     # 设计与移植规则
```

## 品牌与署名边界

来源信息可出现在 Skill 文档、流程 HTML、审阅页面、验证页面和开发者工作面中；**不默认写入最终客户交付物**。若你在自己的 Skill 里承载审阅页，无需为本模组加水印。

`Planners Review Core` 与 `阿祖不看 TVC` 用于标识本项目及其来源。开源许可证授予代码使用权，不自动授予项目名或作者名的商标使用权。修改版请标注 fork，不要暗示作者背书。详见 [TRADEMARK.md](TRADEMARK.md)。

## 开源协议和商业入口

本项目以 **AGPL-3.0** 发布 —— 可以商业使用；修改版与通过网络提供的服务需公开对应源码。若需要闭源授权、私有部署、企业工作流或私有增强模块：

- Email：`Lawyif@163.com`
- Website：[demyth.info](https://demyth.info)

详见 [COMMERCIAL.md](COMMERCIAL.md) · 安全策略见 [SECURITY.md](SECURITY.md) · 归属声明见 [NOTICE](NOTICE)。

## 相关项目

- [Planners Bypage](https://github.com/thePlannerIvan/planners-bypage) —— 多源资料 → 逐页 PPT 内容包（审阅面的消费方）
- [Planner's PPT Hell](https://github.com/thePlannerIvan/planners-ppt-hell) —— 可编辑 PPT 与视频静态画面
