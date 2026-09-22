/**
 * A stub `cursor-agent -p` (r1-fixes 6.8): the transport, the project hooks and
 * a model following `cursorPinLine`, minus the model.
 *
 * It prints the stream-json lines the adapter reads — `system/init` with a
 * fresh chat id first, `result` with usage last — and in between fires the
 * commands `.cursor/hooks.json` holds, with Cursor's own payloads (the
 * 2026.09.15 fixtures) and the chat id as `session_id`, the way print mode
 * does: sessionStart, postToolUse, sessionEnd, and no stop (print mode fires
 * none). Then it takes the injected Session line's id when one arrived, the
 * assigned id otherwise, and writes the record with real `sofar event append`
 * calls. Cursor itself is the only fake; that print mode hands the hooks this
 * chat id is what 6.3's live S1c showed.
 *
 * Usage: node cursor-hooked-session.cjs <argv-dump>
 * Env: STUB_ROOT (repo root), STUB_OUT (dir for results), STUB_PAYLOADS (the
 * payload fixture file). STUB_HOOKS=none fires no hook, a project with no
 * sofar hooks Cursor runs. STUB_PARALLEL registers another cursor session
 * mid-launch.
 */
const { randomUUID } = require('node:crypto')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const [argvFile] = process.argv.slice(2)
const root = process.env.STUB_ROOT
const out = process.env.STUB_OUT
const hooksRun = process.env.STUB_HOOKS !== 'none'
const payloads = JSON.parse(fs.readFileSync(process.env.STUB_PAYLOADS, 'utf8'))
const hooks = JSON.parse(fs.readFileSync(path.join(root, '.cursor', 'hooks.json'), 'utf8')).hooks
const chat = randomUUID()

const emit = (line) => process.stdout.write(JSON.stringify(line) + '\n')

function fire(event, fixture, overrides) {
  if (!hooksRun) return null
  const body = {
    ...payloads[fixture].payload,
    conversation_id: chat,
    generation_id: chat,
    session_id: chat,
    workspace_roots: [root],
    ...overrides,
  }
  return spawnSync('sh', ['-c', hooks[event][0].command], {
    cwd: root,
    env: { ...process.env, CURSOR_PROJECT_DIR: root, CLAUDE_PROJECT_DIR: root },
    input: JSON.stringify(body),
    encoding: 'utf8',
  })
}

function sofar(...args) {
  const run = spawnSync('sofar', args, { cwd: root, encoding: 'utf8' })
  if (run.status !== 0) throw new Error(`sofar ${args.join(' ')}: ${run.stderr}`)
  return run.stdout
}

const prompt = fs.readFileSync(argvFile, 'utf8')
const slug = /serves the initiative `([^`]+)`/.exec(prompt)[1]
const assigned = /use the id the driver assigned: (\S+)/.exec(prompt)[1]
const taskId = /Task (\S+) —/.exec(prompt)[1]

emit({ type: 'system', subtype: 'init', apiKeySource: 'login', cwd: root, session_id: chat, model: 'Auto', permissionMode: 'default' })

const start = fire('sessionStart', 'session-start.print')
const session = /Session: ([^\s"\\]+)/.exec(start === null ? '' : start.stdout)
const id = session !== null ? session[1] : assigned
fs.appendFileSync(path.join(out, 'ids'), `${chat} ${id}\n`)

if (process.env.STUB_PARALLEL) {
  sofar('event', 'append', slug, '--session', process.env.STUB_PARALLEL, '--source', 'cursor', '--type', 'session_started', '--payload', '{"tool":"cursor"}')
}

const append = (type, payload) =>
  sofar('event', 'append', slug, '--session', id, '--source', 'cursor', '--type', type, '--payload', JSON.stringify(payload))

append('session_started', { tool: 'cursor' })
const file = path.join(root, `task-${taskId}.txt`)
fs.writeFileSync(file, `${taskId}\n`)
fire('postToolUse', 'post-tool-use.write', {
  tool_input: { file_path: file, content: `${taskId}\n` },
  tool_output: JSON.stringify({ file_path: file, success: true }),
})
append('task_status_changed', { id: taskId, status: 'done' })
append('session_ended', { summary: `did ${taskId}`, next_action: 'the next one' })
fire('sessionEnd', 'session-end.print')

emit({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: `did ${taskId}`,
  session_id: chat,
  usage: { inputTokens: 100, outputTokens: 5, cacheReadTokens: 20, cacheWriteTokens: 0 },
})
