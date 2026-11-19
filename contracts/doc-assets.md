# doc-assets/1 · 图资产清单契约

一份文档引用的图（位图或 SVG）登记在一份清单里。清单是**派生索引**，不是第二个真源：

- 正文里的 `![说明](相对路径)` 决定用哪张图、放在哪；
- 清单只记录那张文件**现在是什么字节**（`sha256` / `bytes` / `kind`）以及它绑在哪几个块身份上；
- 打开工作台时按正文重建清单，模型直接换掉文件后重开就登记新指纹，删掉图块条目随之消失。

素材取舍（用不用这张图、要不要处理、是否通过视觉检查）归 bypage 的 `asset-manifest/1.1.0`（票 09），
不在本契约里。理由见文末「为什么不沿用 asset-manifest/1.1.0」。

- 唯一校验器：`scripts/validate-doc-assets.mjs`
- 实现：`scripts/lib/doc-assets.mjs`
- 样例：[`examples/storyline.assets.json`](examples/storyline.assets.json)、[`examples/by-page.assets.json`](examples/by-page.assets.json)

## 1. 文件位置

清单与被引用的文档**同名同目录**，扩展名换成 `.assets.json`：

| 文档 | 清单 |
|---|---|
| `.planners/storyline.md` | `.planners/storyline.assets.json` |
| `.planners/by-page.md` | `.planners/by-page.assets.json` |

这样一份文档只有一份清单，`storyline` 与 `by-page` 共享 `assets/` 目录也不会互相覆盖。
校验器也接受 `--manifest <path>` 显式指定。

## 2. 形状

```json
{
  "contract": "doc-assets/1",
  "doc": "storyline.md",
  "assets": [
    {
      "path": "assets/positioning-map.svg",
      "kind": "svg",
      "sha256": "231f8db54ebe03d3a9cad3d731bf37d698a312ad8e33f871206ef94fcdacb897",
      "bytes": 2253,
      "anchors": ["b:e3d281"],
      "alt": "剂量与场景的竞争空白"
    }
  ]
}
```

| 字段 | 必填 | 含义 |
|---|---|---|
| `contract` | 是 | 固定为 `doc-assets/1` |
| `doc` | 是 | 清单所属文档的文件名（`basename`），与清单同目录 |
| `assets[]` | 是 | 正文引用到的图，按在正文里首次出现的顺序 |
| `assets[].path` | 是 | Markdown 引用里的**原样**相对路径；相对文档目录解析 |
| `assets[].kind` | 是 | `svg` 或 `bitmap`（按扩展名） |
| `assets[].sha256` | 是 | 文件当前字节的 SHA-256，小写十六进制 |
| `assets[].bytes` | 是 | 文件当前字节数 |
| `assets[].anchors` | 是 | 引用这张图的块锚点，按块在正文中的顺序；段落里的行内图算所在段落的锚点 |
| `assets[].alt` | 是 | 第一次引用时的 `说明`（可为空字符串） |
| `assets[].replaced_from_sha256` | 否 | 只在上一次同步时文件字节不同才出现：记**上一版**的 SHA-256 |

规则：

- **只登记取得到的文件**。路径不存在、不是文件时条目缺席，不编造哈希；缺图本身由 `validate-doc.mjs` 的 `image_missing` 报。
- **正文没引用的文件不进清单**。清单不替人决定「这张图该不该用」。
- **路径必须相对且落在文档目录内**；绝对路径、`http(s)://`、`..` 越界都算错。
- **锚点全局唯一**。同一个路径被多个块引用时，`anchors` 列出全部；块移动后锚点不变，清单不需要跟着改。
- 文本编辑**不会**让清单失效：清单不记录文档哈希。图块之外的正文改了，清单一个字都不用动。

## 3. 工作台行为

