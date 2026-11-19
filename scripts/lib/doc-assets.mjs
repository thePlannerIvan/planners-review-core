/**
 * `doc-assets/1`：一份文档引用的图资产清单。
 *
 * 为什么是**派生索引**而不是第二个真源：正文里的 `![说明](相对路径)` 才是「用哪张图」的
 * 唯一决定；清单只把「这句话指向的文件现在是什么」记下来（类型、字节数、sha256、绑定锚点）。
 * 因此：打开工作台按正文重建；模型直接换掉文件后重开就登记新指纹；删掉图块后条目自动消失。
 *
 * 它和 bypage 的 `asset-manifest/1.1.0` 不是一份东西：那份记录的是**素材取舍**
 * （semantic_class / status / processing_level / visual_check），归票 09 的资产流程；
 * 这里只回答「文档里的图现在是什么字节」，不评价、不选材。字段名只沿用含义相同的
 * `path` / `kind` / `sha256`（原名 `source_sha256`）/ `bytes`，其余都是文档侧新增。
 */
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, extname, resolve, sep } from 'node:path';
import { imageReferences, parseDocument } from './doc-blocks.mjs';
import { atomicWrite } from './doc-io.mjs';
import { sha256 } from '../content-review-contract.mjs';

export const ASSET_CONTRACT = 'doc-assets/1';

/** 工作台只把图片当资产发出去：扩展名 → MIME。同时也是 /asset 的白名单。 */
export const IMAGE_MIME = Object.freeze({
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
});

export const imageMime = (path) => IMAGE_MIME[extname(String(path ?? '')).toLowerCase()] ?? null;
export const assetKind = (path) => (extname(String(path ?? '')).toLowerCase() === '.svg' ? 'svg' : 'bitmap');

/** 清单跟文档同名同目录：`storyline.md` → `storyline.assets.json`。 */
export function manifestPathFor(docPath) {
  const absolute = resolve(docPath);
  const extension = extname(absolute);
  return extension ? `${absolute.slice(0, -extension.length)}.assets.json` : `${absolute}.assets.json`;
}

export function isRelativeAssetPath(path) {
  return typeof path === 'string'
    && path.trim() !== ''
    && !/^(?:[a-zA-Z][a-zA-Z0-9+.-]*:|\/|\\|~)/.test(path);
}

/**
 * 文件系统层面的包含性：符号链接指到文档目录外时，字符串前缀看不出来。
 * 只有真实文件才判得了，返回 false 表示「不该当资产」。
 */
export function realPathInside(docPath, file) {
  try {
    const root = realpathSync(dirname(resolve(docPath)));
    const real = realpathSync(file);
    return real.startsWith(root + sep);
  } catch {
    return false;
  }
}

/** 资产必须落在文档目录里；`resolve` 之后再比前缀，`..` 与绝对路径都过不去。 */
export function resolveInside(docPath, relative) {
  if (!isRelativeAssetPath(relative)) return null;
  const root = dirname(resolve(docPath));
  const target = resolve(root, relative);
  if (!target.startsWith(root + sep)) return null;
  return target;
}

/**
 * 正文里所有图片引用（图块与段落里的行内图都算），按出现顺序、按路径去重。
 * 每条带上它所在块的锚点：清单借此把「文件」绑到「块身份」上。
 */
