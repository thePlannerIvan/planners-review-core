'use strict';
const REVIEW = JSON.parse(document.getElementById('reviewData').textContent);
const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const icon = name => ReviewUI.icon(name).outerHTML;
const fresh = () => ({source_sha256:REVIEW.sourceSha256,review_kind:REVIEW.reviewKind,
  edits:{pages:{},sections:{}},page_order:REVIEW.pages.map(p => p.page_number),
  section_order:REVIEW.sections.map(s => s.section_id),added_pages:{},deleted_pages:[],
  feedbacks:{},attachments:{},asset_decisions:{},overall_feedback_zh:''});
let state = fresh(), page = state.page_order[0], mode = REVIEW.sections.length ? 'storyline' : 'bypage';
let review, writable = false, dsh = false, headRevision, pendingSave, pendingTask;
let editsVersion = 0, draftVersion = 0, savedVersion = 0, draftedVersion = 0;
let timer, chain = Promise.resolve(), drag, conflicted = false;
const recoveryKey = 'content-workbench:' + REVIEW.reviewKind + ':' + REVIEW.sourceSha256;
const pageById = id => REVIEW.pages.find(p => p.page_number === Number(id)) ?? {
  page_number:Number(id),section_id:state.added_pages[id]?.section_id,title:state.added_pages[id]?.title,
  claim:state.added_pages[id]?.title,blocks:[],sections:[]};
const patch = id => state.edits.pages[id] ??= {};
const title = id => state.edits.pages[id]?.title ?? pageById(id).title ?? '';
const operationId = () => crypto.randomUUID();
const projection = s => JSON.stringify([s.edits,s.page_order,s.section_order,s.added_pages ?? {},s.deleted_pages ?? [],s.attachments ?? {},s.asset_decisions ?? {}]);
const uiProjection = s => JSON.stringify([projection(s),s.feedbacks ?? {},s.overall_feedback_zh ?? '']);
function notice(text) { $('#notice').textContent = text; $('#notice').hidden = !text; }
function status(text, dirty = false) { $('.save-state').classList.add('visible'); $('#saveState').textContent = text; $('#saveDot').classList.toggle('dirty',dirty); }
function snapshot() { return {...structuredClone(state),base_revision:headRevision,pending_save:pendingSave,
  pending_task:pendingTask,view:{mode,page},saved_at:new Date().toISOString()}; }
