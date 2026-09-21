/**
 * A stub `codex` whose project hooks RUN (agents-parity 3.1): it plays Codex
 * firing the commands `.codex/hooks.json` holds, with payloads from the
 * 0.154.0 fixtures (D4) and its thread id as `session_id`, and then plays the
 * model following `codexPinLine` — the injected Session line's id when one
 * arrived, the assigned id otherwise, and the CLI dialect either way.
 *
 * The hooks are sofar's real shims through the built CLI, and the model's
 * writes are real `sofar event append` calls. What is stubbed is Codex itself:
 * that it hands its hooks this env and this thread id is what 3.2 checks live.
 *
 * Usage: node codex-hooked-session.cjs <mode> <argv-dump>
 *   mode `session` — SessionStart, register, an apply_patch edit, Stop before
 *     and after the write-back. STUB_HOOKS=untrusted runs no hook at all.
 *     STUB_PARALLEL registers another codex session in the record mid-launch.
 *   mode `nudge` — wait for the driver's nudge file, then fire PostToolUse.
 * Env: STUB_ROOT (repo root), STUB_OUT (dir for results), STUB_THREAD,
 * STUB_PAYLOADS (the payload fixture file).
 */
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const [mode, argvFile] = process.argv.slice(2)
const root = process.env.STUB_ROOT
const out = process.env.STUB_OUT
const thread = process.env.STUB_THREAD
const hooksRun = process.env.STUB_HOOKS !== 'untrusted'
const payloads = JSON.parse(fs.readFileSync(process.env.STUB_PAYLOADS, 'utf8'))
const hooks = JSON.parse(fs.readFileSync(path.join(root, '.codex', 'hooks.json'), 'utf8')).hooks

function fire(event, fixture, overrides) {
  if (!hooksRun) return null
  const body = { ...payloads[fixture].payload, session_id: thread, cwd: root, ...overrides }
  return spawnSync('sh', ['-c', hooks[event][0].hooks[0].command], {
    cwd: root,
    input: JSON.stringify(body),
    encoding: 'utf8',
  })
}

function sofar(...args) {
  const run = spawnSync('sofar', args, { cwd: root, encoding: 'utf8' })
  if (run.status !== 0) throw new Error(`sofar ${args.join(' ')}: ${run.stderr}`)
  return run.stdout
}

if (mode === 'nudge') {
  const nudge = process.env.SOFAR_DRIVE_NUDGE
  const tick = new Int32Array(new SharedArrayBuffer(4))
  for (let i = 0; i < 200 && !(nudge && fs.existsSync(nudge)); i += 1) Atomics.wait(tick, 0, 0, 25)
  const post = fire('PostToolUse', 'post-tool-use.bash')
  fs.writeFileSync(path.join(out, 'post-tool'), post.stdout)
  process.exit(0)
}

const prompt = fs.readFileSync(argvFile, 'utf8')
const slug = /serves the initiative `([^`]+)`/.exec(prompt)[1]
const assigned = /use the id the driver assigned: (\S+)/.exec(prompt)[1]
const taskId = /Task (\S+) —/.exec(prompt)[1]

const start = fire('SessionStart', 'session-start.startup')
const session = /Session: ([^\s"\\]+)/.exec(start === null ? '' : start.stdout)
const id = session !== null ? session[1] : assigned
fs.writeFileSync(path.join(out, 'id'), id)

if (process.env.STUB_PARALLEL) {
  sofar('event', 'append', slug, '--session', process.env.STUB_PARALLEL, '--source', 'codex', '--type', 'session_started', '--payload', '{"tool":"codex"}')
}

const append = (type, payload) =>
  sofar('event', 'append', slug, '--session', id, '--source', 'codex', '--type', type, '--payload', JSON.stringify(payload))

append('session_started', { tool: 'codex' })
fire('PostToolUse', 'post-tool-use.apply-patch')
const held = fire('Stop', 'stop.first')
append('task_status_changed', { id: taskId, status: 'done' })
append('session_ended', { summary: `did ${taskId}`, next_action: 'the next one' })
// A new turn, so only the write-back can release it — never stop_hook_active.
const released = fire('Stop', 'stop.first', { turn_id: 'turn-after-write-back' })
fs.writeFileSync(
  path.join(out, 'stop'),
  JSON.stringify({ held: held === null ? null : held.status, released: released === null ? null : released.status }),
)