export function documentImageRefs(parsed) {
  const byPath = new Map();
  for (const block of parsed.blocks) {
    if (block.type === 'code') continue;
    for (const reference of imageReferences(block.raw)) {
      const entry = byPath.get(reference.path)
        ?? { path: reference.path, anchors: [], alt: '' };
      if (!entry.alt && reference.alt) entry.alt = reference.alt;
      if (block.anchor && !entry.anchors.includes(block.anchor)) entry.anchors.push(block.anchor);
      byPath.set(reference.path, entry);
    }
  }
  return [...byPath.values()];
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/** 只把磁盘上真取得到的文件写进清单；取不到就缺席，不编造哈希。 */
export function buildManifest(docPath, parsed, previous = null) {
  const previousByPath = new Map(
    (Array.isArray(previous?.assets) ? previous.assets : [])
      .filter((asset) => asset && typeof asset.path === 'string')
      .map((asset) => [asset.path, asset]),
  );
  const assets = [];
  for (const reference of documentImageRefs(parsed)) {
    const file = resolveInside(docPath, reference.path);
    if (!file || !existsSync(file) || !statSync(file).isFile()) continue;
    if (!realPathInside(docPath, file)) continue; // 符号链接指到目录外：不登记、不发布
    const bytes = readFileSync(file);
    const digest = sha256(bytes);
    const prior = previousByPath.get(reference.path);
    const asset = {
      path: reference.path,
      kind: assetKind(reference.path),
      sha256: digest,
      bytes: bytes.length,
      anchors: reference.anchors,
      alt: reference.alt,
    };
    // 换过文件就留下「上一版的指纹」；只换一次与连续换都只记紧邻的上一版。
    if (prior && typeof prior.sha256 === 'string' && prior.sha256 !== digest) {
      asset.replaced_from_sha256 = prior.sha256;
    } else if (prior && typeof prior.replaced_from_sha256 === 'string' && prior.replaced_from_sha256 !== digest) {
      asset.replaced_from_sha256 = prior.replaced_from_sha256;
    }
    assets.push(asset);
  }
  return { contract: ASSET_CONTRACT, doc: basename(docPath), assets };
}

/** 打开文档时顺带同步清单。没变化就不写盘；写失败由调用方决定要不要出声。 */
export function syncManifest(docPath, parsed) {
  const path = manifestPathFor(docPath);
  const previous = readJson(path);
  const manifest = buildManifest(docPath, parsed, previous);
  const text = `${JSON.stringify(manifest, null, 2)}\n`;
  const changed = !existsSync(path) || readFileSync(path, 'utf8') !== text;
  if (changed) atomicWrite(path, text);
  return { path, manifest, changed };
}

// ───────────── 校验：清单必须与正文、磁盘三边对得上 ─────────────
//
// 清单是派生的，所以「过期」是正常风险：模型手改了文件、人删了图块、别处覆盖了清单。
// 校验器不替谁修复，只把三边的差说清楚。

/** 文档里的块：只为拿块锚点与图片引用；缺图不该让清单校验先炸在文档结构上。 */
function imageRefsOfDocument(docPath) {
  const parsed = parseDocument(readFileSync(docPath, 'utf8'), { checkImages: false });
  return documentImageRefs(parsed);
}

/**
 * @returns {{valid:boolean, errors:Array<object>, checked:object}}
 */
export function validateManifest(docPath, manifestPath = manifestPathFor(docPath)) {
  const errors = [];
  const push = (code, message, extra = {}) => errors.push({ code, message, ...extra });
  const doc = resolve(docPath);
  const manifestFile = resolve(manifestPath);
  const references = imageRefsOfDocument(doc);
  const checked = { doc, manifest: manifestFile, assets: references.length };

  if (!existsSync(manifestFile)) {
    push('manifest_missing', `资产清单不存在：${manifestFile}`);
    return { valid: false, errors, checked };
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
  } catch (error) {
    push('manifest_syntax', `资产清单不是合法 JSON：${error.message}`);
    return { valid: false, errors, checked };
  }
  if (manifest?.contract !== ASSET_CONTRACT) {
    push('contract_version', `contract 必须是 "${ASSET_CONTRACT}"，实际 ${JSON.stringify(manifest?.contract ?? null)}`);
  }
  if (manifest?.doc !== basename(doc)) {
    push('doc_mismatch', `清单属于 ${JSON.stringify(manifest?.doc ?? null)}，不是 ${basename(doc)}`);
  }
  if (!Array.isArray(manifest?.assets)) {
    push('assets_type', 'assets 必须是数组');
    return { valid: false, errors, checked };
  }

  const entries = new Map();
  for (const [index, asset] of manifest.assets.entries()) {
    if (!asset || typeof asset !== 'object') {
      push('asset_shape', `第 ${index + 1} 个条目不是对象`, { index });
      continue;
    }
    const path = typeof asset.path === 'string' ? asset.path : '';
    if (!isRelativeAssetPath(path)) {
      push('asset_path', `第 ${index + 1} 个条目的 path 必须是相对路径，实际 ${JSON.stringify(asset.path ?? null)}`, { index });
      continue;
    }
    if (entries.has(path)) {
      push('asset_duplicate', `资产 ${path} 在清单里出现了两次`, { path });
      continue;
    }
    entries.set(path, { asset, index });
  }

  const expected = new Map(references.map((reference) => [reference.path, reference]));
  for (const reference of references) {
    const file = resolveInside(doc, reference.path);
    if (!file || !existsSync(file) || !statSync(file).isFile()) {
      push('asset_missing', `正文引用的图不存在：${reference.path}`, { path: reference.path });
      continue;
    }
    if (!realPathInside(doc, file)) {
      push('asset_path', `图片指向文档目录之外：${reference.path}`, { path: reference.path });
      continue;
    }
    if (!entries.has(reference.path)) {
      push('asset_unregistered', `正文引用了 ${reference.path}，但清单里没有登记`, { path: reference.path });
    }
  }

  for (const [path, { asset, index }] of entries) {
    const reference = expected.get(path);
    if (!reference) {
      push('asset_unreferenced', `清单里的 ${path} 没有被正文引用`, { path, index });
      continue;
    }
    const file = resolveInside(doc, path);
    if (!file || !existsSync(file) || !statSync(file).isFile()) {
      push('asset_missing', `清单里的 ${path} 指向的文件不存在`, { path, index });
      continue;
    }
    const bytes = readFileSync(file);
    if (asset.kind !== assetKind(path)) {
      push('asset_kind', `${path} 的 kind 应为 ${assetKind(path)}，实际 ${JSON.stringify(asset.kind ?? null)}`, { path, index });
    }
    if (asset.sha256 !== sha256(bytes)) {
      push('asset_hash_mismatch', `${path} 的 sha256 与磁盘文件不一致；文件被换过或清单过期`, { path, index });
    }
    if (asset.bytes !== bytes.length) {
      push('asset_bytes_mismatch', `${path} 的 bytes 应为 ${bytes.length}，实际 ${JSON.stringify(asset.bytes ?? null)}`, { path, index });
    }
    if (!Array.isArray(asset.anchors) || asset.anchors.join(',') !== reference.anchors.join(',')) {
      push('asset_anchors', `${path} 绑定的块身份应为 ${reference.anchors.join('、') || '（无）'}，实际 ${JSON.stringify(asset.anchors ?? null)}`, { path, index });
    }
    if ((asset.alt ?? '') !== reference.alt) {
      push('asset_alt', `${path} 的 alt 应为 ${JSON.stringify(reference.alt)}，实际 ${JSON.stringify(asset.alt ?? null)}`, { path, index });
    }
    if ('replaced_from_sha256' in asset) {
      const previous = asset.replaced_from_sha256;
      if (typeof previous !== 'string' || !/^[0-9a-f]{64}$/.test(previous)) {
        push('asset_lineage', `${path} 的 replaced_from_sha256 必须是 64 位小写十六进制`, { path, index });
      } else if (previous === asset.sha256) {
        push('asset_lineage', `${path} 的 replaced_from_sha256 不能等于当前 sha256`, { path, index });
      }
    }
  }

  return { valid: errors.length === 0, errors, checked };
}

// ───────────── 换文件的入口守卫 ─────────────
//
// 文件按正文里的扩展名解释，内容必须真的是那一类图片：`pixel.png` 里塞 HTML 或 SVG 也不行。
// 这是「图只以文件形式进文档」的底线 —— 不然一次换图就能把工作台的同源资产变成可执行页面。

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function svgBytesOk(bytes) {
  const text = bytes.toString('utf8').replace(/^\uFEFF/, '').trimStart();
  return /^(?:<\?xml[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!DOCTYPE[^>]*>\s*)?<svg[\s>]/i.test(text);
}

/**
 * 校验要写进图块路径的字节。
 * 扩展名不认识 → `asset_type`；内容与扩展名不符 → `asset_content`。
 */
export function assertImageBytes(path, bytes) {
  const mime = imageMime(path);
  if (!mime) {
    throw Object.assign(Error(`不支持的图片类型：${extname(String(path)) || '（无扩展名）'}`), { code: 'asset_type' });
  }
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? []);
  if (!buffer.length) throw Object.assign(Error('图文件不能为空'), { code: 'asset_content' });
  let ok = false;
  if (mime === 'image/png') ok = buffer.subarray(0, 8).equals(PNG_SIGNATURE);
  else if (mime === 'image/jpeg') ok = buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  else if (mime === 'image/gif') ok = ['GIF87a', 'GIF89a'].includes(buffer.subarray(0, 6).toString('ascii'));
  else if (mime === 'image/webp') ok = buffer.subarray(0, 4).toString('ascii') === 'RIFF'
    && buffer.subarray(8, 12).toString('ascii') === 'WEBP';
  else if (mime === 'image/avif') ok = buffer.subarray(4, 8).toString('ascii') === 'ftyp'
    && ['avif', 'avis'].includes(buffer.subarray(8, 12).toString('ascii'));
  else if (mime === 'image/svg+xml') ok = svgBytesOk(buffer);
  if (!ok) {
    throw Object.assign(Error(`文件内容不是 ${mime}：扩展名与字节不符，已拒绝`), { code: 'asset_content' });
  }
  return { mime, kind: assetKind(path), bytes: buffer.length };
}
