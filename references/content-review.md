# 内容审阅壳

可选，不是所有任务的统一 UI。唯一实现：`assets/content-review/`；DSH 令牌仍只取 `assets/dsh-tokens.css`。生产方通过公共模组解析器 import `scripts/render-content-review.mjs`，不复制壳、桥或令牌。

## 当前交互约定

修改内容审阅工作台及调用方之前读取本节。它是当前规则；历史设计和 legacy 兼容入口不能覆盖它。

- 故事线一页一行，正文（主张、支撑、依据与边界）点哪改哪，不经过展开或编辑模式；支撑按 Enter 增一条、空行按 Backspace 删一条。悬停行首出现拖动把手，拖到目标位置调整页序（也可 Alt+↑↓）；拖动只认把手，选文字不会误触。
- 每页行尾的批注按钮打开行内批注卡，写这一页要改什么并单独提交；模型只处理这一页，其他页可以继续改。行内批注与右侧“本页批注”是同一份内容。
- 用户编辑文字、支撑、备注、页序或内容资产后，系统自动保存到当前正式主稿；DSH 与本地浏览器一致。界面显示保存中、已自动保存、失败、待核对或待刷新状态，不提供手动保存按钮，也不把保存绑在提交批注上。
- 保存按页校验：模型改过 A 页不影响用户保存 B 页，模型对 A 页的改动也不会被 B 页的保存覆盖。用户与外部改动命中同一页时，只有那一页标“待核对”，其余页照常落盘；人明确选择“保留我的”或“用模型版”，不静默覆盖。
- 模型处理反馈后会重新生成工作台。页面内嵌数据过期时显示“待刷新”并暂时只读；未保存编辑留在草稿里，刷新后由人决定是否让模型合并，不用旧页面保存去覆盖新主稿。
- 版本管理用于查看历史并恢复。恢复保留既有记录，将选中内容作为新的修改自动保存；版本基线不兼容时保留当前内容并说明原因。
- 批注与整体意见是请求模型处理的任务。提交前系统自动完成尚未落盘的内容修改；任务按页绑定该页内容指纹与用户编辑版本，不锁整份文件。保存和提交都不是批准。
- 网络或宿主失败时保留草稿并明确提示，不能用成功状态掩盖未落盘。底层 `save` API 是内部机制，不对应一个用户保存动作。

新增宿主、重做界面或调整交接时，遵循同一规则并清理调用方的旧说明。验收应覆盖无需点击即可落盘、刷新恢复、模型改一页时另一页仍可保存、版本恢复保留历史，以及不存在手动保存入口。

## 输入与展示

`renderContentReview(options)` 接受 `reviewKind`、`feedbackContractVersion`、`sourceSha256`、`draftPath`、`thesis`、`sections`、`pages` 和 `allowUploads`。缺少内容不编造补位文字；项目名称不写进公共壳。

- 章节：稳定 `section_id`，`title`、`lead`、`transition`。有章节时连续展示；没有时只展示逐页稿。
- 页面：原始 `page_number` 是本轮稳定身份，`section_id` 连接章节；标题 `title`、判断 `claim`；结构块用 `blocks[{title,text}]`，完整稿用 `sections[{label,value,collapsed,editable}]`。
- 仅 legacy：`default_decision` 由生产方提供；上一轮要求修改与事实例外为 `null`，必须人明确决定。`prior` 只读，不预填意见。
- 图片、事实例外和上传权限只由生产方传入，不要求所有任务都有。Markdown 图片走桥，页面内 blob URL 不回写正文。

## 保存与任务

默认是 `content-workbench/1`：编辑、拖动、图片上传先进入页面状态；`draft` 保存可恢复草稿；`command({op:'save'})` 按页校验后原子回写 canonical 主稿；`command({op:'feedback'})` 只追加带 revision、pages 与页面指纹的 pending task。两种宿主自动保存并调用同一后端，均以回执为准。

