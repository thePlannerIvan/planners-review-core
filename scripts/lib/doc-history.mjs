/**
 * 历史版本：每次写盘前把上一版整份存档，只追加、不删除。
 *
 * 存档位置：`.doc-workbench/history/<文档文件名>/<时间戳>-<指纹>-<随机>.json`。
 * 记录里带整份 raw，所以「列出 / 恢复」不再依赖别的文件。恢复不是特例写盘：
 * 它读一条旧档，再交给内核当一次新的正常编辑落盘 —— 写前同样把当前版本存一档，
 * 旧档因此一个都不会被覆盖或删除（SPEC 第 4 节）。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { atomicWrite, stateDirFor } from './doc-io.mjs';
import { sha256 } from '../content-review-contract.mjs';

export const HISTORY_CONTRACT = 'planners-doc-history/1';

/** 文件 id 由本模块生成；恢复入口只认这个形状，天然挡住路径穿越。 */
const RECORD_ID_RE = /^\d{4}-\d{2}-\d{2}T[\d-]+Z-[0-9a-f]{8}-[0-9a-f]{6}$/;

const fail = (code, message) => { throw Object.assign(Error(message), { code }); };

/** 按文档分桶：同目录的 storyline.md 与 by-page.md 各有自己的历史。 */
export function historyDirFor(docPath) {
  return join(stateDirFor(docPath), 'history', basename(resolve(docPath)));
}

/** 列表只带摘要；整份 raw 留在磁盘上，恢复时再读。 */
function metaOf(record, id) {
  return {
    id,
    sha256: record.sha256,
    bytes: record.bytes,
    operation: record.operation,
    archived_at: record.archived_at,
    preview: previewOf(record.raw),
  };
}

/** 摘要取正文第一行（跳过 front matter），不把整份内容塞进列表。 */
function previewOf(raw) {
  const lines = String(raw).split('\n');
  let start = 0;
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
    if (end > 0) start = end + 1;
  }
  const body = lines.slice(start);
  const line = body.find((value) => value.trim() && !/^#{1,6}\s/.test(value))
    ?? body.find((value) => value.trim())
    ?? '';
  return line.replace(/^#+\s*/, '').replace(/\s+/g, ' ').slice(0, 80);
}

/**
 * 写盘前存上一版。调用方是唯一的写盘入口 `commitDocument`，所以每一次真正改变
 * 文档的写（人保存 / 分块 / 合并 / 重排 / 模型写回 / 裁决 / 恢复 / 补锚点）都会留一档。
 */
export function archiveVersion(docPath, { raw, operation = 'write' } = {}) {
  if (typeof raw !== 'string' || raw === '') return null;
  const digest = sha256(raw);
  const created = new Date();
  const id = `${created.toISOString().replace(/[:.]/g, '-')}-${digest.slice(0, 8)}-${randomBytes(3).toString('hex')}`;
  const record = {
    contract: HISTORY_CONTRACT,
    doc: basename(resolve(docPath)),
    sha256: digest,
    bytes: Buffer.byteLength(raw),
    operation,
    archived_at: created.toISOString(),
    raw,
  };
  const path = join(historyDirFor(docPath), `${id}.json`);
  mkdirSync(dirname(path), { recursive: true });
  atomicWrite(path, `${JSON.stringify(record, null, 2)}\n`);
  return { id, sha256: record.sha256, bytes: record.bytes, operation, archived_at: record.archived_at, preview: previewOf(raw) };
}

function readRecord(docPath, id) {
  if (typeof id !== 'string' || !RECORD_ID_RE.test(id)) fail('history_id', '历史版本 id 形状不对');
  const path = join(historyDirFor(docPath), `${id}.json`);
  if (!existsSync(path)) fail('history_missing', `找不到历史版本 ${id}`);
  let record;
  try {
    record = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    fail('history_corrupt', `历史版本不是合法 JSON：${path}`);
  }
  if (record?.contract !== HISTORY_CONTRACT || typeof record.raw !== 'string'
    || typeof record.sha256 !== 'string' || record.sha256 !== sha256(record.raw)) {
    fail('history_corrupt', `历史版本内容与指纹对不上：${path}`);
  }
  if (record.doc !== basename(resolve(docPath)) || record.bytes !== Buffer.byteLength(record.raw)) {
    fail('history_corrupt', `历史版本不属于这份文档或字节数不对：${path}`);
  }
  return record;
}

/** 新的在前；读不出来的档不静默跳过，放进 `errors` 让页面说清楚。 */
export function listVersions(docPath) {
  const dir = historyDirFor(docPath);
  if (!existsSync(dir)) return { versions: [], errors: [] };
  const versions = [];
  const errors = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const id = name.slice(0, -'.json'.length);
    try {
      versions.push(metaOf(readRecord(docPath, id), id));
    } catch (error) {
      errors.push({ id, error: error?.message ?? String(error) });
    }
  }
  versions.sort((left, right) => right.id.localeCompare(left.id));
  return { versions, errors };
}

export function readVersion(docPath, id) {
  return { id, ...readRecord(docPath, id) };
}
