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
// 待办任务认的是「提交那一刻的 head」。而 resolve 要求 task.revision 等于 head.revision，
// 一旦 head 前进（人提交批注后页面又自动保存一次、或产出方按新基线重建），任务就永远标不掉。
// 所以 head 前进时 pending 任务跟着前进；已完成的任务保留它当时的版本，作为处理记录。
const carryTasks = (tasks, revision, sourceHash) => (tasks ?? []).map(task =>
  task.status === 'pending' ? {...task, revision, source_hash: sourceHash} : task);
export const changesOf = state => ({contract_version: 'content-review-edits/1.1.0', edits: state.edits,
  page_order: state.page_order, section_order: state.section_order,
  added_pages: state.added_pages ?? {}, deleted_pages: state.deleted_pages ?? []});

// ── 按页指纹（unit）──────────────────────────────────────────────────────────
// adapter 可选导出 unitHashes(raw) → {pages:{[页号]:sha256}, sections:{[章节id]:sha256}}。
// 没有这个导出、抛错或返回空页时返回 null，整条逻辑退回旧的「整份文件一个指纹」行为，
// 别的 adapter 不会被弄坏。
export function unitsOf(adapterModule, raw) {
  try {
    if (typeof adapterModule?.unitHashes !== 'function') return null;
    const units = adapterModule.unitHashes(raw);
    if (!units || typeof units !== 'object') return null;
    const pages = units.pages && typeof units.pages === 'object' ? units.pages : {};
    const sections = units.sections && typeof units.sections === 'object' ? units.sections : {};
    if (!Object.keys(pages).length) return null;
    return {pages: {...pages}, sections: {...sections}};
  } catch { return null; }
}
const sameOrder = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length
  && a.every((id, index) => String(id) === String(b[index]));
