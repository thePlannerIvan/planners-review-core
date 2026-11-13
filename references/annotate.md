# 产物批注层（annotate）

> 给**产出物本身是 HTML** 的任务用的一层，与内容无关：直接改正文、点选元素、框选区域、选中一句话。
> 它不替代 Skill 已有的审阅页（那仍然是各 Skill 自己的事），只在"人要指着页面说"的场合补上那一层。

## 谁负责什么

| 归宿主 | 归页面（`assets/annotate/annotate.js`） | 归生产方（Skill / 模型） |
|---|---|---|
| 显示、注入、写 `feedback` / `draft`、唤醒 | 采集四种记录、版本读取、草稿自动保存与恢复 | 读批注、按锚点定位、改源、记账、判门 |

页面**不做**版本核对，所以它写 `pre_check: false` —— 不把"我没核对"说成"我核对过"。

## 开启方式

```json
{ "annotate": true }
```

宿主把 `assets/annotate/annotate.js` 内联进入口 HTML。页面可以留一个**裸的** `{{REVIEW_ANNOTATE}}` 独占一行指定位置；不留就追加在 `</body>` 前。

- 有 DSH：`review_open` 挂侧栏。
- 没 DSH：`serve-review.mjs` 起本地宿主，桥自动切 fetch。
- 双击打开：页面自己带 `<script src="annotate.js">`，提交时给可复制的 JSON。

## 版本与"别被覆盖"（这一节是重点）

### 为什么会覆盖

产物只有一份文件。模型重新生成它、人在页面上改它、另一个任务也在写它 —— 三件事没有任何一个自动知道另外两个。

### 四条规则

1. **一次提交 = 一批，不是一点一次。**
   页面只在人点「提交」时 `wake`；在此之前所有批注和改动都只在页面里，并自动进 `draft`（900ms 防抖）。
   每一次提交带一个 `bundle_id`，批注的 `id` 在批内唯一。生产方应用过的 id 自己记账，**不要重复应用旧批**。

2. **产物自己带版本。**
   生成 HTML 时写 `<meta name="artifact-version" content="…">`（时间戳、uuid 或内容哈希都行），**每次重新生成就换一个值**。
   页面读它，写进 `base.version`；`base.draft_stale: true` 表示"这批是从旧版草稿恢复的"。

3. **版本不一致时，不许按选择器直接改。**
   `base.version` 与当前产物相同 → `target.selector` 是快路径。
   不同（或 `draft_stale`）→ 只信 `quote.exact / prefix / suffix` 重新锚定；锚不上就标 orphaned 回来问人，**不要猜**。

4. **重新生成 = 先收，再改，再重放。**
   生成之前把还没应用的批注（含 `draft`）读出来；生成之后按第 3 条重锚、重放。
   应用方式一律是 **patch**：HTML 就改那个节点，md/json 产出的就改源数据再重生成。**不要整文件重写** —— 那是"后写的覆盖先写的"唯一来源。

### 侧栏里的提示

- 页面收到宿主的 `review/changed` 且本地有未提交内容 → 顶部条："产物已更新，这页还有 N 条未提交批注"，给「重新加载 / 继续」。不自动丢。
- 刷新或重开：先读 `draft`。版本相同就静默恢复；版本不同就问「恢复 / 忽略」，恢复的那批标记 `draft_stale`。

### 一个产物只归一个面

两个会话同时开同一份产物，最后写入的一方会赢。约定：**一个产物只有一个拥有它的 surface**；要换人审，先关掉旧的。
宿主的 `wake-log.jsonl` 是 append-only 的接入日志，可用来核对"这次提交进了哪一轮"。

## 记录形状

```json
{
  "contract": "artifact-annotations/1",
  "bundle_id": "bmwf31iw",
  "base": { "version": "v1", "captured_at": "2026-11-13T14:22:31Z", "draft_stale": false },
  "artifact": { "title": "…", "path": "/…/report.html" },
  "annotations": [
    {
      "id": "a1",
      "kind": "element",
      "intent": { "verb": "change", "severity": "normal" },
      "comment": "这个数和下面的 41% 对不上，先核口径",
      "target": {
        "selector": "section:nth-of-type(1) > div.stats > div.stat:nth-of-type(1) > b",
        "path": "0/5/3/0/0",
        "tag": "b",
        "label": "div.stat > b",
        "text": "3.2%",
        "section": "现状：三条内容线在讲同一件事",
        "rect": { "x": 20, "y": 595, "w": 220, "h": 29, "space": "page" }
      }
    },
    {
      "id": "a2",
      "kind": "region",
      "comment": "这张表只排到 W10，后两周空着",
      "region": { "x": 10, "y": 1450, "w": 460, "h": 191, "space": "page" },
      "elements": [{ "selector": "table", "tag": "table", "text": "周次 内容 …" }],
      "text": "周次 内容 要解决的问题 …"
    },
    {
      "id": "a3",
      "kind": "text-comment",
      "comment": "这半句可以删",
      "quote": { "exact": "过去三个月，", "prefix": "", "suffix": "门店、电商…", "start": 0, "end": 6, "unit": "utf16" }
    },
    {
      "id": "e4",
      "kind": "text-edit",
      "intent": { "verb": "replace" },
      "edit": {
        "before": "…是那个愿意为新鲜付出代价的具体的人。",
        "after": "…（先别下结论。）",
        "ops": [{ "t": "keep", "v": "…" }, { "t": "ins", "v": "（先别下结论。）" }],
        "markup_changed": false
      }
    }
  ],
  "stats": { "total": 4, "element": 1, "region": 1, "text": 1, "edit": 1 }
}
```

| 字段 | 用法 |
|---|---|
| `target.selector` | 最短唯一 CSS 选择器（带 section/main 上下文）；快路径 |
| `target.path` | 子节点索引路径；选择器失配时的第二条路 |
| `target.text` / `quote` | 内容指纹；重生成后重锚的**权威** |
| `target.rect` / `region` | 页面坐标（`space: "page"`）；只用于理解"哪一块"，不是身份 |
| `elements[]` | 区域里被框住的元素（子元素被全框住时收成父容器）；模型据此逐条改 |
| `edit.ops` | 逐字 keep / del / ins；`before` + `after` 已足够，ops 用来做精确替换 |
| `base.version` | 这批批注锚在哪一版产物上 |
| `bundle_id` | 一次提交的批次号；生产方按它记账，避免重复应用 |

区域批注**没有截图**：给的是元素清单 + 文本。截图要克隆整页、内联字体，跨域资源会坏，代价远大于收益。

## 边界

- canvas 里的内容、跨域 iframe 里的内容点不到（DOM 里没有）。
- SVG 文本可以点选/框选，但不做就地编辑（`contenteditable` 在 `<text>` 上不可靠）。
- 草稿只按版本恢复一份，没有多版本历史；要版本树就自己存文件。
- 页面不校验 `base.version` 是否可信 —— 它只如实上报读到的值。

## 实现页面时要守的规

- **先渲染，再握手**；握手 1.5s 上限，失败按"没有宿主"降级，并在页面上说出来。
- 不碰 `localStorage`（不透明源里会抛）；状态在内存 + `draft`。
- 自己是 shadow DOM，不改产物 DOM（唯一例外：编辑模式下给叶子文字块临时加 `contenteditable`）。
- `draft` 900ms 防抖写；提交走 `write` + `wake`，回执照实说（本地宿主没有模型可唤醒）。
- 收到 `review/changed` 且有未提交内容 → 提示，不自动丢弃。
