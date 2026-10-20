import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { contentHash, contentProjection, sha256, validateChanges } from './content-review-contract.mjs';

const PRODUCERS = {
  co_creation_page_architecture: ['02-content-assembly', 'planners-proposal-system', 'proposal-co-creation/scripts/lib/review-edits.mjs'],
  storyline: ['02-content-assembly', 'planners-bypage', 'scripts/lib/review-edits.mjs'],
  bypage: ['02-content-assembly', 'planners-bypage', 'scripts/lib/review-edits.mjs'],
  bypage_sample: ['02-content-assembly', 'planners-bypage', 'scripts/lib/review-edits.mjs'],
};
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const fail = (code, message) => { throw Object.assign(new Error(message), {code}); };
const initial = context => ({source_sha256: context.sourceSha256, review_kind: context.reviewKind,
  edits: {pages: {}, sections: {}}, page_order: context.pages.map(p => p.page_number),
  section_order: context.sections.map(s => s.section_id), added_pages: {}, deleted_pages: [],
  feedbacks: {}, attachments: {}, asset_decisions: {}, overall_feedback_zh: ''});
export const changesOf = state => ({contract_version: 'content-review-edits/1.1.0', edits: state.edits,
  page_order: state.page_order, section_order: state.section_order,
  added_pages: state.added_pages ?? {}, deleted_pages: state.deleted_pages ?? []});

