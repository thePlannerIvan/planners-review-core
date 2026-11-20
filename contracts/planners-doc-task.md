# planners-doc-task/1 · 块级反馈任务契约

工作台的块级反馈只派发「一条任务」：人选中几块、写下意见，工作台把**块身份 + 提交时的内容指纹**装进任务；模型按任务读工作稿、只改这几块。任务不进正文，不改文档字节；它和工作台的锁一样，是旁路状态。

- 形状由工作台 `scripts/lib/doc-tasks.mjs` 产生，页面不自己拼任务。
- 任务**不携带全文**，也不携带块 raw。模型要改哪块，按 `doc.path` 读文件、按 `anchor` 定位。
- 任务、锁与待核对落在文档同目录的 `.doc-workbench/state/`，所以本地页、DSH 侧栏命令后端与模型 CLI
  即使不在一个进程里，也看到同一组锁；无插件时同一条任务另落一份本地收件箱（第 6 节）。
  同块双改的「待核对」由本契约第 4、5 节定义（04 已实现）。

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
    "contract": "planners-doc/2",
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
| `page` | 仅 `scope: "page"` 时有值：`{chapter, number, title}`，与 `planners-doc/2` 的页身份一致（章节 + 顺序 + 标题） |
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
| `POST /api/feedback` | 页面 | `{ok, task, dispatch}` | 创建 `pending` 任务。请求体 `{scope, text, anchors?}` 或 `{scope: "page", page, text}` 或 `{scope: "doc", text}`；`dispatch.channel` 是 `wake`（有插件）或 `inbox`（落收件箱） |
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
| `block_conflict` | 人保存 / 分块 / 合并时**同一块**在别处也被改过（409，停下来让两边核对；错误里点名锚点，`details` 带回 `disk_raw` 与 `your_content` 两版，磁盘不动） |
| `stale_document` | 整份基线过期且没带这一块的 `base_block_sha256`，无法判断是不是同一块（409，刷新后再保存） |
| `conflict_request` / `conflict_anchor` / `conflict_decision` / `conflict_missing` / `conflict_stale` | 裁决请求形状不对、裁决值非法、没有这条待核对 / 块已不存在（400 / 409） |
| `locked` | 拿不到写锁（另一个工作台正在写盘，409，稍后重试） |

`GET /api/doc` 的块视图同时给出 `sha256`、`locked`、`locked_by`、`deferred`：`locked_by` 是持有该块的任务 id，没有锁为 `null`；`deferred` 有待核对时是 `{task_id, reason}`，否则 `null`。整份回执另有 `deferred_blocks: [{anchor, task_id, reason}]` 与 `journal`（`null`，或 `{state: "orphaned", path}` 表示有一笔被中断的写盘待人工核对）。

## 3. 锁

- **派发不锁块，模型开始处理才锁**（claim）。`pending` 只是「等人/模型来读」。
- 锁的粒度为块：**只锁 `task.blocks` 里那几块**。它们显示「模型正在改这一段」且不可编辑，
  其余块照常编辑、照常保存。
- 保存路径在服务端再拦一次：锁定块返回 `block_locked`，**错误里点名是哪一块**，磁盘一个字节都不动。
- 文件在别处变了不预先拒绝：保存 / 分块 / 合并 / 重排都自动重读当前全文，把这次改动重放到新版本上
  （回执 `merged` / `replayed: true`）。只有重放到**同一块**（这一块的 `base_block_sha256` 也对不上）才返回
  `block_conflict` 停下来让人核对；重排只挪位置、不覆盖块内容，所以块还在就重放，块没了才返回
  `block_missing`。
- 分块（`/api/block/split`）与删空合并（`/api/block/merge`）同样先拒锁定块：
  锚点随内容走，块被锁着时改它的身份会和模型手里的基线打架。
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

三种裁决都会解锁该块、删除待核对记录；任务手里没有别的块时转 `done`，否则仍是 `review`。

任务、锁与待核对落在文档同目录的 `.doc-workbench/state/tasks.json` 与 `conflicts.json`（`planners-doc-board/1`）。所以本地页、DSH 侧栏的命令后端与模型侧的 `doc-command.mjs` CLI 即使不在同一个进程里，也看到同一组锁；每次写前在文档写锁里读回最新状态，避免两份旧板互相覆盖。

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

