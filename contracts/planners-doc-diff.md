# planners-doc-diff/1 · 结构 diff 契约

人提交一批批注时，工作台把「模型上次取稿时看到的版本 → 现在」的结构变化算成一份 diff，随任务一起给模型。模型不必猜人动过什么：章节、页、块的新增 / 删除 / 改名 / 移动 / 合并 / 拆分，以及目标块已被删掉的批注，都在这一份里。

- 形状由工作台 `scripts/lib/doc-diff.mjs` 产生，页面与模型都不自己拼 diff。
- diff 只说「哪里动了」，**不带正文**。正文由模型按任务的 `doc.path` 自己读，按锚点定位。
- 基准是上一次模型取稿时看到的版本，落在文档同目录的 `.doc-workbench/state/baseline.json`。
- 空 diff 是合法结果：结构没越界时照常提交，不因为 diff 为空而失败。

## 1. 形状

```json
{
  "contract": "planners-doc-diff/1",
  "batch": "b:9f21c4",
  "baseline_sha256": "9f2c…",
  "chapters": [
    { "action": "renamed", "from": { "index": 1, "title": "一、判断" }, "to": { "index": 1, "title": "一、判断（改）" } }
  ],
  "pages": [
    { "action": "renamed", "from": [{ "chapter": 1, "index": 2, "title": "旧页名" }], "to": { "chapter": 1, "index": 2, "title": "新页名" } }
  ],
  "blocks": [
    { "anchor": "b:77ac24", "action": "moved", "from": { "chapter": 1, "page": 2 }, "to": { "chapter": 2, "page": 5 } }
  ],
  "orphan_notes": [
    { "note": "n:4c1a", "text": "这句太虚", "reason": "target_block_removed" }
  ]
}
```

| 字段 | 含义 |
|---|---|
| `contract` | 固定 `planners-doc-diff/1`。模型先认版本再消费 |
| `batch` | 这批批注的批次号，与 `planners-doc-notes/1` 的 `note.batch`、任务里的 `batch` 是同一个 |
| `baseline_sha256` | 基准版本的整份文件指纹；模型还没取过稿（没有基准）时是 `null` |
| `chapters` | 章节变化；`from` / `to` 是 `{index, title}`，新增为 `null`、删除为 `null` |
| `pages` | 页变化；`from` 是页引用的**数组**（合并时是多页），`to` 是单个页引用或 `null` |
| `blocks` | 块变化；`from` / `to` 是 `{chapter, page}`（章节号 + 章内页号，都从 1 数） |
| `orphan_notes` | 目标块已经不在文档里的批注；`{note, text, reason}`，不静默消失 |

页引用是 `{chapter, index, title}`：章节号（1 起）、章内页号（1 起）、页标题。页没有锚点，身份是「章节 + 顺序 + 标题」，所以 diff 里必须把编号一起带上。

### 动作

| 列表 | `action` | 什么时候 |
|---|---|---|
| `chapters` | `added` / `removed` | 整章出现 / 整章不见了 |
| `chapters` | `renamed` | 同一章换了标题 |
| `chapters` | `moved` | 标题没变，但这几章之间的前后顺序变了（插一章、删一章不算移动） |
| `pages` | `added` / `removed` | 整页出现 / 整页不见了 |
| `pages` | `renamed` | 同一页换了标题 |
| `pages` | `moved` | 标题没变，章节或页号变了 |
| `pages` | `merged` | 两页（或更多）并成一页：`from` 是被并进来的页，`to` 是留下的那一页 |
| `pages` | `split` | 一页分出新页：每张新分出来的页一条，`from` 指回原页 |
| `blocks` | `added` / `removed` | 新块出现 / 锚点不见了 |
| `blocks` | `moved` | 锚点还在，但所属页变了（跨页移动） |

页本身的改名 / 合并 / 拆分不算块移动：块跟着它那一页走，`blocks` 里不重复报。

## 2. 怎么认「同一页」

页没有锚点，可它的标题、章节、顺序都会变。判据是**这一页里有哪些块**（块锚点随内容走，不因移动而变）：

1. 标题相同 → 同一页（再看位置是否变了）。
2. 标题没了的页：整页锚点落进某一页 → 并进那一页（`merged`）；整页锚点落成一张新页 → 改名（`renamed`）。
3. 标题新出现的页：整页锚点来自某一页 → 从它拆出来（`split`）。
4. 都不认得才是 `added` / `removed`。

只挪走几块不算「整页落进另一页」：块的串门在 `blocks` 里报 `moved`，页列表保持干净。

章节同理：先按标题配；改了名的章节按「这一章里有哪些块」配；最后剩下的才是新增 / 删除。

## 3. 基准

```text
<文档目录>/.doc-workbench/state/baseline.json
```

```json
{
  "contract": "planners-doc-baseline/1",
  "sha256": "9f2c…",
  "taken_at": "2026-11-20T09:30:00.000Z",
  "chapters": [{ "index": 1, "title": "一、判断" }],
  "pages": [{ "chapter": 1, "index": 1, "title": "品类机会…", "anchors": ["b:7b057d"] }],
  "blocks": [{ "anchor": "b:7b057d", "page": { "chapter": 1, "page": 1 } }]
}
```

- **刷新时机**：模型侧取稿（`doc-command.mjs ... tasks`，以及模型身份的 `open`）时刷新；页面每 3 秒轮询
  `tasks` 看锁，是浏览器身份，**不刷新基准** —— 否则基准永远追着最新一版，diff 恒为空。
- 基准只记身份（章节 / 页 / 块锚点），不记正文。
- 模型还没取过稿时没有基准：`baseline_sha256` 为 `null`，四个列表都为空。不能把「没有基准」说成
  「所有章节、所有块都是新加的」。
- 基准文件坏了不静默清空：报 `baseline_state`，让人看见。

## 4. 孤儿批注

提交时，草稿的目标块已经不在当前文档里（人删了、模型删了、别的工具删了）：

- 这条批注**留在草稿里**（不提交、不静默消失），回执 `orphaned` 里带 `{note, text, anchor, reason}`；
- 同一批的 `diff.orphan_notes` 带 `{note, text, reason}`（形状见第 1 节），模型读任务时一并看到。

如果整批批注都失去了目标，提交本身会被拒（`notes_orphaned`）：没有可派发的任务。

## 5. 读取入口

diff 随任务一起落盘、随 `tasks` 回执返回，**没有第二条命令**：

```bash
node scripts/doc-command.mjs <review-surface.json> tasks   # 模型侧读取；任务的 diff 字段就是这一份
node scripts/doc-inbox.mjs list <文档路径>                  # 无插件宿主：收件箱任务里同一份 diff
```

任务形状见 `contracts/planners-doc-task.md`（`diff` 字段）；批注三态见 `planners-doc-notes/1`
（`scripts/lib/doc-notes.mjs`）。
