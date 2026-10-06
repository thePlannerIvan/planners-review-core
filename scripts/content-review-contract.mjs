import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const sha256 = value => createHash('sha256').update(value).digest('hex');
export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  return value;
}
export const contentHash = value => sha256(JSON.stringify(canonical(value)));

// This is the optional shell's wire format, not a native feedback or content format.
export function validateChanges(changes, context, submission) {
  const object = value => value && typeof value === 'object' && !Array.isArray(value);
  if (!object(changes)) throw Error('文字修改不是对象');
  if (changes.contract_version !== 'content-review-edits/1.0.0') throw Error('不支持的文字修改格式');
  const permutation = (list, expected) => Array.isArray(list) && list.length === expected.length
    && new Set(list.map(String)).size === expected.length && expected.every(id => list.map(String).includes(String(id)));
  if (!permutation(changes.page_order, context.pages.map(p => p.page_number))) throw Error('页序不是原有页面的完整排列');
  if (!permutation(changes.section_order, context.sections.map(s => s.section_id))) throw Error('章节顺序不是原有章节的完整排列');
  if (!permutation(submission.decisions.map(d => d.page_number), context.pages.map(p => p.page_number))) throw Error('决定必须与原有页面一一对应');
  const edits = changes.edits;
  if (!edits || typeof edits !== 'object' || Array.isArray(edits)) throw Error('文字修改不是对象');
  if (!object(edits.pages) || !object(edits.sections)) throw Error('页面与章节修改必须是对象');
  for (const key of Object.keys(edits)) if (!['pages', 'sections', 'thesis'].includes(key)) throw Error('未知文字字段：' + key);
  if ('thesis' in edits && (typeof edits.thesis !== 'string' || !context.sections.length)) throw Error('核心判断字段不适用于本稿');
  function fields(value, allowed) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('修改字段不是对象');
    for (const [key, text] of Object.entries(value)) if (!allowed.includes(key) || typeof text !== 'string') throw Error('无效修改字段：' + key);
  }
  for (const [id, patch] of Object.entries(edits.sections ?? {})) {
    if (!context.sections.some(s => s.section_id === id)) throw Error('未知章节：' + id);
    fields(patch, ['title', 'lead', 'transition']);
  }
  for (const [id, patch] of Object.entries(edits.pages ?? {})) {
    const page = context.pages.find(p => String(p.page_number) === id);
    if (!page) throw Error('未知页面：' + id);
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw Error('页面修改不是对象');
    for (const [key, value] of Object.entries(patch)) {
      if (['title', 'claim'].includes(key)) { if (typeof value !== 'string') throw Error('页面文字无效'); }
      else if (key === 'blocks') {
        if (!object(value)) throw Error('内容块修改必须是对象');
        for (const [index, block] of Object.entries(value ?? {})) {
          if (!/^\d+$/.test(index) || !page.blocks?.[Number(index)]) throw Error('未知内容块');
          fields(block, ['title', 'text']);
        }
      } else if (key === 'sections') {
        if (!object(value)) throw Error('正文修改必须是对象');
        for (const [index, text] of Object.entries(value ?? {})) {
          if (!/^\d+$/.test(index) || !page.sections?.[Number(index)] || page.sections[Number(index)].editable === false || typeof text !== 'string') throw Error('未知或只读正文段落');
        }
      } else throw Error('未知页面字段：' + key);
    }
  }
  return changes;
}

export function writeReviewContext(dir, context) {
  const file = join(dir, 'review-context.json');
  const previous = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  context.draftPath = 'draft-' + context.sourceSha256 + '.json';
  if (previous.sourceSha256 && previous.sourceSha256 !== context.sourceSha256) {
    const draftFile = join(dir, previous.draftPath || 'draft.json');
    if (existsSync(draftFile)) {
      const draft = JSON.parse(readFileSync(draftFile, 'utf8'));
      const cursor = join(dir, '.inbox-cursor.json');
      const applied = existsSync(cursor) ? JSON.parse(readFileSync(cursor, 'utf8')).applied_draft : null;
      const change = {edits:draft.edits, page_order:draft.page_order, section_order:draft.section_order};
      const baseline = {edits:{pages:{},sections:{}},page_order:previous.pages?.map(p => p.page_number),section_order:previous.sections?.map(s => s.section_id)};
      if (contentHash(change) !== contentHash(baseline) && contentHash(change) !== applied) {
        throw Error('上一版还有未收下的文字或顺序修改；草稿已保留。先处理草稿，再生成新审阅页。');
      }
    }
  }
  writeFileSync(file, JSON.stringify({...previous,...context}, null, 2) + '\n');
  writeFileSync(join(dir, 'review-snapshot.json'), JSON.stringify({source_sha256:context.sourceSha256}) + '\n');
  return context;
}