## 6. 无插件派发：本地收件箱

派发只有一个出口 `createTaskDispatcher`：有侧栏插件（`startDocWorkbench({ onTask })`）时把**同一个任务对象**
交给唤醒；没有插件时把**同一个任务对象**写进本地收件箱。两条路径不各自拼形状，模型侧不需要知道有没有插件。

**位置与文件名**

```text
<文档目录>/.doc-workbench/inbox/t-<12 位十六进制>.json
```

- 由任务 id `t:<12 位十六进制>` 派生，文件名把 `:` 换成 `-` 以便跨平台。
- 文件内容就是第 1 节的任务对象（含 `contract` / `id` / `blocks[].anchor` / `blocks[].sha256` / `text`），
  不另包一层、不复制块 raw 或全文。
- **一条任务一个文件**：重复派发同一条任务只覆盖同一个文件，不产生第二个条目。
- 收件箱是任务的落盘副本；任务板（含锁与待核对）落在 `.doc-workbench/state/`。模型在工作台运行时参与锁与写回：
  本地页走 `/api/task/claim`、`/api/patch`；侧栏或工作台不在时用 `scripts/doc-command.mjs <surface> claim|patch`，
  与本地的块锁判定是同一份实现。

**状态**

| 文件里的 `status` | 含义 |
|---|---|
| `pending` | 已派发，等人/模型来读 |
| `processing` | 模型已取走：写 `started_at`，`locked_blocks` 是这条任务占的块 |

`take` 之前的任务才是「未处理」。`take` 之后用 `list --all` 仍能看到它，却不会再被取第二次。

**模型读取入口**

```bash
node scripts/doc-inbox.mjs list <文档路径>          # 只列 pending，stdout 是 JSON
node scripts/doc-inbox.mjs list <文档路径> --all    # 连 processing / done 一起列
node scripts/doc-inbox.mjs take <文档路径> [--id <任务 id>]  # pending → processing
```

`list` 每条形如第 1 节的任务，模型据此拿 `doc.path` 读工作稿、按 `blocks[].anchor` 定位、
用 `blocks[].sha256` 对齐提交时的版本。`take` 幂等：没有待取任务时返回空列表，不报错。

## 7. 旧 JSON 主稿只读

`.proposal-work/page-architecture.json`、`.bypage-work/page-architecture.json` 这类旧 JSON **不迁移、不兼容读取**，
但可以被工作台**只读挂载**看一眼：`node scripts/doc-workbench.mjs <旧 JSON>`。

- 检测按扩展名 `.json`；打开时不补锚点、不恢复 journal、不写任何旁路文件。
- `GET /api/doc` 返回 `readonly: {reason: "legacy-json", message}`，页与块只作预览（块没有锚点、`readonly: true`）。
- 所有写入口（`/api/block`、`/api/reorder`、`/api/feedback`、`/api/task/*`、`/api/patch`、`/api/conflict/decide`、`/api/history/restore`）
  一律 `409 {code: "readonly", error: <可读原因>}`；磁盘一个字节都不动。
- 页面顶部显示「旧项目 · 只读」，不显示反馈入口、拖柄与编辑面；保存失败直接显示服务端原因。

## 8. 历史与恢复（SPEC 第 4 节）

- 每一次真正改变文档的写盘（人保存 / 分块 / 合并 / 重排 / 模型写回 / 裁决 / 补锚点 / 恢复）
  在写前把**上一版整份**存进 `.doc-workbench/history/<文档文件名>/`，一版一个 JSON 文件，
  记录 `contract` / `doc` / `sha256` / `bytes` / `operation` / `archived_at` / `raw`。
- 列表 `GET /api/history`（侧栏 `command({op:'history'})`）新的在前，每条带 id、时间、操作、
  指纹、字节数与首行摘要；读不出来的档进 `errors`，不静默跳过。
- 恢复 `POST /api/history/restore` `{id, base_sha256}`（侧栏 `command({op:'restore'})`）：
  按当前基线拒绝过期写入；有块被锁或待核对的整份恢复会覆盖它们，因此先拒（`block_locked`）。
  恢复走同一个 `commitDocument`，写前同样存档，所以恢复前的那一版会留下，旧档一个不删。
- 历史只追加；没有「删除某一版」的操作。
