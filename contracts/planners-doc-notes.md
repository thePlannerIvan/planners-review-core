# planners-doc-notes/1 · 批注契约

右侧抽屉里攒的意见：人可以在正文里一块一块地批，也可以对**整份**稿子说一句；草稿跨页、跨天、
关掉浏览器都还在，底部「提交模型 · N」把这一批装成**一条**任务。模型改到的自动进历史批注，
没改到的如实标出来。

- 落盘：`.doc-workbench/notes.json`；主文件超过 2 MB 时最老的归档搬进 `.doc-workbench/notes-archive.json`。
- 唯一实现：`scripts/lib/doc-notes.mjs`（读写、校验、三态、归档、2 MB 搬迁）；`scripts/lib/doc-session.mjs`
  只做业务判断（哪条失去目标、这一批怎么派发）。
- 任务形状见 [`planners-doc-task/1`](planners-doc-task.md)，批次随附的结构 diff 见
  [`planners-doc-diff/1`](planners-doc-diff.md)。

## 1. 文件形状

```json
{
  "contract": "planners-doc-notes/1",
  "notes": [
    {
      "id": "n:7f3a2c10",
      "scope": "blocks",
      "anchor": "b:7b057d",
      "page": { "chapter": 1, "index": 2 },
      "text": "这句太虚，补一个数字。",
      "state": "draft",
      "batch": null,
      "created_at": "2026-11-20T08:00:00.000Z",
      "resolved_at": null,
      "model_state": null,
      "snapshot": null
    }
  ]
}
```

| 字段 | 含义 |
|---|---|
| `contract` | 固定 `planners-doc-notes/1`；文件里只认这个版本 |
| `id` | 批注身份，`n:` + 8 位小写十六进制 |
| `scope` | `blocks`（落在一块上）或 `doc`（针对整份文档）。**老文件没有这个字段时按 `blocks` 读** |
| `anchor` | `scope: "blocks"` 时是块锚点（`<!-- b:… -->`）；`scope: "doc"` 时**必须是 `null`** —— 整份意见没有锚点，硬挂一块就是伪造 |
| `page` | `{chapter, index}`：块级批注当初在第几章第几页；`scope: "doc"` 时为 `null` |
| `text` | 人写的那句话，非空，≤ 2000 字 |
| `state` | `draft` → `committed`（提交批次）→ `resolved`（模型改到，已归档） |
| `batch` | 提交时的批次号 `b:` + 12 位小写十六进制；草稿为空 |
| `created_at` / `resolved_at` | ISO 时间；`resolved_at` 是模型回执落盘的时间 |
| `model_state` | `null`，或 `"untouched"`（模型看了任务却没动这条）；这是**结构化状态**，页面不靠文案猜 |
| `snapshot` | 归档时存的改前 / 改后：块级是块 raw，`scope: "doc"` 是整份文档的 raw；草稿与未归档为空 |

校验与归一化在 `readState`：坏 JSON、契约名不对、`scope` 非法、块级没有合法锚点、整份带了锚点
都会报 `notes_state`，**不静默清空**。缺 `scope` 的旧条目补成 `blocks`。

## 2. 命令面

页面只发 `{route, body}`，本地宿主与侧栏桥共用同一套动作名：

| 动作 | 本地路由 | 请求体 | 回执 |
|---|---|---|---|
| `notes` | `GET /api/notes` | — | `{ok, contract, notes}`：主文件 + 档案合成一份 |
| `note_add` | `POST /api/note` | `{anchor \| anchors, text}` 或 `{scope: "doc", text}` | `{ok, contract, note, added, notes}` |
| `note_delete` | `POST /api/note/delete` | `{id}` | `{ok, contract, removed, notes}`；只删 `draft` |
| `note_reopen` | `POST /api/note/reopen` | `{id}` | `{ok, contract, note, notes}`：已提交 / 已归档 → 草稿（档案里的那条先搬回主文件） |
| `note_submit` | `POST /api/note/submit` | `{}` | `{ok, contract, batch, task, committed, orphaned, diff, notes}` |

- `scope: "doc"` 的 `note_add` **不接受** `anchor` / `anchors`（`note_scope`）：整份批注没有锚点，
  它随后进批次、进任务时目标写「整份」。
- 一批 = 一条任务：同块的块级批注只绑一块；有整份批注时任务 `scope` 是 `"doc"`，
  `blocks` 只装块级批注点名的块（可以为空），整份批注不伪造锚点。
- 失去目标的**块级**草稿不静默消失：留在 `draft`，回执 `orphaned` 带 `{note, text, anchor, reason}`，
  同一批的 `diff.orphan_notes` 也带一份。整份批注没有目标块，永远随批次走。
- 目标块正被模型处理（`block_locked`）时不提交这一批，草稿一条不动。
- 提交不是保存、也不是批准：它只建任务与落盘批次，唤醒由入口决定。

## 3. 归档

归档不由人点（ADR 0007），以模型回执的 `applied` 为准：

- 块级批注：这一块的锚点在 `applied` 里 → `resolved`，`snapshot = {before, after}` 是块 raw。
- 整份批注：这一批确实改到了文档（`applied` 非空）→ `resolved`，`snapshot` 是**整份文档**的改前 / 改后 raw。
- 模型 claim 后直接 complete、或这一批一块都没改 → 留在 `committed` 并 `model_state: "untouched"`，
  进历史批注面板如实标出「模型没动这条」，可重新打开回草稿。
- 只归档本批次（`batch` 相同）的批注；别的批次不被顺带改状态。

## 4. 错误码

| 码 | 什么时候 |
|---|---|
| `note_request` / `note_text` / `note_id` | 请求体不是 JSON 对象、批注为空或超长、缺 id（400） |
| `note_scope` | `scope` 不是 `blocks` / `doc`，或整份批注带了锚点（400） |
| `note_anchor` | 块级批注的锚点形状不对、块已不存在、同一块出现两次（400 / 409） |
| `note_state` | 已提交的批注不让删、还是草稿不用重新打开（409）；批注文件形状不对也用它（409） |
| `note_missing` | 找不到这条批注（400） |
| `notes_empty` / `notes_orphaned` | 没有草稿可提交、这批草稿的块都没了（400） |
| `block_locked` | 这批点名的块正由模型处理或待核对（409） |
