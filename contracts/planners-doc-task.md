# planners-doc-task/1 · 块级反馈任务契约

工作台的块级反馈只派发「一条任务」：人选中几块、写下意见，工作台把**块身份 + 提交时的内容指纹**装进任务；模型按任务读工作稿、只改这几块。任务不进正文，不改文档字节；它和工作台的锁一样，是旁路状态。

- 形状由工作台 `scripts/lib/doc-tasks.mjs` 产生，页面不自己拼任务。
- 任务**不携带全文**，也不携带块 raw。模型要改哪块，按 `doc.path` 读文件、按 `anchor` 定位。
- 本版任务只在工作台运行期间存在。落盘派发（无插件）与唤醒模型属于 `07 无插件派发`；同块双改的「待核对」由本契约第 4、5 节定义（04 已实现）。

## 1. 任务形状

```json
{
  "contract": "planners-doc-task/1",
  "id": "t:3f2a9c1b7d4e",
  "scope": "blocks",
  "page": null,
  "text": "把这两块写紧一点，只改这两块。",
  "doc": {
    "path": "/path/to/project/.planners/storyline.md",
    "contract": "planners-doc/1",
    "doc": "storyline",
    "project": "朗标笔试案"
  },
  "blocks": [
    { "anchor": "b:7b057d", "sha256": "9f2c…" },
    { "anchor": "b:81c4d0", "sha256": "41aa…" }
  ],
  "status": "pending",
  "created_at": "2026-11-19T12:00:00.000Z",
  "started_at": null,
  "finished_at": null
}
```

| 字段 | 含义 |
|---|---|
| `contract` | 固定 `planners-doc-task/1`。模型先认版本再消费 |
| `id` | 任务身份，`t:` + 12 位小写十六进制；claim / complete 用它 |
| `scope` | `blocks`（选区 / 块尾按钮）、`page`（整页）、`doc`（整份） |
| `page` | 仅 `scope: "page"` 时有值：`{chapter, number, title}`，与 `planners-doc/1` 的页身份一致 |
| `text` | 人的意见原文，非空；是「要模型改什么」，不是批准或保存 |
| `doc` | 任务对应的文档：绝对路径 + 文档头三元组。模型据此读文件 |
| `blocks` | 任务绑定的块，**只有锚点与 `sha256(block.raw)`**。顺序即提交顺序/文档顺序 |
| `status` | `pending` → `processing` → `review`（有待核对块）→ `done` |
| `locked_blocks` | 这条任务此刻还占着哪些块。`processing` 时是 `task.blocks` 的全部；写回后只剩待核对的块；`done` 为空 |
| `created_at` / `started_at` / `finished_at` | ISO 时间；后两个在 claim / complete 时写入 |

`sha256(block.raw)` 是**提交那一刻**的块内容指纹，不是当前磁盘指纹。模型写回时由服务端拿它和当前磁盘指纹逐块比对：一致才应用，不一致进待核对，不静默覆盖（第 4 节）。

## 2. 命令面

| 命令 | 谁调用 | 回执 | 副作用 |
|---|---|---|---|
| `POST /api/feedback` | 页面 | `{ok, task}` | 创建 `pending` 任务。请求体 `{scope, text, anchors?}` 或 `{scope: "page", page, text}` 或 `{scope: "doc", text}` |
| `GET /api/tasks` | 模型 / 07 | `{ok, contract, tasks}` | 只读；模型侧靠它取待办 |
| `POST /api/task/claim` | 模型 | `{ok, task}` | `pending → processing`，锁定 `task.blocks`；同一任务重复 claim 幂等 |
| `POST /api/task/complete` | 模型 | `{ok, task}` | `processing → done`，只解自己持有的锁；重复 complete 幂等 |
| `POST /api/patch` | 模型 | `{ok, contract, task_id, applied, deferred_blocks, sha256, task}` | 按块比对任务基线，一次写回多块：一致的落盘并解锁，不一致的进待核对并保持锁定（第 4 节） |
| `GET /api/conflicts` | 页面 / 模型 | `{ok, contract, conflicts}` | 只读待核对：每条带人的版本与模型的版本 |
| `POST /api/conflict/decide` | 人 | `{ok, contract, anchor, decision, written, sha256, block, task, deferred_blocks}` | 裁决一块：`mine` / `model` / `discard`，三种都解锁并删除待核对记录 |

请求体都带 `task_id`（也接受 `id`）。错误码：

| 码 | 什么时候 |
|---|---|
| `feedback_text` / `feedback_scope` / `feedback_request` | 意见为空、范围非法、请求不是 JSON 对象（400） |
| `feedback_anchor` / `feedback_page` | 锚点不存在、页身份对不上、同块提交两次（409，先刷新工作台） |
| `block_locked` | 目标块正被另一条任务处理（409）；保存锁定块也返回它 |
| `task_missing` / `task_state` | 任务不存在、或状态不允许这一步（409） |
| `task_stale` | claim 时任务绑定的块已不在文档里（409，重新提交反馈） |
| `patch_request` / `patch_blocks` / `patch_anchor` | 写回请求不是对象、patch 为空 / 不是文本 / 锚点重复、锚点不在这条任务里或文档里已不存在（400 / 409） |
| `block_conflict` | 人保存时整份基线与这一块的基线都过期（409，这一块在别处被改过；请刷新后再核对） |
| `conflict_request` / `conflict_anchor` / `conflict_decision` / `conflict_missing` / `conflict_stale` | 裁决请求形状不对、裁决值非法、没有这条待核对 / 块已不存在（400 / 409） |
| `locked` | 拿不到写锁（另一个工作台正在写盘，409，稍后重试） |