// 一页的「编辑 patch」身份：页面文字修改 + 新增页自身的字段（负 id 页的标题就住在 added_pages 里）。
const pagePatch = (state, id) => contentHash({edit: state?.edits?.pages?.[id] ?? null, added: state?.added_pages?.[id] ?? null});
// page_versions 只记「人把这一页改成了不同内容」：模型改主稿不动它，重建基线按页集合/交集沿用。
function nextPageVersions(previous, previousState, nextState) {
  const versions = {};
  for (const id of nextState.page_order) {
    const key = String(id);
    versions[key] = (previous?.[key] ?? 0) + (pagePatch(previousState, key) === pagePatch(nextState, key) ? 0 : 1);
  }
  return versions;
}
function carriedPageVersions(context, previous = {}) {
  return Object.fromEntries(context.pages.map(page => {
    const key = String(page.page_number);
    return [key, previous?.[key] ?? 0];
  }));
}
// 把「内部页 id」的累计编辑翻译成「磁盘当前文件页号」的形状，再作用在当前文件上。
// 内部 id ↔ 磁盘页号 由上一版 head.state.page_order 的位置决定（磁盘就是按它写出来的）；
// 新加页（负 id）保持负 id —— adapter 每次都会按 added_pages 重新生成它。
function rebasedChanges(head, state) {
  const base = head.state.page_order.map(String);
  const translate = id => {
    const key = String(id);
    if (/^-\d+$/.test(key)) return key;
    const index = base.indexOf(key);
    return index < 0 ? key : String(index + 1);
  };
  const edits = state.edits ?? {};
  return {
    contract_version: 'content-review-edits/1.1.0',
    edits: {
      ...(edits.thesis !== undefined ? {thesis: edits.thesis} : {}),
      pages: Object.fromEntries(Object.entries(edits.pages ?? {}).map(([id, patch]) => [translate(id), patch])),
      sections: edits.sections ?? {},
    },
    page_order: state.page_order.map(translate),
    section_order: state.section_order ?? [],
    added_pages: state.added_pages ?? {},
    deleted_pages: state.deleted_pages ?? [],
  };
}
// 基线前进（另一个窗口/模型已保存过）时，把上一版已经提交的编辑并回 head.state：
// 否则文件里的内容与 head.state 会脱节，页面刷新/下一次保存会把别人已经落盘的编辑「忘掉」。
function mergeCommitted(previousState, nextState) {
  const before = previousState?.edits ?? {}, after = nextState.edits ?? {};
  const thesis = after.thesis !== undefined ? after.thesis : before.thesis;
  return {...nextState, edits: {...after,
    pages: {...(before.pages ?? {}), ...(after.pages ?? {})},
    sections: {...(before.sections ?? {}), ...(after.sections ?? {})},
    ...(thesis !== undefined ? {thesis} : {})},
    attachments: {...(previousState?.attachments ?? {}), ...(nextState.attachments ?? {})}};
}
// 这次保存是否在「回退」上一版已经提交的编辑（删掉了某页/某段的 patch）：
// 这种保存只有从基线重建才能把原文找回来。
function patchKeysLost(before = {}, after = {}) {
  return Object.entries(before).some(([id, patch]) => {
    const next = after?.[id];
    if (!next) return true;
    return Object.keys(patch).some(field => !(field in next));
  });
}
function editsReverted(previousState, nextState) {
  const before = previousState?.edits ?? {}, after = nextState?.edits ?? {};
  if (before.thesis !== undefined && after.thesis === undefined) return true;
  return patchKeysLost(before.pages, after.pages) || patchKeysLost(before.sections, after.sections);
}
// 外部（模型）改动过、但人还没编辑的页 —— 只作「这些页在磁盘上变了」的提示。
function externalPages(head, currentUnits, currentState) {
  if (!head.units || !currentUnits) return null;
  const edited = currentState?.edits?.pages ?? {}, added = currentState?.added_pages ?? {};
  const order = head.state.page_order.map(String);
  const pages = [];
  for (const key of new Set([...Object.keys(head.units.pages), ...Object.keys(currentUnits.pages)])) {
    if (head.units.pages[key] === currentUnits.pages[key]) continue;
    const id = order[Number(key) - 1];
    if (id !== undefined && (edited[id] !== undefined || added[id] !== undefined)) continue;
    pages.push(Number(key));
  }
  return [...new Set(pages)].filter(Number.isFinite).sort((a, b) => a - b);
}

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
// Uploaded images become canonical page references, not transient browser URLs.
function attachImages(raw, state, head, source, reviewDir, root) {
  if (head.context.type !== 'copy') return raw;
  for (const [id, attachments] of Object.entries(state.attachments ?? {})) {
    if (!head.context.pages.some(page => String(page.page_number) === id) || !Array.isArray(attachments)) fail('attachments', '图片未绑定当前页面');
    const number = state.page_order.map(String).indexOf(id) + 1;
    for (const image of attachments) {
      if (typeof image.path !== 'string' || !image.path.startsWith('uploads/')) fail('attachments', '图片必须来自本工作台上传目录');
      const file = contained(root, join(reviewDir, image.path));
      if (!file.startsWith(realpathSync(join(reviewDir, 'uploads')) + sep)) fail('attachments', '图片越出上传目录');
      if (!['.png', '.jpg', '.jpeg', '.webp', '.gif'].some(ext => file.toLowerCase().endsWith(ext))) fail('attachments', '只能添加图片');
      const ref = relative(dirname(source), file).split(sep).join('/');
      // 现在是把修改打在磁盘当前文件上（可能已经带着上次保存时插入的图片），
      // 所以同一张图已在正文里就不再插一次。
      if (raw.includes('](<' + ref + '>)')) continue;
      const pattern = new RegExp('(page_number: ' + number + '\\n[\\s\\S]*?## Page Content\\s*\\n[\\s\\S]*?)(\\n## Speaker Notes)');
      raw = raw.replace(pattern, (_, body, tail) => body + '\n![' + String(image.alt ?? '').replace(/[\[\]\n]/g, '') + '](<' + ref + '>)\n' + tail);
    }
  }
  return raw;
}

