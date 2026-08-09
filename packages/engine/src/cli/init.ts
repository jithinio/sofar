import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { mcpRegistration } from '../mcp/register'
import { detectTailwindV4, SOURCE_NOT_SINCE } from './scanners'
import { fail, ok, REPO_MD_STUB, type CmdResult } from './shared'
import { type Caps, createStyle, stderrCaps, stdoutCaps, symbolsFor } from './ui'
import sessionStartShim from '../hooks/session-start.sh'
import userPromptSubmitShim from '../hooks/user-prompt-submit.sh'
import postToolUseShim from '../hooks/post-tool-use.sh'
import stopShim from '../hooks/stop.sh'
import sessionEndShim from '../hooks/session-end.sh'

/**
 * `sofar init` (task 4.1, SPEC §CLI) — make a repo sofar-ready:
 *   .sofar/ (repo.md stub + bindings.json), hook shims in .claude/hooks/,
 *   .claude/settings.json hooks block, .mcp.json registration, and the
 *   total-jurisdiction protocol blocks (BD19) in CLAUDE.md (MCP loop) and
 *   AGENTS.md (CLI convention dialect for MCP-less tools — task 5.1, BD31).
 *
 * Idempotency is BYTE-LEVEL: a file is written only when its target content
 * differs, so a second run changes nothing (SPEC §Acceptance criteria, Phase 4).
 * Hand-written files are sacred: repo.md is never overwritten; CLAUDE.md
 * outside (and inside) the markers is never touched once the block exists;
 * settings.json/.mcp.json are merged, never clobbered — unparseable JSON in
 * either aborts with exit 1 rather than risking user config.
 *
 * Shim TEXT ships inside the bundle (esbuild `loader: {'.sh': 'text'}`) —
 * only dist/ is published, so init never reads src/hooks/ at runtime.
 */

export const PROTOCOL_START = '<!-- sofar:protocol -->'
export const PROTOCOL_END = '<!-- /sofar:protocol -->'

/**
 * Every CLAUDE.md protocol block sofar has ever SHIPPED, current one excluded
 * (speed-2 T6).
 *
 * The block is sofar's only lever on agent behaviour, and init used to never
 * touch it once installed — so no protocol change could reach a repo that had
 * already run init, and the product could not evolve its own core mechanism in
 * the field. Refreshing blindly is the opposite failure: a block the user has
 * edited is theirs, and this very repo's carries a local ORDER MATTERS clause.
 *
 * A byte-match against this ledger proves a previous sofar wrote the block and
 * nobody has touched it since, which is exactly when replacing it is safe.
 * Anything else is customized and is reported, never rewritten.
 *
 * APPEND, never edit: every entry must stay byte-exact forever, or the repos
 * still carrying it stop matching and silently fall back to "customized". When
 * changing PROTOCOL_BLOCK, move the OLD text here first.
 */
export const PROTOCOL_BLOCK_V1 = `${PROTOCOL_START}
## Sofar protocol (jurisdiction is total)

This repo's work memory lives in sofar records under \`.sofar/\`.
1. ALL work state lives in sofar records — never in tool memory, scratch
   files, or ad-hoc notes. If it is worth keeping, it goes in the record.
2. Work that matches no existing initiative requires creating one first:
   run \`sofar new <slug>\` before proceeding.
3. Bindings (\`.sofar/bindings.json\`) resolve which record a session
   serves — the current git branch selects the initiative.

Session loop:
- START: orient from the record — call \`sofar_get_state\` (MCP) or run
  \`sofar status\`. Do not ask for context the record already answers.
  Then call \`sofar_start_session\` passing the \`session_id\` from the
  injected context line ("Session: <id> — …") so your events attach to
  YOUR session — never omit it when that line is present (omitting mints
  a separate session id and orphans the hook-registered one).
- DURING: log decisions (\`sofar_log_decision\`) and task status changes
  (\`sofar_update_task\`) as they happen.
- BEFORE FINISHING: write back with \`sofar_end_session\` (summary +
  next action). The Stop hook blocks sessions that skip this.
${PROTOCOL_END}
`

/**
 * Superseded by the repo-memory-capture D1 refresh, which added the
 * `sofar_remember` clause to DURING. Kept byte-exact — see the ledger note.
 */
export const PROTOCOL_BLOCK_V2 = `${PROTOCOL_START}
## Sofar protocol (jurisdiction is total)

This repo's work memory lives in sofar records under \`.sofar/\`.
1. ALL work state lives in sofar records — never in tool memory, scratch
   files, or ad-hoc notes. If it is worth keeping, it goes in the record.
2. Work that matches no existing initiative requires creating one first:
   run \`sofar new <slug>\` before proceeding.
3. Bindings (\`.sofar/bindings.json\`) resolve which record a session
   serves — the current git branch selects the initiative.

Session loop:
- START: the SessionStart hook has ALREADY injected the record above —
  goal, progress, next action, decisions, rejected approaches. Do not
  call \`sofar_get_state\` to re-read it: that digest is the same
  projection rendered with fewer fields, so it can only tell you less.
  Reach for it only when the injected block is missing or truncated, or
  to read a DIFFERENT initiative.
  Do still call \`sofar_start_session\`, passing the \`session_id\` from the
  injected context line ("Session: <id> — …"). It is not bookkeeping: it
  pins which record your writes land in — without it they follow the
  branch binding, which moves mid-session — and attaches them to YOUR
  session rather than minting a separate id that orphans the
  hook-registered one.
- DURING: log decisions (\`sofar_log_decision\`) and task status changes
  (\`sofar_update_task\`) as they happen.
- BEFORE FINISHING: write back with \`sofar_end_session\` (summary +
  next action). The Stop hook blocks sessions that skip this.
${PROTOCOL_END}
`

