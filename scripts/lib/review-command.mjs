import { spawn } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const CORE_DIR = fileURLToPath(new URL('../../', import.meta.url));
const BACKEND = 'svg-workbench/1';
const PROCESSOR = ['planners-ppt-hell', 'scripts', 'workbench_store.py'];
const OPERATIONS = new Set(['get', 'state', 'save', 'feedback', 'snapshot', 'restore', 'order']);
const OVERRIDES = ['root', 'project_root', 'projectRoot', 'executable', 'script', 'processor', 'python', 'argv', 'cwd', 'command_backend'];
const INPUT_LIMIT = 1024 * 1024;
const OUTPUT_LIMIT = 4 * 1024 * 1024;
const TIMEOUT_MS = 20000;
const failure = (code, error) => ({ ok: false, code, error });

export function commandEnabled(data) {
  return data?.command_backend === BACKEND && Array.isArray(data.capabilities) && data.capabilities.includes('command');
}

// Only host-owned Skill locations are searched. Neither the surface nor the
// command may supply a processor path; runtime mounts may themselves be symlinks.
export async function resolveCommandProcessor() {
  const candidates = [
    join(dirname(CORE_DIR), ...PROCESSOR),
    join(dirname(dirname(CORE_DIR)), '03-design-delivery', ...PROCESSOR),
  ];
  let here = CORE_DIR;
  for (let depth = 0; depth < 6; depth += 1) {
    candidates.push(join(here, '02-skills-library', '03-design-delivery', ...PROCESSOR));
    const parent = dirname(here);
    if (parent === here) break;
    here = parent;
  }
  for (const runtime of ['.codex/skills', '.dsh/skills', '.claude/skills', '.agents/skills', '.gemini/config/skills']) {
    candidates.push(join(homedir(), runtime, ...PROCESSOR));
  }
  for (const candidate of new Set(candidates)) {
    if ((await stat(candidate).catch(() => null))?.isFile()) return realpath(candidate);
  }
  return null;
}

function invoke(python, args, input) {
  return new Promise((done) => {
    let settled = false;
    let bytes = 0;
    const chunks = [];
    const child = spawn(python, args, { shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    const finish = (value, kill = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (kill) child.kill('SIGKILL');
      done(value);
    };
    const timer = setTimeout(() => finish(failure('command_timeout', 'Command processor timed out'), true), TIMEOUT_MS);
    child.on('error', () => finish(failure('python_unavailable', 'Cannot start the configured Python interpreter')));
    child.stdin.on('error', () => { /* close/error supplies the result, including early exits */ });
    const collect = (chunk, stdout) => {
      bytes += chunk.length;
      if (bytes > OUTPUT_LIMIT) return finish(failure('command_output_limit', 'Command processor output is too large'), true);
      if (stdout) chunks.push(chunk);
    };
    child.stdout.on('data', (chunk) => collect(chunk, true));
    child.stderr.on('data', (chunk) => collect(chunk, false));
    child.on('close', (code) => {
      if (settled) return;
      let value;
      try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { return finish(failure('command_invalid_response', 'Command processor did not return JSON')); }
      if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.ok !== 'boolean'
          || (!value.ok && (typeof value.code !== 'string' || typeof value.error !== 'string'))) {
        return finish(failure('command_invalid_response', 'Command processor returned an invalid result envelope'));
      }
      if (code !== 0 && value.ok) return finish(failure('command_exit', 'Command processor exited unsuccessfully'));
      finish(value);
    });
    child.stdin.end(input);
  });
}

/** Browser-only transport. Models must use the backend CLI directly. */
export async function runBrowserCommand(surface, payload) {
  if (!commandEnabled(surface?.data)) return failure('command_not_enabled', 'Surface has no supported command capability/backend');
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return failure('command_shape', 'Command must be a JSON object');
  if (!OPERATIONS.has(payload.op)) return failure('command_operation', 'Browser command operation is not allowlisted');
  if (Object.hasOwn(payload, 'author') && payload.author !== 'human') return failure('browser_author', 'Browser commands cannot act as a model');
  if (OVERRIDES.some((key) => Object.hasOwn(payload, key))) return failure('command_override', 'Command cannot override host paths or execution settings');
  let input;
  try { input = JSON.stringify(payload); }
  catch { return failure('command_shape', 'Command must be JSON serializable'); }
  if (Buffer.byteLength(input) > INPUT_LIMIT) return failure('command_input_limit', 'Command is too large');

  // projectRoot is resolved from the loaded surface by the host, never the body.
  let root;
  try {
    if (!isAbsolute(surface.projectRoot) || !isAbsolute(surface.dir)) throw new Error();
    root = await realpath(surface.projectRoot);
    const dir = await realpath(surface.dir);
    if (!(await stat(root)).isDirectory() || !(await stat(dir)).isDirectory()
        || (dir !== root && !dir.startsWith(root + sep))) throw new Error();
  } catch { return failure('command_project_root', 'Surface project_root/dir must resolve to contained absolute directories'); }

  const processor = await resolveCommandProcessor();
  if (!processor) return failure('command_backend_missing', 'Cannot find planners-ppt-hell/scripts/workbench_store.py in trusted Skill locations');
  const python = process.env.PLANNERS_REVIEW_PYTHON || process.env.PYTHON || 'python3';
  return invoke(python, [processor, '--root', root, '--command-json', '--browser'], input);
}
