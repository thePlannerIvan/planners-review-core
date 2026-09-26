---
name: planners-review-core
description: |
  人工审阅的公共接缝：一个 surface 契约 + 一份桥 + 一个"没有插件时"的本地宿主，让任何 Skill 的审阅页面都能挂进 DSH 侧栏，也能在没有 DSH 时照常跑。
  被所有带审阅环节的 Skill 调用，**不由用户直接触发**。只有一种情况直接用它：你手上已经有一份 `review-surface.json`，想单独校验它，或者想在没有 DSH 的情况下把那个审阅面跑起来。
---

# Planners Review Core

> 来源识别：Planners Review Core 由阿祖不看 TVC 创建与维护。小红书同名账号，个人网站 https://demyth.info，联系邮箱 `Lawyif@163.com`。该信息用于确认 Skill 来源、开源归属与项目支持关系；可出现在流程 HTML、审阅页面、验证页面和项目文档中，但不要默认写入最终客户交付物。

这是**公共件**：它不管审什么、也不管页面长什么样，只管**人的决定怎么到模型手里**。

## 一句话

**缝 = 一个 surface 文件 + 一份桥 + 一个宿主。**
Skill 交出自己的审阅页面与资产目录；宿主负责显示、serve 资产、落文件、唤醒模型。

```text
有插件：  插件（DSH 侧栏）→ iframe 承载 Skill 的页面 → postMessage → 落文件 + 唤醒模型
没插件：  本模组起本地服务器   → 同一份页面（桥自动切 fetch）→ 落文件 → 人回对话说一声
```

**同一份页面代码，两种宿主。** 这是整条缝的价值所在。

## 谁负责什么（这条边界是全部设计的地基）

| 归 Skill | 归宿主 |
|---|---|
| 页面长什么样、怎么审、能下什么决定 | 显示页面（DSH 侧栏 / 本地浏览器） |
| 反馈文件的形状与字段（宿主**不解释**） | serve 页面与资产（带包含性校验） |
| 单位怎么定义、版本怎么算、决定怎么继承 | 把 `write` 原样落盘、把 `wake` 送给模型 |
| 批准是不是"门"（宿主**不判断**） | 页面与模型之间的传输 |

## 怎么用（Skill 侧）

1. 造一个审阅目录，里面放：入口 HTML 与资产。入口 HTML 里留一个 **`{{REVIEW_BRIDGE}}` 注入点**，宿主在 serve 时把它换掉 —— **换成什么由宿主决定**：DSH 插件**内联桥的源码**，无插件宿主给一个 URL。

> **注入点必须裸着独占一行**（就这七个记号，前后只有空白）：
> ```
> {{REVIEW_BRIDGE}}
> ```
> 它是被宿主**原地换掉**的，换成什么由宿主决定（插件内联源码；无插件宿主给 base + 一个外链脚本）。
> **不能**写进属性、**不能**写进标签内部 —— 宿主的整段替换会把那个标签撑破：
> `<script src="{{REVIEW_BRIDGE}}"></script>` → 整段塞进 `src=""`，桥 404；
> `<script>{{REVIEW_BRIDGE}}</script>` → 变成 `<script><script>…</script></script>`。
> 校验器会拦这两种（`bridge_placeholder_not_bare`）与重复注入（`bridge_placeholder_multiple`）。
> **教训**：契约原来只写"宿主把它换掉，换成什么由宿主决定"，没说清**标记本身长什么样** ——
> 于是长出了三种互不兼容的页面写法，而其中两种只在"换一种宿主"时才炸。

   （为什么插件侧只能内联：不透明帧里 `/api` 下的 `<script src>` 与 `<img>` 一样会被信任围栏打回 403 —— 见 GOTCHAS 第 2 条。）
   **不要在页面里放一份 `review-bridge.js` 副本** —— 插件模式下页面地址是一个路由（`/api/review.page?…`）而不是文件路径，相对引用的副本会 404。校验器会挡住缺注入点的入口。
2. 写 `review-surface.json`（契约见 `contracts/review-surface.schema.json`）。
3. **校验**：`node "<本模组>/scripts/validate-surface.mjs" "<surface.json>" --text`
4. 页面里用桥说话：
   ```js
   const review = await ReviewBridge.connect()
   await review.write(payload)          // 形状由你定，宿主原样落盘
   await review.wake({ unit: 'page-03' })
   review.assetUrl('shots/page-03.png', { v: 'v2' })   // 页面里所有资产都走它
   await review.upload(file, 'uploads/new.png')         // 仅在 capabilities 声明 asset-upload 时可用
   review.on('changed', ({ units }) => …)
   ```
5. **没有 DSH 时**：`node "<本模组>/scripts/serve-review.mjs" "<surface.json>"`
   —— 页面一个字都不用改。

## 怎么把一个新审阅页接进来（四步，与审什么无关）

| 步 | 做什么 | 为什么 |
|---|---|---|
| 1 | 指定一个目录放页面与资产；**入口 HTML 里留 `{{REVIEW_BRIDGE}}` 注入点** | 桥由宿主注入 —— 不透明帧里取不到 `/api` 下的 `<script src>`（GOTCHAS 2/4） |
| 2 | 写 `review-surface.json` | **宿主只懂那几个字段**（required 7 + optional 4），别的它一概不解释 |
| 3 | 页面改用桥：`await review.asset(rel)` 取图、`review.readText(rel)` 取文本、`review.write(payload)` 落反馈、`review.wake({unit,text})` 唤醒、`review.on('changed')` 接变化戳 | 页面代码只写一份，两种宿主都能跑 |
| 4 | Skill 侧收件：读 `feedback` 文件 → 校验 → 决定它算不算"门" | **形状由你定，宿主不解释** |