/**
 * Superseded by peer-messaging 3.1, which named a message from another
 * session as a channel work state can arrive through. Kept byte-exact — see
 * the ledger note.
 */
export const PROTOCOL_BLOCK_V3 = `${PROTOCOL_START}
## Sofar protocol (jurisdiction is total)

This repo's work memory lives in sofar records under \`.sofar/\`.
1. ALL work state lives in sofar records — never in tool memory, scratch
   files, or ad-hoc notes. If it is worth keeping, it goes in the record.
2. Work that matches no existing initiative requires creating one first:
   run \`sofar new <slug>\` before proceeding.
3. Bindings (\`.sofar/bindings.json\`) resolve which record a session
   serves — the current git branch selects the initiative.

Session loop:
- START: the SessionStart hook has ALREADY injected the record above —
  goal, progress, next action, decisions, rejected approaches. Do not
  call \`sofar_get_state\` to re-read it: that digest is the same
  projection rendered with fewer fields, so it can only tell you less.
  Reach for it only when the injected block is missing or truncated, or
  to read a DIFFERENT initiative.
  Do still call \`sofar_start_session\`, passing the \`session_id\` from the
  injected context line ("Session: <id> — …"). It is not bookkeeping: it
  pins which record your writes land in — without it they follow the
  branch binding, which moves mid-session — and attaches them to YOUR
  session rather than minting a separate id that orphans the
  hook-registered one.
- DURING: log decisions (\`sofar_log_decision\`) and task status changes
  (\`sofar_update_task\`) as they happen. An operational fact you learn is
  NOT a decision — a release command, a failure mode and how it is
  diagnosed, a convention every later session needs. Promote it with
  \`sofar_remember\` the moment you learn it, or it lives only in your own
  context and dies with the session.
- BEFORE FINISHING: write back with \`sofar_end_session\` (summary +
  next action). The Stop hook blocks sessions that skip this.
${PROTOCOL_END}
`

/**
 * The BD19 total-jurisdiction protocol block. Clauses (a)–(c) are contract
 * (SPEC §CLI): record-only state, \`sofar new\` before unmatched work,
 * bindings resolve the record — plus the read-orient/write-back loop.
 *
 * Clause 1 names messages from other sessions (peer-messaging 3.1). Claude
 * Code sessions can message each other, and such a message is text between
 * two live sessions — "never conversation history or files" — that collapses
 * to a one-line row and dies with the session that heard it. Transport, never
 * storage: a finding that arrives that way is work state entering through a
 * channel the record cannot see, which is the first genuine hole in total
 * jurisdiction. Naming the channel is the whole fix, because the clause's
 * existing instruction already says what to do about it.
 */
export const PROTOCOL_BLOCK = `${PROTOCOL_START}
## Sofar protocol (jurisdiction is total)

This repo's work memory lives in sofar records under \`.sofar/\`.
1. ALL work state lives in sofar records — never in tool memory, scratch
   files, ad-hoc notes, or a message from another session. If it is worth
   keeping, it goes in the record.
2. Work that matches no existing initiative requires creating one first:
   run \`sofar new <slug>\` before proceeding.
3. Bindings (\`.sofar/bindings.json\`) resolve which record a session
   serves — the current git branch selects the initiative.

Session loop:
- START: the SessionStart hook has ALREADY injected the record above —
  goal, progress, next action, decisions, rejected approaches. Do not
  call \`sofar_get_state\` to re-read it: that digest is the same
  projection rendered with fewer fields, so it can only tell you less.
  Reach for it only when the injected block is missing or truncated, or
  to read a DIFFERENT initiative.
  Do still call \`sofar_start_session\`, passing the \`session_id\` from the
  injected context line ("Session: <id> — …"). It is not bookkeeping: it
  pins which record your writes land in — without it they follow the
  branch binding, which moves mid-session — and attaches them to YOUR
  session rather than minting a separate id that orphans the
  hook-registered one.
- DURING: log decisions (\`sofar_log_decision\`) and task status changes
  (\`sofar_update_task\`) as they happen. An operational fact you learn is
  NOT a decision — a release command, a failure mode and how it is
  diagnosed, a convention every later session needs. Promote it with
  \`sofar_remember\` the moment you learn it, or it lives only in your own
  context and dies with the session.
- BEFORE FINISHING: write back with \`sofar_end_session\` (summary +
  next action). The Stop hook blocks sessions that skip this.
${PROTOCOL_END}
`

/** Superseded CLAUDE.md blocks, oldest first. */
export const SHIPPED_PROTOCOL_BLOCKS: readonly string[] = [
  PROTOCOL_BLOCK_V1,
  PROTOCOL_BLOCK_V2,
  PROTOCOL_BLOCK_V3,
]

/**
 * The AGENTS.md convention dialect (task 5.1, BD31) — the same three BD19
 * total-jurisdiction clauses, but a CLI-only loop: AGENTS.md readers
 * (OpenCode, Codex, plain shells) cannot be assumed to have MCP, so every
 * step goes through \`sofar status\` / \`sofar event append\`. No hook
 * enforces write-back for these tools, hence the MANDATORY clause (the
 * compensating control — see docs/opencode-adapter.md).
 */
