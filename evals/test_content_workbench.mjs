import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync,
  rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runContentCommand } from '../scripts/content-workbench.mjs';
import { sha256, writeReviewContext } from '../scripts/content-review-contract.mjs';

const core = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const originalModulesHome = process.env.PLANNERS_MODULES_HOME;
const originalAutoInstall = process.env.PLANNERS_NO_AUTO_INSTALL;
process.env.PLANNERS_MODULES_HOME = dirname(core);
process.env.PLANNERS_NO_AUTO_INSTALL = '1';
after(() => {
  if (originalModulesHome === undefined) delete process.env.PLANNERS_MODULES_HOME;
  else process.env.PLANNERS_MODULES_HOME = originalModulesHome;
  if (originalAutoInstall === undefined) delete process.env.PLANNERS_NO_AUTO_INSTALL;
  else process.env.PLANNERS_NO_AUTO_INSTALL = originalAutoInstall;
});

const parse = path => JSON.parse(readFileSync(path, 'utf8'));
const bytes = path => readFileSync(path, 'utf8');
const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const variants = [
  { name: 'Proposal architecture', kind: 'co_creation_page_architecture', type: 'architecture', claim: 'claim', lead: 'cognitive_job' },
  { name: 'Bypage architecture', kind: 'storyline', type: 'architecture', claim: 'main_message', lead: 'audience_shift' },
  { name: 'Bypage copy', kind: 'bypage', type: 'copy' },
];

