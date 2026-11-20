/**
 * 旧项目主稿（`.proposal-work/page-architecture.json` 这类 JSON）的只读挂载。
 *
 * 新工作台只认 `planners-doc/2` 的 Markdown：旧 JSON 不迁移、不兼容读取，也绝不被写。
 * 但人仍需要能把旧主稿打开看一眼，确认「这是它」，所以这里把旧 JSON 变成一份**只读快照**：
 * 同样的 `pages` / `blocks` 形状，块上没有锚点、不可编辑；任何写入由工作台在入口拒绝。
 *
 * 检测只看扩展名 `.json`，不猜 Markdown。旧主稿的字段尽量读（contract_version、project_id、
 * storyline_thesis、sections、pages），读不懂的部分不编造；解析失败也仍然是只读，不抛成崩溃。
 */
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { sha256 } from '../content-review-contract.mjs';

export const LEGACY_REASON = 'legacy-json';
export const LEGACY_READONLY_MESSAGE = '旧 JSON 主稿只读：这份文件用的是旧存储，新工作台只写 planners-doc/2 的 Markdown，不会修改它。'
  + '要在这个工作台里改，请先按新契约重建 storyline.md / by-page.md。';

const textOf = (value) => (typeof value === 'string' ? value : '');

/** 打开旧主稿：不是 `.json` 返回 null；是 `.json` 就一定按只读处理（即使解析失败）。 */
export function readLegacyMaster(docPath) {
  if (extname(docPath).toLowerCase() !== '.json') return null;
  const raw = readFileSync(docPath, 'utf8');
  const master = {
    kind: 'legacy-json',
    path: docPath,
    raw,
    sha256: sha256(raw),
    parsed: null,
    parseError: null,
  };
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) master.parsed = parsed;
    else master.parseError = '旧 JSON 主稿的顶层不是对象';
  } catch (error) {
    master.parseError = `旧 JSON 主稿无法解析：${error.message}`;
  }
  return master;
}

const chapterKey = (value, fallback = 1) => (Number.isInteger(Number(value)) ? Number(value) : fallback);

/**
 * 只读快照：页按 `sections` 归章，块是每页的 `claim`。
 * 阅读顺序与页号优先用旧主稿自己的 `page_number` 与数组顺序，不按新契约重排。
 */
export function legacySnapshot({ path, master }) {
  const parsed = master?.parsed ?? {};
  const sections = Array.isArray(parsed.sections) ? parsed.sections : [];
  const sectionByID = new Map();
  sections.forEach((section, position) => {
    if (section && typeof section === 'object') {
      sectionByID.set(section.section_id, { title: textOf(section.title) || `第 ${position + 1} 章`, index: position + 1 });
    }
  });
  const legacyPages = Array.isArray(parsed.pages) ? parsed.pages : [];
  const pages = [];
  const blocks = [];
  legacyPages.forEach((page, position) => {
    if (!page || typeof page !== 'object') return;
    const section = sectionByID.get(page.section_id) ?? { title: sections.length ? '未分章' : '旧主稿', index: 1 };
    const chapterIndex = chapterKey(section.index, 1);
    const number = Number.isInteger(Number(page.page_number)) ? Number(page.page_number) : position + 1;
    const title = textOf(page.title_intent) || textOf(page.title) || textOf(page.claim) || `第 ${number} 页`;
    // 旧主稿的页号是全局的（page_number），目录照它显示；key 仍按位置保证唯一。
    const key = `${chapterIndex}-${position + 1}`;
    pages.push({
      key,
      chapter: section.title,
      chapterIndex,
      index: number,
      number,
      title,
      anchor: null,
    });
    const claim = textOf(page.claim);
    blocks.push({
      anchor: null,
      type: 'paragraph',
      index: position + 1,
      page: { key, chapter: section.title, chapterIndex, number, title },
      raw: claim,
      sha256: sha256(claim),
      inline: claim,
      prefix: '',
      start: 0,
      end: claim.length,
      editable: false,
      degraded: false,
      reason: null,
      locked: false,
      locked_by: null,
      deferred: null,
      readonly: true,
      legacy: {
        page_job: textOf(page.page_job) || null,
        content_blocks: Array.isArray(page.content_blocks)
          ? page.content_blocks
            .filter((block) => block && typeof block === 'object')
            .map((block) => ({
              title: textOf(block.block_title),
              requirement: textOf(block.content_requirement),
            }))
          : [],
      },
    });
  });

  return {
    path,
    contract: null,
    doc: null,
    project: textOf(parsed.project_id) || null,
    sha256: master?.sha256 ?? null,
    readonly: { reason: LEGACY_REASON, message: LEGACY_READONLY_MESSAGE },
    legacy: {
      contract_version: textOf(parsed.contract_version) || null,
      project_id: textOf(parsed.project_id) || null,
      thesis: textOf(parsed.storyline_thesis) || null,
      page_count: pages.length,
    },
    pages,
    blocks,
    deferred_blocks: [],
    journal: null,
    repairs: [],
    errors: master?.parseError
      ? [{ code: 'legacy_json', message: master.parseError, line: null, block: null }]
      : [],
  };
}
