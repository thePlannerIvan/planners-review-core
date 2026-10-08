'use strict';
const REVIEW = JSON.parse(document.getElementById('reviewData').textContent);
marked.use({renderer:{
  html({text}) { return /^<br\s*\/?>(\n)?$/i.test(text) ? '<br>' : esc(text); },
  link({href,tokens}) { const text = this.parser.parseInline(tokens); return /^(https?:|mailto:|#)/i.test(href) ? '<a href="'+esc(href)+'" target="_blank" rel="noopener noreferrer">'+text+'</a>' : text; },
  image({href,text}) { return '<img data-original-src="'+esc(href)+'" alt="'+esc(text)+'">'; },
}});
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const pad = n => String(n).padStart(2, '0');
const initial = () => ({
  source_sha256: REVIEW.sourceSha256, review_kind: REVIEW.reviewKind,
  edits: { pages: {}, sections: {} },
  page_order: REVIEW.pages.map(p => p.page_number), section_order: REVIEW.sections.map(s => s.section_id),
  decisions: Object.fromEntries(REVIEW.pages.map(p => [p.page_number, p.default_decision ?? null])),
  feedbacks: {}, attachments: {}, asset_decisions: {}, overall_feedback_zh: '',
});
let state = initial(), page = state.page_order[0], chapter = state.section_order[0];
let mode = chapter ? 'storyline' : 'bypage', review = null, writable = false;
let revision = 0, savedRevision = 0, timer, saveChain = Promise.resolve(), submitting = false;
let expandedAssets = false, drag = null, stale = false, sourceChecked = false;
let programmaticScroll = false, scrollTimer;
const pageById = id => REVIEW.pages.find(p => String(p.page_number) === String(id));
const chapterById = id => REVIEW.sections.find(s => s.section_id === id);
  const addedChapterById = id => null;
const sectionById = id => chapterById(id) ?? addedChapterById(id);
const title = id => state.edits.pages[id]?.title ?? pageById(id)?.title ?? '';
const sectionTitle = id => state.edits.sections[id]?.title ?? sectionById(id)?.title ?? '';
const currentPages = () => mode === 'storyline'
  ? REVIEW.pages.filter(p => p.section_id === chapter).map(p => p.page_number) : [page];
const unit = () => mode === 'storyline' ? 'chapter-' + chapter : 'page-' + pad(page);
const position = (kind, id) => state[kind + '_order'].map(String).indexOf(String(id)) + 1;
function notice(text) { $('#notice').textContent = text; $('#notice').hidden = !text; }
function status(text, failed = false) {
  $('.save-state').classList.add('visible'); $('#saveState').textContent = text;
  $('#saveDot').classList.toggle('dirty', failed);
}
function toast(text) {
  $('#toast').textContent = text; $('#toast').classList.add('show');
  clearTimeout(toast.timer); toast.timer = setTimeout(() => $('#toast').classList.remove('show'), 2200);
}
function draft() { return { ...structuredClone(state), view: { mode, page, chapter }, saved_at: new Date().toISOString() }; }
function dirty() { revision++; status('正在保存', true); clearTimeout(timer); timer = setTimeout(() => saveDraft(), 450); }
async function saveDraft(snapshot = draft(), version = revision) {
  clearTimeout(timer);
  const run = async () => {
    try {
      if (!writable) throw Error('readonly');
      await review.draft(snapshot);
      savedRevision = Math.max(version, savedRevision);
      if (savedRevision === revision) { status('已保存'); if ($('#notice').textContent.startsWith('修改尚未保存')) notice(''); }
      return true;
    } catch (_) { status('未保存', true); notice('修改尚未保存，请保持页面打开并重试。'); return false; }
  };
  saveChain = saveChain.then(run, run); return saveChain;
}
function editedPage(id) { return state.edits.pages[id] ??= {}; }
function textEditor(node, update) {
  if (!writable || !node) return;
  node.contentEditable = 'true'; node.classList.add('editable-ready');
  node.onfocus = () => { node.classList.add('editing'); const card = node.closest('[data-section-id]'); if (card) { chapter = card.dataset.sectionId; updateSelection(); } };
  node.oninput = () => { update(node.textContent); dirty(); };
  node.onblur = () => { node.classList.remove('editing'); if (revision > savedRevision) saveDraft(); };
  node.onpaste = e => {
    e.preventDefault(); const selection = getSelection(); if (!selection.rangeCount) return;
    const range = selection.getRangeAt(0); range.deleteContents();
    const text = document.createTextNode(e.clipboardData.getData('text/plain')); range.insertNode(text);
    range.setStartAfter(text); range.collapse(true); selection.removeAllRanges(); selection.addRange(range);
    update(node.textContent); dirty();
  };
}
function markdown(root, value, update) {
  const tokens = marked.lexer(String(value ?? ''));
  root.innerHTML = tokens.map((token, index) => '<div class="rich-block" data-token="' + index + '">' + marked.parser([token]) + '</div>').join('');
  root.querySelectorAll('a').forEach(a => { if (!/^(https?:|mailto:|#)/i.test(a.getAttribute('href') || '')) a.removeAttribute('href'); a.target = '_blank'; a.rel = 'noopener noreferrer'; });
  const changed = () => { update(tokens.map(t => t.raw).join('')); dirty(); };
  function editor(node, value, commit) {
    if (!writable) return;
    const input = document.createElement('textarea'); input.className = 'inline-editor'; input.value = value;
    input.setAttribute('aria-label', '修改文字'); node.replaceChildren(input);
    const resize = () => { input.style.height = 'auto'; input.style.height = Math.min(350, Math.max(36, input.scrollHeight)) + 'px'; };
    input.oninput = () => { commit(input.value); changed(); resize(); };
    input.onblur = () => { commit(input.value); markdown(root,tokens.map(t => t.raw).join(''),update); if (revision > savedRevision) saveDraft(); };
    input.onkeydown = e => { if (e.key === 'Escape') input.blur(); };
    input.focus(); resize();
  }
  root.querySelectorAll('[data-token]').forEach(block => {
    const token = tokens[Number(block.dataset.token)];
    if (token.type === 'table') {
      const rows = [token.header, ...token.rows];
      block.querySelectorAll('tr').forEach((row, r) => row.querySelectorAll('th,td').forEach((cell, c) => {
        cell.onclick = event => {
          if (event.target.closest('img,a,textarea') || !rows[r]?.[c]) return;
          editor(cell, rows[r][c].text, text => {
            rows[r][c].text = text;
            const cells = row => '| ' + row.map(cell => cell.text.replace(/(?<!\\)\|/g, '\\|').replace(/\n/g, '<br>')).join(' | ') + ' |';
            token.raw = cells(token.header) + '\n| ' + token.align.map(a => a === 'center' ? ':---:' : a === 'right' ? '---:' : a === 'left' ? ':---' : '---').join(' | ') + ' |\n' + token.rows.map(cells).join('\n') + '\n\n';
          });
        };
      }));
    } else if (token.type !== 'space' && token.type !== 'html') {
      block.onclick = event => {
        if (event.target.closest('img,a,textarea')) return;
        editor(block, token.type === 'heading' ? token.text : token.raw.trimEnd(), text => {
          token.raw = (token.type === 'heading' ? '#'.repeat(token.depth) + ' ' : '') + text + '\n\n';
        });
      };
    }
  });
  hydrateAssets(root);
}
function renderStory() {
  $('.thesis').hidden = !REVIEW.thesis && state.edits.thesis === undefined;
  $('.thesis p').textContent = state.edits.thesis ?? REVIEW.thesis;
  textEditor($('.thesis p'), text => { state.edits.thesis = text; });
  $('#storyStream').innerHTML = state.section_order.map(id => {
    const s = sectionById(id), e = state.edits.sections[id] ?? state.edits.added_sections?.[id] ?? {};
    const pages = state.page_order.filter(n => pageById(n)?.section_id === id);
    const isNew = !!state.edits.added_sections?.[id];
    return '<article class="story-card' + (isNew ? ' is-new' : '') + '" data-section-id="' + esc(id) + '"><div class="eyebrow">第 ' + pad(position('section',id)) + ' 条故事线' + (isNew ? ' · 新增' : '') + '</div><h2 data-field="title">' + esc(e.title ?? s?.title ?? '') + '</h2><p data-field="lead">' + esc(e.lead ?? s?.lead ?? '') + '</p><div class="shift" data-field="transition">' + esc(e.transition ?? s?.transition ?? '') + '</div><div class="story-pages">' + pages.map(n => '<div class="story-page"><span class="story-page-no">' + pad(position('page',n)) + '</span><strong data-page-title="' + n + '">' + esc(title(n)) + '</strong></div>').join('') + '</div></article>';
  }).join('');
  $$('.story-card').forEach(card => {
    const id = card.dataset.sectionId;
    card.querySelectorAll('[data-field]').forEach(node => textEditor(node, text => {
      const target = state.edits.added_sections?.[id] ?? (state.edits.sections[id] ??= {});
      target[node.dataset.field] = text; updateNavTitles();
    }));
    card.querySelectorAll('[data-page-title]').forEach(node => textEditor(node, text => { editedPage(node.dataset.pageTitle).title = text; }));
    card.onclick = event => { if (event.target.closest('[data-remove-section]')) return; chapter = id; updateSelection(); };
  });
}
function addStorylineSection() {
  return;
  const used = new Set(state.section_order.map(String));
  let index = 1, id = 'sec-new-' + index;
  while (used.has(id)) id = 'sec-new-' + (++index);
  state.edits.added_sections ??= {};
  state.edits.added_sections[id] = { section_id: id, title: '新故事线', lead: '请填写这一条故事线要让听众接受的判断。', transition: '' };
  state.edits.removed_sections = (state.edits.removed_sections ?? []).filter(item => item !== id);
  state.section_order.push(id); chapter = id; dirty(); renderNav(); renderStory(); remember();
}
function removeStorylineSection(id) {
  return;
  const pages = state.page_order.filter(n => pageById(n)?.section_id === id);
  if (pages.length) { notice('这条故事线仍有页面，先把页面移到其他故事线后再删除。'); return; }
  state.edits.removed_sections ??= [];
  state.section_order = state.section_order.filter(item => item !== id);
  if (state.edits.added_sections?.[id]) delete state.edits.added_sections[id];
  else if (!state.edits.removed_sections.includes(id)) state.edits.removed_sections.push(id);
  chapter = state.section_order[0] || null; dirty(); renderNav(); renderStory(); remember();
}
function renderPage() {
  const p = pageById(page), e = state.edits.pages[page] ?? {};
  $('#currentPageLabel').textContent = pad(position('page',page)); $('#pageTitle').textContent = title(page);
  $('#pageClaim').textContent = e.claim ?? p.claim ?? ''; $('#pageClaim').hidden = !$('#pageClaim').textContent;
  textEditor($('#pageTitle'), text => { editedPage(page).title = text; updateNavTitles(); });
  textEditor($('#pageClaim'), text => { editedPage(page).claim = text; });
  $('#pageContent').innerHTML = '';
  if (p.blocks?.length) {
    const root = document.createElement('div');
    root.innerHTML = p.blocks.map((b,i) => '<section class="content-block"><h3 data-block-title="' + i + '">' + esc(e.blocks?.[i]?.title ?? b.title) + '</h3><p data-block-text="' + i + '">' + esc(e.blocks?.[i]?.text ?? b.text) + '</p></section>').join('');
    root.querySelectorAll('[data-block-title],[data-block-text]').forEach(node => textEditor(node, text => {
      const index = node.dataset.blockTitle ?? node.dataset.blockText, field = node.dataset.blockTitle !== undefined ? 'title' : 'text';
      const ep = editedPage(page); ep.blocks ??= {}; ep.blocks[index] ??= {}; ep.blocks[index][field] = text;
    })); $('#pageContent').appendChild(root);
  }
  (p.sections ?? []).forEach((s,i) => {
    const outer = document.createElement(s.collapsed ? 'details' : 'section'); outer.className = s.collapsed ? 'source-panel' : 'copy-block';
    const heading = document.createElement(s.collapsed ? 'summary' : 'h3'); heading.textContent = s.label; outer.appendChild(heading);
    const body = document.createElement('div'); body.className = 'rich-copy'; outer.appendChild(body); $('#pageContent').appendChild(outer);
    const value = e.sections?.[i] ?? (Array.isArray(s.value) ? s.value.join('\n') : s.value ?? '');
    const update = text => { const ep = editedPage(page); ep.sections ??= {}; ep.sections[i] = text; };
    if (s.editable === false) body.textContent = value;
    else markdown(body, value, update);
  });
  if (!p.sections?.length && !p.blocks?.length) $('#pageContent').innerHTML = '<p class="empty-content">暂无正文</p>';
  renderAssets(); updateSelection();
}
function renderAssets() {
  const p = pageById(page), list = p.asset_candidates ?? [];
  $('#assetSection').hidden = mode !== 'bypage' || !list.length;
  const shown = expandedAssets ? list : list.filter(a => a.group !== 'other').slice(0,3);
  $('#candidateList').innerHTML = shown.map(a => {
    const selected = state.asset_decisions[page]?.find(x => x.asset_id === a.asset_id)?.status ?? p.seeded_asset_decisions?.find(x => x.asset_id === a.asset_id)?.status ?? a.status ?? 'backup';
    return '<div class="candidate"><img src="' + esc(a.url) + '" alt="' + esc(a.alt ?? a.asset_id) + '"><div class="candidate-copy"><strong>' + esc(a.alt ?? a.asset_id) + '</strong><small title="' + esc(a.reason) + '">' + esc(a.reason) + '</small></div><select data-asset-choice="' + esc(a.asset_id) + '" aria-label="图片取舍">' + [['selected','采用'],['backup','备用'],['excluded','排除'],['replace','替换']].map(([value,label]) => '<option value="' + value + '"' + (selected === value ? ' selected' : '') + '>' + label + '</option>').join('') + '</select></div>';
  }).join('');
  $('#candidateMore').hidden = list.length <= shown.length && !expandedAssets;
  $('#candidateMore').textContent = expandedAssets ? '收起' : '更多图片';
  $$('#candidateList select').forEach(select => {
    select.disabled = !writable;
    select.onchange = () => {
      state.asset_decisions[page] ??= structuredClone(p.seeded_asset_decisions ?? list.map(a => ({asset_id:a.asset_id,status:a.status ?? 'backup'})));
      state.asset_decisions[page].find(a => a.asset_id === select.dataset.assetChoice).status = select.value;
      state.decisions[page] = 'revise'; dirty(); updateSelection();
    };
  }); hydrateAssets($('#candidateList'));
}
async function hydrateAssets(root) {
  await Promise.all([...root.querySelectorAll('img')].map(async img => {
    const rel = img.dataset.originalSrc ?? img.getAttribute('src'); img.dataset.originalSrc = rel;
    if (/^(https?:|data:image\/|blob:)/i.test(rel ?? '')) img.src = rel;
    else if (/^[a-z][a-z0-9+.-]*:/i.test(rel ?? '')) img.removeAttribute('src');
    else if (review) try { const url = await review.asset(rel, {v:REVIEW.sourceSha256}); if (img.isConnected) img.src = url; } catch (_) { img.alt += '（未能加载）'; }
    img.onclick = e => { e.stopPropagation(); $('#modalImage').src = img.src; $('#modalImage').alt = img.alt; $('#imageModal').classList.add('open'); $('#modalClose').focus(); };
  }));
}
function updateNavTitles() { $$('.page-nav').forEach(b => { const t = mode === 'storyline' ? sectionTitle(b.dataset.id) : title(b.dataset.id); b.querySelector('.page-nav-title').textContent = t; b.title = t; }); }
function updateSelection() {
  $$('.page-nav').forEach(b => b.classList.toggle('active', b.dataset.id === String(mode === 'storyline' ? chapter : page)));
  $('#inspectorKicker').textContent = mode === 'storyline' ? '本章审阅' : '本页审阅';
  $('#inspectorTitle').textContent = '第 ' + pad(position(mode === 'storyline' ? 'section' : 'page', mode === 'storyline' ? chapter : page)) + (mode === 'storyline' ? ' 章' : ' 页');
  const ids = currentPages(), values = ids.map(n => state.decisions[n]);
  $$('.decision').forEach(b => b.classList.toggle('active', values.length && values.every(d => d === b.dataset.decision)));
  const p = pageById(page);
  $('#feedback').value = mode === 'storyline' ? state.feedbacks['chapter:' + chapter] ?? '' : state.feedbacks[page] ?? '';
  $('#overallFeedback').value = state.overall_feedback_zh;
  $('#factNotice').hidden = mode !== 'bypage' || !p.requires_fact_decision;
  $('#factNotice').textContent = (p.fact_exceptions ?? []).map(f => [f.surface,f.note].filter(Boolean).join('：')).join('\n');
  $('.decision.approve').textContent = mode === 'bypage' && p.requires_fact_decision ? '接受并通过' : '✓ 没问题';
  $('#priorOpinion').hidden = mode !== 'bypage' || !p.prior?.feedback_zh;
  $('#priorOpinion').textContent = '上一轮：' + (p.prior?.feedback_zh ?? '');
  $('#assetSection').hidden = mode !== 'bypage' || !(p.asset_candidates?.length);
  $('#uploadSection').hidden = mode !== 'bypage' || !REVIEW.allowUploads || !review?.capabilities.includes('asset-upload');
  $('#attachmentList').innerHTML = (state.attachments[page] ?? []).map((a, index) => '<div class="attachment-item"><span>' + esc(a.alt || a.path) + '</span><button class="attachment-remove" data-remove-attachment="' + index + '" title="移除图片" aria-label="移除图片">×</button></div>').join('');
  $$('#attachmentList [data-remove-attachment]').forEach(button => button.onclick = () => {
    if (!writable) return;
    state.attachments[page].splice(Number(button.dataset.removeAttachment), 1);
    if (!state.attachments[page].length) delete state.attachments[page];
    dirty(); updateSelection();
  });
  const at = state.page_order.map(String).indexOf(String(page));
  $('#pagePrev').disabled = at <= 0;
  $('#pageNext').disabled = at < 0 || at >= state.page_order.length - 1;
}
function remember() { try { history.replaceState(null, '', '#' + unit()); } catch (_) {} }
function selectChapter(id, scroll) {
  chapter = id; updateSelection(); remember();
  if (scroll) { programmaticScroll = true; $('[data-section-id="' + CSS.escape(id) + '"]')?.scrollIntoView({behavior:'smooth',block:'start'}); clearTimeout(scrollTimer); scrollTimer = setTimeout(() => programmaticScroll = false,600); }
}
function clearDrag() { $$('.page-nav').forEach(b => b.classList.remove('dragging','drop-before','drop-after')); }
function move(id, target, after) {
  const key = mode === 'storyline' ? 'section_order' : 'page_order', order = state[key];
  if (String(id) === String(target)) return;
  const source = order.find(x => String(x) === String(id)), rest = order.filter(x => String(x) !== String(id));
  const index = rest.findIndex(x => String(x) === String(target)); if (source === undefined || index < 0) return;
  rest.splice(index + Number(after),0,source); if (JSON.stringify(rest) === JSON.stringify(order)) return;
  state[key] = rest;
  if (mode === 'storyline') state.page_order = state.section_order.flatMap(s => state.page_order.filter(n => pageById(n)?.section_id === s));
  dirty(); renderNav(); if (mode === 'storyline') renderStory(); else renderPage();
}
function renderNav() {
  const order = state[mode === 'storyline' ? 'section_order' : 'page_order'];
  $('#railTitle').textContent = mode === 'storyline' ? '章节' : '页面'; $('#railCount').textContent = order.length + (mode === 'storyline' ? ' 章' : ' 页');
  $('#pageList').innerHTML = order.map((id,i) => '<button class="page-nav" data-id="' + esc(id) + '" draggable="' + writable + '"><span class="page-num">' + pad(i+1) + '</span><span class="page-nav-title"></span><span class="drag-handle" tabindex="' + (writable ? '0' : '-1') + '" role="button" aria-label="调整顺序" title="调整顺序">⠿</span></button>').join('');
  updateNavTitles(); updateSelection();
  $$('.page-nav').forEach(b => {
    b.onclick = e => { if (e.target.closest('.drag-handle')) return; if (mode === 'storyline') selectChapter(b.dataset.id,true); else { page = pageById(b.dataset.id).page_number; expandedAssets = false; renderPage(); remember(); $('.workspace').scrollTop = 0; } };
    b.ondragstart = e => { if (!writable) return e.preventDefault(); drag = {id:b.dataset.id,mode}; b.classList.add('dragging'); e.dataTransfer.setData('text/plain',b.dataset.id); };
    b.ondragover = e => { if (!drag || drag.mode !== mode) return; e.preventDefault(); clearDrag(); b.classList.add(e.clientY > b.getBoundingClientRect().top + b.offsetHeight/2 ? 'drop-after' : 'drop-before'); };
    b.ondrop = e => { e.preventDefault(); if (drag) move(drag.id,b.dataset.id,e.clientY > b.getBoundingClientRect().top + b.offsetHeight/2); drag = null; clearDrag(); };
    b.ondragend = () => { drag = null; clearDrag(); };
    b.onkeydown = e => { if (!writable || !e.altKey || !['ArrowUp','ArrowDown'].includes(e.key)) return; e.preventDefault(); const at = order.map(String).indexOf(b.dataset.id), target = order[at + (e.key === 'ArrowUp' ? -1 : 1)]; if (target !== undefined) { const id = b.dataset.id; move(id,target,e.key === 'ArrowDown'); $('.page-nav[data-id="' + CSS.escape(id) + '"] .drag-handle').focus(); } };
    b.querySelector('.drag-handle').onpointerdown = e => { if (!writable || e.button !== 0) return; e.preventDefault(); drag = {id:b.dataset.id,mode,pointer:true,startY:e.clientY}; e.target.setPointerCapture(e.pointerId); };
  });
}
window.addEventListener('pointermove',e => {
  if (!drag?.pointer || Math.abs(e.clientY - drag.startY) < 4) return;
  const rail = $('.left-rail'), bounds = rail.getBoundingClientRect();
  if (e.clientY < bounds.top + 30) rail.scrollTop -= 16; if (e.clientY > bounds.bottom - 30) rail.scrollTop += 16;
  const row = document.elementFromPoint(e.clientX,e.clientY)?.closest('.page-nav'); if (!row) return;
  drag.target = row.dataset.id; drag.after = e.clientY > row.getBoundingClientRect().top + row.offsetHeight/2;
  clearDrag(); row.classList.add(drag.after ? 'drop-after' : 'drop-before');
});
window.addEventListener('pointerup',() => { if (!drag?.pointer) return; const d = drag; drag = null; if (d.target && d.mode === mode) move(d.id,d.target,d.after); clearDrag(); });
window.addEventListener('pointercancel',() => { drag = null; clearDrag(); });
function setMode(next, rememberPosition = true) {
  mode = next; $$('.mode-tabs button').forEach(b => b.classList.toggle('active',b.dataset.mode === mode));
  $('#storylineView').classList.toggle('view-active',mode === 'storyline'); $('#bypageView').classList.toggle('view-active',mode === 'bypage');
  $('.workspace').scrollTop = 0; renderNav(); if (mode === 'storyline') renderStory(); else renderPage(); if (rememberPosition) remember();
}
async function checkSource() {
  try { const latest = JSON.parse(await review.readText('review-snapshot.json')); sourceChecked = true;
    if (latest.source_sha256 !== REVIEW.sourceSha256) { stale = true; notice('原文已有更新。你的修改已保留，请刷新后核对。'); }
  } catch (_) { sourceChecked = false; notice('暂时无法核对原文。你的修改会保留。'); }
}
function submission() {
  const decisions = REVIEW.pages.map(p => ({
    page_number:p.page_number, decision:state.decisions[p.page_number],
    feedback_zh:[state.feedbacks[p.page_number],state.feedbacks['chapter:' + p.section_id]].filter(Boolean).join('\n'),
    attachments:state.attachments[p.page_number] ?? [],
    asset_decisions:(state.asset_decisions[p.page_number] ?? p.seeded_asset_decisions ?? (p.asset_candidates ?? []).map(a => ({asset_id:a.asset_id,status:a.status ?? 'backup'}))).map(a => ({asset_id:a.asset_id,status:a.status})),
    ...(p.requires_fact_decision ? {fact_exception_decision:state.decisions[p.page_number] === 'approve' ? 'accept' : 'revise'} : {}),
  }));
  const edits = {
    pages: structuredClone(state.edits.pages ?? {}),
    sections: structuredClone(state.edits.sections ?? {}),
  };
  if (state.edits.thesis !== undefined) edits.thesis = state.edits.thesis;
  return {
    contract_version:REVIEW.feedbackContractVersion, review_kind:REVIEW.reviewKind, source_sha256:REVIEW.sourceSha256,
    overall_decision:decisions.some(d => d.decision === 'revise') ? 'revise' : 'approve',
    overall_feedback_zh:state.overall_feedback_zh, decisions, saved_at:new Date().toISOString(),
    pre_check:sourceChecked && !stale, pre_check_note:sourceChecked ? '' : '未读取到当前版本，收件时需要核对。',
    review_changes:{contract_version:'content-review-edits/1.0.0',edits,page_order:[...state.page_order],section_order:[...state.section_order]},
  };
}
async function submit() {
  if (!writable || submitting) return;
  document.activeElement?.blur();
  const missing = REVIEW.requireDecisions === false ? null : REVIEW.pages.find(p => !state.decisions[p.page_number]);
  if (missing) { notice('第 ' + pad(position('page',missing.page_number)) + ' 页需要你确认。'); page = missing.page_number; setMode('bypage'); return; }
  const withoutReason = REVIEW.pages.find(p => state.decisions[p.page_number] === 'revise' && !state.feedbacks[p.page_number]?.trim() && !state.feedbacks['chapter:' + p.section_id]?.trim() && !state.attachments[p.page_number]?.length && !state.asset_decisions[p.page_number]?.length && !state.edits.pages[p.page_number] && !Object.keys(state.edits.sections).length);
  if (withoutReason) { notice('请写下需要修改的地方。'); return; }
  dirty(); submitting = true; $('#saveButton').disabled = true;
  try {
    await checkSource();
    if (stale) return;
    const payload = submission(), snapshot = draft(), version = revision; if (!await saveDraft(snapshot,version)) return;
    await review.write(payload); status(revision === version ? '已提交' : '新的修改尚未提交',revision !== version);
    try { const result = await review.wake({unit:unit()}); if (result?.woke === false) notice('已提交。请回到对话继续。'); else if (result?.verified) toast('已提交并通知'); else toast('已提交'); }
    catch (_) { notice('已提交，但通知未成功。请回到对话继续。'); }
  } catch (_) { status('提交未成功',true); notice('提交未成功。修改已保留，请重试。'); }
  finally { submitting = false; $('#saveButton').disabled = !writable; updateSelection(); }
}
$$('.mode-tabs button').forEach(b => b.onclick = () => setMode(b.dataset.mode));
$$('.decision').forEach(b => b.onclick = () => { currentPages().forEach(n => state.decisions[n] = b.dataset.decision); dirty(); updateSelection(); });
$('#feedback').oninput = () => { state.feedbacks[mode === 'storyline' ? 'chapter:' + chapter : page] = $('#feedback').value; currentPages().forEach(n => state.decisions[n] = 'revise'); dirty(); };
$('#overallFeedback').oninput = () => { state.overall_feedback_zh = $('#overallFeedback').value; dirty(); };
$('#saveButton').onclick = submit; $('#draftButton').onclick = () => saveDraft();
$('#addStoryline').onclick = addStorylineSection;
$('#pagePrev').onclick = () => {
  const at = state.page_order.map(String).indexOf(String(page));
  if (at > 0) { page = state.page_order[at - 1]; expandedAssets = false; renderPage(); remember(); $('.workspace').scrollTop = 0; }
};
$('#pageNext').onclick = () => {
  const at = state.page_order.map(String).indexOf(String(page));
  if (at >= 0 && at < state.page_order.length - 1) { page = state.page_order[at + 1]; expandedAssets = false; renderPage(); remember(); $('.workspace').scrollTop = 0; }
};
$('#reload').onclick = async () => { if (!writable || await saveDraft()) location.reload(); };
$('#candidateMore').onclick = () => { expandedAssets = !expandedAssets; renderAssets(); };
$('#inspectorToggle').onclick = () => {
  const collapsed = $('.layout').classList.toggle('inspector-collapsed'); $('.inspector').classList.toggle('collapsed',collapsed);
  $('#inspectorToggle').textContent = collapsed ? '‹' : '›'; $('#inspectorToggle').setAttribute('aria-expanded',String(!collapsed));
  $('#inspectorToggle').setAttribute('aria-label',collapsed ? '展开审阅区' : '收起审阅区');
};
$('#modalClose').onclick = () => $('#imageModal').classList.remove('open');
$('#imageModal').onclick = e => { if (e.target === $('#imageModal')) $('#imageModal').classList.remove('open'); };
window.addEventListener('keydown',e => { if (e.key === 'Escape') { document.activeElement?.blur(); $('#imageModal').classList.remove('open'); } });
window.addEventListener('beforeunload',e => { if (revision > savedRevision) { e.preventDefault(); e.returnValue = ''; } });
$('.workspace').onscroll = () => {
  if (mode !== 'storyline' || programmaticScroll || document.activeElement?.isContentEditable || document.activeElement?.tagName === 'TEXTAREA') return;
  const top = $('.workspace').getBoundingClientRect().top + 50;
  const card = $$('.story-card').find(c => c.getBoundingClientRect().bottom > top);
  if (card && card.dataset.sectionId !== chapter) selectChapter(card.dataset.sectionId,false);
};
$('#uploadButton').onclick = () => $('#uploadFile').click();
$('#uploadFile').onchange = async () => {
  const file = $('#uploadFile').files[0]; if (!file || !writable) return;
  const id = page, rel = 'uploads/page-' + pad(id) + '/' + Date.now() + '-' + file.name.replace(/[^\p{L}\p{N}._-]/gu,'-');
  try { await review.upload(file,rel); (state.attachments[id] ??= []).push({path:rel,url:rel,alt:file.name,caption:''}); state.decisions[id] = 'revise'; dirty(); updateSelection(); }
  catch (_) { notice('图片没有保存，请重试。'); } finally { $('#uploadFile').value = ''; }
};
function restore(saved) {
  if (!saved || saved.review_kind !== REVIEW.reviewKind) return;
  if (saved.source_sha256 !== REVIEW.sourceSha256) { writable = false; notice('上一版修改仍保存在草稿中，请回到对话核对后继续。'); return; }
  const permutation = (order, expected) => Array.isArray(order) && order.length === expected.length && new Set(order.map(String)).size === expected.length && expected.every(id => order.map(String).includes(String(id)));
  if (!permutation(saved.page_order,state.page_order) || !permutation(saved.section_order,state.section_order)) return;
  state = {...state,...saved};
  state.edits = {...initial().edits, ...(saved.edits || {})};
  if (saved.view) { if (pageById(saved.view.page)) page = saved.view.page; if (chapterById(saved.view.chapter)) chapter = saved.view.chapter; if (saved.view.mode === 'bypage' || (saved.view.mode === 'storyline' && chapter)) mode = saved.view.mode; }
}
async function boot() {
  if (!chapter) $('.mode-tabs [data-mode="storyline"]').hidden = true;
  if (REVIEW.sections.length) $('.mode-tabs [data-mode="bypage"]').textContent = '页面';
  // The legacy structure surface renders its chapter cards inside <details>.
  // Keep that compatibility surface readable on first load; the Workbench
  // editor has its own deliberate collapsed chapter context.
  $('#chapterDetails').open = Boolean(chapter);
  $('#feedback').disabled = true; $('#overallFeedback').disabled = true; $('#saveButton').disabled = true; $('#draftButton').disabled = true; $$('.decision').forEach(b => b.disabled = true);
  if (matchMedia('(max-width:1120px)').matches) $('#inspectorToggle').click();
  setMode(mode,false);
  try {
    if (!window.ReviewBridge) throw Error('No host');
    review = await Promise.race([ReviewBridge.connect(),new Promise((_,reject) => setTimeout(() => reject(Error('Timeout')),2500))]);
    writable = review.capabilities.includes('draft');
    if (!writable) throw Error('No draft');
    try { restore(JSON.parse(await review.readText(REVIEW.draftPath || 'draft.json'))); } catch (_) {}
    review.on('changed',checkSource); await checkSource();
  } catch (_) { notice('内容可以阅读，暂时无法保存修改。请重新打开审阅页。'); }
  $('#feedback').disabled = !writable; $('#overallFeedback').disabled = !writable; $('#saveButton').disabled = !writable; $('#draftButton').disabled = !writable; $$('.decision').forEach(b => b.disabled = !writable);
  $('#addStoryline').hidden = true;
  setMode(mode);
}
boot();