function fixture(t, variant = variants[0]) {
  const root = mkdtempSync(join(tmpdir(), 'content-workbench-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, 'review');
  mkdirSync(dir);
  const source = join(root, variant.type === 'copy' ? 'copy.md' : 'architecture.json');
  const pages = [1, 2].map(n => ({
    page_number: n, section_id: 'sec-' + n, title: 'Original ' + n, claim: 'Claim ' + n,
    blocks: [{ title: 'Block ' + n, text: 'Body ' + n }],
    sections: ['Page Content', 'Speaker Notes', 'Production Notes', 'Sources'].map(label => ({ label, value: label + ' ' + n })),
  }));
  const sections = [1, 2].map(n => ({ section_id: 'sec-' + n, title: 'Section ' + n, lead: 'Lead ' + n, transition: '' }));
  let raw;
  if (variant.type === 'architecture') {
    raw = JSON.stringify({
      contract_version: '1.0.0', storyline_thesis: 'Original thesis',
      sections: sections.map(s => ({ section_id: s.section_id, title: s.title, [variant.lead]: s.lead,
        transition: '', page_numbers: [Number(s.section_id.slice(-1))] })),
      pages: pages.map(p => ({ page_number: p.page_number, section_id: p.section_id,
        title_intent: p.title, [variant.claim]: p.claim, page_job: 'Explain', page_type: 'explanation',
        content_blocks: [{ block_title: p.blocks[0].title, content_requirement: p.blocks[0].text, role: 'Explain', suggested_form: 'paragraph' }],
        source_needs: [], evidence_needs: [], recommended_assets: [], other_candidate_assets: [],
        chart_brief: null, layout_direction: null, transition: '' })),
    }, null, 2) + '\n';
  } else {
    raw = '# Copy fixture\n\n' + pages.map(p =>
      '---\ncontract_version: 1.0.0\npage_number: ' + p.page_number + '\npage_title: "' + p.title +
      '"\nmain_message: "' + p.claim + '"\n---\n\n' + p.sections.map(s => '## ' + s.label + '\n\n' + s.value + '\n').join('\n')
    ).join('\n');
  }
  writeFileSync(source, raw);
  const dependency = join(root, 'dependency.json');
  writeJson(dependency, { assets: [] });
  const context = { type: variant.type, reviewKind: variant.kind,
    allowStructureChanges: variant.type === 'architecture', sourceSha256: sha256(raw), pages,
    sections: variant.type === 'copy' ? [] : sections,
    files: [{ path: source, sha256: sha256(raw) }, { path: dependency, sha256: sha256(bytes(dependency)) }] };
  writeReviewContext(dir, context);
  const surface = { projectRoot: root, dir };
  const run = command => runContentCommand(surface, command);
  const headPath = join(dir, 'workbench/head.json');
  return { root, dir, source, raw, context, variant, run, headPath, head: () => parse(headPath) };
}

async function stateOf(f) {
  const result = await f.run({ op: 'state' });
  assert.equal(result.ok, true, JSON.stringify(result));
  return result;
}

function saveCommand(head, state, id = 'save_test_0001') {
  return { op: 'save', operation_id: id, base_revision: head.revision, state: structuredClone(state) };
}

function modified(head, variant) {
  const state = structuredClone(head.state);
  state.page_order = [2, 1];
  state.edits.pages['1'] = variant.type === 'copy'
    ? { title: 'Human title', sections: { '0': 'Human body', '1': 'Human notes' } }
    : { title: 'Human title', claim: 'Human claim', blocks: { '0': { title: 'Human block', text: 'Human body' } } };
  if (variant.type === 'architecture') {
    state.section_order = ['sec-2', 'sec-1'];
    state.edits.sections['sec-1'] = { title: 'Human section', lead: 'Human lead' };
    state.edits.thesis = 'Human thesis';
  }
  return state;
}

function assertProjection(f) {
  if (f.variant.type === 'copy') {
    const raw = bytes(f.source);
    assert.ok(raw.indexOf('Original 2') < raw.indexOf('Human title'));
    assert.match(raw, /page_number: 2\npage_title: "Human title"/);
    assert.match(raw, /Human body/);
    assert.match(raw, /Human notes/);
  } else {
    const doc = parse(f.source);
    assert.deepEqual(doc.pages.map(p => p.page_number), [1, 2]);
    assert.deepEqual(doc.pages.map(p => p.title_intent), ['Original 2', 'Human title']);
    assert.equal(doc.pages[1][f.variant.claim], 'Human claim');
    assert.equal(doc.pages[1].content_blocks[0].content_requirement, 'Human body');
    assert.deepEqual(doc.sections.map(s => s.section_id), ['sec-2', 'sec-1']);
    assert.equal(doc.sections[1][f.variant.lead], 'Human lead');
    assert.deepEqual(doc.sections[1].page_numbers, [2]);
    assert.equal(doc.storyline_thesis, 'Human thesis');
  }
}

for (const variant of variants) {
  test(variant.name + ': canonical save, retry, frozen baseline and repeated reorder', async t => {
    const f = fixture(t, variant), initial = await stateOf(f);
    const state = modified(initial, variant), command = saveCommand(initial, state);
    const first = await f.run(command);
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(first.content_changed, true);
    assert.equal(first.requires_fact_recheck, variant.type === 'copy');
    assert.deepEqual(first.page_mapping, { '1': 2, '2': 1 });
    assertProjection(f);
    const savedBytes = bytes(f.source), savedHead = bytes(f.headPath);
    assert.equal(f.head().baseline, f.raw);
    assert.equal(first.source_hash, sha256(savedBytes));
    assert.deepEqual(await f.run(command), first);
    assert.equal(bytes(f.headPath), savedHead, 'An exact retry must not create another commit');
    assert.equal(bytes(f.source), savedBytes);
    const second = await f.run(saveCommand(await stateOf(f), state, 'save_test_0002'));
    assert.equal(second.ok, true, JSON.stringify(second));
    assert.equal(second.content_changed, false);
    assert.equal(bytes(f.source), savedBytes, 'Cumulative order must project from baseline, not current numbered pages');
    assertProjection(f);
    assert.equal(f.head().baseline, f.raw);
    assert.equal(existsSync(join(f.dir, 'workbench/journal.json')), false);
    const archived = parse(join(f.dir, 'workbench/history', initial.revision + '.json'));
    assert.equal(archived.source_hash, sha256(f.raw));
  });

  test(variant.name + ': two stale clients cannot both commit', async t => {
    const f = fixture(t, variant), a = await stateOf(f), b = await stateOf(f);
    const first = await f.run(saveCommand(a, modified(a, variant), 'client_a_0001'));
    assert.equal(first.ok, true, JSON.stringify(first));
    const source = bytes(f.source), head = bytes(f.headPath);
    const other = structuredClone(b.state);
    other.edits.pages['2'] = { title: 'Client B unsaved input' };
    const command = saveCommand(b, other, 'client_b_0001');
    const result = await f.run(command);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'revision_conflict');
    assert.equal(bytes(f.source), source);
    assert.equal(bytes(f.headPath), head);
    assert.equal(command.state.edits.pages['2'].title, 'Client B unsaved input');
  });

  test(variant.name + ': simultaneous CAS saves produce exactly one winner', async t => {
    const f = fixture(t, variant), initial = await stateOf(f);
    const commands = ['A', 'B'].map(name => {
      const state = structuredClone(initial.state);
      state.edits.pages['1'] = { title: 'Client ' + name };
      return saveCommand(initial, state, 'parallel_client_' + name);
    });
    const results = await Promise.all(commands.map(f.run));
    assert.equal(results.filter(result => result.ok).length, 1, JSON.stringify(results));
    const winner = results.findIndex(result => result.ok);
    assert.equal(results[1 - winner].code, 'revision_conflict');
    assert.deepEqual(f.head().state, commands[winner].state);
    assert.equal(sha256(bytes(f.source)), results[winner].source_hash);
    assert.equal(Object.keys(f.head().operations).length, 1);
    assert.deepEqual(await f.run(commands[winner]), results[winner]);
    assert.equal(existsSync(join(f.dir, 'workbench/save.lock')), false);
  });

  test(variant.name + ': legacy state saves and cleared edits restore the frozen baseline', async t => {
    const f = fixture(t, variant), initial = await stateOf(f), legacy = modified(initial, variant);
    delete legacy.added_pages; delete legacy.deleted_pages;
    const saved = await f.run(saveCommand(initial, legacy));
    assert.equal(saved.ok, true, JSON.stringify(saved));
    const restored = await f.run(saveCommand(await stateOf(f), initial.state, 'save_clear_0001'));
    assert.equal(restored.ok, true, JSON.stringify(restored));
    assert.equal(restored.content_changed, true);
    if (variant.type === 'copy') assert.equal(bytes(f.source), f.raw);
    else assert.deepEqual(parse(f.source), JSON.parse(f.raw));
    const restoredBytes = bytes(f.source);
    const repeated = await f.run(saveCommand(await stateOf(f), initial.state, 'save_clear_0002'));
    assert.equal(repeated.ok, true, JSON.stringify(repeated));
    assert.equal(repeated.content_changed, false);
    assert.equal(bytes(f.source), restoredBytes);
    assert.equal(f.head().baseline, f.raw);
  });

  test(variant.name + ': external main-copy change is preserved on save/state', async t => {
    const f = fixture(t, variant), initial = await stateOf(f);
    const head = bytes(f.headPath), external = f.raw + '\nExternal author change\n';
    writeFileSync(f.source, external);
    for (const command of [{ op: 'state' }, saveCommand(initial, modified(initial, variant))]) {
      const result = await f.run(command);
      assert.equal(result.ok, false);
      assert.equal(result.code, 'source_conflict');
      assert.equal(bytes(f.source), external);
      assert.equal(bytes(f.headPath), head);
    }
  });

  test(variant.name + ': dependency changes reject save/task without mutating canonical content', async t => {
    const f = fixture(t, variant), initial = await stateOf(f);
    writeJson(f.context.files[1].path, { assets: ['External manifest update'] });
    const head = bytes(f.headPath);
    for (const command of [saveCommand(initial, modified(initial, variant)),
      { op: 'feedback', operation_id: 'feedback_dependency_0001', base_revision: initial.revision,
        scope: 'deck', text: 'Task from stale dependency input' }]) {
      const receipt = await f.run(command);
      assert.equal(receipt.ok, false);
      assert.equal(receipt.code, 'dependency_conflict');
      assert.equal(bytes(f.source), f.raw);
      assert.equal(bytes(f.headPath), head);
    }
  });

  test(variant.name + ': invalid patches and reused operation IDs leave main copy unchanged', async t => {
    const f = fixture(t, variant), initial = await stateOf(f);
    const invalid = structuredClone(initial.state);
    invalid.edits.pages['999'] = { title: 'Unknown input' };
    const head = bytes(f.headPath);
    const denied = await f.run(saveCommand(initial, invalid));
    assert.equal(denied.ok, false);
    assert.equal(bytes(f.source), f.raw);
    assert.equal(bytes(f.headPath), head);
    const command = saveCommand(initial, modified(initial, variant));
    assert.equal((await f.run(command)).ok, true);
    const saved = bytes(f.source), reused = structuredClone(command);
    reused.state.overall_feedback_zh = 'Changed same-ID payload';
    const result = await f.run(reused);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'operation_reused');
    assert.equal(bytes(f.source), saved);
  });

  test(variant.name + ': page/deck tasks bind saved revision and mapped scope', async t => {
    const f = fixture(t, variant), initial = await stateOf(f);
    const saved = await f.run(saveCommand(initial, modified(initial, variant)));
    assert.equal(saved.ok, true);
    const pageCommand = { op: 'feedback', operation_id: 'feedback_page_0001', base_revision: saved.revision,
      scope: 'page', page: 1, text: 'Change only the original first node' };
    const pageReceipt = await f.run(pageCommand);
    assert.equal(pageReceipt.ok, true, JSON.stringify(pageReceipt));
    assert.deepEqual(pageReceipt.task.pages, [2]);
    assert.equal(pageReceipt.task.revision, saved.revision);
    assert.equal(pageReceipt.task.source_hash, saved.source_hash);
    const originalTask = structuredClone(pageReceipt.task);
    assert.deepEqual(await f.run(pageCommand), pageReceipt);
    assert.equal(f.head().tasks.length, 1);
    const deckReceipt = await f.run({ op: 'feedback', operation_id: 'feedback_deck_0001',
      base_revision: saved.revision, scope: 'deck', text: 'Overall-only deck task' });
    assert.equal(deckReceipt.ok, true);
    assert.deepEqual(deckReceipt.task.pages, [1, 2]);
    assert.equal(deckReceipt.task.scope, 'deck');
    assert.equal(deckReceipt.task.revision, saved.revision);
    const newer = modified(initial, variant);
    newer.edits.pages['1'].title = 'Later saved title';
    assert.equal((await f.run(saveCommand(await stateOf(f), newer, 'save_later_0001'))).ok, true);
    assert.deepEqual(f.head().tasks[0], originalTask, 'A later save must not retarget an existing task');
    const head = bytes(f.headPath), source = bytes(f.source);
    for (const extra of [
      { base_revision: saved.revision, scope: 'deck', text: 'Stale task' },
      { base_revision: f.head().revision, scope: 'page', page: 999, text: 'Unknown page' },
      { base_revision: f.head().revision, scope: 'deck', text: ' ' },
    ]) {
      assert.equal((await f.run({ op: 'feedback', operation_id: 'feedback_bad_0001', ...extra })).ok, false);
      assert.equal(bytes(f.headPath), head);
      assert.equal(bytes(f.source), source);
    }
  });
}