- 单位指纹由生产方 adapter 的 `unitHashes(raw)` 提供（每页一段内容指纹）。`save` 把修改应用到磁盘上的当前文件，而不是工作台建基时那份字节，因此模型对其他页的改动会被保留。
- 同一页冲突：用户编辑过的页若已被外部改动，该页进入回执 `deferred_pages`，不写盘；页面保留这页编辑并标“待核对”，由人选择“保留我的”（下一次保存带 `force_pages`）或“用模型版”。
- 结构性修改（增删页、改页序）仍要求整份文件与 `head.state.page_order` 的基线一致，否则 `source_conflict`；页面提示刷新后重排，避免页号错位。
- 反馈任务带 `pages`（显示页号）、`page_keys`（本轮页身份）、`page_hashes`（提交时该页内容指纹）、`page_versions`（提交时用户编辑版本）与 `page_drift`（提交时磁盘上已变化的页）。提交批注只校验页集合未变，不再要求整份主稿一致；模型在 A 页工作时，B 页的批注照常可以提交。`resolve` 只要求任务仍为 pending，不再要求整份 revision/source_hash 相等；回执的 `stale_pages` 提示提交后用户又改过哪些页，模型应先核对再声明完成。
- `state` 回执带 `head.context.sourceSha256`（页面内嵌数据是否过期）与 `external_pages`（模型改过、页面尚未编辑的页）。页面用前者决定是否提示刷新，不因整份文件变化把自己锁成只读。

`feedback` 文件和 `review-inbox.mjs` 只属于显式 `--legacy-review true` 的旧项目续接。legacy 模式下，编辑先写 draft，提交后才 `write`，再由生产方运行 inbox；普通 Workbench 不运行 inbox，也不把保存称为批准。

仅 legacy 提交保留生产方原生 feedback 字段，另带 `review_changes`：

```json
{"contract_version":"content-review-edits/1.0.0","edits":{"pages":{},"sections":{}},"page_order":[1,2],"section_order":["sec-one"]}
```

`edits.pages` 以原始页号为键，允许 `title`、`claim`、按索引修改 `blocks` 的 `title/text` 或可编辑 `sections` 的 Markdown 字符串。`edits.sections` 以稳定章节 ID 为键，允许 `title/lead/transition`；核心判断修改存 `edits.thesis`。1.0 编辑保持原单位完整排列；1.1 可显式声明 added_pages/deleted_pages，页序必须覆盖当前全部活动页面。

builder 调用 `writeReviewContext(dir,context)` 保存源文件指纹及原始单位。草稿按源指纹隔离；有未保存文字时拒绝悄悄换成新版。Workbench 后端用 journal + CAS 回写原生内容，记录 revision/history，并在回执中返回 page_mapping 与 `requires_fact_recheck`。正文变化是否重新核查、是否需要用户确认，归生产方决定。legacy inbox 只在显式兼容分支调用 `validateChanges`、adapter 和原生反馈校验。

Markdown 由 vendored Marked 17.0.5（MIT）解析，取自本机 bundled Node runtime 的 `marked/lib/marked.umd.js`，许可证同目录保存；不执行材料中的 HTML 或脚本。页面包含全部依赖，可由不透明 iframe 内联加载。

## 验证

`evals/check-content-render.py --html <入口>` 验离线和握手超时渲染；`evals/exercise-content-review.py --surface <surface> [--opaque]` 验生产方真实入口的编辑、图片、排序、落盘、恢复、提交与版本变化。需要测试环境的 Python Playwright；生产运行仍只需要 Node。原生稿回写与交接断言在各生产方 evals 中，不由公共壳测试代替。

Proposal 3.0 使用 `simpleStoryline: true`：行文字映射为唯一 claim，blocks 文本列表映射 supports，notes 为正文备注；行内只维护一份主张与支撑，不重复显示逐页标题。新页可暂时没有支撑，完整性由交接检查承担。