- **就地显示**：按引用路径从 `/asset?path=…` 取图；SVG 与位图一样走 `<img>`，不内联进 DOM。
- **取不到**：图片加载失败时块内标「未能加载 · 路径」，可点「重试」；不画占位图、不假装成功。
- **点击放大**：浮层里可滚轮 / 按钮缩放（25%–800%）、切「适应窗口」与「1:1」；只读，不改块、不发写请求。
- **换文件**：`POST /api/asset/replace` 的请求只有块身份、图字节与基线：

  ```json
  {"anchor": "b:e3d281", "content_base64": "…", "base_sha256": "…"}
  ```

  用哪张图由正文引用决定，**请求里没有路径**，所以换图在结构上不可能改掉引用路径；正文一个字节都不写。
  服务端先拒锁定块（`block_locked`），再按 `base_sha256` 拒过期写入，然后按扩展名校验真实字节
  （PNG / JPEG / GIF / WebP / AVIF / SVG 签名），最后原子替换文件并同步清单。
- **模型直接换文件**：工作台不拦文件系统；下次打开时按磁盘重新登记新指纹，正文引用同样不动。
- **SVG 隔离**：`/asset` 只发图片 MIME；SVG 响应带 `Content-Security-Policy: sandbox; script-src 'none'` 与
  `X-Content-Type-Options: nosniff`。页面只用 `<img>` 加载它 —— 图里的脚本不执行，单独打开也一样。

## 4. 校验

```bash
node scripts/validate-doc-assets.mjs <storyline.md|by-page.md>            # JSON 回执
node scripts/validate-doc-assets.mjs <storyline.md|by-page.md> --text    # 人读输出
node scripts/validate-doc-assets.mjs <doc> --manifest <path>             # 指定清单
```

退出码：`0` 合规、`1` 不合规、`2` 用法错误（没给路径 / 文件不存在）。

错误码：

| 码 | 什么时候 |
|---|---|
| `manifest_missing` / `manifest_syntax` | 清单不存在，或不是合法 JSON |
| `contract_version` | `contract` 不是 `doc-assets/1` |
| `doc_mismatch` | 清单的 `doc` 不是这份文档的文件名 |
| `assets_type` / `asset_shape` | `assets` 不是数组，或条目不是对象 |
| `asset_path` | `path` 不是相对路径 / 不在文档目录内 |
| `asset_missing` | 正文引用了图，但文件不在磁盘上 |
| `asset_unregistered` | 正文引用了、文件也在，但清单没登记 |
| `asset_unreferenced` | 清单登记了，但正文没引用 |
| `asset_duplicate` | 同一路径在清单里出现两次 |
| `asset_kind` / `asset_hash_mismatch` / `asset_bytes_mismatch` | 类型、指纹或字节数与磁盘不一致 |
| `asset_anchors` / `asset_alt` | 绑定的块身份或 `alt` 与正文不一致 |
| `asset_lineage` | `replaced_from_sha256` 形状不对，或等于当前指纹 |

校验器只报告三边差异，**不自动修复**：修复方式是打开一次工作台（重建清单）或换回对应文件。

## 5. 为什么不沿用 `asset-manifest/1.1.0`

bypage 的 `asset-manifest/1.1.0` 记录的是**素材取舍**：`semantic_class`（内容证据 / 叙述 / 品牌…）、
`status`（未审 / 采用 / 备用 / 排除）、`processing_level`、`visual_check`、来源索引。这一票的问题不是
「选哪张图」，而是「文档里已经引用的这张图现在是什么字节」。直接沿用那份结构会有三个后果：

1. **编造内容判断**：给流程图填 `semantic_class: narrative`、`status: selected` 不是任何人的决定，
   是把没有的元数据写成事实；
2. **两份真源**：素材取舍归票 09 的资产流程，文档工作台再写一遍就会与它漂移；
3. **跨 Skill 依赖**：那份契约的校验器在 `planners-bypage`，本模组不能为了校验一张文档插图去依赖另一个 Skill。

所以这里只沿用含义相同的字段名（`path` / `kind` / `sha256`，旧名 `source_sha256` / `bytes`），
新增文档侧需要的 `doc`、`anchors`、`replaced_from_sha256`；取舍与来源字段一个都不碰。

## 6. 它不做什么

- 不做上传落盘与多段落点治理（bypage 资产清单流程，票 09）。
- 不评价图的内容、不检查裁切与视觉质量。
- 不把交互式图表放进文档；交互版只在需要时以链接给出（SPEC 第 8 节）。
- 不阻止模型直接改文件；它只保证「再打开时清单说的是磁盘上的真相」。
