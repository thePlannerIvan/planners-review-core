'use strict';
const REVIEW = JSON.parse(document.getElementById('reviewData').textContent);
const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const icon = name => ReviewUI.icon(name).outerHTML;
const fresh = () => ({source_sha256:REVIEW.sourceSha256,review_kind:REVIEW.reviewKind,
  edits:{pages:{},sections:{}},page_order:REVIEW.pages.map(p => p.page_number),
  section_order:REVIEW.sections.map(s => s.section_id),added_pages:{},deleted_pages:[],
  feedbacks:{},attachments:{},asset_decisions:{},overall_feedback_zh:'',submitted_notes:{}});
let state = fresh(), page = state.page_order[0], mode = REVIEW.sections.length ? 'storyline' : 'bypage';
let review, writable = false, dsh = false, headRevision, pendingSave, pendingTask, contextStale = false;
let editsVersion = 0, draftVersion = 0, savedVersion = 0, draftedVersion = 0;
let timer, chain = Promise.resolve(), drag, justDragged = false, conflicted = false;
const recoveryKey = 'content-workbench:' + REVIEW.reviewKind + ':' + REVIEW.sourceSha256;
const pageById = id => REVIEW.pages.find(p => p.page_number === Number(id)) ?? {
  page_number:Number(id),section_id:state.added_pages[id]?.section_id,title:state.added_pages[id]?.title,
  claim:state.added_pages[id]?.title,blocks:[],sections:[]};
const patch = id => state.edits.pages[id] ??= {};
const title = id => state.edits.pages[id]?.title ?? pageById(id).title ?? '';
const noteOf = id => String(state.feedbacks[id] ?? '').trim();
const pendingNote = id => Boolean(noteOf(id)) && noteOf(id) !== String(state.submitted_notes?.[id] ?? '');
function selectPage(id) {
  const next = Number(id); if (!Number.isFinite(next)) return;
  page = next;
  $$('.outline-line').forEach(row => row.classList.toggle('active', Number(row.dataset.outlineId) === page));
  $$('.page-nav').forEach(node => node.classList.toggle('active', Number(node.dataset.id) === page));
  updateSelection();
}
const operationId = () => crypto.randomUUID();
const projection = s => JSON.stringify([s.edits,s.page_order,s.section_order,s.added_pages ?? {},s.deleted_pages ?? [],s.attachments ?? {},s.asset_decisions ?? {}]);
const uiProjection = s => JSON.stringify([projection(s),s.feedbacks ?? {},s.overall_feedback_zh ?? '']);
function notice(text) { $('#notice').textContent = text; $('#notice').hidden = !text; }
function status(text, dirty = false) { $('.save-state').classList.add('visible'); $('#saveState').textContent = text; $('#saveDot').classList.toggle('dirty',dirty); }
function snapshot() { return {...structuredClone(state),base_revision:headRevision,pending_save:pendingSave,
  pending_task:pendingTask,blocked_pages:blocked,view:{mode,page},saved_at:new Date().toISOString()}; }