for (const variant of variants.filter(v => v.type === 'architecture')) {
  test(variant.name + ': add/delete nodes, preserve stable draft IDs and canonical numbering', async t => {
    const f = fixture(t, variant), initial = await stateOf(f), state = structuredClone(initial.state);
    state.added_pages = { '-1': { section_id: 'sec-1', title: 'New human judgment' } };
    state.deleted_pages = [2];
    state.page_order = [-1, 1];
    const receipt = await f.run(saveCommand(initial, state));
    assert.equal(receipt.ok, true, JSON.stringify(receipt));
    const doc = parse(f.source);
    assert.deepEqual(doc.pages.map(p => p.title_intent), ['New human judgment', 'Original 1']);
    assert.deepEqual(doc.pages.map(p => p.page_number), [1, 2]);
    assert.equal(doc.pages[0][variant.claim], 'New human judgment');
    assert.deepEqual(doc.sections[0].page_numbers, [1, 2]);
    assert.deepEqual(doc.sections[1].page_numbers, []);
    assert.deepEqual(receipt.page_mapping, { '-1': 1, '1': 2 });
    assert.deepEqual((await stateOf(f)).state, state);
    const task = await f.run({ op: 'feedback', operation_id: 'feedback_new_0001', base_revision: receipt.revision,
      scope: 'page', page: -1, text: 'Revise the newly added node only' });
    assert.equal(task.ok, true);
    assert.deepEqual(task.task.pages, [1]);
    const deletedTask = await f.run({ op: 'feedback', operation_id: 'feedback_deleted_0001',
      base_revision: receipt.revision, scope: 'page', page: 2, text: 'Deleted node cannot receive a task' });
    assert.equal(deletedTask.ok, false);
    assert.equal(deletedTask.code, 'feedback_page');
    const saved = bytes(f.source);
    assert.equal((await f.run(saveCommand(await stateOf(f), state, 'save_nodes_0002'))).ok, true);
    assert.equal(bytes(f.source), saved);
  });

  test(variant.name + ': negative-ID node title remains editable before and after save', async t => {
    const f = fixture(t, variant), initial = await stateOf(f), state = structuredClone(initial.state);
    state.added_pages = { '-12': { title: 'Initial new judgment', section_id: 'sec-1' } };
    state.page_order = [1, -12, 2];
    state.added_pages['-12'].title = 'Edited before save';
    const first = await f.run(saveCommand(initial, state));
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(first.page_mapping['-12'], 2);
    assert.equal(parse(f.source).pages[1].title_intent, 'Edited before save');
    const recovered = await stateOf(f);
    recovered.state.added_pages['-12'].title = 'Edited after reload';
    const second = await f.run(saveCommand(recovered, recovered.state, 'save_negative_0002'));
    assert.equal(second.ok, true, JSON.stringify(second));
    assert.equal(parse(f.source).pages[1].title_intent, 'Edited after reload');
    assert.equal(parse(f.source).pages[1][variant.claim], 'Edited after reload');
    assert.deepEqual(parse(f.source).pages.map(page => page.page_number), [1, 2, 3]);
    assert.equal((await stateOf(f)).state.added_pages['-12'].title, 'Edited after reload');
  });

  test(variant.name + ': 1.1.0 page patches can target a newly added negative ID', async t => {
    const f = fixture(t, variant), initial = await stateOf(f), state = structuredClone(initial.state);
    state.added_pages = { '-1': { title: 'Initial new judgment', section_id: 'sec-1' } };
    state.page_order = [1, -1, 2];
    state.edits.pages['-1'] = { title: 'Patched new judgment', claim: 'Patched new claim' };
    const receipt = await f.run(saveCommand(initial, state));
    assert.equal(receipt.ok, true, JSON.stringify(receipt));
    assert.equal(parse(f.source).pages[1].title_intent, 'Patched new judgment');
    assert.equal(parse(f.source).pages[1][variant.claim], 'Patched new claim');
    const saved = bytes(f.source);
    assert.equal((await f.run(saveCommand(await stateOf(f), state, 'save_patch_negative_0002'))).ok, true);
    assert.equal(bytes(f.source), saved);
  });
}

