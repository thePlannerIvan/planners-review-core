---
contract: planners-doc/1
doc: storyline
project: DSH 插件上游
---

# DSH 插件补丁包 —— 向上游贡献用

## 概述

### 原文开头

这是给两个 DSH 社区插件做的新功能/修复，整理成标准 git 补丁，方便提交 Pull Request 回上游。

## 项目信息

### 概览

| 插件 | 仓库 | 版本 | License |
|---|---|---|---|
| dsh-better-sidebar（文件树） | https://github.com/omdsh-dev/DSH-better-sidebar | 0.10.3（npm） | MIT |
| dsh-at-file（@文件引用） | https://github.com/omdsh-dev/dsh-at-file | main（GitHub tarball） | MIT |

## 补丁清单

### 01-dsh-better-sidebar-file-management.patch —— 文件树基础文件管理（PR 候选 #1）

基于 `dsh-better-sidebar@0.10.3`，改动 4 个文件（全部在 `src/`，`lib/` 是构建产物不提交）：

- **`src/fs-tree.ts`**：文件树不再显示 macOS Finder 垃圾文件（`.DS_Store`、`.localized`），隐藏文件（`.env`、`.git` 等）照常显示。
- **`src/index.ts`**：host 端新增 5 个 API（`/sidebar/api` 路由）：
- `fs.mkdir` / `fs.create` —— 新建文件夹 / 空文件（`wx` 防覆盖）
- `fs.rename` —— 同目录重命名
- `fs.move` —— 移动到目标目录（拖拽用）
- `fs.remove` —— 递归删除（拒绝删除工作区根目录）
- 全部带安全边界：目标必须在会话工作区内（越界 403）、名字必须是单个路径段（拒绝 `..`、`/`、`\`）。
- **`src/client/api.ts`**：客户端 5 个对应方法。
- **`src/client/ExplorerView.tsx`**：VS Code Explorer 式交互：
- 文件夹行 hover 出现"新建文件 / 新建文件夹"按钮（根目录行也有），行内输入命名，Enter 确认 / Esc 取消，未展开目录自动展开
- 右键菜单：新建文件 / 新建文件夹 / 重命名（行内改名）/ 删除（两步确认，不可恢复）
- 文件、文件夹可拖拽到文件夹行 / 根目录 / 空白区域移动，目标行蓝色高亮；不能拖进自身或子目录
- 变更后自动刷新受影响层级、清理被移动/删除目录的缓存与展开状态；错误显示在顶部横幅（4 秒自动消失）

### 02-dsh-at-file-space-in-path.patch —— @引用 支持含空格的文件名（PR 候选 #2）

基于 `dsh-at-file` GitHub main（**新架构**：只注入路径引用、不读文件内容），只改 `src/mention.ts`：

- **问题**：原正则 `@([^\s@]+)` 在空格处截断路径，`@AI 很奇怪.md` 会被切成不存在的 `AI`，静默失效。
- **修复**：匹配到行尾（允许空格），完整路径优先；失败时回退到空格前片段（`@README.md 的内容` 仍能解析出 `README.md`）；自动剥离尾部句子标点（，。！？等）。

> ⚠️ 注意：旧版 at-file 的"二进制/超大文件跳过不炸整轮"修复**不需要提交**——上游新架构根本不读取文件内容，该问题天然不存在。本地的 `src/files.ts`、`src/mention.ts` 改动是给旧版（0.1.0）打的补丁，别拿它提交 PR。

## 提交 PR 步骤

### 概览

```bash
# 以 better-sidebar 为例
git clone https://github.com/omdsh-dev/DSH-better-sidebar
cd DSH-better-sidebar
git checkout -b feat/explorer-file-management

# 应用补丁（-p1 对应 a/src/... b/src/... 风格）
git apply --check 01-dsh-better-sidebar-file-management.patch
git apply 01-dsh-better-sidebar-file-management.patch

# 上游 CI 会跑 typecheck + 测试 + build，提交前先自测
pnpm install
pnpm run typecheck
pnpm test
pnpm run build

git add -A && git commit -m "feat(explorer): basic file management (create/rename/move/delete + drag & drop)"
git push -u origin feat/explorer-file-management
# 然后去 GitHub 创建 PR，PR 描述可参考 patches/PR-DESCRIPTIONS.md
```

at-file 同理，clone 后应用 `02-dsh-at-file-space-in-path.patch`。

## 注意事项

### 概览

1. **只提交 `src/`**：`lib/` 是构建产物（`pnpm run build` 生成），上游合并后自己会重新构建。
2. **提交前务必过 `pnpm run typecheck && pnpm test`**：本补丁在本机只做过逻辑冒烟测试，未跑上游测试套件（工具链不在本机）；如果有测试因行为变更失败（比如 at-file 的 `mention.spec.ts` 期望旧返回类型），需要同步更新测试再提交。
3. better-sidebar 的新菜单文案目前是硬编码中文（"新建文件/重命名/删除"等），与插件现有 `t()` 国际化风格不一致——上游如果要求 i18n，需要把文案并入 `src/client/locales.ts`。
4. 先看两个仓库的 README 是否有贡献说明（CONTRIBUTING），没有就按常规 PR 流程。
