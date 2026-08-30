/**
 * The record-writing half of the stub `codex` (session-driver 3.1): what a
 * DRIVEN codex session does, minus the model.
 *
 * It reads its own session id and task id out of the prompt it was handed —
 * exactly as `codexPinLine` instructs a real one to — and writes the record in
 * the CLI dialect's envelope, because codex carries no sofar MCP server. Plain
 * CommonJS with no imports, so the stub needs no build and no engine code:
 * anything it borrowed from the engine would be the engine grading its own
 * homework.
 *
 * Usage: node codex-driven-session.cjs <events.jsonl> <argv-dump> [block-note]
 * With a block note it marks the task `blocked` instead of `done` — the
 * needs_user lever, driven from the agent's side.
 */
const fs = require('node:fs')

const [log, argvFile, blockNote] = process.argv.slice(2)
const prompt = fs.readFileSync(argvFile, 'utf8')
const sessionId = /Your session id is (\S+)/.exec(prompt)[1]
const taskId = /Task (\S+) —/.exec(prompt)[1]

const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
let seq = 0
function ulid() {
  let t = Date.now()
  let head = ''
  for (let i = 0; i < 10; i += 1) {
    head = B32[t % 32] + head
    t = Math.floor(t / 32)
  }
  seq += 1
  return head + String(seq).padStart(16, '0')
}

function append(type, payload) {
  fs.appendFileSync(
    log,
    JSON.stringify({
      v: 1,
      id: ulid(),
      ts: new Date().toISOString(),
      initiative: 'demo',
      session: sessionId,
      source: 'codex',
      actor: 'agent',
      type,
      payload,
    }) + '\n',
  )
}

append('session_started', { tool: 'codex' })
if (blockNote) {
  append("task_status_changed", { id: taskId, status: "blocked", note: blockNote })
  append('session_ended', { summary: 'stopped on ' + taskId, next_action: blockNote })
} else {
  append("task_status_changed", { id: taskId, status: "done" })
  append('session_ended', { summary: 'did ' + taskId, next_action: 'the next one' })
}