test('copy rejects structure additions/deletions without changing main copy', async t => {
  const f = fixture(t, variants[2]), initial = await stateOf(f), state = structuredClone(initial.state);
  state.deleted_pages = [2]; state.page_order = [1];
  assert.equal((await f.run(saveCommand(initial, state))).ok, false);
  assert.equal(bytes(f.source), f.raw);
  state.deleted_pages = []; state.page_order = [1, 2, -1];
  state.added_pages = { '-1': { title: 'Not a copy page', section_id: 'sec-1' } };
  assert.equal((await f.run(saveCommand(initial, state, 'save_copy_bad_0002'))).ok, false);
  assert.equal(bytes(f.source), f.raw);
});

test('copy upload references are durable, remapped and not duplicated by later saves', async t => {
  const f = fixture(t, variants[2]), initial = await stateOf(f), state = modified(initial, variants[2]);
  mkdirSync(join(f.dir, 'uploads'), { recursive: true });
  writeFileSync(join(f.dir, 'uploads/image.png'), Buffer.from([137, 80, 78, 71]));
  state.attachments = { '1': [{ path: 'uploads/image.png', alt: 'Human [caption]', url: 'blob:transient' }] };
  const first = await f.run(saveCommand(initial, state));
  assert.equal(first.ok, true, JSON.stringify(first));
  const raw = bytes(f.source);
  assert.equal(raw.split('](<review/uploads/image.png>)').length - 1, 1);
  assert.ok(raw.indexOf('page_number: 2') < raw.indexOf('](<review/uploads/image.png>)'));
  assert.ok(!raw.includes('blob:transient'));
  assert.equal((await f.run(saveCommand(await stateOf(f), state, 'save_upload_0002'))).ok, true);
  assert.equal(bytes(f.source), raw);
});