`GET /api/doc` 的块视图同时给出 `sha256`、`locked`、`locked_by`、`deferred`：`locked_by` 是持有该块的任务 id，没有锁为 `null`；`deferred` 有待核对时是 `{task_id, reason}`，否则 `null`。整份回执另有 `deferred_blocks: [{anchor, task_id, reason}]` 与 `journal`（`null`，或 `{state: "orphaned", path}` 表示有一笔被中断的写盘待人工核对）。

## 3. 锁

- **派发不锁块，模型开始处理才锁**（claim）。`pending` 只是「等人/模型来读」。
- 锁的粒度为块：同一任务处理的块显示「模型正在改这一段」且不可编辑，其余块照常编辑、照常保存。
- 保存路径在服务端再拦一次：锁定块返回 `block_locked`，磁盘一个字节都不动。
- 模型写回后只解已应用的块；进待核对的块继续锁着（任务状态变 `review`），人裁决后才解锁。
- complete 只解自己持有的块；别的任务占着的块不受影响。`review` 状态的任务不能直接 complete。

## 4. 模型写回与待核对

模型一次可以提交多块，请求体是任务 id 加 patch 列表：

```json
POST /api/patch
{
  "task_id": "t:3f2a9c1b7d4e",
  "patches": [
    { "anchor": "b:7b057d", "content": "模型改后的块 raw。" },
    { "anchor": "b:81c4d0", "content": "另一块的新 raw。" }
  ]
}
```

服务端逐块比对 `task.blocks[].sha256` 与当前磁盘上的 `sha256(block.raw)`：

- 一致 → 应用并解锁，anchor 进回执的 `applied`。
- 不一致 → 该块**不动磁盘**、保持锁定，进回执的 `deferred_blocks`；其余块照常落盘。
- 写回是任务进入 `processing` 之后的**终态动作**。有块待核对的 `review` 任务不能再写回。

回执里的 deferred 每一项只有判定信息，不带两个版本的正文：

```json
{
  "ok": true,
  "contract": "planners-doc-task/1",
  "task_id": "t:3f2a9c1b7d4e",
  "applied": ["b:81c4d0"],
  "deferred_blocks": [
    { "anchor": "b:7b057d", "reason": "block_changed",
      "base_sha256": "9f2c…", "disk_sha256": "41aa…" }
  ],
  "sha256": "整份写盘后的文件指纹",
  "task": { "status": "review", "locked_blocks": ["b:7b057d"], "...": "任务现状" }
}
```

`GET /api/conflicts` 才返回两个版本的全文，供人裁决：

```json
{"ok": true, "contract": "planners-doc-conflict/1", "conflicts": [
  { "contract": "planners-doc-conflict/1", "anchor": "b:7b057d", "task_id": "t:…",
    "reason": "block_changed", "base_sha256": "9f2c…", "disk_sha256": "41aa…",
    "disk_raw": "人改过的块 raw。", "model_content": "模型版块 raw。",
    "created_at": "2026-11-19T12:00:00.000Z" }
]}
```

裁决：

```json
POST /api/conflict/decide
{"anchor": "b:7b057d", "decision": "mine"}
```

| decision | 磁盘 | 是否写盘 | 回执 `written` |
|---|---|---|---|
| `mine` 保留我的 | 保持人当前版本 | 否 | `false` |
| `model` 用模型版 | 写入 `model_content` | 是（journal） | `true` |
| `discard` 放弃该块 | 保持人当前版本，放弃模型的这一块 | 否 | `false` |

三种裁决都会解锁该块、删除待核对记录；任务手里没有别的块时转 `done`，否则仍是 `review`。待核对队列只在工作台进程内存在（与任务、锁同生命周期），不跨重启恢复。

## 5. 写盘 journal 与崩溃恢复

所有写盘（补锚点 / 人保存 / 模型写回 / 裁决）都走同一个 journal，位置在文档同目录：

```text
<文档目录>/.doc-workbench/<文档文件名>.journal.json
<文档目录>/.doc-workbench/save.lock
```

- journal 存的是**完整的目标全文**（`raw`）加写前/写后整份指纹，不是块 patch。
- 顺序：写 journal（fsync）→ 原子替换文档 → 删 journal。进程在中间被打断，盘上只会留下「journal + 旧文档」或「journal + 新文档」。
- 启动时按当前磁盘指纹判：等于 `new_sha256` → 只删 journal；等于 `old_sha256` → 用 `journal.raw` 原子替换（未提交改动可恢复）；两者都不等 → 不覆盖，journal 改名成 `.orphaned` 留档，文档保持现状。
- 恢复写的是整份快照，不按锚点重拼，所以不会在文档里多出幽灵块；锚点集合与块数由恢复后的正文决定。
- `save.lock` 把跨进程的读-改-写串行化。人保存带 `base_block_sha256` 时，整份基线过期但这一块没变就按块合并（`merged: true`），两人改不同块都能落盘；同一块被改过则 `block_conflict`，不静默覆盖。

## 6. 给后续票的接口

- **07 无插件派发**：`startDocWorkbench({ onTask })` 在任务创建后回调（失败只报错，不影响已创建的任务）；或轮询 `GET /api/tasks` 把 `pending` 任务写进本地收件箱。有插件时的唤醒与无插件时的落盘必须消费同一个 `task` 形状，不要另造一份。
