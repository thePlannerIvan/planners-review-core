# 架构：module、缝、边界

给**改它的人**读。

## 目的与全景

```text
Skill 的审阅页面 ──┐
Skill 的资产     ──┼→ 宿主（DSH 插件 / 本模组的本地服务器）→ 落文件 → 唤醒模型
review-bridge.js ──┘
        ↑
   review-surface.json（契约）
```

## 模块表

| module | 它是什么 | 拥有什么（唯一主人） | 接口 | 不做什么 |
|---|---|---|---|---|
| `contracts/review-surface.schema.json` | 契约 | surface 的字段与语义 | 被校验器与宿主读取 | 不表达审阅语义（审什么、能下什么决定、怎么绑版本） |
| `scripts/validate-surface.mjs` | **唯一校验器** | 结构、路径包含性、桥的哈希一致性 | CLI，输出 JSON，非零即不合规 | 不评价审阅设计 |
| `assets/review-bridge.js` | 页面与宿主之间唯一的说话方式 | 两种传输（postMessage / fetch）、`write`/`wake`/`upload`/`assetUrl`/`on`/`capabilities` | `window.ReviewBridge.connect()`；**由宿主注入**，页面只留 `{{REVIEW_BRIDGE}}` | 不碰 localStorage、不解释反馈形状、不知道"页"是什么 |
| `scripts/serve-review.mjs` | 没有 DSH 时的宿主 | serve `dir`、写 feedback、wake 落日志、版本令牌 | CLI | 不唤醒 Agent（没人可唤）—— 打印提示让人回对话 |
| `scripts/review-host.mjs` | **宿主的生命周期，唯一实现**（Node CLI） | 写/校验 surface、起/复用宿主、判死活与**身份**、停干净、找 node、解析启动自证、越界出声 | `write` / `validate` / `state` / `alive` / `start` / `stop` / `open` ＋ `pid` / `report` / `match` / `constants`；入参是**一个 surface 路径** | **不认识任何 Skill 的业务**：不解释审的是什么，也不需要在替谁干活；文档内容由各家的 `surface_document()` 建 |
| `scripts/lib/review_host.py` | **只是传输层**（Python） | spawn `review-host.mjs` + 解析 JSON + 映射名字 | 同名函数给 Python 调用方；只有 `node_binary()` 留在这一侧（怎么启动 CLI）；**开浏览器也归实现侧**（`launchBrowser()` / `--no-open`） | **判据一条都没有** —— 僵尸、身份、越界、日志解析全在 Node 侧（上面那一行） |

### 为什么生命周期是 Node，而不是 Python

缝的四块里三块本来就是 Node（契约 JSON、`validate-surface.mjs`、`serve-review.mjs`、桥），而
**Node 是所有人的底线**：校验器与无插件宿主都是 Node CLI，连 Python 技能也要找到 node 才能用它们。
生命周期放在 Python，就把纯 `.mjs` 的调用方（`planners-bypage` 全是 `.mjs`，而它的运行契约明确
不许假定 `python3` 存在）关在门外；而它们**不能**再写一份 Node 生命周期 —— 那正是要消灭的
"两份副本各自漂移"。**收到 Node，谁都不多一个依赖，Python 调用方也不必自己拼命令行。**

顺带少掉一个坑：Python 那份以前要自己防僵尸（`Popen` 之后不 `wait()` → 僵尸 → `os.kill(pid,0)`
仍返回成功）。Node 的 libuv 自己收 SIGCHLD，实测子进程退出 400ms 后就是 ESRCH —— 这个坑在
实现侧结构上不存在（`start` 里仍优先看句柄，因为那里需要**退出码**才能把"起不来"与"起来了但没自证"分开）。

## 缝：三样东西跨过去

可选内容壳独立于宿主：`scripts/render-content-review.mjs` + `assets/content-review/` 只拥有阅读、编辑、排序与桥接交互；`scripts/content-review-contract.mjs` 只拥有壳的字段检查、深度哈希与审阅上下文。生产方 adapter 拥有原生内容映射、原文保护、回写和批准语义。接口见 `references/content-review.md`；不替换其他专用审阅面。

| 方向 | 东西 |
|---|---|
| Skill → 宿主 | surface 文件、页面与资产（在 `dir` 里） |
| 宿主 → 页面 | `init`（nonce / assetBase / surface）、`changed`（哪些单位变了） |
| 页面 → 宿主 | `write`（形状由 Skill 定）、`wake`（一句话给模型） |