test('unsafe upload paths, extensions and symlinks fail without main-copy mutation', async t => {
  const f = fixture(t, variants[2]), initial = await stateOf(f);
  mkdirSync(join(f.dir, 'uploads'));
  writeFileSync(join(f.dir, 'uploads/script.js'), 'not an image');
  writeFileSync(join(f.root, 'outside.png'), 'outside uploads');
  symlinkSync(join(f.root, 'outside.png'), join(f.dir, 'uploads/project-escape.png'));
  const elsewhere = mkdtempSync(join(tmpdir(), 'content-workbench-outside-'));
  t.after(() => rmSync(elsewhere, { recursive: true, force: true }));
  writeFileSync(join(elsewhere, 'outside.png'), 'outside project');
  symlinkSync(join(elsewhere, 'outside.png'), join(f.dir, 'uploads/escape.png'));
  const head = bytes(f.headPath);
  for (const [i, path] of ['../outside.png', 'uploads/../../outside.png', 'uploads/script.js',
    'uploads/escape.png', 'uploads/project-escape.png', join(f.root, 'outside.png'),
    'uploads/missing.png', 'uploads/image.png\u0000'].entries()) {
    const state = structuredClone(initial.state);
    state.edits.pages['1'] = { title: 'Must not save when upload fails' };
    state.attachments = { '1': [{ path }] };
    const result = await f.run(saveCommand(initial, state, 'save_unsafe_000' + i));
    assert.equal(result.ok, false, path);
    assert.equal(bytes(f.source), f.raw, path);
    assert.equal(bytes(f.headPath), head, path);
  }
});