// 模型已经改过、人还没核对的页：这次保存先不带它们，等用户选「保留我的」或「用模型版」。
function saveState() {
  const clone = structuredClone(state);
  for (const id of Object.keys(blocked)) {
    if (forcePages.has(String(id))) continue;
    if (clone.edits?.pages) delete clone.edits.pages[id];
  }
  return clone;
}
const pageIdOfNumber = number => state.page_order[Number(number) - 1];
function backup() { try { sessionStorage.setItem(recoveryKey,JSON.stringify(snapshot())); } catch (_) {} }
function enqueue(run) { const result = chain.then(run,run); chain = result.catch(() => {}); return result; }
function changed(content = true) {
  if (content) { editsVersion++; status('待保存', true); }
  draftVersion++; backup();
  clearTimeout(timer); timer = setTimeout(() => enqueue(async () => {
    if (!await persistDraft()) return false;
    return editsVersion > savedVersion ? persistCanonical() : true;
  }),400);
}
async function persistDraft() {
  const version = draftVersion;
  try { await review.draft(snapshot()); draftedVersion = version; return true; }
  catch (_) { notice('草稿未落盘，编辑仍保留在当前窗口。请重试保存。'); status('保存失败',true); return false; }
}
async function command(payload) {
  const result = await review.command(payload);
  if (!result?.ok) throw Object.assign(Error(result?.error ?? '保存未成功'),{code:result?.code});
  return result;
}
async function persistCanonical() {
  if (!writable || conflicted || contextStale) return false;
  try {
    // Keep the same operation across uncertain transport failures.
    if (!pendingSave) pendingSave = {op:'save',operation_id:operationId(),base_revision:headRevision,
      state:saveState(),force_pages:[...forcePages],edit_version:editsVersion};
    const version = pendingSave.edit_version;
    const {edit_version:_,...payload} = pendingSave; backup();
    const result = await command(payload);
    headRevision = result.revision; savedVersion = version; pendingSave = null;
    for (const key of [...forcePages]) forcePages.delete(key);
    for (const id of Object.keys(payload.state?.edits?.pages ?? {})) externalPages.delete(String(id));
    backup(); await persistDraft();
    if (needsRenderAfterSave) { needsRenderAfterSave = false; if (mode === 'storyline') renderStory(); else { updateSelection(); renderPageNotice(); } }
    const deferred = (result.deferred_pages ?? []).map(Number);
    if (deferred.length) {
      for (const number of deferred) blocked[pageIdOfNumber(number) ?? number] = true;
      status('已自动保存 · ' + deferred.length + ' 页待核对', true);
      notice('模型已更新第 ' + deferred.join('、') + ' 页；你这几页的修改先留着，没有覆盖模型版本。');
      if (mode === 'storyline') renderStory(); else { updateSelection(); renderPageNotice(); }
    } else {
      status('已自动保存');
      notice(result.merged ? '另一处已经存过新版本，这次按页合并了。' : '');
    }
    void loadVersions();
    if (savedVersion !== editsVersion) return persistCanonical();
    return savedVersion === editsVersion;
  } catch (error) {
    if (error.code === 'baseline_conflict') { contextStale = true; $('#reload')?.classList.add('attention'); status('待刷新', true); }
    if (['source_conflict','revision_conflict','baseline_conflict','dependency_conflict'].includes(error.code)) conflicted = true;
    backup(); await persistDraft();
    if (error.code === 'revision_conflict' || error.code === 'source_conflict') {
      $('#reload')?.classList.add('attention');
      notice(error.message + '：含页序/增删的保存需要刷新后重试；当前编辑已保留，刷新不会丢草稿。');
    } else {
      notice((error.code === 'baseline_conflict' ? '主稿已被模型更新；当前页面内容已过期，点右上角刷新载入新版本。' : error.message) + '：当前编辑已保留。');
    }
    status('保存失败',true); return false;
  }
}
async function save() {
  document.activeElement?.blur(); clearTimeout(timer);
  return enqueue(async () => await persistDraft() && await persistCanonical());
}
function textEditor(node, update) {
  node.contentEditable = String(writable); node.classList.toggle('editable-ready',writable);
  node.oninput = () => { update(node.textContent); changed(); updateNavTitles(); };
  node.onpaste = event => {
    if (!writable) return;
    event.preventDefault(); const selection = getSelection(); if (!selection.rangeCount) return;
    const range = selection.getRangeAt(0); range.deleteContents(); const text = document.createTextNode(event.clipboardData.getData('text/plain'));
    range.insertNode(text); range.setStartAfter(text); range.collapse(true); selection.removeAllRanges(); selection.addRange(range);
    update(node.textContent); changed(); updateNavTitles();
  };
}
marked.use({renderer:{
  html({text}) { return /^<br\s*\/?>(\n)?$/i.test(text) ? '<br>' : esc(text); },
  link({href,tokens}) { const label = this.parser.parseInline(tokens); return /^(https?:|mailto:|#)/i.test(href) ? '<a href="'+esc(href)+'" target="_blank" rel="noopener noreferrer">'+label+'</a>' : label; },
  image({href,text}) { return '<img data-original-src="'+esc(href)+'" alt="'+esc(text)+'">'; },
}});
function markdown(root, value, update) {
  const tokens = marked.lexer(String(value ?? ''));
  const commit = () => { const text = tokens.map(t => t.raw).join(''); update(text); changed(); markdown(root,text,update); };
  root.innerHTML = tokens.map((token,index) => '<div class="rich-block" data-token="'+index+'">'+marked.parser([token])+'</div>').join('');
  root.querySelectorAll('[data-token]').forEach(block => {
    const token = tokens[Number(block.dataset.token)];
    function editor(node, text, mutate) {
      if (!writable || node.querySelector('textarea')) return;
      const input = document.createElement('textarea'); input.className = 'block-editor'; input.value = text;
      node.replaceChildren(input); const resize = () => { input.style.height = 'auto'; input.style.height = input.scrollHeight+'px'; };
      input.oninput = () => { mutate(input.value); update(tokens.map(t => t.raw).join('')); changed(); resize(); };
      input.onblur = () => markdown(root,tokens.map(t => t.raw).join(''),update);
      input.onkeydown = e => { if (e.key === 'Escape') input.blur(); }; input.focus(); resize();
    }
    if (token.type === 'table') {
      const rows = [token.header,...token.rows];
      block.querySelectorAll('tr').forEach((row,r) => row.querySelectorAll('th,td').forEach((cell,c) => {
        cell.onclick = event => {
          if (event.target.closest('img,a,textarea') || !rows[r]?.[c]) return;
          editor(cell,rows[r][c].text,text => {
            rows[r][c].text = text;
            const cells = row => '| '+row.map(x => x.text.replace(/(?<!\\)\|/g,'\\|').replace(/\n/g,'<br>')).join(' | ')+' |';
            token.raw = cells(token.header)+'\n| '+token.align.map(a => a === 'center' ? ':---:' : a === 'right' ? '---:' : a === 'left' ? ':---' : '---').join(' | ')+' |\n'+token.rows.map(cells).join('\n')+'\n\n';
          });
        };
      }));
    } else if (!['space','html'].includes(token.type)) {
      block.onclick = event => { if (!event.target.closest('img,a,textarea,button')) editor(block,token.raw.trimEnd(),text => { token.raw = text+'\n\n'; }); };
    }
    if (writable) block.querySelectorAll('img').forEach(img => {
      const remove = document.createElement('button'); remove.className = 'review-icon-button image-inline-actions';
      remove.title = '移除图片'; remove.setAttribute('aria-label','移除图片'); remove.innerHTML = icon('Trash2');
      remove.onclick = e => {
        e.stopPropagation();
        const nodes = (token.tokens ?? []).filter(t => t.type === 'image');
        const image = nodes.find(t => t.href === img.dataset.originalSrc);
        if (image) token.raw = token.raw.replace(image.raw,'');
        else token.raw = '';
        commit();
      }; img.after(remove);
    });
  });
  hydrateAssets(root);
}
async function hydrateAssets(root) {
  await Promise.all([...root.querySelectorAll('img')].map(async img => {
    const rel = img.dataset.originalSrc ?? img.getAttribute('src');
    if (/^https?:/i.test(rel ?? '')) img.src = rel;
    else if (rel && !/^[a-z][a-z0-9+.-]*:/i.test(rel) && review) {
      try { const url = await review.asset(rel,{v:REVIEW.sourceSha256}); if (img.isConnected) img.src = url; }
      catch (_) { img.alt += '（未能加载）'; }
    }
    img.onclick = event => { event.stopPropagation(); $('#modalImage').src = img.src; $('#modalImage').alt = img.alt; $('#imageModal').classList.add('open'); };
  }));
}
let submittingAnnotations = false;
let submittingNote = false;
async function submitAnnotations() {
  if (!writable || submittingAnnotations) return;
  const entries = state.page_order
    .map(id => ({page: id, text: String(state.feedbacks[id] ?? '').trim()}))
    .filter(entry => entry.text);
  if (!entries.length) { notice('还没有批注：点行尾的批注按钮写一条。'); return; }
  document.activeElement?.blur();
  if (editsVersion > savedVersion) { if (!await save()) return; }
  submittingAnnotations = true;
  status('提交中', true);
  try {
    const text = entries.map(entry => `第 ${state.page_order.indexOf(entry.page) + 1} 页：${entry.text}`).join('\n');
    let result;
    try {
      result = await command({op:'feedback', operation_id:operationId(), base_revision:headRevision, scope:'annotations', entries});
    } catch (error) {
      if (!['feedback', 'feedback_page'].includes(error?.code)) throw error;
      result = await command({op:'feedback', operation_id:operationId(), base_revision:headRevision, scope:'deck', text});
    }
    status('已提交');
    for (const entry of entries) { (state.submitted_notes ??= {})[entry.page] = entry.text; }
    changed(false); renderNav(); if (mode === 'storyline') renderStory(); else updateSelection();
    status('已提交');
    notice('已提交 ' + entries.length + ' 条批注' + (dsh ? '，正在通知模型' : '，请回到对话通知模型处理'));
    if (dsh) {
      try {
        const wake = await review.wake({unit: entries.length + ' 条批注'});
        if (wake?.woke === false) notice('批注已保存，请回到对话继续。');
      } catch (_) { notice('批注已保存，通知未送达，请回到对话继续。'); }
    }
  } catch (error) {
    status('提交失败', true);
    notice('批注提交失败：' + (error?.message || error));
  } finally { submittingAnnotations = false; }
}
async function submitPageNote(id) {
  if (!writable || submittingNote) return;
  const pageKey = Number(id);
  const text = String(state.feedbacks[pageKey] ?? '').trim();
  if (!text) { notice('先写这一页要改什么。'); return; }
  document.activeElement?.blur();
  if (editsVersion > savedVersion) { if (!await save()) return; }
  submittingNote = true; status('提交中', true);
  try {
    const result = await command({op:'feedback', operation_id:operationId(), base_revision:headRevision,
      scope:'page', page:pageKey, text});
    (state.submitted_notes ??= {})[pageKey] = text;
    status('已提交');
    const drift = result?.task?.page_drift ?? [];
    notice('已提交第 '+(state.page_order.indexOf(pageKey)+1)+' 页批注'
      + (drift.length ? '；第 '+drift.join('、')+' 页磁盘上已更新，模型会以最新内容为准' : '')
      + (dsh ? '，正在通知模型' : '，请回到对话通知模型处理'));
    changed(false); renderNav(); if (mode === 'storyline') renderStory(); else updateSelection();
    if (dsh) {
      try { const wake = await review.wake({unit:'task-' + (result?.task_id ?? '')}); if (wake?.woke === false) notice('批注已保存，请回到对话继续。'); }
      catch (_) { notice('批注已保存，通知未送达，请回到对话继续。'); }
    }
  } catch (error) {
    status('提交失败', true); notice('批注提交失败：' + (error?.message || error));
  } finally { submittingNote = false; }
}
let openComment = null;
let blocked = {};
let externalPages = new Set();
let forcePages = new Set();
let needsRenderAfterSave = false;
function defaultPageOrder() {
  const pages = (REVIEW.pages ?? []).map(p => Number(p.page_number)).filter(id => !(state.deleted_pages ?? []).includes(id));
  return [...pages, ...Object.keys(state.added_pages ?? {}).map(Number)];
}
function normalizeOrder() {
  const allowed = defaultPageOrder();
  const list = Array.isArray(state.page_order) ? state.page_order.map(Number) : [];
  const valid = list.length === allowed.length && new Set(list).size === list.length
    && allowed.every(id => list.includes(id));
  if (!valid) state.page_order = allowed;
  if (!state.page_order.includes(Number(page)) && Number.isFinite(Number(page))) page = state.page_order[0];
}
function outlineBullets(id) {
  const edited = state.edits.pages[id]?.blocks;
  if (Array.isArray(edited)) return edited;
  const blocks = pageById(id)?.blocks ?? [];
  return blocks.map((block, index) => {
    const legacy = edited?.[index] && typeof edited[index] === 'object' ? edited[index].text : undefined;
    return legacy ?? block.text;
  });
}
function focusEnd(node) {
  if (!node) return;
  node.focus();
  if (node.tagName === 'TEXTAREA' || node.tagName === 'INPUT') {
    const end = node.value.length;
    try { node.setSelectionRange(end, end); } catch (_) {}
    return;
  }
  const selection = getSelection();
  if (!selection) return;
  const range = document.createRange();
  range.selectNodeContents(node); range.collapse(false);
  selection.removeAllRanges(); selection.addRange(range);
}
function supportNode(id, index) { return document.querySelector('[data-outline-id="'+id+'"] .support-text[data-support-index="'+index+'"]'); }
function commentCard(id) {
  const value = state.feedbacks[id] ?? '';
  const submitted = String(state.submitted_notes?.[id] ?? '') === String(value).trim() && String(value).trim();
  return '<div class="line-comment" data-comment-card="'+id+'"'+(submitted ? ' data-submitted="1"' : '')+'>'
    + '<textarea data-note-input="'+id+'" rows="3" placeholder="这一页要怎么改？模型会收到这条批注。">'+esc(value)+'</textarea>'
    + '<div class="line-comment-foot">'
    + '<button type="button" class="secondary" data-comment-close="'+id+'">收起</button>'
    + '<button type="button" class="primary" data-comment-submit="'+id+'">提交这一页</button></div></div>';
}
function conflictCard(id) {
  return '<div class="line-conflict" data-conflict="'+id+'"><span>模型已更新这一页；你的这页修改还没保存。</span>'
    + '<button type="button" class="secondary" data-keep-mine="'+id+'">保留我的</button>'
    + '<button type="button" class="secondary" data-use-model="'+id+'">用模型版</button></div>';
}
function renderStory() {
  $('.thesis').hidden = !REVIEW.thesis && state.edits.thesis === undefined;
  $('.thesis p').textContent = state.edits.thesis ?? REVIEW.thesis;
  textEditor($('.thesis p'),text => { state.edits.thesis = text; });
  $('#outlineList').hidden = false;
  $('#outlineList').innerHTML = state.page_order.map((id,i) => {
    const supportList = outlineBullets(id), bullets = supportList.length ? supportList : [''];
    const supports = bullets.map((text,index) => '<div class="support-row"><span class="support-dot" aria-hidden="true">·</span>'
      + '<div class="support-text" data-support-index="'+index+'" contenteditable="'+writable+'" spellcheck="false">'+esc(text)+'</div></div>').join('');
    const rawNotes = state.edits.pages[id]?.notes ?? pageById(id).notes;
    const notes = REVIEW.simpleStoryline
      ? '<div class="line-notes" data-content-notes="'+id+'" contenteditable="'+writable+'" spellcheck="false">'+esc(rawNotes ?? '')+'</div>' : '';
    const note = state.feedbacks[id] ?? '';
    return '<li class="outline-line'+(String(id) === String(page) ? ' active' : '')+'" data-outline-id="'+id+'">'
      + '<div class="line-gutter"><span class="line-index">'+(i+1)+'</span>'
      + '<button type="button" class="outline-grip" title="按住拖动调整页序；Alt+↑↓ 也可以" aria-label="拖动调整页序">'+icon('GripVertical')+'</button></div>'
      + '<div class="line-body">'
      + '<div class="line-title" data-outline-title="'+id+'" contenteditable="'+writable+'" spellcheck="false">'+esc(title(id))+'</div>'
      + (Number(id) < 0 ? '<span class="line-new-tag">新页</span>' : '')
      + (externalPages.has(String(id)) && !blocked[id] ? '<span class="line-external-tag" title="模型改过这一页；刷新审阅页后能看到模型版本">模型已更新</span>' : '')
      + '<div class="line-supports">'+supports+'</div>'
      + (writable || !supportList.length ? '<button type="button" class="support-add" data-support-add="'+id+'">＋ 添加支撑</button>' : '')
      + notes
      + (blocked[id] ? conflictCard(id) : '')
      + (openComment === String(id) ? commentCard(id) : '')
      + '</div>'
      + '<div class="line-actions">'
      + '<button type="button" class="review-icon-button" data-outline-note="'+id+'" data-has-note="'+(note.trim() ? 1 : 0)+'" title="批注这一页" aria-label="批注这一页">'+icon('MessageSquare')+'</button>'
      + '<button type="button" class="review-icon-button" data-delete-node="'+id+'" title="删除这一页" aria-label="删除这一页" '+(!writable || state.page_order.length < 2 ? 'disabled' : '')+'>'+icon('Trash2')+'</button>'
      + '</div></li>';
  }).join('');
  $$('#outlineList [data-outline-title]').forEach(node => {
    textEditor(node,text => {
      if (state.added_pages[node.dataset.outlineTitle]) state.added_pages[node.dataset.outlineTitle].title = text;
      else patch(node.dataset.outlineTitle).title = text;
    });
    node.onfocus = () => selectPage(node.dataset.outlineTitle);
    node.onkeydown = event => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        focusEnd(supportNode(node.dataset.outlineTitle, 0));
      }
      if (event.key === 'Escape') node.blur();
    };
  });
  $$('#outlineList .support-text').forEach(node => {
    const row = node.closest('[data-outline-id]');
    const id = row.dataset.outlineId;
    const read = () => [...row.querySelectorAll('.support-text')].map(item => item.textContent.replace(/\s+$/,''));
    const commit = list => { patch(id).blocks = list; changed(); };
    node.oninput = () => commit(read());
    node.onfocus = () => selectPage(id);
    node.onkeydown = event => {
      const index = Number(node.dataset.supportIndex);
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        const list = read(); list.splice(index + 1, 0, ''); commit(list); renderStory();
        focusEnd(supportNode(id, index + 1));
        return;
      }
      if (event.key === 'Backspace' && !node.textContent.trim()) {
        const list = read();
        if (list.length <= 1) return;
        event.preventDefault();
        list.splice(index, 1); commit(list); renderStory();
        focusEnd(supportNode(id, Math.max(0, index - 1)));
        return;
      }
      if (event.key === 'ArrowUp' && index === 0) { event.preventDefault(); focusEnd(document.querySelector('[data-outline-id="'+id+'"] [data-outline-title]')); }
      if (event.key === 'ArrowDown' && index === read().length - 1) {
        const next = document.querySelector('[data-outline-id="'+id+'"] [data-content-notes]');
        if (next) { event.preventDefault(); focusEnd(next); }
      }
      if (event.key === 'Escape') node.blur();
    };
  });
  $$('#outlineList [data-support-add]').forEach(button => button.onclick = () => {
    const id = button.dataset.supportAdd;
    const list = outlineBullets(id).slice(); list.push('');
    patch(id).blocks = list; changed(); renderStory(); focusEnd(supportNode(id, list.length - 1));
  });
  $$('#outlineList [data-content-notes]').forEach(node => {
    const id = node.dataset.contentNotes;
    node.oninput = () => { patch(id).notes = node.textContent.replace(/\s+$/,''); changed(); };
    node.onfocus = () => selectPage(id);
    node.onkeydown = event => { if (event.key === 'Escape') node.blur(); };
  });
  $$('#outlineList [data-outline-note]').forEach(button => button.onclick = () => {
    const id = button.dataset.outlineNote;
    openComment = String(openComment) === String(id) ? null : String(id);
    selectPage(id); renderStory();
    if (openComment) focusEnd(document.querySelector('[data-note-input="'+openComment+'"]'));
  });
  $$('#outlineList [data-comment-close]').forEach(button => button.onclick = () => { openComment = null; renderStory(); });
  $$('#outlineList [data-comment-submit]').forEach(button => button.onclick = () => { void submitPageNote(button.dataset.commentSubmit); });
  $$('#outlineList [data-note-input]').forEach(node => {
    node.oninput = () => {
      const id = node.dataset.noteInput;
      state.feedbacks[id] = node.value;
      if (String(page) === String(id)) $('#feedback').value = node.value;
      changed(false); renderNav();
    };
    node.onkeydown = event => { if (event.key === 'Escape') { openComment = null; renderStory(); } };
  });
  $$('#outlineList [data-keep-mine]').forEach(button => button.onclick = () => {
    const id = button.dataset.keepMine;
    forcePages.add(String(id)); delete blocked[id]; externalPages.delete(String(id)); pendingSave = null;
    needsRenderAfterSave = true;
    notice('正在用你的版本覆盖这一页'); void save();
  });
  $$('#outlineList [data-use-model]').forEach(button => button.onclick = () => {
    const id = button.dataset.useModel;
    delete blocked[id]; forcePages.delete(String(id)); pendingSave = null;
    const target = state.edits.pages[id];
    if (target && !state.added_pages[id]) {
      for (const key of ['title','blocks','notes','claim']) delete target[key];
      if (!Object.keys(target).length) delete state.edits.pages[id];
    }
    renderStory();
    notice('已放弃你对这一页的修改。模型改过的内容会在模型重新生成审阅页后出现。');
    void save();
  });
  $$('#outlineList .outline-line').forEach(row => {
    const id = row.dataset.outlineId;
    row.addEventListener('click', event => {
      if (event.target.closest('button, .line-comment, [contenteditable]')) return;
      selectPage(id);
    });
    row.addEventListener('focusin', () => selectPage(id));
    enableRowDrag(row, Number(row.dataset.outlineId));
  });
  $$('#outlineList [data-delete-node]').forEach(button => button.onclick = () => {
    const id = Number(button.dataset.deleteNode); if (!writable || state.page_order.length < 2) return;
    state.page_order = state.page_order.filter(n => n !== id);
    if (id < 0) { delete state.added_pages[id]; delete state.edits.pages[id]; }
    else state.deleted_pages.push(id);
    if (page === id) page = state.page_order[0]; changed(); render();
  });
  $('#storyStream').innerHTML = state.section_order.map(id => {
    const section = REVIEW.sections.find(s => s.section_id === id), e = state.edits.sections[id] ?? {};
    return '<article class="story-card" data-section-id="'+esc(id)+'"><h2 data-field="title">'+esc(e.title ?? section.title)+'</h2>'+ (REVIEW.simpleStoryline ? '' : '<p data-field="lead">'+esc(e.lead ?? section.lead)+'</p><p data-field="transition">'+esc(e.transition ?? section.transition)+'</p>')+'</article>';
  }).join('');
  $$('#storyStream [data-field]').forEach(node => textEditor(node,text => {
    const id = node.closest('[data-section-id]').dataset.sectionId; (state.edits.sections[id] ??= {})[node.dataset.field] = text;
  }));
}