function atomic(path, value) {
  const temp = path + '.workbench.tmp';
  if (existsSync(temp)) unlinkSync(temp);
  const fd = openSync(temp, 'wx', 0o600);
  try { writeFileSync(fd, typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n'); fsyncSync(fd); }
  finally { closeSync(fd); }
  renameSync(temp, path);
}
function contained(root, path) {
  const file = realpathSync(path);
  if (file !== root && !file.startsWith(root + sep)) fail('outside_project', '工作台文件不在当前项目内');
  if (file.split(sep).some(part => /^\.env(?:\.|$)|^\.venv$/.test(part))) fail('sensitive_path', '敏感文件不是内容输入');
  return file;
}
export function adapterCandidates(context) {
  const spec = PRODUCERS[context.reviewKind];
  if (!spec) fail('producer', '不支持的内容生产方');
  const core = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  return [
    // DSH form skills are the primary runtime for plugin-hosted surfaces.
    join(dirname(core), spec[1], spec[2]),
    // Source/library layout and a plain DSH skills mount are valid fallbacks.
    join(dirname(dirname(core)), ...spec),
    join(homedir(), '.dsh', 'skills', spec[1], spec[2]),
    join(homedir(), '.dsh', 'planners-form', 'skills', spec[1], spec[2]),
  ];
}

export function resolveAdapterPath(context) {
  const candidates = adapterCandidates(context);
  const file = candidates.find(existsSync);
  if (!file) fail('adapter_missing', '找不到已安装的内容 adapter；已检查：' + candidates.join('、'));
  return file;
}

async function adapter(context) {
  return import(pathToFileURL(resolveAdapterPath(context)));
}
function lock(path) {
  try { const fd = openSync(path, 'wx'); writeFileSync(fd, String(process.pid)); closeSync(fd); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const pid = Number(readFileSync(path, 'utf8'));
    if (!Number.isInteger(pid) || pid <= 0) fail('locked', '保存锁不可确认，保留编辑并重试');
    try { process.kill(pid, 0); fail('locked', '另一个保存正在执行，请重试'); }
    catch (probe) { if (probe.code !== 'ESRCH') throw probe; }
    unlinkSync(path); return lock(path);
  }
  return () => unlinkSync(path);
}
function recover(dir, root) {
  const journal = join(dir, 'journal.json');
  if (!existsSync(journal)) return;
  contained(root, journal);
  const pending = json(journal), source = contained(root, pending.source);
  const hash = sha256(readFileSync(source));
  if (![pending.old_hash, pending.new_hash].includes(hash)) fail('source_conflict', '主稿已被外部修改，恢复事务未覆盖任何内容');
  if (hash === pending.old_hash) atomic(source, pending.raw);
  const headPath = join(dir, 'head.json');
  if (existsSync(headPath)) contained(root, headPath);
  atomic(headPath, pending.head);
  const cursorPath = join(dirname(dir), '.inbox-cursor.json');
  if (existsSync(cursorPath)) contained(root, cursorPath);
  const cursor = existsSync(cursorPath) ? json(cursorPath) : {};
  cursor.applied_draft = contentHash(contentProjection(pending.head.state));
  atomic(cursorPath, cursor);
  unlinkSync(journal);
}
function checkSource(head, root) {
  const file = contained(root, head.context.files[0].path);
  if (sha256(readFileSync(file)) !== head.source_hash) fail('source_conflict', '主稿已有外部修改；你的编辑已保留，未覆盖主稿');
  return file;
}

/** Called by both hosts after their capability/path checks. No model is involved. */
export async function runContentCommand(surface, command) {
  try {
    const root = realpathSync(surface.projectRoot), reviewDir = contained(root, surface.dir);
    const context = json(contained(root, join(reviewDir, 'review-context.json')));
    const apply = (await adapter(context)).applyContentChanges;
    const directory = join(reviewDir, 'workbench'); mkdirSync(directory, {recursive: true});
    contained(root, directory);
    const unlock = lock(join(directory, 'save.lock'));
    try {
      recover(directory, root);
      const path = join(directory, 'head.json');
      if (existsSync(path)) contained(root, path);
      let head = existsSync(path) ? json(path) : null;
      // The producer may rebuild after model edits; its context binds the new bytes.
      if (!head || head.context.sourceSha256 !== context.sourceSha256) {
        const source = contained(root, context.files[0].path), raw = readFileSync(source, 'utf8');
        if (sha256(raw) !== context.files[0].sha256) fail('source_conflict', '生成页面后的主稿已经变化');
        for (const item of context.files) contained(root, item.path);
        if (head) {
          const archive = join(directory, 'history'); mkdirSync(archive, {recursive:true});
          contained(root, archive);
          if (!existsSync(join(archive, head.revision + '.json'))) atomic(join(archive, head.revision + '.json'), head);
        }
        head = {version: 'content-workbench/1', revision: sha256(raw + context.sourceSha256), context,
          baseline: raw, source_hash: sha256(raw), state: initial(context), tasks: head?.tasks ?? [], operations: {},
          page_mapping: Object.fromEntries(context.pages.map(p => [p.page_number, p.page_number]))};
        atomic(path, head);
      }
      if (command.op === 'state') { checkSource(head, root); return {ok: true, ...head}; }
      // 版本历史：每次 save 都会把上一版写进 workbench/history/<revision>.json
      if (command.op === 'history') {
        const archive = join(directory, 'history');
        const items = existsSync(archive) ? readdirSync(archive).filter(name => name.endsWith('.json')).map(name => {
          const revision = name.slice(0, -5);
          let saved_at = '', pages = 0;
          try { const doc = json(join(archive, name)); saved_at = doc.saved_at || ''; pages = doc.state?.page_order?.length ?? 0; } catch (_) {}
          return { revision, saved_at, pages, current: revision === head.revision };
        }).sort((a, b) => String(b.saved_at).localeCompare(String(a.saved_at))) : [];
        return { ok: true, current: head.revision, history: [
          {revision:head.revision,saved_at:head.saved_at || '',pages:head.state.page_order.length,current:true},
          ...items.filter(item => item.revision !== head.revision),
        ] };
      }
      // 任务处理完成：模型改完主稿后把 task 标掉，页面才不会一直显示 pending
      if (command.op === 'resolve') {
        const ids = Array.isArray(command.task_ids) ? command.task_ids : [];
        if (!ids.length) fail('task_ids', '请指定已完成的任务');
        if (command.base_revision !== head.revision || command.source_hash !== head.source_hash) fail('revision_conflict', '任务处理基线已变化，请核对后再标记完成');
        if (ids.some(id => !(head.tasks ?? []).some(t => t.id === id && t.status === 'pending' && t.revision === command.base_revision && t.source_hash === command.source_hash))) fail('task_version', '任务不存在、已完成或不属于当前处理版本');
        let resolved = 0;
        for (const task of head.tasks ?? []) {
          if (task.status !== 'pending' || (ids.length && !ids.includes(task.id))) continue;
          task.status = 'resolved'; task.resolved_at = new Date().toISOString(); resolved += 1;
        }
        if (resolved) atomic(path, head);
        return {ok: true, resolved, revision: head.revision};
      }
      // 恢复：只读回那一版的状态，由页面把它当一次新的编辑保存（历史不会丢）
      if (command.op === 'restore') {
        if (!/^[a-f0-9]{8,64}$/.test(String(command.revision || ''))) fail('restore_revision', '版本号无效');
        const file = contained(root, join(directory, 'history', command.revision + '.json'));
        if (!file || !existsSync(file)) fail('restore_missing', '找不到该历史版本');
        const doc = json(file);
        if (!doc?.state) fail('restore_empty', '该版本没有可恢复的内容');
        if (doc.context?.sourceSha256 !== head.context.sourceSha256) fail('restore_baseline', '该版本属于模型更新前的编辑基线；请让模型核对历史内容后恢复，当前主稿未改变');
        return { ok: true, revision: command.revision, state: doc.state, source_hash: doc.source_hash || '' };
      }
      const identity = command.operation_id;
      if (typeof identity !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(identity)) fail('operation_id', '保存需要稳定操作身份');
      const signature = contentHash(command);
      if (head.operations[identity]) {
        if (head.operations[identity].signature !== signature) fail('operation_reused', '操作身份已用于其他内容');
        return head.operations[identity].receipt;
      }
      if (command.base_revision !== head.revision) fail('revision_conflict', '另一个窗口已保存新版本；当前编辑已保留，请核对后重试');
      const source = checkSource(head, root);
      for (const item of head.context.files.slice(1)) {
        if (sha256(readFileSync(contained(root, item.path))) !== item.sha256) fail('dependency_conflict', '来源、核查或资产清单已有变化，请核对后重新生成工作台');
      }
      if (command.op === 'save') {
        if (command.state?.source_sha256 !== head.context.sourceSha256 || command.state?.review_kind !== head.context.reviewKind) fail('baseline_conflict', '编辑来自不同基线');
        validateChanges(changesOf(command.state), head.context);
        let raw = apply(head.baseline, changesOf(command.state), head.context);
        // Uploaded images become canonical page references, not transient browser URLs.
        if (head.context.type === 'copy') {
          for (const [id, attachments] of Object.entries(command.state.attachments ?? {})) {
            if (!head.context.pages.some(page => String(page.page_number) === id) || !Array.isArray(attachments)) fail('attachments', '图片未绑定当前页面');
            const number = command.state.page_order.map(String).indexOf(id) + 1;
            for (const image of attachments) {
              if (typeof image.path !== 'string' || !image.path.startsWith('uploads/')) fail('attachments', '图片必须来自本工作台上传目录');
              const file = contained(root, join(reviewDir, image.path));
              if (!file.startsWith(realpathSync(join(reviewDir, 'uploads')) + sep)) fail('attachments', '图片越出上传目录');
              if (!['.png', '.jpg', '.jpeg', '.webp', '.gif'].some(ext => file.toLowerCase().endsWith(ext))) fail('attachments', '只能添加图片');
              const ref = relative(dirname(source), file).split(sep).join('/');
              const pattern = new RegExp('(page_number: '+number+'\\n[\\s\\S]*?## Page Content\\s*\\n[\\s\\S]*?)(\\n## Speaker Notes)');
              raw = raw.replace(pattern, (_, body, tail) => body + '\n![' + String(image.alt ?? '').replace(/[\[\]\n]/g, '') + '](<' + ref + '>)\n' + tail);
            }
          }
        }
        const hash = sha256(raw), previous = head.revision;
        const receipt = {ok: true, revision: sha256(previous + signature), source_hash: hash,
          content_changed: hash !== head.source_hash,
          requires_fact_recheck: head.context.type === 'copy' && hash !== head.source_hash,
          page_mapping: Object.fromEntries(command.state.page_order.map((id, i) => [id, i + 1]))};
        head = {...head, revision: receipt.revision, source_hash: hash, state: command.state,
          page_mapping: receipt.page_mapping, saved_at: new Date().toISOString()};
        head.operations[identity] = {signature, receipt};
        const archive = join(directory, 'history'); mkdirSync(archive, {recursive: true});
        contained(root, archive);
        if (!existsSync(join(archive, previous + '.json'))) atomic(join(archive, previous + '.json'), json(path));
        atomic(join(directory, 'journal.json'), {source, raw, old_hash: sha256(readFileSync(source)), new_hash: hash, head});
        recover(directory, root);
        // Mark the exact canonical projection as consumed so rebuilding this surface
        // does not mistake a saved main稿 for an unsubmitted draft.
        const cursorPath = join(reviewDir, '.inbox-cursor.json');
        const cursor = existsSync(cursorPath) ? json(cursorPath) : {};
        if (existsSync(cursorPath)) contained(root, cursorPath);
        cursor.applied_draft = contentHash(contentProjection(command.state));
        atomic(cursorPath, cursor);
        return receipt;
      }
      if (command.op === 'feedback') {
        // 批注：一次交齐页面上已有的所有批注（每页一条），模型拿到 page → 文本
        if (command.scope === 'annotations') {
          const entries = Array.isArray(command.entries)
            ? command.entries.map(entry => ({page: entry?.page, text: typeof entry?.text === 'string' ? entry.text.trim() : ''})).filter(entry => entry.text)
            : [];
          if (!entries.length) fail('feedback', '请先写下批注');
          if (entries.some(entry => !head.state.page_order.includes(entry.page))) fail('feedback_page', '批注页面不存在');
          const text = entries.map(entry => `第 ${head.page_mapping[entry.page]} 页：${entry.text}`).join('\n');
          const task = {id: identity, scope: 'annotations', text,
            entries: entries.map(entry => ({page: head.page_mapping[entry.page], text: entry.text})),
            revision: head.revision, source_hash: head.source_hash,
            pages: [...new Set(entries.map(entry => head.page_mapping[entry.page]))], status: 'pending'};
          head.tasks.push(task);
          const receipt = {ok: true, task_id: identity, task, revision: head.revision};
          head.operations[identity] = {signature, receipt}; atomic(path, head);
          return receipt;
        }
        if (!['page', 'deck'].includes(command.scope) || typeof command.text !== 'string' || !command.text.trim()) fail('feedback', '请填写修改意见');
        const ids = command.scope === 'page' ? [command.page] : head.state.page_order;
        if (ids.some(id => !head.state.page_order.includes(id))) fail('feedback_page', '反馈页面不存在');
        const task = {id: identity, scope: command.scope, text: command.text,
          revision: head.revision, source_hash: head.source_hash, pages: ids.map(id => head.page_mapping[id]), status: 'pending'};
        head.tasks.push(task);
        const receipt = {ok: true, task_id: identity, task, revision: head.revision};
        head.operations[identity] = {signature, receipt}; atomic(path, head);
        return receipt;
      }
      fail('command_operation', '内容工作台只支持 state/save/feedback');
    } finally { unlock(); }
  } catch (error) { return {ok: false, code: error.code || 'content_command', error: error.message}; }
}