export const AGENTS_PROTOCOL_BLOCK_V1 = `${PROTOCOL_START}
## Sofar protocol (jurisdiction is total)

This repo's work memory lives in sofar records under \`.sofar/\`. Drive
the whole loop with the \`sofar\` CLI — no MCP support is required.
1. ALL work state lives in sofar records — never in tool memory, scratch
   files, or ad-hoc notes. If it is worth keeping, it goes in the record.
2. Work that matches no existing initiative requires creating one first:
   run \`sofar new <slug>\` before proceeding.
3. Bindings (\`.sofar/bindings.json\`) resolve which record a session
   serves — the current git branch selects the initiative.

Session loop (every write is one \`sofar event append\` call):
- BEFORE any work: run \`sofar status\` and orient from it. Detail lives
  in \`.sofar/initiatives/<slug>/plan.md\` and \`decisions.md\`. Do not
  ask for context the record already answers.
- START: pick one unique session id, reuse it for every append this
  session, and register it:
  \`sofar event append --type session_started --session <session-id> --source opencode --payload '{"tool":"opencode"}'\`
  (put your tool's name in --source and the payload).
- DURING: log work as it happens with \`sofar event append --session <session-id> --source <tool>\` plus:
  task status:  \`--type task_status_changed --payload '{"id":"<task-id>","status":"pending|active|done|blocked"}'\`
  decisions:    \`--type decision_logged --payload '{"chose":"...","over":"...","because":"..."}'\`
  notes:        \`--type note_added --payload '{"text":"..."}'\`
- BEFORE FINISHING (MANDATORY): write back —
  \`sofar event append --type session_ended --session <session-id> --source <tool> --payload '{"summary":"<what happened>","next_action":"<single next step>"}'\`
  A session that skips this abandons its state and the next session starts blind.

Prohibitions:
- Never hand-edit generated projections (plan.md, decisions.md,
  sessions/*) — they are rebuilt from events.jsonl on every append.
- Never edit events.jsonl directly — truth is append-only, via the CLI.
- Corrections are new \`correction\` events referencing the bad event's id
  (then append the corrected event fresh); history is never rewritten.
${PROTOCOL_END}
`

/**
 * Superseded by peer-messaging 3.1, in lockstep with PROTOCOL_BLOCK_V3 — the
 * two dialects carry the SAME three clauses and must not drift. Kept
 * byte-exact — see the ledger note.
 */
export const AGENTS_PROTOCOL_BLOCK_V2 = `${PROTOCOL_START}
## Sofar protocol (jurisdiction is total)

This repo's work memory lives in sofar records under \`.sofar/\`. Drive
the whole loop with the \`sofar\` CLI — no MCP support is required.
1. ALL work state lives in sofar records — never in tool memory, scratch
   files, or ad-hoc notes. If it is worth keeping, it goes in the record.
2. Work that matches no existing initiative requires creating one first:
   run \`sofar new <slug>\` before proceeding.
3. Bindings (\`.sofar/bindings.json\`) resolve which record a session
   serves — the current git branch selects the initiative.

Session loop (every write is one \`sofar event append\` call):
- BEFORE any work: run \`sofar status\` and orient from it. Detail lives
  in \`.sofar/initiatives/<slug>/plan.md\` and \`decisions.md\`. Do not
  ask for context the record already answers.
- START: pick one unique session id, reuse it for every append this
  session, and register it:
  \`sofar event append --type session_started --session <session-id> --source opencode --payload '{"tool":"opencode"}'\`
  (put your tool's name in --source and the payload).
- DURING: log work as it happens with \`sofar event append --session <session-id> --source <tool>\` plus:
  task status:  \`--type task_status_changed --payload '{"id":"<task-id>","status":"pending|active|done|blocked"}'\`
  decisions:    \`--type decision_logged --payload '{"chose":"...","over":"...","because":"..."}'\`
  notes:        \`--type note_added --payload '{"text":"..."}'\`
- DURING, for operational facts: a release command, a failure mode and how
  it is diagnosed, a convention every later session needs is NOT a decision.
  Promote it the moment you learn it with \`sofar remember "<fact>"\`, or it
  lives only in your own context and dies with the session.
- BEFORE FINISHING (MANDATORY): write back —
  \`sofar event append --type session_ended --session <session-id> --source <tool> --payload '{"summary":"<what happened>","next_action":"<single next step>"}'\`
  A session that skips this abandons its state and the next session starts blind.

Prohibitions:
- Never hand-edit generated projections (plan.md, decisions.md,
  sessions/*) — they are rebuilt from events.jsonl on every append.
- Never edit events.jsonl directly — truth is append-only, via the CLI.
- Corrections are new \`correction\` events referencing the bad event's id
  (then append the corrected event fresh); history is never rewritten.
${PROTOCOL_END}
`

/**
 * The AGENTS.md convention dialect (task 5.1, BD31) — the same three BD19
 * total-jurisdiction clauses, but a CLI-only loop: AGENTS.md readers
 * (OpenCode, Codex, plain shells) cannot be assumed to have MCP, so every
 * step goes through \`sofar status\` / \`sofar event append\`. No hook
 * enforces write-back for these tools, hence the MANDATORY clause (the
 * compensating control — see docs/opencode-adapter.md).
 *
 * Clause 1 names messages in lockstep with PROTOCOL_BLOCK (peer-messaging
 * 3.1). The wording is deliberately tool-agnostic: an OpenCode or Codex
 * session cannot receive a Claude Code peer message, but the hazard the
 * clause guards against is any finding that arrives as transient text between
 * sessions, and the two dialects stating the same three clauses differently
 * would be worse than either statement alone.
 */