**宿主只实现三件事**：落文件、递话给模型、给资产 URL。任何第四件事都说明缝设计错了。

## 安全：两条必须守住的线

1. **包含性**：`dir` 与反馈文件都必须落在 `project_root` 里，用 **realpath** 比对（符号链接能绕过字符串前缀比对）。
   校验器与两个宿主都要查；宿主侧还要再查一次（不能只信校验器 —— surface 可能在起服务之后被改）。
2. **往回的消息不可鉴权**：不透明 iframe 里 `event.origin` 是 `"null"`（所有 sandboxed/data:/file: 都是 `"null"`），**没有任何鉴别力**。只能用 `event.source === iframe.contentWindow` + 每次实例一个 nonce。桥就是这么做的。

## 接入 DSH 的硬要求（写给插件那边）

- **`keepMounted: true` 是前置条件**：默认 falsy 时 tab 一切走 React 就卸载 → iframe 销毁 → 人写了一半的意见全丢。
- **HTTP 端点必须挂在 `/api` 围栏下**（`ctx.connection.fetch.register`）。裸 `webServer.register({kind:'prefix'})` 没有 Host/Origin 围栏也没有 cookie 校验 —— 任何你能访问的网页都能让浏览器对 loopback 盲发带副作用的请求。
- **父页面创建的 `blob:` URL 不属于不透明 iframe**。资产字节经桥传入后，由 iframe 自己创建 URL；不得直接引用受宿主围栏限制的资产路由。
- **推送**：宿主 SSE → 插件客户端 → 父页面 `postMessage` 转投。页面只换那一张图，不重载 iframe。
- **`ctx.emit → ctx.remote.$on` 对第三方插件是关死的**，而且客户端 `$on` 不校验事件名 → 写错了会静默永不触发。别用。

## 动了 X 会牵连什么

| 你要改 | 该动哪里 | 会牵连什么 |
|---|---|---|
| 契约字段 | schema + 校验器 | 所有 Skill 的 surface 与两个宿主；**桥的 API 也在这条线上** |
| 桥的 API | `assets/review-bridge.js` | 每个审阅目录里的副本（校验器报 `bridge_stale` 挡住），以及所有 Skill 的页面 |
| 包含性规则 | 校验器 + 两个宿主 | 安全面；改前先想清楚能不能被绕过 |
| 新增宿主（除 DSH 与本地服务器） | 本文件 + SKILL.md | 新宿主必须实现同样三件事，页面不用改 |

## 同一件事的两个真相源（故意分开）

- **契约**只有 schema 一份；Skill 的文档只描述**自己怎么用它**，不重述字段。
- **桥**的真相源在本模组，且**只有这一份**：宿主把它注入到 serve 出去的 HTML 里（页面只留 `{{REVIEW_BRIDGE}}` 注入点，换成**源码内联**或 URL 由宿主决定）。**不做副本**，也不给帧一个 `/api` 下的 `<script src>` —— 不透明帧取不到它（实测 403）。

**注入点的写法只有一种**：`{{REVIEW_BRIDGE}}` **裸着独占一行**。宿主原地替换它，放进 `src=` 或 `<script>` 里都会把标签撑破（两种都真的发生过，校验器现在拦 `bridge_placeholder_not_bare` / `bridge_placeholder_multiple`）。

## 退役

- `review-surface/1.0.0`（2026-09-26 退役）：它试图让宿主理解审阅语义（`unit` / `version` / `decisions` / `required_decisions` / `assets`），与"能力、内容、文件结构归 Skill"的裁定相悖。归档在 `_archive/review-surface-1.0.0-retired-2026-09-26/`。

## 已知缺口（记着，暂时不做）

- **`dir` 只能取"页面与它要读的东西的最近公共祖先"，往往是项目根 → 整个项目根都在 serve 范围里**（第二家 video-craft 实测：含 GB 级素材与 `composition/`）。包含性校验管住了**越界**，没管住**暴露面**。危害有界（宿主绑 `127.0.0.1`、只服务本机、页面是自己人写的），但这是一条真缺口。
  **要补的话**：surface 上加一个"只 serve 这几棵子树"或一个 `hide` 列表。**用户 2026-09-26 明确说暂时先不改** —— 先记在这里，别忘。
- **追加式存储没有幂等原语**：缝的 `write` 是覆盖写；要"只追加"的产出方得自己在 Skill 侧造游标（第二家用的是"记录内容哈希 + 旁边一个小文件"）。见 SKILL.md 里那一行改造路径。