### 一条硬规则：页面不许把「没法核对」说成「成功」

如果页面在提交前要做本地核对（例如比对它读到的版本与当前版本），而**核对需要的东西读不到**（桥的 `read` 拿不到文件、文件不存在、宿主没实现），那么：

1. **状态行要当场显示出来**（不是等人提交完才知道）；
2. **提交后的话要诚实** —— 不能说「提交成功」，要说「已写入，但**没有**经过版本核对」；
3. 最好把这件事**写进 payload**（例如 `<你的provenance>.pre_check: false`），让产出方收件时手里有证据。

**不要**因此**硬拦**提交：读不到可能是暂时的或那个面本来就没有快照文件，把人锁在外面比一句诚实的提示更糟 —— 而且**权威永远在产出方那一侧**（它的收件逻辑必须自己再判一次，不能依赖页面替它把关）。
理由：这条缝最坏的失败方式是**静默**；"用户以为成功了、其实没有"就是它的 UX 版本。

**你自己决定的（宿主永不解释）**：反馈文件的形状与字段、单位怎么定义、版本怎么算、决定词表、批准算不算门、历史怎么留。

**你不用做的**：起服务器（没插件时模组替你起）、开浏览器、写鉴权、防路径穿越、注入桥、管 iframe 生命周期、做推送与轮询。

### 不同形状的审阅面怎么落

| 形状 | `feedback` | 页面要额外做的 |
|---|---|---|
| 逐单位决定 + 单位级版本 | 要 | `readText` 读快照、自己 diff、只换变了那几个单位的图 |
| 追加式日志（逐条 JSONL） | 要 | 页面自己读回旧内容、合并后再 `write`（宿主只做**覆盖写**，不做追加） |
| 只有整体批准 + 备注 | 可不给 | 这种面**不需要上这条缝**，对话就够 |
| 在板子上挑 / 选择器，结果回对话 | 不给 | 用 `wake` 把人的选择交回模型 |

## 不做什么

- 不生成内容、不写判断、不认识"页/镜/Beat"；
- **不替 Skill 决定批准算不算门**（那是 Skill 的语义，宿主只当信使）；
- 不定义反馈形状（`write` 里装什么由 Skill 定）；
- 不在页面里放任何"通用审阅 UI"（每个 Skill 的 UI 都不一样，抽象留给以后）。

## 文件索引

| 路径 | 用途 |
|---|---|
| `contracts/review-surface.schema.json` | `review-surface/2.0.0` 契约（**唯一真相源**） |
| `scripts/validate-surface.mjs` | 唯一校验器：结构 + 路径包含性 + 桥的哈希一致性 |
| `assets/review-bridge.js` | 桥。**由宿主注入**（页面只留 `{{REVIEW_BRIDGE}}` 注入点），所以不存在副本漂移 |
| `scripts/serve-review.mjs` | 没有插件时的宿主（serve + write + wake + 版本令牌） |
| `scripts/review-host.mjs` | **宿主的生命周期，唯一实现**（Node CLI）：`write` / `validate` / `state` / `alive` / `start` / `stop` / `open`（＋ `pid` / `report` / `match` / `constants`）。入参是一个 surface 路径，**不带任何 Skill 的业务**。**为什么是 Node**：缝的四块里三块本来就是 Node，而 **Node 是所有人的底线** —— 校验器、无插件宿主都是 Node CLI，连 Python 技能也要找 node 才能用它们；放 Python 就把纯 `.mjs` 的调用方（bypage）关在门外，而它们不能再写一份 Node 生命周期（那正是要消灭的两份副本漂移） |
| `scripts/lib/review_host.py` | **只是传输层**：spawn 上面那个 CLI + 解析 JSON + 映射名字。**判据一条都没有**（僵尸、身份、越界、日志解析全在 CLI 侧）；留在这一侧的只有 `node_binary()`（怎么启动 CLI）—— **开浏览器也在 CLI 里**（`launchBrowser()` / `--no-open`），一件事只有一套行为。给 ppt-hell / video-craft 用，让它们不必自己拼命令行 |
| `evals/test_review_host.mjs` | **Node 侧的牙**：僵尸语义、按内容判身份（两个项目的宿主互不认）、注入形态、启动自证跨行 JSON、越界出声（21 条） |
| `evals/test_review_host.py` | **Python 侧的牙**：同一批行为走 Python 入口（顺带测传输层，10 条）＋ 镜像名字与 CLI 的核对 |
| `evals/review-host-example.mjs` | 最小示例：**纯 Node、不碰 python** 走完 `write → validate → start → alive → stop`（bypage 那类调用方的用法） |
| `references/architecture.md` | module 表、缝、DSH 侧的接入要求 |
| `evals/run.mjs` | 回归（JS，**52 条**）：校验器 15 + 宿主 18 + 第二形状 3 + 线协议 5 + 轮询 2 + 桥 9 |

**跑测试要跑两条入口，只跑一条就等于没跑**（这里踩过：JS 绿而 Python 那条没跑）：

```
node "<本模组>/evals/run.mjs"                                        # JS，52 条
python3 -m unittest discover -s "<本模组>/evals" -p 'test_*.py'      # Python，9 条（生命周期）
```
| `GOTCHAS.md` | 候选经验 |