export const AGENTS_PROTOCOL_BLOCK = `${PROTOCOL_START}
## Sofar protocol (jurisdiction is total)

This repo's work memory lives in sofar records under \`.sofar/\`. Drive
the whole loop with the \`sofar\` CLI — no MCP support is required.
1. ALL work state lives in sofar records — never in tool memory, scratch
   files, ad-hoc notes, or a message from another session. If it is worth
   keeping, it goes in the record.
2. Work that matches no existing initiative requires creating one first:
   run \`sofar new <slug>\` before proceeding.
3. Bindings (\`.sofar/bindings.json\`) resolve which record a session
   serves — the current git branch selects the initiative.

Session loop (every write is one \`sofar event append\` call):
- BEFORE any work: run \`sofar status\` and orient from it. Detail lives
  in \`.sofar/initiatives/<slug>/plan.md\` and \`decisions.md\`. Do not
  ask for context the record already answers.
- START: pick one unique session id, reuse it for every append this
  session, and register it:
  \`sofar event append --type session_started --session <session-id> --source opencode --payload '{"tool":"opencode"}'\`
  (put your tool's name in --source and the payload).
- DURING: log work as it happens with \`sofar event append --session <session-id> --source <tool>\` plus:
  task status:  \`--type task_status_changed --payload '{"id":"<task-id>","status":"pending|active|done|blocked"}'\`
  decisions:    \`--type decision_logged --payload '{"chose":"...","over":"...","because":"..."}'\`
  notes:        \`--type note_added --payload '{"text":"..."}'\`
- DURING, for operational facts: a release command, a failure mode and how
  it is diagnosed, a convention every later session needs is NOT a decision.
  Promote it the moment you learn it with \`sofar remember "<fact>"\`, or it
  lives only in your own context and dies with the session.
- BEFORE FINISHING (MANDATORY): write back —
  \`sofar event append --type session_ended --session <session-id> --source <tool> --payload '{"summary":"<what happened>","next_action":"<single next step>"}'\`
  A session that skips this abandons its state and the next session starts blind.

Prohibitions:
- Never hand-edit generated projections (plan.md, decisions.md,
  sessions/*) — they are rebuilt from events.jsonl on every append.
- Never edit events.jsonl directly — truth is append-only, via the CLI.
- Corrections are new \`correction\` events referencing the bad event's id
  (then append the corrected event fresh); history is never rewritten.
${PROTOCOL_END}
`

/** Superseded AGENTS.md blocks, oldest first. */
export const SHIPPED_AGENTS_PROTOCOL_BLOCKS: readonly string[] = [
  AGENTS_PROTOCOL_BLOCK_V1,
  AGENTS_PROTOCOL_BLOCK_V2,
]

// REPO_MD_STUB moved to ./shared (ui-free) so event.ts can import it without
// transitively reaching cli/ui through this module; re-exported here for the
// existing importers (init is where the stub is written to disk).
export { REPO_MD_STUB } from './shared'

/**
 * Union-merge attribute for committed event logs (team-readiness T2):
 * two branches appending to the same events.jsonl must merge without
 * conflicts. git's union driver keeps both sides' lines — safe here and
 * ONLY here because the log is append-only and the fold replays in ulid
 * id order (D-sync-1), so line order carries no meaning.
 */
export const GITATTRIBUTES_LINE = '.sofar/**/events.jsonl merge=union'

const HOOK_COMMAND_PREFIX = '$CLAUDE_PROJECT_DIR/.claude/hooks/'

/**
 * Seconds between statusline re-renders. Claude Code re-runs a statusLine
 * command only on session start, a new assistant message, compact, and mode
 * toggles, so an idle session shows a frozen line — the staleness is the
 * host's render cadence, not a stale fold (`sofar statusline` folds in
 * ~40 ms). `refreshInterval` is the host's own remedy, so the installed
 * entry ships it instead of leaving every user to discover the gap.
 */
export const STATUSLINE_REFRESH_SECONDS = 10

/**
 * The settings.json statusLine entry `--statusline` installs (D4 informed
 * re-test, init-statusline D1). Merged ONLY when the key is absent — an
 * existing statusLine, whatever its value, is the user's and wins.
 */
export const STATUSLINE_SETTINGS_ENTRY = {
  type: 'command',
  command: 'sofar statusline',
  refreshInterval: STATUSLINE_REFRESH_SECONDS,
} as const

/**
 * Keys that may appear on our entry without it ceasing to be ours. Identity
 * is type + command, NOT byte equality: `refreshInterval` is render cadence
 * the user is meant to tune, and an entry installed before it shipped has
 * only two keys. Neither may make `--uninstall` call our own line foreign
 * and refuse to remove it.
 */
const STATUSLINE_OWN_KEYS = new Set(['type', 'command', 'refreshInterval'])

/** Is this settings.statusLine value the one --statusline installs? */
export function isSofarStatusline(v: unknown): boolean {
  return (
    isObj(v) &&
    v.type === STATUSLINE_SETTINGS_ENTRY.type &&
    v.command === STATUSLINE_SETTINGS_ENTRY.command &&
    Object.keys(v).every((k) => STATUSLINE_OWN_KEYS.has(k))
  )
}

export interface InitOptions {
  /** Wire `sofar statusline` as the project statusLine (merged only when absent). */
  statusline?: boolean
  /**
   * Home directory override for the personal-settings check behind the
   * statusline hint. Tests only — production always reads os.homedir().
   * Without it the hint's suppression would depend on the machine running
   * the suite, which is exactly the non-hermeticity it exists to avoid.
   */
  home?: string
}

