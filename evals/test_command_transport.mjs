import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { commandFixture, seedWorkbench, startCommandHost } from './command-transport-fixture.mjs';

const post = (origin, payload, headers = {}) => fetch(origin + '/__review/command', {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(payload),
});

const rawPost = (origin, headers) => new Promise((done, fail) => {
  const req = httpRequest(origin + '/__review/command', { method: 'POST', headers: { 'content-type': 'application/json', ...headers } }, (res) => {
    res.resume();
    res.on('end', () => done(res.statusCode));
  });
  req.on('error', fail);
  req.end('{"op":"state"}');
});

test('local host passes all allowlisted operations, JSON stdin, canonical root and --browser', async (t) => {
  const f = await commandFixture(t);
  const origin = await startCommandHost(t, f);
  assert.deepEqual((await (await fetch(origin + '/__review/capabilities')).json()).capabilities, ['command']);
  for (const op of ['get', 'state', 'save', 'feedback', 'snapshot', 'restore', 'order']) {
    const payload = { op, operation_id: 'human_' + op, author: 'human', page_key: 'page_01', notes: 'Human text', edits: [{ element_id: 't1', kind: 'text', value: 'A & B' }] };
    const result = await (await post(origin, payload)).json();
    assert.equal(result.ok, true);
    assert.deepEqual(result.payload, payload);
    assert.deepEqual(result.args, ['--root', f.project, '--command-json', '--browser']);
  }
  assert.equal((await f.calls()).length, 7);
});

test('local host preserves backend rejection details despite nonzero CLI exit', async (t) => {
  const f = await commandFixture(t);
  const origin = await startCommandHost(t, f);
  const response = await post(origin, { op: 'save', operation_id: 'same_op', fixture_mode: 'conflict' });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: false, code: 'conflict', error: 'Changed', current_revision: 'r_new', operation_id: 'same_op' });
});

test('local host refuses browser model, unknown operations and execution overrides before spawn', async (t) => {
  const f = await commandFixture(t);
  const origin = await startCommandHost(t, f);
  const invalid = [null, [], { op: 'resolve' }, { op: 'checkout' }, { op: 'shell' }, { op: 'save', author: 'model' },
    { op: 'save', root: '/tmp/another' }, { op: 'state', executable: '/bin/sh' }, { op: 'state', command_backend: '/tmp/evil.py' }];
  for (const payload of invalid) assert.equal((await (await post(origin, payload)).json()).ok, false);
  assert.equal((await f.calls()).length, 0);
});

