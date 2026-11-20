# 冻结的迁移输入

`storyline-v1.md` 是硬切到 `planners-doc/2` 之前那份真实样例的**逐字副本**（含锚点与图片引用），
只作 `evals/test_doc_migration.mjs` 的输入：证明「现有 storyline.md 迁得动，块锚点与块内容不动」。

它不是一条兼容读取路径：`planners-doc/1` 的文档在工作台与校验器里都会被拒（`contract_version`），
唯一能读它的是 `scripts/migrate-doc.mjs 1 2 <file>`。改契约时不要改这份文件——它是历史基线。