test('journal recovers prepared/committed saves once, and refuses unrelated external bytes', async t => {
  for (const phase of ['prepared', 'source-written', 'external']) {
    const f = fixture(t), initial = await stateOf(f), newRaw = f.raw + '\n';
    const head = { ...f.head(), revision: sha256('recovered revision'), source_hash: sha256(newRaw) };
    const journal = join(f.dir, 'workbench/journal.json');
    writeJson(journal, { source: f.source, raw: newRaw, old_hash: sha256(f.raw), new_hash: sha256(newRaw), head });
    if (phase === 'source-written') writeFileSync(f.source, newRaw);
    if (phase === 'external') writeFileSync(f.source, 'Unrelated external input');
    const result = await f.run({ op: 'state' });
    if (phase === 'external') {
      assert.equal(result.ok, false);
      assert.equal(result.code, 'source_conflict');
      assert.equal(bytes(f.source), 'Unrelated external input');
      assert.equal(f.head().revision, initial.revision);
      assert.equal(existsSync(journal), true);
    } else {
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.revision, head.revision);
      assert.equal(bytes(f.source), newRaw);
      assert.equal(existsSync(journal), false);
      assert.equal(typeof parse(join(f.dir, '.inbox-cursor.json')).applied_draft, 'string');
      assert.equal((await stateOf(f)).revision, head.revision);
    }
  }
});