test('local command requires POST/JSON and same-origin browser requests', async (t) => {
  const f = await commandFixture(t);
  const origin = await startCommandHost(t, f);
  assert.equal((await fetch(origin + '/__review/command')).status, 405);
  assert.equal((await post(origin, { op: 'state' }, { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await post(origin, { op: 'state' }, { origin: 'https://attacker.invalid' })).status, 403);
  assert.equal((await post(origin, { op: 'state' }, { origin: 'null' })).status, 403);
  assert.equal(await rawPost(origin, { origin: '' }), 403);
  assert.equal((await post(origin, { op: 'state' }, { 'sec-fetch-site': 'cross-site' })).status, 403);
  // Node fetch normalizes Host, so test rebinding with a raw HTTP client.
  assert.equal(await rawPost(origin, { host: 'attacker.invalid' }), 403);
  assert.equal(await rawPost(origin, { host: 'localhost:' + new URL(origin).port }), 403);
  assert.equal((await fetch(origin + '/__review/command', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' })).status, 400);
  assert.equal((await (await post(origin, { op: 'state' }, { origin })).json()).ok, true);
});

test('local host advertises command only when declared and backend is supported', async (t) => {
  for (const change of [{ command_backend: undefined }, { capabilities: ['future'] }]) {
    const f = await commandFixture(t);
    await f.setSurface(change);
    const origin = await startCommandHost(t, f);
    assert.deepEqual((await (await fetch(origin + '/__review/capabilities')).json()).capabilities, []);
    assert.equal((await (await post(origin, { op: 'state' })).json()).code, 'command_not_enabled');
  }
});

test('shared runner restricts root to loaded surface and bounds input/output', async (t) => {
  const f = await commandFixture(t);
  const runner = await import(pathToFileURL(join(f.core, 'scripts/lib/review-command.mjs')));
  const surface = { data: f.data, projectRoot: f.project, dir: f.dir };
  assert.equal((await runner.runBrowserCommand({ ...surface, projectRoot: 'relative' }, { op: 'state' })).code, 'command_project_root');
  assert.equal((await runner.runBrowserCommand({ ...surface, dir: f.base }, { op: 'state' })).code, 'command_project_root');
  assert.equal((await runner.runBrowserCommand(surface, { op: 'state', notes: 'x'.repeat(1024 * 1024) })).code, 'command_input_limit');
  for (const fixture_mode of ['invalid', 'bad-envelope', 'crash']) {
    assert.equal((await runner.runBrowserCommand(surface, { op: 'state', fixture_mode })).code, 'command_invalid_response');
  }
  assert.equal((await runner.runBrowserCommand(surface, { op: 'state', fixture_mode: 'false-success' })).code, 'command_exit');
  assert.equal((await runner.runBrowserCommand(surface, { op: 'state', fixture_mode: 'overflow' })).code, 'command_output_limit');
});

test('configured Python is host-only and unavailable interpreter is explicit', async (t) => {
  const f = await commandFixture(t);
  const runner = await import(pathToFileURL(join(f.core, 'scripts/lib/review-command.mjs')));
  const previous = process.env.PLANNERS_REVIEW_PYTHON;
  try {
    process.env.PLANNERS_REVIEW_PYTHON = join(f.base, 'missing-python');
    const result = await runner.runBrowserCommand({ data: f.data, projectRoot: f.project, dir: f.dir }, { op: 'state' });
    assert.equal(result.code, 'python_unavailable');
  } finally {
    if (previous === undefined) delete process.env.PLANNERS_REVIEW_PYTHON;
    else process.env.PLANNERS_REVIEW_PYTHON = previous;
  }
});

test('shared runner kills a stalled processor before the bridge 30-second deadline', async (t) => {
  const f = await commandFixture(t);
  const runner = await import(pathToFileURL(join(f.core, 'scripts/lib/review-command.mjs')));
  const start = Date.now();
  const result = await runner.runBrowserCommand({ data: f.data, projectRoot: f.project, dir: f.dir }, { op: 'state', fixture_mode: 'timeout' });
  assert.equal(result.code, 'command_timeout');
  assert.ok(Date.now() - start < 30000);
});

test('bridge command preserves structured results in both transports and respects capabilities', async () => {
  const source = await readFile(new URL('../assets/review-bridge.js', import.meta.url), 'utf8');
  const payload = { op: 'save', operation_id: 'op_retry', author: 'human', page_key: 'page_01' };
  const rejection = { ok: false, code: 'conflict', error: 'Changed', current_revision: 'r2' };
  for (const frame of [false, true]) {
    for (const enabled of [false, true]) {
      let listener;
      const calls = [];
      const parent = { postMessage(data) {
        if (data.type === 'hello') queueMicrotask(() => listener({ source: parent, data: { __review: true, type: 'init', nonce: data.nonce, capabilities: enabled ? ['command'] : [] } }));
        if (data.type === 'call') {
          calls.push(data);
          queueMicrotask(() => listener({ source: parent, data: { __review: true, type: 'result', nonce: data.nonce, id: data.id, ok: true, value: rejection } }));
        }
      } };
      const fetcher = async (url, init) => {
        if (url.endsWith('capabilities')) return { ok: true, json: async () => ({ capabilities: enabled ? ['command'] : [] }) };
        if (url.endsWith('version')) return { ok: true, json: async () => ({ token: 'initial' }) };
        calls.push({ method: 'command', payload: JSON.parse(init.body) });
        return { ok: true, json: async () => rejection };
      };
      const win = { parent: frame ? parent : null, crypto: globalThis.crypto, addEventListener(_type, fn) { listener = fn; }, setTimeout: () => 0, setInterval: () => 0 };
      const Bridge = new Function('window', 'fetch', source + '\nreturn window.ReviewBridge;')(win, fetcher);
      const review = await Bridge.connect();
      const result = await review.command(payload);
      assert.deepEqual(result, enabled ? rejection : { ok: false, code: 'command_not_enabled', error: 'Host has no command capability' });
      assert.equal(calls.length, enabled ? 1 : 0);
      if (enabled) assert.deepEqual(calls[0].payload, payload);
    }
  }
});

test('validator accepts backend identifier and rejects executable identifiers', async (t) => {
  const f = await commandFixture(t);
  const validate = () => spawnSync(process.execPath, [join(f.core, 'scripts/validate-surface.mjs'), f.surface], { encoding: 'utf8' });
  assert.equal(validate().status, 0);
  await f.setSurface({ command_backend: '/bin/sh' });
  assert.equal(JSON.parse(validate().stdout).errors.some((e) => e.code === 'command_backend'), true);
});

test('real candidate backend: save/retry/conflict, page feedback, snapshot, order and restore', async (t) => {
  const f = await commandFixture(t, { backend: 'candidate' });
  await seedWorkbench(f);
  const origin = await startCommandHost(t, f);
  const command = async (payload) => (await post(origin, payload)).json();
  const state = await command({ op: 'state' });
  assert.equal(state.ok, true);
  assert.deepEqual(state.order, ['page_01', 'page_02']);
  const initial = await command({ op: 'get', page_key: 'page_01' });
  const save = { op: 'save', operation_id: 'human_save', author: 'human', page_key: 'page_01', base_revision: initial.revision, edits: [
    { element_id: 'title', kind: 'text', value: 'Human' }, { element_id: 'box', kind: 'attributes', attributes: { x: 30 } },
  ], notes: 'Human notes' };
  const saved = await command(save);
  assert.equal(saved.ok, true);
  assert.deepEqual(await command(save), saved, 'retry must keep the backend receipt, not rewrite identity');
  const current = await command({ op: 'get', page_key: 'page_01' });
  assert.match(current.svg, />Human</);
  assert.equal(current.notes, 'Human notes');
  const conflict = await command({ ...save, operation_id: 'human_stale' });
  assert.equal(conflict.code, 'conflict');
  assert.equal(conflict.current_revision, saved.revision);
  assert.equal((await command({ ...save, operation_id: 'human_candidate', base_revision: saved.revision, candidate: 'candidate.svg' })).code, 'invalid_candidate');
  assert.equal((await command({ op: 'feedback', operation_id: 'human_feedback', scope: 'page', pages: { page_01: { revision: saved.revision, feedback: 'Simplify this page', rewrite_elements: ['title'] } } })).ok, true);
  assert.equal((await command({ op: 'snapshot', operation_id: 'human_snapshot', purpose: 'slides' })).ok, true);
  assert.equal((await command({ op: 'order', operation_id: 'human_order', base_order: state.order, order: ['page_02', 'page_01'] })).ok, true);
  const deleted = await command({ op: 'save', operation_id: 'human_delete', page_key: 'page_01', base_revision: saved.revision, author: 'human', edits: [{ element_id: 'box', kind: 'delete' }] });
  assert.equal(deleted.ok, true);
  assert.equal((await command({ op: 'restore', operation_id: 'human_restore', page_key: 'page_01', base_revision: deleted.revision, revision: initial.revision })).ok, true);
  assert.match((await command({ op: 'get', page_key: 'page_01' })).svg, />Original</);
});