export type StatuslineInstall =
  /** The key was absent and now holds sofar's entry. */
  | { status: 'wired'; path: string }
  /** Already exactly sofar's entry — nothing to do. */
  | { status: 'already'; path: string }
  /** Some OTHER statusLine is configured; it was left alone. */
  | { status: 'kept'; path: string; existing: unknown }

export type StatuslineUninstall =
  /** sofar's entry was there and is now gone — the host's default returns. */
  | { status: 'removed'; path: string }
  /** No statusLine at all at this scope. */
  | { status: 'absent'; path: string }
  /** Someone else's statusLine — left alone, as always. */
  | { status: 'foreign'; path: string; existing: unknown }

/** Scope for the statusLine install/uninstall pair. */
export interface StatuslineScope {
  /** Target ~/.claude/settings.json (all repos) instead of the project's. */
  user?: boolean
  /** Home directory override — tests only; defaults to os.homedir(). */
  home?: string
}

/** The personal settings file Claude Code reads for every project. */
export function userSettingsPath(home: string = homedir()): string {
  return join(home, '.claude', 'settings.json')
}

function statuslineTarget(rootDir: string, scope: StatuslineScope): string {
  return scope.user === true
    ? userSettingsPath(scope.home)
    : join(rootDir, '.claude', 'settings.json')
}

/**
 * Is sofar's statusLine already wired at the USER scope? Read-only and
 * best-effort — a missing, unreadable or unparseable personal settings file
 * answers false rather than throwing. init calls this to decide whether the
 * "not wired" hint is true, and a broken personal file must never abort an
 * unrelated `sofar init`.
 */
export function userStatuslineWired(home?: string): boolean {
  try {
    const path = userSettingsPath(home)
    if (!existsSync(path)) return false
    const decoded: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return isObj(decoded) && isSofarStatusline(decoded.statusLine)
  } catch {
    return false
  }
}

/**
 * Install ONLY the statusLine entry into <root>/.claude/settings.json
 * (felt-cost D14) — no hooks, no .sofar/, no CLAUDE.md block.
 *
 * `sofar init --statusline` wires the same key, but init is the whole
 * ceremony: it makes a repo sofar-TRACKED. The statusline is read-side and
 * degrades to model/dir/branch/ctx/cache in a repo with no record at all,
 * so wanting the line is not wanting the tracking, and a user who only
 * wants the line should not have to accept five hooks to get it.
 *
 * Same merge law as init (init-statusline D1): an existing statusLine —
 * ours, customized, or someone else's entirely — is the user's and wins.
 * Only the settings file is touched; .claude/ is created if missing.
 */
export function installStatusline(
  rootDir: string,
  scope: StatuslineScope = {},
): StatuslineInstall {
  const path = statuslineTarget(rootDir, scope)
  const settings = readJSONObject(path, path)

  if (settings.statusLine !== undefined) {
    return isSofarStatusline(settings.statusLine)
      ? { status: 'already', path }
      : { status: 'kept', path, existing: settings.statusLine }
  }

  settings.statusLine = STATUSLINE_SETTINGS_ENTRY
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, stableJSON(settings))
  return { status: 'wired', path }
}

/**
 * Remove sofar's statusLine, restoring whatever the host tool renders on
 * its own (felt-cost D15). The exact inverse of installStatusline, and it
 * honours the same theirs-wins law from the other side: an entry that is
 * not byte-for-byte ours is someone else's and is never deleted.
 *
 * Only the statusLine key is touched — every other setting, and the file
 * itself, survives even if this empties it to `{}`. Removing a line is not
 * a reason to delete a user's config file.
 */
export function uninstallStatusline(
  rootDir: string,
  scope: StatuslineScope = {},
): StatuslineUninstall {
  const path = statuslineTarget(rootDir, scope)
  if (!existsSync(path)) return { status: 'absent', path }
  const settings = readJSONObject(path, path)

  if (settings.statusLine === undefined) return { status: 'absent', path }
  if (!isSofarStatusline(settings.statusLine)) {
    return { status: 'foreign', path, existing: settings.statusLine }
  }

  delete settings.statusLine
  writeFileSync(path, stableJSON(settings))
  return { status: 'removed', path }
}

interface ShimSpec {
  file: string
  event: 'SessionStart' | 'UserPromptSubmit' | 'PostToolUse' | 'Stop' | 'SessionEnd'
  matcher?: string
  text: string
}

/** Order here is the order entries land in settings.json. */
export const SHIMS: readonly ShimSpec[] = [
  { file: 'session-start.sh', event: 'SessionStart', text: sessionStartShim },
  { file: 'user-prompt-submit.sh', event: 'UserPromptSubmit', text: userPromptSubmitShim },
  {
    file: 'post-tool-use.sh',
    event: 'PostToolUse',
    matcher: 'Edit|Write|MultiEdit|Bash',
    text: postToolUseShim,
  },
  { file: 'stop.sh', event: 'Stop', text: stopShim },
  { file: 'session-end.sh', event: 'SessionEnd', text: sessionEndShim },
]

export function hookCommand(file: string): string {
  return `${HOOK_COMMAND_PREFIX}${file}`
}

// ---------------------------------------------------------------------------
// Small file primitives — every mutation reports created/updated/unchanged.
// ---------------------------------------------------------------------------

type Change = 'created' | 'updated' | 'unchanged'

class InitAbort extends Error {}

