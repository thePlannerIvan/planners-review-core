# Security Policy

## Supported version

安全修复优先应用于 `main` 分支的最新版本。

## 报告安全问题

请不要先创建公开 Issue。将复现条件、受影响版本、风险和建议修复方式发送至：

- Email：Lawyif@163.com

收到报告后会尽快确认。修复完成或风险得到控制后，再协商是否公开披露。

## 本模组的攻击面

Planners Review Core 会在**没有 DSH 插件**时起一个本地宿主（`scripts/serve-review.mjs`），它同时是页面服务器和文件写入端。它应当：

- 只绑定 `127.0.0.1`，不向公网暴露；
- 把页面、资产、反馈文件与 `watch` 的范围**限制在 surface 文档声明的那棵树之内**（校验器与宿主都做包含性校验，拒绝符号链接逃逸与 `..` 穿越）；
- 不在日志、状态文件或反馈文件中保存 token、cookie、密码和密钥；
- 只在 `capabilities` 显式声明 `asset-upload` 时才接受上传，并限制文件类型与大小；
- 审阅结束后停止不再需要的本地服务（`stop` / `pid` / `state` 给出干净的生命周期）。

`wake` 与 `write` 只落文件、只写本地日志，不发起任何出站网络请求。

如果 fork 改为监听 `0.0.0.0`、加入远程上传或外部数据接口，维护者必须自行补充认证、授权、CSRF、防注入、文件类型和大小限制。

## 敏感资料

不要向公开仓库提交客户 Brief、研究数据、未发布内容、审阅工作目录、环境变量、浏览器状态或内部测试材料。本仓库的审阅产物由 `.gitignore` 覆盖（`review_host.json` / `review_host.log` / `wake-log.jsonl`），请勿强行 `add -f`。
