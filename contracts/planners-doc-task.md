# planners-doc-task/1 · 块级反馈任务契约

工作台的块级反馈只派发「一条任务」：人选中几块、写下意见，工作台把**块身份 + 提交时的内容指纹**装进任务；模型按任务读工作稿、只改这几块。任务不进正文，不改文档字节；它和工作台的锁一样，是旁路状态。

- 形状由工作台 `scripts/lib/doc-tasks.mjs` 产生，页面不自己拼任务。
- 任务**不携带全文**，也不携带块 raw。模型要改哪块，按 `doc.path` 读文件、按 `anchor` 定位。
- 本版任务只在工作台运行期间存在。落盘派发（无插件）与唤醒模型属于 `07 无插件派发`；同块双改的「待核对」属于 `04 待核对与并发`。

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
| `status` | `pending` → `processing` → `done` |
| `created_at` / `started_at` / `finished_at` | ISO 时间；后两个在 claim / complete 时写入 |

`sha256(block.raw)` 是**提交那一刻**的块内容指纹，不是当前磁盘指纹。模型侧用它判断「这块还是不是我当时看到的那一版」；不一致时把这块交给 04 的待核对，不要静默覆盖。

## 2. 命令面

| 命令 | 谁调用 | 回执 | 副作用 |
|---|---|---|---|
| `POST /api/feedback` | 页面 | `{ok, task}` | 创建 `pending` 任务。请求体 `{scope, text, anchors?}` 或 `{scope: "page", page, text}` 或 `{scope: "doc", text}` |
| `GET /api/tasks` | 模型 / 07 | `{ok, contract, tasks}` | 只读；模型侧靠它取待办 |
| `POST /api/task/claim` | 模型 | `{ok, task}` | `pending → processing`，锁定 `task.blocks`；同一任务重复 claim 幂等 |
| `POST /api/task/complete` | 模型 | `{ok, task}` | `processing → done`，只解自己持有的锁；重复 complete 幂等 |

请求体都带 `task_id`（也接受 `id`）。错误码：

| 码 | 什么时候 |
|---|---|
| `feedback_text` / `feedback_scope` / `feedback_request` | 意见为空、范围非法、请求不是 JSON 对象（400） |
| `feedback_anchor` / `feedback_page` | 锚点不存在、页身份对不上、同块提交两次（409，先刷新工作台） |
| `block_locked` | 目标块正被另一条任务处理（409）；保存锁定块也返回它 |
| `task_missing` / `task_state` | 任务不存在、或状态不允许这一步（409） |
| `task_stale` | claim 时任务绑定的块已不在文档里（409，重新提交反馈） |

`GET /api/doc` 的块视图同时给出 `sha256`、`locked`、`locked_by`：`locked_by` 是持有该块的任务 id，没有锁为 `null`。

## 3. 锁

- **派发不锁块，模型开始处理才锁**（claim）。`pending` 只是「等人/模型来读」。
- 锁的粒度为块：同一任务处理的块显示「模型正在改这一段」且不可编辑，其余块照常编辑、照常保存。
- 保存路径在服务端再拦一次：锁定块返回 `block_locked`，磁盘一个字节都不动。
- complete 只解自己持有的块；别的任务占着的块不受影响。

## 4. 给后续票的接口

- **04 待核对与并发**：`task.blocks[].sha256` 是提交基线，`board.lockOf(anchor)` 是占锁任务；完成 / 应用 patch 时比对当前 `sha256(block.raw)` 与基线，只把变化的那一块标待核对，其余照常落盘。锁表在 `scripts/lib/doc-tasks.mjs`，按块扩展即可。
- **07 无插件派发**：`startDocWorkbench({ onTask })` 在任务创建后回调（失败只报错，不影响已创建的任务）；或轮询 `GET /api/tasks` 把 `pending` 任务写进本地收件箱。有插件时的唤醒与无插件时的落盘必须消费同一个 `task` 形状，不要另造一份。