test('old/new unchanged pure drafts allow rebuilding without feedback submission', t => {
  for (const legacy of [true, false]) {
    const f = fixture(t), draft = { edits: { pages: {}, sections: {} },
      page_order: [1, 2], section_order: ['sec-1', 'sec-2'], feedbacks: {}, overall_feedback_zh: '' };
    if (!legacy) Object.assign(draft, { added_pages: {}, deleted_pages: [] });
    writeJson(join(f.dir, f.context.draftPath), draft);
    const updated = { ...structuredClone(f.context), sourceSha256: sha256('new baseline ' + legacy) };
    assert.doesNotThrow(() => writeReviewContext(f.dir, updated));
    assert.equal(parse(join(f.dir, 'review-context.json')).sourceSha256, updated.sourceSha256);
    assert.deepEqual(parse(join(f.dir, f.context.draftPath)), draft);
  }
});

test('unsaved pure draft edits and structural deletes prevent rebuilding and retain recovery bytes', t => {
  for (const mode of ['text', 'delete']) {
    const f = fixture(t), draft = { edits: { pages: {}, sections: {} }, page_order: [1, 2],
      section_order: ['sec-1', 'sec-2'], added_pages: {}, deleted_pages: [] };
    if (mode === 'text') draft.edits.pages['1'] = { title: 'Unsubmitted human text' };
    else { draft.deleted_pages = [2]; draft.page_order = [1]; }
    const path = join(f.dir, f.context.draftPath);
    writeJson(path, draft);
    const before = bytes(path), context = bytes(join(f.dir, 'review-context.json'));
    assert.throws(() => writeReviewContext(f.dir, { ...f.context, sourceSha256: sha256('next ' + mode) }), /草稿/);
    assert.equal(bytes(path), before);
    assert.equal(bytes(join(f.dir, 'review-context.json')), context);
    assert.equal(bytes(f.source), f.raw);
  }
});

test('an unsubmitted add-then-delete draft is not mistaken for an empty legacy draft', t => {
  const f = fixture(t), draft = { edits: { pages: {}, sections: {} }, page_order: [1, -1],
    section_order: ['sec-1', 'sec-2'], added_pages: { '-1': { title: 'Unsubmitted new node', section_id: 'sec-1' } }, deleted_pages: [2] };
  writeJson(join(f.dir, f.context.draftPath), draft);
  assert.throws(() => writeReviewContext(f.dir, { ...f.context, sourceSha256: sha256('new source') }), /草稿/);
});

test('saved addition followed by an unsaved title edit must block rebuilding', async t => {
  const f = fixture(t), initial = await stateOf(f), draft = structuredClone(initial.state);
  draft.added_pages = { '-1': { title: 'Saved new judgment', section_id: 'sec-1' } };
  draft.page_order = [1, 2, -1];
  const saved = await f.run(saveCommand(initial, draft));
  assert.equal(saved.ok, true, JSON.stringify(saved));
  draft.added_pages['-1'].title = 'Unsubmitted revised judgment';
  const path = join(f.dir, f.context.draftPath);
  writeJson(path, draft);
  const before = bytes(path), context = bytes(join(f.dir, 'review-context.json'));
  assert.throws(() => writeReviewContext(f.dir, { ...f.context, sourceSha256: saved.source_hash }), /草稿/);
  assert.equal(bytes(path), before);
  assert.equal(bytes(join(f.dir, 'review-context.json')), context);
  assert.equal(parse(f.source).pages[2].title_intent, 'Saved new judgment');
});

