# Command Transport

Use `review.command(payload)` when a surface needs a durable command receipt
from an allowlisted backend instead of overwriting a feedback file. The same
bridge method works in the DSH sidebar and the local review server. Core owns
transport only; revisions, edits, feedback authorization, ordering, snapshots
and restore semantics belong to the backend.

## Surface Declaration

Add these optional fields to an otherwise valid `review-surface/2.0.0`:

```json
{
  "command_backend": "svg-workbench/1",
  "capabilities": ["command"]
}
```

Both hosts advertise the capability intersection. A missing or unsupported
backend identifier does not enable command. The validator rejects unknown
backend identifiers. DSH also requires a Core bridge and shared runner that
both provide command; older installations do not advertise it.

The backend executable is fixed:
`planners-ppt-hell/scripts/workbench_store.py`. The runner searches trusted
runtime sibling mounts, the candidate/monorepo `03-design-delivery` layout,
then conventional Skill runtime locations. It never resolves an executable
relative to the surface/project or accepts one in the request.

Python selection is host-owned: `PLANNERS_REVIEW_PYTHON`, then `PYTHON`, then
`python3` on PATH. Each configured value is one executable, not shell syntax
or a command with flags. Invocation uses no shell:

```text
<python> <fixed workbench_store.py> --root <canonical surface.project_root> --command-json --browser
```

The command JSON goes to stdin unchanged. Root is resolved from the loaded
surface file, made absolute/canonical and checked to contain `surface.dir`.
Command-level path/executable/root overrides are rejected.

## Browser Calls

```js
const review = await ReviewBridge.connect();
if (!review.capabilities.includes('command')) throw new Error('Command unavailable');
const receipt = await review.command({
  op: 'save',
  operation_id: 'human_save_001',
  page_key: 'page_01',
  base_revision: currentRevision,
  author: 'human',
  edits: [{ element_id: 'title', kind: 'text', value: 'Updated title' }],
  notes: 'Updated speaker notes'
});
if (!receipt.ok) {
  // Conflict details remain available; refresh/reconcile in the surface UI.
  console.error(receipt.code, receipt.error, receipt.current_revision);
}
```

Browser operations are `get`, `state`, `save`, `feedback`, `snapshot`, `restore`
and `order`. Browser `author: model`, `checkout`, `resolve` and nonallowlisted
operations are rejected. The backend enforces human patch-only saves and rejects
model candidate SVG submission. Feedback rewrite authorization is a human
backend operation, not an identity rewrite performed by transport.

The sidebar surface supplies per-page feedback controls. Transport adds no
whole-deck sidebar control and does not invent or restrict domain feedback scope.
`command` does not automatically call `write` or `wake`; the surface decides
whether to wake after a successful durable feedback receipt.

Backend `{ok:true,...}` and `{ok:false,code,error,...}` envelopes are returned
unchanged, including expected `ok:false` with CLI exit code 1. Domain rejection
is HTTP 200 / a successful postMessage result carrying `ok:false`, not a rejected
Promise that discards conflict fields. Invalid HTTP requests and bridge failures
still reject the call. A missing capability returns `command_not_enabled`.

Use the same `operation_id` and identical payload when retrying an uncertain
write. Transport never generates or rewrites that identity and never retries
automatically. Requests are limited to 1 MiB, processor output to 4 MiB, and
processing to 20 seconds (below the bridge's 30-second deadline). On timeout,
retry with the original operation ID: the backend may already have committed.

## Host Integration

Local host: run `scripts/serve-review.mjs <surface> --no-open`
or its lifecycle CLI. The endpoint is `POST /__review/command` with the command
itself as its JSON body. It accepts only the bound `127.0.0.1:<port>` Host and,
when present, exactly that HTTP Origin. Null, empty and cross-origin Origin,
cross-site fetch metadata, bad Host and non-JSON content types are refused.
Missing Origin remains available to native clients; this is not model identity
authentication.

DSH: use a command-capable Review Dock plugin and the same current Core for
its bridge and runner. For isolated testing, `reviewCoreDir` or
`DSH_REVIEW_CORE_DIR` pins Core's absolute directory; an explicit pin takes
precedence over runtime copy timestamps. Reload plugin activation after
updating its implementation or pin. `POST /api/review.command`
receives `{surface: <absolute surface file>, payload: <command>}` from the
authenticated parent; Connection's browser-trust/session fence remains in force.
The plugin resolves and imports `scripts/lib/review-command.mjs` from the same
Core that supplies its bridge. It has no second command runner implementation.

Use isolated imports and host tests before updating the installed plugin.

## Model Calls

Models use the fixed Store CLI directly, with JSON stdin and without `--browser`:

```text
<python> <planners-ppt-hell>/scripts/workbench_store.py --root <absolute project> --command-json
```

There is no DSH model command tool and no browser switch for becoming a model.
The backend owns model candidates, checkout, task resolution and protected-edit
rules. No model is required for a human command/save receipt.

## Verification

Run in the Core directory:

```bash
node --test evals/test_command_transport.mjs
node evals/run.mjs
node --test evals/test_review_host.mjs
python3 -m unittest discover -s evals -p 'test_*.py'
```

Run `npm test` in the candidate plugin directory. The fixture creates isolated
trusted Skill layouts and temporary project files. Integration cases copy the
latest candidate Store CLI at test time; no candidate PPT/backend files are
edited. Local suites need loopback-listen permission. Plugin tests exercise the
exported HTTP helper boundary and route registration, not a live DSH profile.
