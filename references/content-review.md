# 内容审阅壳

可选，不是所有任务的统一 UI。唯一实现：`assets/content-review/`；DSH 令牌仍只取 `assets/dsh-tokens.css`。生产方通过公共模组解析器 import `scripts/render-content-review.mjs`，不复制壳、桥或令牌。

## 当前交互约定

修改内容审阅工作台及调用方之前读取本节。它是当前规则；历史设计和 legacy 兼容入口不能覆盖它。

- 用户编辑文字、支撑点、备注、页序或内容资产后，系统自动保存到当前正式主稿；DSH 与本地浏览器一致。界面提供保存中、已自动保存、失败或冲突状态，不提供手动保存按钮，也不把保存绑在提交批注上。
- 版本管理用于查看历史并恢复。恢复保留既有记录，将选中内容作为新的修改自动保存；版本基线不兼容时保留当前内容并说明原因。
- 批注与整体意见是请求模型处理的任务。提交前系统自动完成尚未落盘的内容修改，再将任务绑定到该版本。保存和提交都不是批准。
- 网络或宿主失败时保留草稿并明确提示，不能用成功状态掩盖未落盘。底层 `save` API 是内部机制，不对应一个用户保存动作。

新增宿主、重做界面或调整交接时，遵循同一规则并清理调用方的旧说明。验收应覆盖无需点击即可落盘、刷新恢复、版本恢复保留历史，以及不存在手动保存入口。

## 输入与展示

`renderContentReview(options)` 接受 `reviewKind`、`feedbackContractVersion`、`sourceSha256`、`draftPath`、`thesis`、`sections`、`pages` 和 `allowUploads`。缺少内容不编造补位文字；项目名称不写进公共壳。

- 章节：稳定 `section_id`，`title`、`lead`、`transition`。有章节时连续展示；没有时只展示逐页稿。
- 页面：原始 `page_number` 是本轮稳定身份，`section_id` 连接章节；标题 `title`、判断 `claim`；结构块用 `blocks[{title,text}]`，完整稿用 `sections[{label,value,collapsed,editable}]`。
- 仅 legacy：`default_decision` 由生产方提供；上一轮要求修改与事实例外为 `null`，必须人明确决定。`prior` 只读，不预填意见。
- 图片、事实例外和上传权限只由生产方传入，不要求所有任务都有。Markdown 图片走桥，页面内 blob URL 不回写正文。

## 保存与任务

默认是 `content-workbench/1`：编辑、拖动、图片上传先进入页面状态；`draft` 保存可恢复草稿；`command({op:'save'})` 在 revision 校验通过后原子回写 canonical 主稿；`command({op:'feedback'})` 只追加带 revision/source_hash/pages 的 pending task。两种宿主自动保存并调用同一后端，均以回执为准。冲突时保留草稿，不能覆盖用户或外部修改。

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

Proposal 3.0 使用 `simpleStoryline: true`：行文字映射为唯一 claim，blocks 文本列表映射 supports，notes 为正文备注；隐藏重复的逐页标题/claim 编辑入口。新页可暂时没有支撑，完整性由交接检查承担。