function renderPageNotice() {
  const box = $('#pageNotice'); if (!box) return;
  if (blocked[page]) {
    box.hidden = false;
    box.innerHTML = '<div class="line-conflict"><span>模型已更新这一页；你的这页修改还没保存。</span>'
      + '<button type="button" class="secondary" data-keep-mine="'+page+'">保留我的</button>'
      + '<button type="button" class="secondary" data-use-model="'+page+'">用模型版</button></div>';
    box.querySelector('[data-keep-mine]').onclick = () => {
      forcePages.add(String(page)); delete blocked[page]; externalPages.delete(String(page)); pendingSave = null;
      needsRenderAfterSave = true; notice('正在用你的版本覆盖这一页'); void save();
    };
    box.querySelector('[data-use-model]').onclick = () => {
      delete blocked[page]; forcePages.delete(String(page)); pendingSave = null;
      const target = state.edits.pages[page];
      if (target && !state.added_pages[page]) {
        for (const key of ['title','blocks','notes','claim']) delete target[key];
        if (!Object.keys(target).length) delete state.edits.pages[page];
      }
      renderPage();
      notice('已放弃你对这一页的修改。模型改过的内容会在模型重新生成审阅页后出现。');
      void save();
    };
  } else if (externalPages.has(String(page))) {
    box.hidden = false;
    box.innerHTML = '<div class="line-external-tag">模型已更新这一页；刷新审阅页后可见</div>';
  } else { box.hidden = true; box.innerHTML = ''; }
}
function renderPage() {
  const p = pageById(page), e = state.edits.pages[page] ?? {};
  renderPageNotice();
  $('#currentPageLabel').textContent = String(state.page_order.indexOf(page)+1).padStart(2,'0');
  $('#pageTitle').textContent = title(page); $('#pageClaim').textContent = e.claim ?? p.claim ?? '';
  $('#pageClaim').hidden = !$('#pageClaim').textContent;
  textEditor($('#pageTitle'),text => { patch(page).title = text; });
  textEditor($('#pageClaim'),text => { patch(page).claim = text; });
  $('#pageContent').innerHTML = '';
  (p.blocks ?? []).forEach((b,i) => {
    const outer = document.createElement('section'); outer.className = 'content-block';
    outer.innerHTML = '<h3>'+esc(e.blocks?.[i]?.title ?? b.title)+'</h3><p>'+esc(e.blocks?.[i]?.text ?? b.text)+'</p>';
    for (const [tag,field] of [['h3','title'],['p','text']]) textEditor(outer.querySelector(tag),text => {
      const target = patch(page); target.blocks ??= {}; (target.blocks[i] ??= {})[field] = text;
    }); $('#pageContent').appendChild(outer);
  });
  (p.sections ?? []).forEach((s,i) => {
    const outer = document.createElement(s.collapsed ? 'details' : 'section'); outer.className = s.collapsed ? 'source-panel' : 'copy-block';
    const heading = document.createElement(s.collapsed ? 'summary' : 'h3'); heading.textContent = s.label;
    const body = document.createElement('div'); body.className = 'rich-copy'; outer.append(heading,body); $('#pageContent').appendChild(outer);
    const value = e.sections?.[i] ?? (Array.isArray(s.value) ? s.value.join('\n') : s.value ?? '');
    if (s.editable === false) body.textContent = value;
    else markdown(body,value,text => { const target = patch(page); target.sections ??= {}; target.sections[i] = text; });
  });
  const images = document.createElement('div'); images.className = 'workbench-uploads';
  images.innerHTML = (state.attachments[page] ?? []).map((a,i) => '<figure><img data-original-src="'+esc(a.path)+'" alt="'+esc(a.alt)+'"><figcaption>'+esc(a.alt)+'<button class="review-icon-button" data-remove-upload="'+i+'" title="移除图片" aria-label="移除图片">'+icon('Trash2')+'</button></figcaption></figure>').join('');
  images.querySelectorAll('[data-remove-upload]').forEach(button => {
    button.disabled = !writable; button.onclick = () => { state.attachments[page].splice(Number(button.dataset.removeUpload),1); if (!state.attachments[page].length) delete state.attachments[page]; changed(); renderPage(); };
  }); $('#pageContent').appendChild(images); hydrateAssets(images);
  renderAssets(); updateSelection();
}
function renderAssets() {
  const p = pageById(page), list = p.asset_candidates ?? [];
  $('#assetSection').hidden = mode !== 'bypage' || !list.length;
  $('#candidateMore').hidden = true;
  $('#candidateList').innerHTML = list.map(a => {
    const selected = state.asset_decisions[page]?.find(x => x.asset_id === a.asset_id)?.status ?? a.status ?? 'backup';
    return '<div class="candidate"><img data-original-src="'+esc(a.url)+'" alt="'+esc(a.alt ?? a.asset_id)+'"><div class="candidate-copy"><strong>'+esc(a.alt ?? a.asset_id)+'</strong><small>'+esc(a.reason)+'</small></div><select data-asset-id="'+esc(a.asset_id)+'" aria-label="图片取舍">'+[['selected','采用'],['backup','备用'],['excluded','排除'],['replace','替换']].map(([v,label]) => '<option value="'+v+'" '+(v === selected ? 'selected' : '')+'>'+label+'</option>').join('')+'</select></div>';
  }).join('');
  $$('#candidateList select').forEach(select => {
    select.disabled = !writable; select.onchange = () => {
      state.asset_decisions[page] ??= list.map(a => ({asset_id:a.asset_id,status:a.status ?? 'backup'}));
      state.asset_decisions[page].find(a => a.asset_id === select.dataset.assetId).status = select.value; changed();
    };
  }); hydrateAssets($('#candidateList'));
}
function updateNavTitles() {
  $$('.page-nav').forEach(node => { node.querySelector('.page-nav-title').textContent = title(node.dataset.id); });
  if ($('#inspectorTitle') && state.page_order.includes(page)) { $('#inspectorTitle').textContent = title(page); $('#inspectorTitle').title = title(page); }
}
function updateSelection() {
  $$('.page-nav').forEach(node => node.classList.toggle('active',Number(node.dataset.id) === page));
  const kicker = $('#inspectorKicker'); if (kicker) kicker.textContent = '本页'; const pageNo = state.page_order.indexOf(page)+1;
  $('#inspectorTitle').textContent = title(page);
  $('#inspectorTitle').title = title(page);
  $('#feedback').value = state.feedbacks[page] ?? ''; $('#overallFeedback').value = state.overall_feedback_zh;
  const p = pageById(page); $('#factNotice').hidden = !p.requires_fact_decision;
  $('#factNotice').textContent = (p.fact_exceptions ?? []).map(f => [f.surface,f.note].filter(Boolean).join('：')).join('\n');
  $('#uploadSection').hidden = mode !== 'bypage' || !REVIEW.allowUploads || !writable || !review?.capabilities.includes('asset-upload');
  $('#pagePrev').disabled = state.page_order.indexOf(page) <= 0;
  $('#pageNext').disabled = state.page_order.indexOf(page) >= state.page_order.length-1;
  $('#pageTaskButton').hidden = false;
  $('#pagePrev').hidden = mode !== 'bypage'; $('#pageNext').hidden = mode !== 'bypage';
  // 这两个按钮由脚本动态创建，取不到时不要抛错（抛错会中断整段渲染）。
  for (const node of [$('#pageTaskButton'), $('#saveButton')]) if (node) node.disabled = !writable || conflicted;
}
function movePage(id,target,after) {
  id = Number(id); target = Number(target);
  if (!writable || !Number.isFinite(id) || !Number.isFinite(target) || id === target) return;
  state.page_order = state.page_order.filter(n => Number(n) !== id);
  const at = state.page_order.indexOf(target);
  if (at < 0) return;
  state.page_order.splice(at + (after ? 1 : 0), 0, id); changed(); render();
}
function enableRowDrag(node, id) {
  const handle = node.querySelector('.outline-grip, .drag-handle');
  if (!handle) return;
  handle.addEventListener('click', event => event.preventDefault());
  handle.addEventListener('pointerdown', event => {
    if (!writable || event.button !== 0) return;
    event.preventDefault(); event.stopPropagation();
    const startX = event.clientX, startY = event.clientY;
    let active = false, target = null, after = false;
    const list = node.closest('.outline-list, .page-list');
    const ghost = document.createElement('div');
    ghost.className = 'drag-ghost'; ghost.textContent = title(id); ghost.hidden = true;
    document.body.appendChild(ghost);
    const clear = () => $$('.drop-before, .drop-after').forEach(other => other.classList.remove('drop-before', 'drop-after'));
    const onMove = event => {
      if (!active) {
        if (Math.abs(event.clientY - startY) < 4 && Math.abs(event.clientX - startX) < 4) return;
        active = true; node.classList.add('dragging'); ghost.hidden = false;
      }
      ghost.style.left = (event.clientX + 14) + 'px';
      ghost.style.top = (event.clientY + 8) + 'px';
      const hit = document.elementFromPoint(event.clientX, event.clientY)?.closest('.outline-line, .page-nav');
      if (hit && hit !== node && list?.contains(hit)) {
        target = Number(hit.dataset.outlineId ?? hit.dataset.id);
        after = event.clientY > hit.getBoundingClientRect().top + hit.offsetHeight / 2;
        clear(); hit.classList.toggle('drop-after', after); hit.classList.toggle('drop-before', !after);
      } else { target = null; clear(); }
      const scroller = $('.workspace');
      if (list?.classList.contains('outline-list')) {
        const box = scroller.getBoundingClientRect();
        if (event.clientY < box.top + 48) scroller.scrollTop -= 12;
        else if (event.clientY > box.bottom - 48) scroller.scrollTop += 12;
      }
    };
    const finish = () => {
      window.removeEventListener('pointermove', onMove);
      node.classList.remove('dragging'); ghost.remove(); clear();
      if (active && target !== null) movePage(id, target, after);
      justDragged = true; setTimeout(() => { justDragged = false; }, 220);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', finish, { once: true });
    window.addEventListener('pointercancel', finish, { once: true });
  });
  handle.addEventListener('keydown', event => {
    if (!writable || !event.altKey || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    const at = state.page_order.indexOf(Number(id));
    const target = state.page_order[at + (event.key === 'ArrowUp' ? -1 : 1)];
    if (target !== undefined) movePage(Number(id), target, event.key === 'ArrowDown');
  });
}

function renderNav() {
  $('#railTitle').hidden = true;
  $('#railCount').textContent = state.page_order.length+' 页';
  $('#pageList').innerHTML = state.page_order.map((id,i) => {
    const pending = pendingNote(id) ? 1 : 0;
    return '<button class="page-nav'+(Number(id) === page ? ' active' : '')+'" data-id="'+id+'" data-pending="'+pending+'"'+(blocked[id] ? ' data-blocked="1"' : '')+'>'
      +'<span class="page-num">'+String(i+1).padStart(2,'0')+'</span>'
      +'<span class="page-nav-title">'+esc(title(id))+'</span>'
      +'<span class="page-state" role="img" aria-label="'+(pending?'有未提交批注':'')+'" title="'+(pending?'有未提交批注':'')+'"></span>'
      +'<span class="drag-handle" role="button" tabindex="0" title="调整顺序" aria-label="调整顺序">'+icon('GripVertical')+'</span></button>';
  }).join('');
  $$('.page-nav').forEach(node => { const id = Number(node.dataset.id); enableRowDrag(node,id);
    node.onclick = e => { if (e.target.closest('.drag-handle')) return; document.activeElement?.blur(); page = id; renderPage(); updateSelection();
      if (mode === 'storyline') $('[data-outline-id="'+id+'"]')?.scrollIntoView({block:'nearest'});
      else $('.workspace').scrollTop = 0;
    };
  });
}
function render() {
  $$('.mode-tabs button').forEach(b => b.classList.toggle('active',b.dataset.mode === mode));
  $('#storylineView').classList.toggle('view-active',mode === 'storyline'); $('#bypageView').classList.toggle('view-active',mode === 'bypage');
  renderNav(); if (mode === 'storyline') renderStory(); else renderPage(); updateSelection();
}
async function task(scope) {
  if (!writable || conflicted) return;
  const taskPage = scope === 'page' ? page : null;
  const text = scope === 'page' ? state.feedbacks[taskPage] : state.overall_feedback_zh;
  // 整套提交时若只写了页内批注，就直接按批注交，不要因为「整体意见为空」看起来没反应
  if (scope === 'deck' && !String(text ?? '').trim()) {
    const hasNotes = state.page_order.some(id => String(state.feedbacks[id] ?? '').trim());
    if (hasNotes) return submitAnnotations();
  }
  if (!text?.trim()) { notice(scope === 'page' ? '请填写本页批注。' : '请填写整体修改意见。'); return; }
  const signature = JSON.stringify([scope,taskPage,text]);
  const samePending = pendingTask?.signature === signature;
  // A content save may advance the revision. Do it before creating a new task;
  // a retry of the same uncertain task keeps its original operation identity.
  if (editsVersion > savedVersion) { pendingTask = null; if (!await save()) return; }
  try {
    if (!samePending || !pendingTask) pendingTask = {op:'feedback',operation_id:operationId(),base_revision:headRevision,scope,page:taskPage,text,signature};
    const result = await command(pendingTask); pendingTask = null;
    const unit = 'task-'+result.task_id; status('已提交');
    if (dsh) { try { const wake = await review.wake({unit}); if (wake?.woke === false) notice('任务已保存，请回到对话继续。'); }
      catch (_) { notice('任务已保存，通知未送达。请回到对话继续。'); } }
    else notice('修改任务已保存，请回到对话继续。');
  } catch (error) { notice(error.message+'。意见已保留。'); }
}
$('#addStoryline').onclick = () => {
  if (!writable) return; let id = -1; while (state.added_pages[id]) id--;
  state.added_pages[id] = {title:'新判断',section_id:pageById(page).section_id ?? REVIEW.sections[0].section_id};
  const at = state.page_order.indexOf(page); state.page_order.splice(at+1,0,id); page = id; changed(); render();
  focusEnd($('[data-outline-title="'+id+'"]'));
};
$$('.mode-tabs button').forEach(b => b.onclick = () => { document.activeElement?.blur(); mode = b.dataset.mode; render(); });
function navigate(delta) { document.activeElement?.blur(); const next = state.page_order[state.page_order.indexOf(page)+delta]; if (next !== undefined) { page = next; renderNav(); renderPage(); $('.workspace').scrollTop = 0; } }
$('#pagePrev').onclick = () => navigate(-1); $('#pageNext').onclick = () => navigate(1);
$('#feedback').oninput = () => {
  state.feedbacks[page] = $('#feedback').value;
  changed(false); renderNav();
  const inline = document.querySelector('[data-note-input="'+page+'"]'); if (inline) inline.value = $('#feedback').value;
  if (mode === 'storyline') {
    const dot = document.querySelector('[data-outline-note="'+page+'"]');
    if (dot) dot.dataset.hasNote = $('#feedback').value.trim() ? '1' : '0';
  }
};
$('#overallFeedback').oninput = () => { state.overall_feedback_zh = $('#overallFeedback').value; changed(false); };
// 任务动作与保存动作分开：任务会唤醒模型，保存只写入当前工作台。
$('#saveButton').onclick = () => task('deck');
async function uploadImages(files) {
  const id = page; if (!writable || !files?.length) return;
  for (const file of files) {
    if (!['image/png','image/jpeg','image/webp','image/gif'].includes(file.type)) { notice('请选择 PNG、JPEG、WebP 或 GIF 图片。'); continue; }
    const rel = 'uploads/page-'+id+'/'+operationId()+'-'+file.name.replace(/[^\p{L}\p{N}._-]/gu,'-');
    try { await review.upload(file,rel); (state.attachments[id] ??= []).push({path:rel,alt:file.name}); }
    catch (_) { notice('图片未落盘，请重试。'); }
  }
  changed(); if (page === id) renderPage();
}
const uploadDrop = $('#uploadDrop');
if (uploadDrop) {
  uploadDrop.onclick = () => $('#uploadFile').click();
  uploadDrop.onkeydown = event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); $('#uploadFile').click(); } };
  uploadDrop.ondragover = event => { event.preventDefault(); uploadDrop.classList.add('over'); };
  uploadDrop.ondragleave = () => uploadDrop.classList.remove('over');
  uploadDrop.ondrop = event => { event.preventDefault(); uploadDrop.classList.remove('over'); void uploadImages([...(event.dataTransfer?.files || [])]); };
}
document.addEventListener('paste', event => {
  if (mode !== 'bypage' || !writable) return;
  const target = event.target;
  if (target?.closest?.('textarea,input,[contenteditable="true"]')) return;
  const files = [...(event.clipboardData?.files || [])].filter(file => file.type.startsWith('image/'));
  if (!files.length) return;
  event.preventDefault(); void uploadImages(files);
});
$('#uploadFile').onchange = async () => { const files = [...($('#uploadFile').files || [])]; $('#uploadFile').value = ''; await uploadImages(files); };
$('#railToggle').onclick = () => {
  const collapsed = $('.layout').classList.toggle('rail-collapsed');
  $('#railToggle').setAttribute('aria-expanded', String(!collapsed));
  $('#railToggle').innerHTML = icon(collapsed?'ChevronRight':'ChevronLeft');
};
// 刷新永远可达：先尽力保存，保存不了（冲突/基线变化）也要把草稿留下再刷新。
$('#reload').onclick = async () => {
  clearTimeout(timer);
  if (!contextStale && !conflicted && editsVersion > savedVersion) await save();
  if (await persistDraft()) location.reload();
};
$('#inspectorToggle').onclick = () => { const collapsed = $('.layout').classList.toggle('inspector-collapsed'); $('.inspector').classList.toggle('collapsed',collapsed); $('#inspectorToggle').innerHTML = icon(collapsed ? 'ChevronLeft' : 'ChevronRight'); $('#inspectorToggle').setAttribute('aria-expanded',String(!collapsed)); };
$('#modalClose').onclick = () => $('#imageModal').classList.remove('open');
$('#imageModal').onclick = e => { if (e.target === $('#imageModal')) $('#imageModal').classList.remove('open'); };
window.addEventListener('keydown',e => { if (e.key === 'Escape') { document.activeElement?.blur(); $('#imageModal').classList.remove('open'); }
  if (mode === 'bypage' && !e.target.closest('textarea,input,[contenteditable="true"]') && ['PageUp','PageDown'].includes(e.key)) { e.preventDefault(); navigate(e.key === 'PageUp' ? -1 : 1); }
});
window.addEventListener('beforeunload',e => { if (draftVersion > draftedVersion || editsVersion > savedVersion) { backup(); e.preventDefault(); e.returnValue = ''; } });
async function boot() {
  $('.decision-row').hidden = true; $('#priorOpinion').hidden = true; $('#chapterDetails').open = false;
  if (!REVIEW.sections.length) $('.mode-tabs [data-mode="storyline"]').hidden = true;
  if (REVIEW.simpleStoryline) $('.mode-tabs [data-mode="bypage"]').hidden = true;
  $('#feedback').disabled = true; $('#overallFeedback').disabled = true;
  $('#saveButton').innerHTML = icon('MessageSquare')+'<span>整体修改</span>';
  $('#pageTaskButton').onclick = () => submitAnnotations();
  $('#pageTaskButton').innerHTML = icon('MessageSquare')+'<span>提交批注</span>';
  render();
  // 宿主握手卡住时也让人看得懂：内容已经画出来，只是暂时不能保存。
  const handshake = setTimeout(() => {
    if (writable) return;
    notice('内容可以阅读，暂时无法保存修改：审阅宿主没有响应。请重新打开审阅页。');
    status('未连接', true);
  }, 2500);
  try {
    review = await ReviewBridge.connect(); clearTimeout(handshake); dsh = review.transport === 'postMessage';
    document.body.dataset.host = dsh ? 'dsh' : 'standalone';
    if (!review.capabilities.includes('command') || !review.capabilities.includes('draft')) throw Error('宿主缺少工作台能力');
    const head = await command({op:'state'}); headRevision = head.revision; state = {...fresh(),...head.state};
    if (Array.isArray(head.external_pages)) externalPages = new Set(head.external_pages.map(String));
    // 主稿被模型处理过并重新生成过工作台：这份页面内嵌的数据已经过期，先让人刷新。
    if (head.context?.sourceSha256 && head.context.sourceSha256 !== REVIEW.sourceSha256) contextStale = true;
    if (head.deferred?.pages?.length) for (const number of head.deferred.pages) {
      const key = pageIdOfNumber(Number(number)); if (key !== undefined) blocked[key] = true;
    }
    let recovered; try { recovered = JSON.parse(await review.readText(REVIEW.draftPath, {optional:true})); } catch (_) {}
    try { const local = JSON.parse(sessionStorage.getItem(recoveryKey)); if (local && (!recovered || local.saved_at > recovered.saved_at)) recovered = local; } catch (_) {}
    if (recovered?.source_sha256 === REVIEW.sourceSha256) {
      const different = uiProjection(recovered) !== uiProjection(state);
      const retryKnown = recovered.pending_save && head.operations?.[recovered.pending_save.operation_id];
      if (different && recovered.base_revision && recovered.base_revision !== headRevision && !retryKnown) {
        state = recovered; conflicted = true; notice('另一个窗口已保存新版本。当前草稿已恢复，需核对两个版本后继续。');
      } else if (different || recovered.base_revision === headRevision) {
        state = {...state,...recovered}; pendingSave = recovered.pending_save; pendingTask = recovered.pending_task;
        if (recovered.blocked_pages) blocked = recovered.blocked_pages;
        if (different) editsVersion = 1;
      }
    }
    normalizeOrder();
    if (state.view?.mode && !REVIEW.simpleStoryline) mode = state.view.mode;
    if (state.page_order.includes(state.view?.page)) page = state.view.page;
    else if (!state.page_order.includes(page)) page = state.page_order[0];
    if (contextStale) {
      writable = false;
      $('#reload').classList.add('attention');
      status('待刷新', true);
      notice('主稿已被模型更新。点右上角刷新载入新版本；刷新前的编辑留在草稿里，需要时让模型合并。');
    } else {
      writable = true;
      // This action only applies to DSH. Keep the optional control guarded so
      // a missing button cannot abort the rest of the boot sequence.
      const pageTaskButton = $('#pageTaskButton');
      if (pageTaskButton) pageTaskButton.hidden = false;
      $('#feedback').disabled = false; $('#overallFeedback').disabled = false;
      $('#addStoryline').hidden = !REVIEW.allowStructureChanges;
      status('已载入');
      if (editsVersion && !conflicted) enqueue(async () => await persistDraft() && await persistCanonical());
    }
    review.on('changed',async () => {
      try {
        const next = await command({op:'state'});
        if (Array.isArray(next.external_pages)) { externalPages = new Set(next.external_pages.map(String)); if (mode === 'storyline') renderStory(); }
        if (next.context?.sourceSha256 && next.context.sourceSha256 !== REVIEW.sourceSha256 && !contextStale) {
          contextStale = true; writable = false; conflicted = true;
          $('#reload').classList.add('attention'); status('待刷新', true);
          notice('主稿已被模型更新。点右上角刷新载入新版本；刷新前的编辑留在草稿里，需要时让模型合并。');
          if (mode === 'storyline') renderStory(); else updateSelection();
        }
      } catch (error) { conflicted = true; backup(); notice(error.message+'。当前编辑已保留。'); updateSelection(); }
    });
  } catch (error) {
    clearTimeout(handshake);
    const raw = String(error?.message || error);
    notice('当前只读：' + (/ReviewBridge|未定义|not defined/.test(raw)
      ? '没有连上审阅宿主，请从审阅入口重新打开页面。'
      : raw));
  }
  if (matchMedia('(max-width:1120px)').matches) $('#inspectorToggle').click();
  render(); ReviewUI.refresh(document);
  void loadVersions();
}