/** Called by both hosts after their capability/path checks. No model is involved. */
export async function runContentCommand(surface, command) {
  try {
    const root = realpathSync(surface.projectRoot), reviewDir = contained(root, surface.dir);
    const context = json(contained(root, join(reviewDir, 'review-context.json')));
    const adapterModule = await adapter(context);
    const apply = adapterModule.applyContentChanges;
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
        const rawHash = sha256(raw), revision = sha256(raw + context.sourceSha256);
        head = {version: 'content-workbench/1', revision, context,
          baseline: raw, source_hash: rawHash, state: initial(context),
          units: unitsOf(adapterModule, raw), page_versions: carriedPageVersions(context, head?.page_versions),
          deferred: null, tasks: carryTasks(head?.tasks, revision, rawHash), operations: {},
          page_mapping: Object.fromEntries(context.pages.map(p => [p.page_number, p.page_number]))};
        atomic(path, head);
      }
      if (command.op === 'state') {
        // 磁盘整份 hash 变了不再报错：改由 external_pages 说清「哪几页在磁盘上变了」。
        // 回执里带 context.sourceSha256，前端拿它和页面内嵌的 REVIEW.sourceSha256 比对即可
        // 判断「页面过期需要刷新」。
        if (!head.units) { checkSource(head, root); return {ok: true, ...head}; }
        const receipt = {ok: true, ...head};
        try {
          const source = contained(root, head.context.files[0].path);
          const currentUnits = unitsOf(adapterModule, readFileSync(source, 'utf8'));
          const current = command.state && typeof command.state === 'object' ? command.state : head.state;
          const pages = externalPages(head, currentUnits, current);
          if (pages) receipt.external_pages = pages;
        } catch (_) { /* 算不了就省略 */ }
        return receipt;
      }
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
      // 任务处理完成：不再要求 revision/source_hash 与 head 相等（整份文件锁已解开）；
      // stale_pages 只作提示：提交后用户又改过的页。
      if (command.op === 'resolve') {
        const ids = Array.isArray(command.task_ids) ? command.task_ids : [];
        if (!ids.length) fail('task_ids', '请指定已完成的任务');
        const pending = new Map((head.tasks ?? []).filter(task => task.status === 'pending').map(task => [task.id, task]));
        if (ids.some(id => !pending.has(id))) fail('task_version', '任务不存在或已完成');
        const stale = new Set();
        const resolvedAt = new Date().toISOString();
        let resolved = 0;
        for (const task of head.tasks ?? []) {
          if (task.status !== 'pending' || !ids.includes(task.id)) continue;
          task.status = 'resolved'; task.resolved_at = resolvedAt; resolved += 1;
          for (const [key, version] of Object.entries(task.page_versions ?? {})) {
            if ((head.page_versions?.[key] ?? 0) === version) continue;
            // 只提示当前工作台里还存在的页（重定基线后旧的新增页 id 可能已不在 page_mapping 里）。
            const display = head.page_mapping?.[key];
            if (display !== undefined) stale.add(Number(display));
          }
        }
        if (resolved) atomic(path, head);
        return {ok: true, resolved, revision: head.revision, stale_pages: [...stale].sort((a, b) => a - b)};
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
      // 按页合并只对 save 生效；feedback/resolve 不需要带基线。
      const allowsMerge = command.op === 'save' && !!head.units;
      if (allowsMerge && typeof command.base_revision !== 'string') fail('revision_conflict', '保存需要带上处理基线；当前编辑已保留');
      if (command.base_revision !== head.revision && !allowsMerge) fail('revision_conflict', '另一个窗口已保存新版本；当前编辑已保留，请核对后重试');
      // feedback 也不该被「模型改了别的页」整份锁住：只在 adapter 支持按页指纹时校验页集合，
      // 旧 adapter / 旧 head 才退回整文件 checkSource。
      const pagedFeedback = command.op === 'feedback' && !!head.units;
      const source = (allowsMerge || pagedFeedback) ? contained(root, head.context.files[0].path) : checkSource(head, root);
      for (const item of head.context.files.slice(1)) {
        if (sha256(readFileSync(contained(root, item.path))) !== item.sha256) fail('dependency_conflict', '来源、核查或资产清单已有变化，请核对后重新生成工作台');
      }
      if (command.op === 'save') {
        if (command.state?.source_sha256 !== head.context.sourceSha256 || command.state?.review_kind !== head.context.reviewKind) fail('baseline_conflict', '编辑来自不同基线');
        const changes = changesOf(command.state);
        validateChanges(changes, head.context);
        const previousState = head.state, previousVersions = head.page_versions ?? {};
        const currentRaw = readFileSync(source, 'utf8');
        const drifted = command.base_revision !== head.revision;
        let effectiveState = command.state, deferredPages = [], raw;
        if (!head.units) {
          // 旧 adapter（没导出 unitHashes）或旧 head：退回整文件基线行为。
          raw = apply(head.baseline, changes, head.context);
        } else {
          const added = changes.added_pages ?? {}, deleted = changes.deleted_pages ?? [];
          const newAddition = Object.keys(added).some(id => !(id in (previousState.added_pages ?? {})));
          const newDeletion = deleted.some(id => !(previousState.deleted_pages ?? []).includes(id));
          // 结构性修改以「磁盘当前顺序」（head.state.page_order）为基准，而不是产出方 context 页序：
          // 用户先重排过一次后再纯文字保存，相对磁盘其实也是重排，不能静默把页序翻回去。
          const structural = newAddition || newDeletion || !sameOrder(command.state.page_order, previousState.page_order);
          if (structural) {
            // 重排/增删会重写页号，无法按页 rebase；而且保存回基线是「清空已保存编辑」
            // 这类还原操作的唯一可靠路径，所以基线已前进时要求刷新，不能静默合并。
            if (drifted) fail('revision_conflict', '另一个窗口已保存新版本；含页序、增删的保存无法按页合并，请刷新后重试');
            // 磁盘必须仍是 head 写出的那份文件：结构性保存会按整份状态重建。
            if (sha256(currentRaw) !== head.source_hash) fail('source_conflict', '主稿已有外部修改；含页序、增删的保存需要在主稿未变时提交，请刷新后重试');
            // 从基线重建能精确还原用户状态，但会丢掉「已合并进主稿」的模型改动；作用在当前文件上则反之。
            // 上一版状态从基线重投后与主稿字节一致 ⇒ 主稿里没有模型改动，可以放心从基线重建；
            // 这次又在回退已保存的编辑 ⇒ 只有基线重建能还原原文。其余情况作用在当前文件上，保住模型改动。
            const cleanBaseline = (() => {
              try { return sha256(apply(head.baseline, changesOf(previousState), head.context)) === head.source_hash; }
              catch { return true; }
            })();
            raw = cleanBaseline || editsReverted(previousState, command.state)
              ? apply(head.baseline, changes, head.context)
              : apply(currentRaw, rebasedChanges(head, command.state), head.context);
          } else {
            const currentUnits = unitsOf(adapterModule, currentRaw);
            if (!currentUnits) fail('source_conflict', '主稿无法按页解析；你的编辑已保留，未覆盖主稿');
            const keys = units => Object.keys(units.pages ?? {}).sort().join('\n');
            if (keys(currentUnits) !== keys(head.units)) fail('source_conflict', '主稿页集合已变，请刷新工作台；你的编辑已保留，未覆盖主稿');
            // 用户编辑过的页：文字 patch 所在页，加上「新增页自身字段」被改过的负 id 页
            // （新页标题住在 added_pages 里，不是 edits.pages）。
            const editedIds = [...new Set([...Object.keys(changes.edits?.pages ?? {}),
              ...Object.keys(added).filter(id => previousState.added_pages?.[id] !== undefined
                && pagePatch(previousState, id) !== pagePatch(command.state, id))])];
            const forced = new Set((Array.isArray(command.force_pages) ? command.force_pages : []).map(String));
            const forcedPage = id => forced.has(String(id)) || forced.has(String(head.page_mapping?.[id]));
            const unitOf = (units, id) => units.pages[String(head.page_mapping?.[id] ?? id)];
            // 冲突分两种来源，同一份 deferred_pages 里返回：
            // ① 外部改动：磁盘该页指纹已不是 head 记录的那个（模型改过这一页）；
            // ② 并发窗口：基线已前进，且 head.state 里这一页已有另一窗口刚提交的 patch、
            //    与本次 patch 不同 —— 不静默覆盖另一个窗口同页的编辑。
            const concurrentPage = id => {
              if (!drifted || pagePatch(previousState, id) === pagePatch(command.state, id)) return false;
              return previousState.edits?.pages?.[id] !== undefined || previousState.added_pages?.[id] !== undefined;
            };
            const conflicting = editedIds.filter(id => !forcedPage(id) && (
              unitOf(currentUnits, id) !== unitOf(head.units, id) || concurrentPage(id)));
            deferredPages = conflicting.map(id => command.state.page_order.map(String).indexOf(String(id)) + 1).filter(n => n > 0);
            if (conflicting.length) {
              // 只保存不冲突的页；冲突页的编辑留在用户窗口/草稿里，由前端处理。
              const pages = {...(changes.edits.pages ?? {})};
              const addedPages = {...(command.state.added_pages ?? {})};
              for (const id of conflicting) {
                delete pages[id];
                if (previousState.added_pages?.[id] !== undefined) addedPages[id] = previousState.added_pages[id];
              }
              effectiveState = {...command.state, edits: {...changes.edits, pages}, added_pages: addedPages};
              if ('attachments' in command.state) {
                const attachments = {...(command.state.attachments ?? {})};
                for (const id of conflicting) delete attachments[id];
                effectiveState.attachments = attachments;
              }
            }
            if (drifted) effectiveState = mergeCommitted(previousState, effectiveState);
            raw = apply(currentRaw, rebasedChanges(head, effectiveState), head.context);
          }
        }
        raw = attachImages(raw, effectiveState, head, source, reviewDir, root);
        const hash = sha256(raw), previous = head.revision;
        const pageMapping = Object.fromEntries(command.state.page_order.map((id, i) => [id, i + 1]));
        const deferred = [...new Set(deferredPages)].sort((a, b) => a - b);
        const savedAt = new Date().toISOString();
        const receipt = {ok: true, revision: sha256(previous + signature), source_hash: hash,
          page_mapping: pageMapping,
          content_changed: hash !== head.source_hash,
          requires_fact_recheck: head.context.type === 'copy' && hash !== head.source_hash,
          deferred_pages: deferred, merged: !!drifted && !deferred.length};
        head = {...head, revision: receipt.revision, source_hash: hash, state: effectiveState,
          page_mapping: receipt.page_mapping, saved_at: savedAt,
          deferred: {pages: deferred, at: savedAt},
          ...(head.units ? {units: unitsOf(adapterModule, raw) ?? head.units,
            page_versions: nextPageVersions(previousVersions, previousState, effectiveState)} : {}),
          tasks: carryTasks(head.tasks, receipt.revision, hash)};
        head.operations[identity] = {signature, receipt};
        const archive = join(directory, 'history'); mkdirSync(archive, {recursive: true});
        contained(root, archive);
        if (!existsSync(join(archive, previous + '.json'))) atomic(join(archive, previous + '.json'), json(path));
        atomic(join(directory, 'journal.json'), {source, raw, old_hash: sha256(readFileSync(source)), new_hash: hash, head});
        recover(directory, root);
        // Mark the exact canonical projection as consumed so rebuilding this surface
        // does not mistake a saved main稿 for an unsubmitted draft. Deferred edits were
        // NOT applied, so they stay unconsumed.
        const cursorPath = join(reviewDir, '.inbox-cursor.json');
        const cursor = existsSync(cursorPath) ? json(cursorPath) : {};
        if (existsSync(cursorPath)) contained(root, cursorPath);
        cursor.applied_draft = contentHash(contentProjection(effectiveState));
        atomic(cursorPath, cursor);
        return receipt;
      }
      if (command.op === 'feedback') {
        // 批注：一次交齐页面上已有的所有批注（每页一条），模型拿到 page → 文本。
        // task 额外按页绑定内部页身份、提交时的 unit 指纹与页版本，供 resolve 判断 stale。
        // 不再整份文件 gate：模型改了别的页仍可提交；只有「页集合变了」才要求刷新。
        let currentUnits = null;
        if (head.units) {
          currentUnits = unitsOf(adapterModule, readFileSync(source, 'utf8'));
          if (!currentUnits) fail('source_conflict', '主稿无法按页解析；你的批注已保留，请刷新工作台');
          const keys = units => Object.keys(units.pages ?? {}).sort().join('\n');
          if (keys(currentUnits) !== keys(head.units)) fail('source_conflict', '主稿页集合已变，请刷新工作台；你的批注已保留');
        }
        const createdAt = new Date().toISOString();
        const unitHashFor = id => {
          const number = head.page_mapping?.[id];
          if (!head.units || number === undefined) return null;
          return head.units.pages[String(number)] ?? null;
        };
        // 提交时指纹用的是「用户看到的那版」（head.units），不是当前磁盘指纹；
        // page_drift 把「磁盘上这几页已和提交时不同」提示给模型，自己对照当前页。
        const driftOf = ids => {
          if (!currentUnits) return [];
          const drift = [];
          for (const id of ids) {
            const number = head.page_mapping?.[id];
            const before = number !== undefined ? head.units.pages[String(number)] : undefined;
            const now = currentUnits.pages[String(number ?? id)];
            if (before !== undefined && now !== undefined && now !== before) drift.push(Number(number ?? id));
          }
          return [...new Set(drift)].filter(Number.isFinite).sort((a, b) => a - b);
        };
        const hashesOf = ids => Object.fromEntries(ids.map(id => [String(id), unitHashFor(id)]).filter(([, hash]) => hash));
        const versionsOf = ids => Object.fromEntries(ids.map(id => [String(id), head.page_versions?.[String(id)] ?? 0]));
        if (command.scope === 'annotations') {
          const entries = Array.isArray(command.entries)
            ? command.entries.map(entry => ({page: entry?.page, text: typeof entry?.text === 'string' ? entry.text.trim() : ''})).filter(entry => entry.text)
            : [];
          if (!entries.length) fail('feedback', '请先写下批注');
          if (entries.some(entry => !head.state.page_order.includes(entry.page))) fail('feedback_page', '批注页面不存在');
          const keys = entries.map(entry => entry.page);
          const text = entries.map(entry => `第 ${head.page_mapping[entry.page]} 页：${entry.text}`).join('\n');
          const task = {id: identity, scope: 'annotations', text,
            entries: entries.map(entry => ({page: head.page_mapping[entry.page], key: entry.page,
              hash: unitHashFor(entry.page), text: entry.text})),
            revision: head.revision, source_hash: head.source_hash,
            pages: [...new Set(entries.map(entry => head.page_mapping[entry.page]))],
            page_keys: [...keys], page_hashes: hashesOf(keys), page_versions: versionsOf(keys),
            page_drift: driftOf(keys), created_at: createdAt, status: 'pending'};
          head.tasks.push(task);
          const receipt = {ok: true, task_id: identity, task, revision: head.revision};
          head.operations[identity] = {signature, receipt}; atomic(path, head);
          return receipt;
        }
        if (!['page', 'deck'].includes(command.scope) || typeof command.text !== 'string' || !command.text.trim()) fail('feedback', '请填写修改意见');
        const keys = command.scope === 'page' ? [command.page] : head.state.page_order;
        if (keys.some(id => !head.state.page_order.includes(id))) fail('feedback_page', '反馈页面不存在');
        const task = {id: identity, scope: command.scope, text: command.text,
          revision: head.revision, source_hash: head.source_hash,
          pages: keys.map(id => head.page_mapping[id]),
          page_keys: [...keys], page_hashes: hashesOf(keys), page_versions: versionsOf(keys),
          page_drift: driftOf(keys), created_at: createdAt, status: 'pending'};
        head.tasks.push(task);
        const receipt = {ok: true, task_id: identity, task, revision: head.revision};
        head.operations[identity] = {signature, receipt}; atomic(path, head);
        return receipt;
      }
      fail('command_operation', '内容工作台只支持 state/save/feedback');
    } finally { unlock(); }
  } catch (error) { return {ok: false, code: error.code || 'content_command', error: error.message}; }
}