test('unsaved upload-only draft must block rebuilding and retain its durable reference', async t => {
  const f = fixture(t, variants[2]), initial = await stateOf(f), state = modified(initial, variants[2]);
  const saved = await f.run(saveCommand(initial, state));
  assert.equal(saved.ok, true, JSON.stringify(saved));
  mkdirSync(join(f.dir, 'uploads'));
  writeFileSync(join(f.dir, 'uploads/image.png'), Buffer.from([137, 80, 78, 71]));
  state.attachments = { '1': [{ path: 'uploads/image.png', alt: 'Unsubmitted image' }] };
  const path = join(f.dir, f.context.draftPath);
  writeJson(path, state);
  const source = bytes(f.source), draft = bytes(path);
  assert.throws(() => writeReviewContext(f.dir, { ...f.context, sourceSha256: saved.source_hash }), /草稿/);
  assert.equal(bytes(f.source), source);
  assert.equal(bytes(path), draft);
  assert.equal(existsSync(join(f.dir, 'uploads/image.png')), true);
});

test('legacy draft.json without structural fields remains rebuild-compatible', t => {
  const f = fixture(t), previous = structuredClone(f.context);
  delete previous.draftPath;
  writeJson(join(f.dir, 'review-context.json'), previous);
  const draft = { edits: { pages: {}, sections: {} }, page_order: [1, 2], section_order: ['sec-1', 'sec-2'] };
  writeJson(join(f.dir, 'draft.json'), draft);
  const next = { ...f.context, sourceSha256: sha256('next legacy baseline') };
  assert.doesNotThrow(() => writeReviewContext(f.dir, next));
  assert.deepEqual(parse(join(f.dir, 'draft.json')), draft);
  assert.equal(parse(join(f.dir, 'review-context.json')).draftPath, 'draft-' + next.sourceSha256 + '.json');
});

test('rebuilding an unsubmitted saved draft resets the baseline but preserves task version/scope', async t => {
  const f = fixture(t), initial = await stateOf(f), state = modified(initial, f.variant);
  const saved = await f.run(saveCommand(initial, state));
  assert.equal(saved.ok, true, JSON.stringify(saved));
  const task = await f.run({ op: 'feedback', operation_id: 'feedback_before_rebuild',
    base_revision: saved.revision, scope: 'page', page: 1, text: 'Original first page, now canonical page 2' });
  assert.equal(task.ok, true, JSON.stringify(task));
  writeJson(join(f.dir, f.context.draftPath), state);
  const canonical = parse(f.source), raw = bytes(f.source);
  const next = { ...structuredClone(f.context), sourceSha256: sha256(raw),
    files: [{ path: f.source, sha256: sha256(raw) }, f.context.files[1]],
    pages: canonical.pages.map(page => ({ page_number: page.page_number, section_id: page.section_id,
      title: page.title_intent, claim: page.claim,
      blocks: page.content_blocks.map(block => ({ title: block.block_title, text: block.content_requirement })) })),
    sections: canonical.sections.map(section => ({ section_id: section.section_id, title: section.title,
      lead: section.cognitive_job, transition: section.transition })) };
  assert.doesNotThrow(() => writeReviewContext(f.dir, next));
  const rebuilt = await stateOf(f);
  assert.equal(rebuilt.baseline, raw);
  assert.notEqual(rebuilt.revision, saved.revision);
  assert.deepEqual(rebuilt.state.edits, { pages: {}, sections: {} });
  assert.deepEqual(rebuilt.state.page_order, [1, 2]);
  assert.deepEqual(rebuilt.tasks, [task.task]);
  assert.equal(rebuilt.tasks[0].revision, saved.revision);
  assert.deepEqual(rebuilt.tasks[0].pages, [2]);
  const repeat = await f.run(saveCommand(rebuilt, rebuilt.state, 'save_rebuilt_0001'));
  assert.equal(repeat.ok, true, JSON.stringify(repeat));
  assert.equal(repeat.content_changed, false);
  assert.equal(bytes(f.source), raw);
  const stale = await f.run(saveCommand(initial, state, 'save_pre_rebuild_0001'));
  assert.equal(stale.ok, false);
  assert.equal(stale.code, 'revision_conflict');
});