// ---- 版本管理：每次保存自动留一版，恢复 = 把那一版的状态写回并重新保存 ----
let versionList = [];
function versionLabel(item) {
  if (!item.saved_at) return item.revision.slice(0,8);
  try { return new Date(item.saved_at).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}); }
  catch (_) { return item.revision.slice(0,8); }
}
async function loadVersions() {
  const select = $('#historyRevision'); if (!select) return;
  try {
    const result = await command({op:'history'});
    versionList = result.history || [];
    select.innerHTML = versionList.map(item => '<option value="'+item.revision+'">'+(item.current?'当前 · ':'')+versionLabel(item)+'</option>').join('');
    $('#restoreRevision').disabled = !writable || conflicted || !versionList.some(item => !item.current);
    $('#versionNote').textContent = versionList.length > 1 ? '每次保存自动留一版，共 '+versionList.length+' 版' : '还没有历史版本';
  } catch (error) { $('#versionNote').textContent = '版本列表读取失败：'+(error?.message || error); }
}
let restoreArmed = '';
if ($('#restoreRevision')) $('#restoreRevision').onclick = async () => {
  const revision = $('#historyRevision').value;
  const item = versionList.find(entry => entry.revision === revision);
  const button = $('#restoreRevision');
  if (!revision || !item || item.current) return;
  // 二次确认做在页内：插件的 iframe 可能弹不出系统对话框
  if (restoreArmed !== revision) {
    restoreArmed = revision; button.textContent = '确认恢复';
    notice('再点一次「确认恢复」：回到 '+versionLabel(item)+' 的版本，当前版本会留在历史里');
    setTimeout(() => { if (restoreArmed === revision) { restoreArmed = ''; button.textContent = '恢复此版'; } }, 5000);
    return;
  }
  restoreArmed = ''; button.textContent = '恢复此版';
  try {
    if (editsVersion > savedVersion && !await save()) return;
    const restored = await command({op:'restore', revision});
    if (!restored?.state) throw Error('该版本没有可恢复的内容');
    state = {...state, ...restored.state};
    render(); updateSelection(); changed();
    notice('已恢复 '+versionLabel(item)+' 的版本，正在保存');
    setTimeout(() => void loadVersions(), 600);
  } catch (error) { notice('恢复失败：'+(error?.message || error)); }
};

boot();