function backup() { try { sessionStorage.setItem(recoveryKey,JSON.stringify(snapshot())); } catch (_) {} }
function enqueue(run) { const result = chain.then(run,run); chain = result.catch(() => {}); return result; }
function changed(content = true) {
  if (content) editsVersion++;
  draftVersion++; backup(); status(content ? (dsh ? '正在保存' : '主稿未保存') : '意见未提交',true);
  clearTimeout(timer); timer = setTimeout(() => enqueue(async () => {
    if (!await persistDraft()) return false;
    return dsh && editsVersion > savedVersion ? persistCanonical() : true;
  }),400);
}
async function persistDraft() {
  const version = draftVersion;
  try { await review.draft(snapshot()); draftedVersion = version; return true; }
  catch (_) { notice('草稿未落盘，编辑仍保留在当前窗口。请重试保存。'); status('未保存',true); return false; }
}
async function command(payload) {
  const result = await review.command(payload);
  if (!result?.ok) throw Object.assign(Error(result?.error ?? '保存未成功'),{code:result?.code});
  return result;
}
async function persistCanonical() {
  if (!writable || conflicted) return false;
  try {
    // Keep the same operation across uncertain transport failures.
    if (!pendingSave) pendingSave = {op:'save',operation_id:operationId(),base_revision:headRevision,
      state:structuredClone(state),edit_version:editsVersion};
    const version = pendingSave.edit_version;
    const {edit_version:_,...payload} = pendingSave; backup();
    const result = await command(payload);
    headRevision = result.revision; savedVersion = version; pendingSave = null;
    backup(); await persistDraft();
    status(savedVersion === editsVersion ? '主稿已保存' : '还有未保存修改',savedVersion !== editsVersion);
    notice('');
    if (dsh && savedVersion !== editsVersion) return persistCanonical();
    return savedVersion === editsVersion;
  } catch (error) {
    if (['revision_conflict','source_conflict','baseline_conflict','dependency_conflict'].includes(error.code)) conflicted = true;
    backup(); await persistDraft(); notice(error.message + '。当前编辑已保留。'); status('主稿未保存',true); return false;
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
function renderStory() {
  $('.thesis').hidden = !REVIEW.thesis && state.edits.thesis === undefined;
  $('.thesis p').textContent = state.edits.thesis ?? REVIEW.thesis;
  textEditor($('.thesis p'),text => { state.edits.thesis = text; });
  $('#outlineList').hidden = false;
  $('#outlineList').innerHTML = state.page_order.map((id,i) => '<li class="outline-line" data-outline-id="'+id+'" draggable="'+writable+'"><button class="outline-grip" title="调整顺序" aria-label="调整顺序">'+icon('GripVertical')+'</button><span class="outline-number">'+String(i+1).padStart(2,'0')+'</span><div data-outline-title="'+id+'">'+esc(title(id))+'</div><button class="review-icon-button" data-delete-node="'+id+'" title="删除这一句" aria-label="删除这一句" '+(!writable || state.page_order.length < 2 ? 'disabled' : '')+'>'+icon('Trash2')+'</button></li>').join('');
  $$('#outlineList [data-outline-title]').forEach(node => {
    textEditor(node,text => {
      if (state.added_pages[node.dataset.outlineTitle]) state.added_pages[node.dataset.outlineTitle].title = text;
      else patch(node.dataset.outlineTitle).title = text;
    }); node.onfocus = () => { page = Number(node.dataset.outlineTitle); updateSelection(); };
  });
  $$('#outlineList [data-delete-node]').forEach(button => button.onclick = () => {
    const id = Number(button.dataset.deleteNode); if (!writable || state.page_order.length < 2) return;
    state.page_order = state.page_order.filter(n => n !== id);
    if (id < 0) { delete state.added_pages[id]; delete state.edits.pages[id]; }
    else state.deleted_pages.push(id);
    if (page === id) page = state.page_order[0]; changed(); render();
  });
  $$('.outline-line').forEach(row => bindDrag(row,Number(row.dataset.outlineId)));
  $('#storyStream').innerHTML = state.section_order.map(id => {
    const section = REVIEW.sections.find(s => s.section_id === id), e = state.edits.sections[id] ?? {};
    return '<article class="story-card" data-section-id="'+esc(id)+'"><h2 data-field="title">'+esc(e.title ?? section.title)+'</h2><p data-field="lead">'+esc(e.lead ?? section.lead)+'</p><p data-field="transition">'+esc(e.transition ?? section.transition)+'</p></article>';
  }).join('');
  $$('#storyStream [data-field]').forEach(node => textEditor(node,text => {
    const id = node.closest('[data-section-id]').dataset.sectionId; (state.edits.sections[id] ??= {})[node.dataset.field] = text;
  }));
}
function renderPage() {
  const p = pageById(page), e = state.edits.pages[page] ?? {};
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
function updateNavTitles() { $$('.page-nav').forEach(node => { node.querySelector('.page-nav-title').textContent = title(node.dataset.id); }); }
function updateSelection() {
  $$('.page-nav').forEach(node => node.classList.toggle('active',Number(node.dataset.id) === page));
  $('#inspectorKicker').textContent = '本页'; $('#inspectorTitle').textContent = '第 '+(state.page_order.indexOf(page)+1)+' 页';
  $('#feedback').value = state.feedbacks[page] ?? ''; $('#overallFeedback').value = state.overall_feedback_zh;
  const p = pageById(page); $('#factNotice').hidden = !p.requires_fact_decision;
  $('#factNotice').textContent = (p.fact_exceptions ?? []).map(f => [f.surface,f.note].filter(Boolean).join('：')).join('\n');
  $('#uploadSection').hidden = mode !== 'bypage' || !REVIEW.allowUploads || !writable || !review?.capabilities.includes('asset-upload');
  $('#pagePrev').disabled = state.page_order.indexOf(page) <= 0;
  $('#pageNext').disabled = state.page_order.indexOf(page) >= state.page_order.length-1;
  $('#pageTaskButton').hidden = !dsh || mode !== 'bypage';
  // 这两个按钮由脚本动态创建，取不到时不要抛错（抛错会中断整段渲染）。
  for (const node of [$('#pageTaskButton'), $('#saveButton'), $('#canonicalSaveButton')]) if (node) node.disabled = !writable || conflicted;
  $('#draftButton').disabled = !writable || conflicted;
}
function move(id,target,after) {
  if (!writable || id === target) return;
  state.page_order = state.page_order.filter(n => n !== id);
  state.page_order.splice(state.page_order.indexOf(target)+(after ? 1 : 0),0,id); changed(); render();
}
function bindDrag(node,id) {
  node.draggable = writable;
  node.ondragstart = e => { if (!writable || e.target.isContentEditable) return e.preventDefault(); drag = {id}; e.dataTransfer.setData('text/plain',String(id)); };
  node.ondragover = e => { if (!drag) return; e.preventDefault(); node.classList.toggle('drop-after',e.clientY > node.getBoundingClientRect().top+node.offsetHeight/2); node.classList.toggle('drop-before',!node.classList.contains('drop-after')); };
  node.ondragleave = () => node.classList.remove('drop-before','drop-after');
  node.ondrop = e => { e.preventDefault(); if (drag) move(drag.id,id,e.clientY > node.getBoundingClientRect().top+node.offsetHeight/2); drag = null; };
  node.ondragend = () => { drag = null; $$('.drop-before,.drop-after').forEach(n => n.classList.remove('drop-before','drop-after')); };
  const handle = node.querySelector('.outline-grip,.drag-handle');
  handle.onkeydown = e => { if (!writable || !e.altKey || !['ArrowUp','ArrowDown'].includes(e.key)) return;
    e.preventDefault(); const at = state.page_order.indexOf(id), target = state.page_order[at+(e.key === 'ArrowUp' ? -1 : 1)]; if (target !== undefined) move(id,target,e.key === 'ArrowDown');
  };
  handle.onpointerdown = e => { if (!writable || e.button !== 0) return; e.preventDefault(); drag = {id,pointer:true}; handle.setPointerCapture(e.pointerId); };
}
window.addEventListener('pointermove',e => {
  if (!drag?.pointer) return;
  const node = document.elementFromPoint(e.clientX,e.clientY)?.closest('[data-id],[data-outline-id]');
  if (node) { drag.target = Number(node.dataset.id ?? node.dataset.outlineId); drag.after = e.clientY > node.getBoundingClientRect().top+node.offsetHeight/2; }
});
window.addEventListener('pointerup',() => { if (!drag?.pointer) return; const value = drag; drag = null; if (value.target !== undefined) move(value.id,value.target,value.after); });
window.addEventListener('pointercancel',() => { drag = null; });
function renderNav() {
  $('#railTitle').textContent = mode === 'storyline' ? '故事线' : '页面'; $('#railCount').textContent = state.page_order.length+' 页';
  $('#pageList').innerHTML = state.page_order.map((id,i) => '<button class="page-nav" data-id="'+id+'"><span class="page-num">'+String(i+1).padStart(2,'0')+'</span><span class="page-nav-title">'+esc(title(id))+'</span><span class="drag-handle" role="button" tabindex="0" title="调整顺序" aria-label="调整顺序">'+icon('GripVertical')+'</span></button>').join('');
  $$('.page-nav').forEach(node => { const id = Number(node.dataset.id); bindDrag(node,id);
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
  if (!text?.trim()) { notice(scope === 'page' ? '请填写本页修改意见。' : '请填写整体修改意见。'); return; }
  const signature = JSON.stringify([scope,taskPage,text]);
  const samePending = pendingTask?.signature === signature;
  // A content save may advance the revision. Do it before creating a new task;
  // a retry of the same uncertain task keeps its original operation identity.
  if (editsVersion > savedVersion) { pendingTask = null; if (!await save()) return; }
  try {
    if (!samePending || !pendingTask) pendingTask = {op:'feedback',operation_id:operationId(),base_revision:headRevision,scope,page:taskPage,text,signature};
    const result = await command(pendingTask); pendingTask = null;
    const unit = 'task-'+result.task_id; status('修改任务已提交');
    if (dsh) { try { const wake = await review.wake({unit}); if (wake?.woke === false) notice('任务已保存，请回到对话继续。'); }
      catch (_) { notice('任务已保存，通知未送达。请回到对话继续。'); } }
    else notice('修改任务已保存，请回到对话继续。');
  } catch (error) { notice(error.message+'。意见已保留。'); }
}
$('#addStoryline').onclick = () => {
  if (!writable) return; let id = -1; while (state.added_pages[id]) id--;
  state.added_pages[id] = {title:'新判断',section_id:pageById(page).section_id ?? REVIEW.sections[0].section_id};
  const at = state.page_order.indexOf(page); state.page_order.splice(at+1,0,id); page = id; changed(); render();
  const node = $('[data-outline-title="'+id+'"]'); node.focus(); const selection = getSelection(), range = document.createRange(); range.selectNodeContents(node); selection.removeAllRanges(); selection.addRange(range);
};
$$('.mode-tabs button').forEach(b => b.onclick = () => { document.activeElement?.blur(); mode = b.dataset.mode; render(); });
function navigate(delta) { document.activeElement?.blur(); const next = state.page_order[state.page_order.indexOf(page)+delta]; if (next !== undefined) { page = next; renderNav(); renderPage(); $('.workspace').scrollTop = 0; } }
$('#pagePrev').onclick = () => navigate(-1); $('#pageNext').onclick = () => navigate(1);
$('#feedback').oninput = () => { state.feedbacks[page] = $('#feedback').value; changed(false); };
$('#overallFeedback').oninput = () => { state.overall_feedback_zh = $('#overallFeedback').value; changed(false); };
// 任务动作与保存动作分开：任务会唤醒模型，保存只写入当前工作台。
const canonicalButton = $('#canonicalSaveButton');
$('#saveButton').onclick = () => task('deck');
canonicalButton.onclick = save;
$('#draftButton').onclick = persistDraft;
$('#uploadButton').onclick = () => $('#uploadFile').click();
$('#uploadFile').onchange = async () => {
  const file = $('#uploadFile').files[0], id = page; if (!file || !writable) return;
  if (!['image/png','image/jpeg','image/webp','image/gif'].includes(file.type)) { notice('请选择 PNG、JPEG、WebP 或 GIF 图片。'); return; }
  const rel = 'uploads/page-'+id+'/'+operationId()+'-'+file.name.replace(/[^\p{L}\p{N}._-]/gu,'-');
  try { await review.upload(file,rel); (state.attachments[id] ??= []).push({path:rel,alt:file.name}); changed(); if (page === id) renderPage(); }
  catch (_) { notice('图片未落盘，请重试。'); } finally { $('#uploadFile').value = ''; }
};
$('#reload').onclick = async () => { if (editsVersion > savedVersion && !await save()) return; if (await persistDraft()) location.reload(); };
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
  $('#feedback').disabled = true; $('#overallFeedback').disabled = true;
  $('#saveButton').innerHTML = icon('MessageSquare')+'<span>提交整套修改任务</span>';
  $('#pageTaskButton').onclick = () => task('page');
  $('#canonicalSaveButton').innerHTML = icon('Save')+'<span>保存主稿</span>';
  $('#draftButton').innerHTML = icon('FilePenLine')+'<span>保存恢复草稿</span>';
  render();
  try {
    review = await ReviewBridge.connect(); dsh = review.transport === 'postMessage';
    if (!review.capabilities.includes('command') || !review.capabilities.includes('draft')) throw Error('宿主缺少工作台能力');
    const head = await command({op:'state'}); headRevision = head.revision; state = {...fresh(),...head.state};
    let recovered; try { recovered = JSON.parse(await review.readText(REVIEW.draftPath, {optional:true})); } catch (_) {}
    try { const local = JSON.parse(sessionStorage.getItem(recoveryKey)); if (local && (!recovered || local.saved_at > recovered.saved_at)) recovered = local; } catch (_) {}
    if (recovered?.source_sha256 === REVIEW.sourceSha256) {
      const different = uiProjection(recovered) !== uiProjection(state);
      const retryKnown = recovered.pending_save && head.operations?.[recovered.pending_save.operation_id];
      if (different && recovered.base_revision && recovered.base_revision !== headRevision && !retryKnown) {
        state = recovered; conflicted = true; notice('另一个窗口已保存新版本。当前草稿已恢复，需核对两个版本后继续。');
      } else if (different || recovered.base_revision === headRevision) {
        state = {...state,...recovered}; pendingSave = recovered.pending_save; pendingTask = recovered.pending_task;
        if (different) editsVersion = 1;
      }
    }
    if (state.view?.mode) mode = state.view.mode;
    if (state.page_order.includes(state.view?.page)) page = state.view.page;
    else if (!state.page_order.includes(page)) page = state.page_order[0];
    writable = true; pageButton.hidden = !dsh;
    $('#feedback').disabled = false; $('#overallFeedback').disabled = false;
    $('#addStoryline').hidden = !REVIEW.allowStructureChanges;
    status(editsVersion ? '主稿未保存' : '主稿已保存',Boolean(editsVersion));
    review.on('changed',async () => { try { await command({op:'state'}); } catch (error) { conflicted = true; backup(); notice(error.message+'。当前编辑已保留。'); updateSelection(); } });
    if (dsh && editsVersion && !conflicted) enqueue(async () => await persistDraft() && await persistCanonical());
  } catch (error) { notice('当前只读：'+error.message); }
  if (matchMedia('(max-width:1120px)').matches) $('#inspectorToggle').click();
  render(); ReviewUI.refresh(document);
}
boot();
