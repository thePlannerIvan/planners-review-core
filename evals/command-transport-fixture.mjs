import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCommandProcessor } from '../scripts/lib/review-command.mjs';

const SOURCE = fileURLToPath(new URL('../', import.meta.url));

// Isolated trusted Skill layout: no test writes to the candidate PPT backend.
export async function commandFixture(t, { backend = 'stub' } = {}) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'review-command-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const core = join(base, '00-system', 'planners-review-core');
  await cp(SOURCE, core, { recursive: true });
  const processor = join(base, '03-design-delivery', 'planners-ppt-hell', 'scripts', 'workbench_store.py');
  await mkdir(dirname(processor), { recursive: true });
  await writeFile(processor, `import json, sys
from pathlib import Path
args = sys.argv[1:]
payload = json.load(sys.stdin)
with Path(__file__).with_suffix('.jsonl').open('a') as log:
    log.write(json.dumps({'args': args, 'payload': payload}) + '\\n')
mode = payload.get('fixture_mode')
if mode == 'invalid':
    print('not json')
elif mode == 'bad-envelope':
    print(json.dumps({'ok': False}))
elif mode == 'crash':
    sys.exit(3)
elif mode == 'false-success':
    print(json.dumps({'ok': True}))
    sys.exit(3)
elif mode == 'overflow':
    print('x' * (5 * 1024 * 1024))
elif mode == 'timeout':
    import time
    time.sleep(25)
elif mode == 'conflict':
    print(json.dumps({'ok': False, 'code': 'conflict', 'error': 'Changed', 'current_revision': 'r_new', 'operation_id': payload.get('operation_id')}))
    sys.exit(1)
else:
    print(json.dumps({'ok': True, 'args': args, 'payload': payload}))
`);
  if (backend === 'candidate') {
    const latest = await resolveCommandProcessor();
    if (!latest) throw new Error('Candidate workbench_store.py is required for the integration test');
    await cp(latest, processor);
  }
  const project = join(base, 'project with spaces');
  const dir = join(project, 'review');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'index.html'), '<!doctype html>\n{{REVIEW_BRIDGE}}\n');
  const surface = join(dir, 'surface.json');
  const data = {
    contract_version: 'review-surface/2.0.0', id: 'fixture/command', title: 'Fixture',
    project_root: '..', dir: '.', entry: 'index.html', wake: { mode: 'steer', text: '{unit}' },
    capabilities: ['command', 'future'], command_backend: 'svg-workbench/1',
  };
  const setSurface = async (change = {}) => writeFile(surface, JSON.stringify({ ...data, ...change }));
  await setSurface();
  const calls = async () => (await readFile(processor.replace(/\.py$/, '.jsonl'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(JSON.parse);
  return { base, core, processor, project, dir, surface, data, setSurface, calls };
}

export async function seedWorkbench(f) {
  await mkdir(join(f.project, '_internal/01_content'), { recursive: true });
  await writeFile(join(f.project, '_internal/01_content/page_content.json'), JSON.stringify({ pages: [{ page_key: 'page_01' }, { page_key: 'page_02' }] }));
  await mkdir(join(f.project, '_internal/02_svg_source'), { recursive: true });
  for (const key of ['page_01', 'page_02']) {
    await writeFile(join(f.project, '_internal/02_svg_source', key + '.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><text id="title">Original</text><rect id="box" width="20" height="10"/></svg>');
  }
}

export async function startCommandHost(t, fixture) {
  const child = spawn(process.execPath, [join(fixture.core, 'scripts', 'serve-review.mjs'), fixture.surface, '--no-open'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  t.after(async () => { child.kill('SIGTERM'); await exited; });
  let stdout = '';
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  return new Promise((done, fail) => {
    const timer = setTimeout(() => fail(new Error(`Host startup timed out: ${stderr}`)), 10000);
    child.on('error', (error) => { clearTimeout(timer); fail(error); });
    child.on('exit', (code) => { clearTimeout(timer); fail(new Error(`Host exited ${code}: ${stdout} ${stderr}`)); });
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      const match = /"url":\s*"([^"]+)"/.exec(stdout);
      if (match) { clearTimeout(timer); done(new URL(match[1]).origin); }
    });
  });
}