function writeIfChanged(path: string, content: string): Change {
  if (existsSync(path)) {
    if (readFileSync(path, 'utf8') === content) return 'unchanged'
    writeFileSync(path, content, 'utf8')
    return 'updated'
  }
  writeFileSync(path, content, 'utf8')
  return 'created'
}

function createIfMissing(path: string, content: string): Change {
  if (existsSync(path)) return 'unchanged'
  writeFileSync(path, content, 'utf8')
  return 'created'
}

type Obj = Record<string, unknown>

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Parse a user-owned JSON object file; refuse to proceed on anything odd. */
function readJSONObject(path: string, label: string): Obj {
  if (!existsSync(path)) return {}
  let decoded: unknown
  try {
    decoded = JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    throw new InitAbort(
      `${label} is not valid JSON — refusing to modify it. Fix or remove it, then re-run sofar init. (${err instanceof Error ? err.message : String(err)})`,
    )
  }
  if (!isObj(decoded)) {
    throw new InitAbort(`${label} must contain a JSON object — refusing to modify it.`)
  }
  return decoded
}

function stableJSON(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

// ---------------------------------------------------------------------------
// Steps.
// ---------------------------------------------------------------------------

function initSofarDir(rootDir: string, report: string[]): void {
  const sofarDir = join(rootDir, '.sofar')
  mkdirSync(join(sofarDir, 'initiatives'), { recursive: true })
  // repo.md is HAND-WRITTEN (SPEC §Record layout) — create only, never touch.
  report.push(`${createIfMissing(join(sofarDir, 'repo.md'), REPO_MD_STUB)} .sofar/repo.md`)
  report.push(
    `${createIfMissing(join(sofarDir, 'bindings.json'), '{}\n')} .sofar/bindings.json`,
  )
}

/**
 * Merge the union-merge rule into .gitattributes — never clobber: user
 * content is byte-preserved, the rule is appended. Any existing line
 * already targeting the events pattern wins over ours (the .mcp.json
 * precedent: a customized entry is the user's, theirs stays).
 */
function ensureGitattributes(rootDir: string, report: string[]): void {
  const path = join(rootDir, '.gitattributes')
  if (!existsSync(path)) {
    writeFileSync(path, `${GITATTRIBUTES_LINE}\n`, 'utf8')
    report.push('created .gitattributes (union merge for event logs)')
    return
  }
  const content = readFileSync(path, 'utf8')
  const hasEventsRule = content
    .split(/\r?\n/)
    .some((line) => line.trim().split(/\s+/)[0] === '.sofar/**/events.jsonl')
  if (hasEventsRule) {
    report.push('unchanged .gitattributes (events.jsonl rule present)')
    return
  }
  const separator = content.endsWith('\n') || content.length === 0 ? '' : '\n'
  writeFileSync(path, `${content}${separator}${GITATTRIBUTES_LINE}\n`, 'utf8')
  report.push('updated .gitattributes (union merge for event logs appended)')
}

function installShims(rootDir: string, report: string[]): void {
  const hooksDir = join(rootDir, '.claude', 'hooks')
  mkdirSync(hooksDir, { recursive: true })
  for (const shim of SHIMS) {
    const path = join(hooksDir, shim.file)
    const change = writeIfChanged(path, shim.text) // shims are sofar-owned: kept current
    if ((statSync(path).mode & 0o777) !== 0o755) chmodSync(path, 0o755)
    report.push(`${change} .claude/hooks/${shim.file}`)
  }
}

/** Does any entry for this event already run our command? (match on command path) */
function hasCommand(entries: unknown[], command: string): boolean {
  return entries.some(
    (entry) =>
      isObj(entry) &&
      Array.isArray(entry.hooks) &&
      entry.hooks.some((h) => isObj(h) && h.command === command),
  )
}

function mergeSettings(
  rootDir: string,
  statusline: boolean,
  report: string[],
): { statuslineAbsent: boolean } {
  const path = join(rootDir, '.claude', 'settings.json')
  const settings = readJSONObject(path, '.claude/settings.json')

  if (settings.hooks !== undefined && !isObj(settings.hooks)) {
    throw new InitAbort('.claude/settings.json has a non-object "hooks" key — refusing to modify it.')
  }
  const hooks: Obj = isObj(settings.hooks) ? settings.hooks : {}

  let added = 0
  for (const shim of SHIMS) {
    const existing = hooks[shim.event]
    if (existing !== undefined && !Array.isArray(existing)) {
      throw new InitAbort(
        `.claude/settings.json hooks.${shim.event} is not an array — refusing to modify it.`,
      )
    }
    const entries: unknown[] = Array.isArray(existing) ? existing : []
    const command = hookCommand(shim.file)
    if (!hasCommand(entries, command)) {
      entries.push({
        ...(shim.matcher !== undefined ? { matcher: shim.matcher } : {}),
        hooks: [{ type: 'command', command }],
      })
      added++
    }
    hooks[shim.event] = entries
  }

  // statusLine (--statusline, D4 informed re-test): merged ONLY when the key
  // is absent — an existing entry, ours or customized, is never rewritten.
  let statuslineNote = ''
  let statuslineWiredNow = false
  if (statusline) {
    if (settings.statusLine === undefined) {
      settings.statusLine = STATUSLINE_SETTINGS_ENTRY
      statuslineWiredNow = true
      statuslineNote = ' (statusLine wired)'
    } else {
      statuslineNote = isSofarStatusline(settings.statusLine)
        ? ' (statusLine already wired)'
        : ' (existing statusLine kept)'
    }
  }
  const statuslineAbsent = settings.statusLine === undefined

  if (added === 0 && !statuslineWiredNow && existsSync(path)) {
    report.push(`unchanged .claude/settings.json${statuslineNote}`)
    return { statuslineAbsent }
  }
  settings.hooks = hooks
  report.push(`${writeIfChanged(path, stableJSON(settings))} .claude/settings.json${statuslineNote}`)
  return { statuslineAbsent }
}

function mergeMcpJson(rootDir: string, report: string[]): void {
  const path = join(rootDir, '.mcp.json')
  const config = readJSONObject(path, '.mcp.json')

  if (config.mcpServers !== undefined && !isObj(config.mcpServers)) {
    throw new InitAbort('.mcp.json has a non-object "mcpServers" key — refusing to modify it.')
  }
  const servers: Obj = isObj(config.mcpServers) ? config.mcpServers : {}

  if (servers.sofar !== undefined && existsSync(path)) {
    report.push('unchanged .mcp.json') // user may have customized the entry — theirs wins
    return
  }
  servers.sofar = mcpRegistration().mcpServers.sofar
  config.mcpServers = servers
  report.push(`${writeIfChanged(path, stableJSON(config))} .mcp.json`)
}

/**
 * The marker-delimited span of a protocol block, trailing newline EXCLUDED so
 * comparisons never turn on whether a file ends in one. Null when the markers
 * are absent or unterminated — an unterminated block is left strictly alone,
 * since its real extent is unknown and guessing could eat user prose.
 */
function protocolSpan(text: string): { start: number; end: number } | null {
  const start = text.indexOf(PROTOCOL_START)
  if (start === -1) return null
  const endAt = text.indexOf(PROTOCOL_END, start)
  if (endAt === -1) return null
  return { start, end: endAt + PROTOCOL_END.length }
}

/**
 * What state is the block in this file? (speed-2 T6)
 *
 * - absent      no markers at all — nothing installed
 * - unterminated  opened but never closed; extent unknown, so hands off
 * - current     byte-matches the template
 * - stale       byte-matches a block sofar previously shipped → safe to refresh
 * - customized  matches nothing sofar ever wrote → the user's, leave it
 *
 * Shared by init (which acts on it) and doctor (which reports it) so the two
 * can never disagree about whether a repo's protocol is up to date.
 */
export type ProtocolBlockState = 'absent' | 'unterminated' | 'current' | 'stale' | 'customized'

export function classifyProtocolBlock(
  text: string,
  template: string,
  shipped: readonly string[],
): ProtocolBlockState {
  if (!text.includes(PROTOCOL_START)) return 'absent'
  const span = protocolSpan(text)
  if (span === null) return 'unterminated'
  const templateSpan = protocolSpan(template)
  if (templateSpan === null) return 'customized' // unreachable; the safe read
  const installed = text.slice(span.start, span.end)
  if (installed === template.slice(templateSpan.start, templateSpan.end)) return 'current'
  const known = shipped.some((old) => {
    const oldSpan = protocolSpan(old)
    return oldSpan !== null && old.slice(oldSpan.start, oldSpan.end) === installed
  })
  return known ? 'stale' : 'customized'
}

/**
 * Install a marker-delimited protocol block into a repo-root file — one
 * discipline for CLAUDE.md and AGENTS.md: create the file if missing, append
 * the block if the markers are absent, and refresh an installed block ONLY
 * when it byte-matches something sofar itself shipped (speed-2 T6).
 *
 * That match is the whole safety argument: it proves a previous sofar wrote
 * those bytes and nobody edited them, so replacing loses nothing. A block that
 * matches neither the current template nor any shipped predecessor has been
 * customized — it is reported and left exactly as it is. Text outside the
 * markers is never touched in any branch.
 */
function appendProtocolBlock(
  rootDir: string,
  file: string,
  block: string,
  shipped: readonly string[],
  report: string[],
): void {
  const path = join(rootDir, file)
  if (!existsSync(path)) {
    writeFileSync(path, block, 'utf8')
    report.push(`created ${file} (sofar protocol block)`)
    return
  }
  const current = readFileSync(path, 'utf8')
  const state = classifyProtocolBlock(current, block, shipped)
  if (state === 'current') {
    report.push(`unchanged ${file} (protocol block current)`)
    return
  }
  if (state === 'customized' || state === 'unterminated') {
    report.push(`unchanged ${file} (protocol block customized — refresh it by hand)`)
    return
  }
  if (state === 'stale') {
    const span = protocolSpan(current)
    const templateSpan = protocolSpan(block)
    // Both are non-null whenever the state is 'stale' — it is derived from them.
    if (span !== null && templateSpan !== null) {
      const wanted = block.slice(templateSpan.start, templateSpan.end)
      writeFileSync(path, current.slice(0, span.start) + wanted + current.slice(span.end), 'utf8')
      report.push(`updated ${file} (protocol block refreshed)`)
      return
    }
  }
  const separator = current.length === 0 ? '' : current.endsWith('\n') ? '\n' : '\n\n'
  writeFileSync(path, `${current}${separator}${block}`, 'utf8')
  report.push(`updated ${file} (sofar protocol block appended)`)
}

// ---------------------------------------------------------------------------
// Confirmation styling (cli-ui 2.5). Wording is identical styled or plain —
// caps only add the ✓/✗ mark, color, and dim └ rails on the per-file detail
// lines — so piped output stays byte-identical to the unstyled report.
// Failure text lands on stderr, so it styles under the STDERR stream's caps
// (errCaps): a stdout TTY must not push escapes into a redirected stderr.
// ---------------------------------------------------------------------------

function renderReport(details: string[], result: string, caps: Caps): string {
  if (!caps.color) return [...details, result].join('\n')
  const style = createStyle(true)
  const symbols = symbolsFor(caps.unicode)
  return [
    ...details.map((line) => style.dim(`  ${symbols.elbow} ${line}`)),
    `${style.success(symbols.ok)} ${result}`,
  ].join('\n')
}

function renderFailure(message: string, caps: Caps): string {
  if (!caps.color) return message
  return `${createStyle(true).error(symbolsFor(caps.unicode).fail)} ${message}`
}

// ---------------------------------------------------------------------------
// Command.
// ---------------------------------------------------------------------------

export function runInit(
  rootDir: string,
  options: InitOptions = {},
  caps: Caps = stdoutCaps(),
  errCaps: Caps = stderrCaps(),
): CmdResult {
  const statusline = options.statusline === true
  const report: string[] = []
  let statuslineAbsent = false
  try {
    initSofarDir(rootDir, report)
    ensureGitattributes(rootDir, report)
    installShims(rootDir, report)
    statuslineAbsent = mergeSettings(rootDir, statusline, report).statuslineAbsent
    mergeMcpJson(rootDir, report)
    appendProtocolBlock(rootDir, 'CLAUDE.md', PROTOCOL_BLOCK, SHIPPED_PROTOCOL_BLOCKS, report)
    appendProtocolBlock(
      rootDir,
      'AGENTS.md',
      AGENTS_PROTOCOL_BLOCK,
      SHIPPED_AGENTS_PROTOCOL_BLOCKS,
      report,
    )
  } catch (err) {
    if (err instanceof InitAbort) return fail(renderFailure(`sofar init: ${err.message}`, errCaps))
    throw err
  }
  const changed = report.filter((line) => !line.startsWith('unchanged')).length
  const result =
    changed === 0
      ? 'sofar init: already initialized — nothing to do'
      : `sofar init: done (${changed} change${changed === 1 ? '' : 's'})`
  const lines = [renderReport(report, result, caps)]
  // Opt-in nudge (init-statusline D1): when the project settings carry no
  // statusLine and the flag was not passed, point at it. Unstyled, like the
  // scanner hint — and always BEFORE it: the scanner hint keeps the final
  // slot (SPEC §CLI).
  // The hint claims the statusline is "not wired", so it must not fire when
  // the personal ~/.claude/settings.json already wires it (D15): that file
  // applies to every project, so a project with no statusLine of its own is
  // already showing sofar's line and there is nothing to opt into.
  if (!statusline && statuslineAbsent && !userStatuslineWired(options.home)) {
    lines.push('', STATUSLINE_HINT)
  }
  // Scanner defense (task 10.1, D-P10): if a tree-wide class scanner will
  // ingest .sofar/, raise the exclusion hint as the FINAL output. init only
  // flags it; `sofar doctor --fix` does the precise, path-aware insert.
  // The hint stays unstyled: its last line is a copy-pasteable directive.
  const hint = scannerHint(rootDir)
  if (hint !== null) lines.push('', hint)
  return ok(`${lines.join('\n')}\n`)
}

/**
 * The rent-meter opt-in hint — printed by plain init while the project
 * settings has no statusLine. A project-level statusLine shadows a personal
 * ~/.claude/settings.json one, which is exactly why wiring it stays opt-in
 * (felt-cost D4): the hint names the trade so the choice is informed.
 */
export const STATUSLINE_HINT = [
  'note: Claude Code statusline not wired. `sofar statusline` renders the',
  '  rent-meter (model, dir, branch, record progress, context %, cache',
  '  health) in the status bar. Opt in with either:',
  '    sofar init --statusline      (with the rest of init)',
  '    sofar statusline --install   (the line alone, any repo)',
  '  (a project statusLine shadows a personal ~/.claude/settings.json one —',
  '  skip this if you prefer yours)',
].join('\n')

/**
 * The Tailwind-v4 scanner hint (task 10.1) — printed as init's final output
 * when a `tailwindcss@>=4` dependency is present. Generic on purpose: init
 * does not scan for the CSS entry (that is `sofar doctor`'s job); it points
 * the user at the automatic fix and shows the hand-edit shape.
 */
function scannerHint(rootDir: string): string | null {
  const tw = detectTailwindV4(rootDir)
  if (!tw.v4) return null
  const head = [
    `note: Tailwind v4 detected (tailwindcss ${tw.installed ?? tw.range}). Its content scanner`,
    '  ingests every non-gitignored file — including .sofar/ records — which can',
    '  bloat or break your CSS build. Exclude the record from scanning:',
  ]
  // `@source not` needs >= 4.1; naming it here on 4.0.x would hand the user a
  // build break, so pre-4.1 repos get the scan-base form instead (scanner-version-gate D1).
  if (!tw.sourceNot) {
    return [
      ...head,
      `    \`@source not\` needs Tailwind >= ${SOURCE_NOT_SINCE}${tw.installed === undefined ? ' (install deps to confirm yours)' : ''} — either`,
      '    upgrade and run `sofar doctor --fix`, or narrow the scan base on the',
      '    import so .sofar/ falls outside it (path relative to the stylesheet,',
      '    and anything outside it stops being scanned):',
      '    @import "tailwindcss" source("<your-template-dir>");',
    ].join('\n')
  }
  return [
    ...head,
    '    run `sofar doctor --fix`   (inserts `@source not` into your Tailwind entry)',
    '  or add this by hand after `@import "tailwindcss";`:',
    '    @source not "<relative-path>/.sofar";',
  ].join('\n')
}
