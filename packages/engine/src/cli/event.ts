import { readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import type { Command } from 'commander'
import { isClosedInitiativeStatus } from '@sofar/schema'
import { ACTORS, SOURCES, type Actor, type Source } from '../core/envelope'
import { crossConflictsFromOpenSessions, type CrossFileConflict } from '../core/cross-conflicts'
import {
  openSessionFileConflicts,
  openSessionFiles,
  sessionDebt,
  sessionGuardViolations,
  type FileConflict,
  type GuardViolation,
  type InitiativeState,
  type SessionState,
} from '../core/fold'
import { readGitState } from '../core/git'
import { refreshTier0 } from '../core/index-tier0'
import { resolvePeers, type Peer } from '../core/peers'
import { redactCommand } from '../core/redact'
import {
  createToolContext,
  homeInitiative,
  initiativeSlugs,
  resolveSessionFirst,
  ToolError,
  type ToolContext,
} from '../mcp/context'
import { enforceStatusLimit, renderStatus } from '../projections/templates/status'
import { REPO_MD_STUB } from './shared'

/**
 * `sofar event <subcommand>` — the internal surface hook shims call
 * (SPEC §Hooks, §CLI). Every subcommand reads Claude Code hook JSON from
 * stdin: { session_id, transcript_path, cwd, hook_event_name, ... }.
 *
 * Philosophy (BD22): hooks must never break the user's session. Any
 * resolution failure — unreadable stdin, no .sofar/, no branch binding,
 * missing session_id — exits 0 silently. The ONE deliberate non-zero exit is
 * Stop's exit 2 when a registered session has not written back (BD2).
 *
 * Handlers are pure-ish ({exitCode, stdout, stderr} in, no process.exit) so
 * tests drive them directly; commander wiring below stays thin.
 */

export interface HookResult {
  exitCode: number
  stdout: string
  stderr: string
}

const OK: HookResult = { exitCode: 0, stdout: '', stderr: '' }

export const STOP_BLOCK_MESSAGE =
  'Write back to the sofar record before finishing: call sofar_end_session (or append session_ended via `sofar event append`).'

/** Hook payload tool = the agent tool whose hooks feed this surface. */
const HOOK_TOOL = 'claude-code'

// ---------------------------------------------------------------------------
// Self-recording commands (record-hygiene D1) — the exemption that lets the
// working tree settle.
// ---------------------------------------------------------------------------

/**
 * Commands whose only effect lands in a ledger that already records itself:
 * `git` keeps its own history, and `sofar` writes the record directly.
 *
 * Logging either as command_run makes the record un-settleable. Committing
 * the record is itself a Bash call, so PostToolUse appends an event ABOUT
 * committing the record — the tree is dirty the instant it is clean, and no
 * amount of committing converges. The tree can only reach clean if some
 * record-committing action appends zero events; this exemption is that
 * action.
 *
 * Nothing is lost: the fold COUNTS command_run and never reads `cmd` (a bare
 * tally in recordActivity, an explicit no-op in applyEvent — core/fold.ts),
 * so an exempt command costs a counter increment and no semantics. Counting
 * a commit as drift was backwards anyway — drift means "the record moved
 * since the last write-back", and committing is the act of recording.
 */
const SELF_RECORDING_COMMANDS = new Set(['git', 'sofar'])

/** Leading executable of one shell segment, ignoring `VAR=val` prefixes and any path. */
function leadingToken(segment: string): string | null {
  for (const word of segment.trim().split(/\s+/)) {
    if (word.length === 0) continue
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) continue // env assignment prefix
    return word.replace(/^.*\//, '') // /usr/bin/git → git
  }
  return null
}

/**
 * Split a command at its shell separators — `&&`, `||`, `;`, `|`, `&`, newline
 * — counting only those that appear OUTSIDE quotes.
 *
 * Returns null when the command cannot be scanned confidently, which the
 * caller resolves toward logging. Two cases: unbalanced quotes (the text does
 * not parse, so no claim about its segments is safe), and command
 * substitution — `$(…)` or backticks run a nested command this scanner does
 * not descend into, so `git log $(rm -rf x)` must not ride the leading `git`
 * to an exemption.
 *
 * Quote rules follow sh: single quotes are literal; inside double quotes a
 * backslash escapes the next character, and `$(`/backtick still substitute.
 */
function shellSegments(cmd: string): string[] | null {
  const segments: string[] = []
  let start = 0
  let quote: '"' | "'" | null = null

  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]
    const next = cmd[i + 1]

    if (quote === "'") {
      if (ch === "'") quote = null
      continue
    }
    // Backslash escapes the next character, unquoted and inside double quotes
    // alike — this is what makes the repo's own `\`npm publish\`` commit body
    // literal text rather than a substitution.
    if (ch === '\\') {
      i++
      continue
    }
    if (ch === '`' || (ch === '$' && next === '(')) return null
    if (quote === '"') {
      if (ch === '"') quote = null
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      continue
    }

    let width = 0
    if ((ch === '&' && next === '&') || (ch === '|' && next === '|')) width = 2
    else if (ch === ';' || ch === '|' || ch === '\n') width = 1
    // A lone `&` backgrounds the segment before it and starts a new one, but
    // the `&` of a `2>&1`-style redirect belongs to the word it sits in.
    else if (ch === '&' && cmd[i - 1] !== '>' && cmd[i - 1] !== '<') width = 1
    if (width === 0) continue

    segments.push(cmd.slice(start, i))
    i += width - 1
    start = i + 1
  }

  if (quote !== null) return null
  segments.push(cmd.slice(start))
  return segments
}

/**
 * True when EVERY segment of a (possibly compound) command is self-recording
 * — `git add .sofar && git commit -m …` is exempt, `cd x && git push` is not.
 *
 * Conservative by construction: a command that cannot be scanned, or that has
 * one non-exempt segment, is logged. Every ambiguity resolves toward logging,
 * so the exemption can never swallow real work — but a separator that is only
 * a separator OUTSIDE quotes must not be read as one inside them, or the
 * repo's own multi-line commit messages defeat the exemption and the record
 * never settles (record-hygiene-quotes D1).
 */
export function isSelfRecordingCommand(cmd: string): boolean {
  const scanned = shellSegments(cmd)
  if (scanned === null) return false
  const segments = scanned.filter((s) => s.trim().length > 0)
  if (segments.length === 0) return false
  return segments.every((segment) => {
    const token = leadingToken(segment)
    return token !== null && SELF_RECORDING_COMMANDS.has(token)
  })
}

// ---------------------------------------------------------------------------
// Defensive stdin parsing — missing/unknown fields must never crash a shim.
// ---------------------------------------------------------------------------

type Obj = Record<string, unknown>

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Parse hook JSON; anything unparseable degrades to an empty object. */
function parseHook(input: string): Obj {
  try {
    const decoded: unknown = JSON.parse(input)
    return isObj(decoded) ? decoded : {}
  } catch {
    return {}
  }
}

function strField(hook: Obj, key: string): string | null {
  const v = hook[key]
  return typeof v === 'string' && v.length > 0 ? v : null
}

/**
 * Resolve the initiative this hook must write to; null on any failure
 * (unbound repo etc.).
 *
 * Session pinning (record-integrity 1.2, D1) — a REGISTERED session's home
 * initiative wins over the current branch. MCP writes have been pinned since
 * BD58 (resolveWriteInitiative), but hooks resolved by branch alone, and a
 * hook runs in a fresh process where the in-memory pin is always null. That
 * asymmetry tore sessions in half: a branch switch during live work sent
 * file_touched/command_run to whatever branch HEAD happened to name while the
 * same session's decisions and write-back went to its real initiative.
 *
 * The precedence itself now lives in resolveSessionFirst (initiative-lifecycle
 * 3.1) so the statusline shares it exactly — one definition of
 * session-before-branch, not one per surface.
 */
function resolveBound(
  rootDir: string,
  sessionId?: string | null,
): { ctx: ToolContext; slug: string } | null {
  try {
    const ctx = createToolContext(rootDir)
    const resolved = resolveSessionFirst(ctx, sessionId)
    if (resolved === null) return null
    return { ctx, slug: resolved.slug }
  } catch {
    return null
  }
}

/**
 * Repo memory (task 6.5, BD40) — .sofar/repo.md is hand-written
 * repo-scoped memory (SPEC §Record layout). Surfaced in the SessionStart
 * context only when it says something: missing, unreadable, empty, or still
 * the untouched `sofar init` stub → null (section omitted entirely).
 */
function readRepoMemory(rootDir: string): string | null {
  try {
    const text = readFileSync(join(rootDir, '.sofar', 'repo.md'), 'utf8')
    if (text.trim().length === 0 || text.trim() === REPO_MD_STUB.trim()) return null
    return text
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Cold-resume advisory (felt-cost 2.1/2.2) — resume-only, read-side,
// best-effort: any failure renders no advisory, never an error. A resume
// past every prompt-cache TTL re-warms the whole transcript at full input
// price while the record is the cheap orientation path — the advisory makes
// that cost felt at the moment it is incurred. Thresholds are heuristics:
// the TTL is server-controlled (5m–1h), so "cold" is measured against the
// longest published TTL, and bytes/4 is a rough token estimate (transcript
// JSONL carries harness overhead). Informed re-test of token-optimization's
// "leading with prompt caching" rejection (felt-cost D2): this play spends
// no record tokens and leaves the status block's bytes untouched.
// ---------------------------------------------------------------------------

/** A resume is "cold" when the record's last event predates the longest cache TTL. */
export const COLD_RESUME_GAP_MS = 60 * 60 * 1000
/** Below ~20k estimated tokens (~4 bytes/token) a re-warm is cheap — stay quiet. */
export const COLD_RESUME_MIN_TRANSCRIPT_BYTES = 80_000

/** Epoch ms of the last parseable event line; null on any failure. */
function lastEventMs(eventsPath: string): number | null {
  try {
    const lines = readFileSync(eventsPath, 'utf8').split('\n')
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!.trim()
      if (line.length === 0) continue
      try {
        const event: unknown = JSON.parse(line)
        if (isObj(event) && typeof event.ts === 'string') {
          const ms = Date.parse(event.ts)
          if (!Number.isNaN(ms)) return ms
        }
      } catch {
        // torn/corrupt trailing line — skip it, same tolerance as the fold
      }
    }
    return null
  } catch {
    return null
  }
}

function coldResumeAdvisory(hook: Obj, eventsPath: string): string | null {
  if (strField(hook, 'source') !== 'resume') return null
  const transcriptPath = strField(hook, 'transcript_path')
  if (transcriptPath === null) return null
  let transcriptBytes: number
  try {
    transcriptBytes = statSync(transcriptPath).size
  } catch {
    return null
  }
  if (transcriptBytes < COLD_RESUME_MIN_TRANSCRIPT_BYTES) return null
  const last = lastEventMs(eventsPath)
  if (last === null) return null
  const gapMs = Date.now() - last
  if (gapMs < COLD_RESUME_GAP_MS) return null

  const hours = Math.round(gapMs / 3_600_000)
  const gap = hours < 48 ? `~${hours}h` : `~${Math.round(hours / 24)}d`
  const kTokens = Math.round(transcriptBytes / 4_000)
  return (
    `⚠ Cold resume: ${gap} since this record's last event — past any prompt-cache TTL, ` +
    `so this transcript (~${kTokens}k tokens, rough estimate) re-warms at full input price. ` +
    `If the resume is deliberate, carry on; otherwise a fresh session oriented from this block is the cheaper path.`
  )
}

// ---------------------------------------------------------------------------
// Handlers.
// ---------------------------------------------------------------------------

/**
 * SessionStart (task 3.2) — prints the status projection to stdout for
 * context injection (≤10,000 chars — guaranteed by renderStatus). The block
 * opens with a "Session: <id>" line (task 7.1, BD43) — the agent passes that
 * id to sofar_start_session as session_id to adopt exactly its own session
 * (the newest-open heuristic is gone).
 *
 * This hook APPENDS NOTHING (record-hygiene D2). Registration is lazy: the
 * session enters the log on its first real event — sofar_start_session's
 * unknown-id branch (mcp/start-session.ts) or the first PostToolUse append.
 * Registering eagerly meant opening a session dirtied the record before any
 * work existed, and a session that only read and exited still minted a
 * session_started, a session_closed, and a permanent tracked projection file
 * for having done nothing. The id line does not depend on the append — it
 * comes from the hook payload — so adopt-by-id is untouched.
 * Re-fires on resume/clear/compact reuse the same session_id and reprint the
 * block every time (re-injection after compact is the point).
 * On source=resume a cold-resume advisory (felt-cost 2.1/2.2) may precede
 * the block: cold record (last event past the longest cache TTL) + a
 * substantial transcript → one line naming the re-warm cost and the fresh
 * start alternative. Best-effort; total output stays ≤10,000 chars.
 */
/**
 * What a session gets when NOTHING resolves — no registered home, no branch
 * binding (initiative-lifecycle 4.1, D4).
 *
 * This used to inject nothing, which is indistinguishable from a healthy
 * repo while every hook event is silently discarded. The drop stays (D4 —
 * lazily binding here would recreate the misrouting record-integrity fixed),
 * but the CONDITION is now named once, where the agent actually reads, along
 * with the two moves that fix it.
 *
 * Scoped to repos that carry a record: one sofar has never touched injects
 * nothing, exactly as before. Slugs come from the directory listing — no
 * folds, because this runs inside the shim's 100ms budget and `sofar list` is
 * the surface that ranks and marks them.
 */
export function unboundNotice(rootDir: string): string {
  try {
    const slugs = initiativeSlugs(join(rootDir, '.sofar'))
    if (slugs.length === 0) return ''
    const MAX_LISTED = 10
    const listed = slugs.slice(0, MAX_LISTED).join(', ')
    const more = slugs.length > MAX_LISTED ? `, …+${slugs.length - MAX_LISTED} more` : ''
    return enforceStatusLimit(
      [
        '# Sofar: this branch is not bound to an initiative',
        '',
        'No record resolves for this session, so nothing you do here is being',
        'recorded — hook events are discarded, not queued. Fix it before working:',
        '',
        `  sofar switch <slug>   work on an existing record (${listed}${more})`,
        '  sofar new <slug>      start a new one (work that matches no existing record)',
        '',
        'Then call sofar_start_session. `sofar list` shows progress and marks closed records.',
      ].join('\n'),
    )
  } catch {
    return ''
  }
}

/**
 * The banner a session pinned to a CLOSED record gets above its status block
 * (4.1). The record still injects in full — the session that closed it is
 * usually the one reading this, and its history is exactly what it needs —
 * but queueing new work into a finished record is the mistake worth naming.
 */
export function closedBanner(state: InitiativeState): string | null {
  if (!isClosedInitiativeStatus(state.status)) return null
  const when = state.status_ts === null ? '' : ` on ${state.status_ts.slice(0, 10)}`
  const why = state.status_note === null ? '' : ` — ${state.status_note}`
  return [
    `⚠ ${state.slug} is CLOSED (${state.status}${when})${why}`,
    'No branch is bound to it. Do not queue new work here: close-out notes and',
    `write-back still belong in this record, but new work needs \`sofar new <slug>\`,`,
    `and resuming this one needs \`sofar switch ${state.slug}\` (which reopens it).`,
  ].join('\n')
}

export function handleSessionStart(rootDir: string, input: string): HookResult {
  try {
    const hook = parseHook(input)
    const sessionId = strField(hook, 'session_id')
    const bound = resolveBound(rootDir, sessionId)
    if (bound === null) return { ...OK, stdout: unboundNotice(rootDir) }
    const { ctx, slug } = bound

    // The gap is measured to the prior session's last event; with lazy
    // registration this hook writes nothing, so no bookkeeping of ours can
    // ever mask a cold record.
    const advisory = coldResumeAdvisory(hook, ctx.eventsPath(slug))
    const state = ctx.foldState(slug)
    const repoMemory = readRepoMemory(rootDir)
    // ≤10,000 chars (BD3/BD24) — repo memory has its own budget (BD40); the
    // session id line (7.1, BD43) tells the agent what to pass to
    // sofar_start_session so it adopts ITS OWN session, never a parallel one.
    // The advisory composes AROUND the status block (never inside it — the
    // block's byte-stability is pinned, felt-cost 1.2); the composed output
    // is re-capped so the injection contract stays ≤10,000 chars.
    // Git state is READ, never logged (record-integrity 4.1) — refs only, so
    // it costs no subprocess inside the 100ms shim budget.
    const git = readGitState(rootDir)
    const status = renderStatus(state, {
      ...(repoMemory !== null ? { repoMemory } : {}),
      ...(sessionId !== null ? { sessionId } : {}),
      ...(git !== null ? { git } : {}),
    })
    // Both the closed banner and the cold-resume advisory compose AROUND the
    // status block, never inside it — the block's byte-stability is pinned
    // (felt-cost 1.2), and the composed output is re-capped so the injection
    // contract stays ≤10,000 chars.
    const preface = [closedBanner(state), advisory].filter((p) => p !== null).join('\n\n')
    return {
      ...OK,
      stdout: preface.length === 0 ? status : enforceStatusLimit(`${preface}\n\n${status}`),
    }
  } catch {
    return { ...OK }
  }
}

/**
 * PostToolUse (task 3.3) — mechanical file_touched / command_run events.
 * Edit|MultiEdit → {op:'edit'}, Write → {op:'write'}, Bash → command_run;
 * any other tool_name (or missing fields) appends nothing.
 *
 * Two record-hygiene rules apply here (D1/D2):
 *  - a self-recording Bash command (git, sofar) appends nothing — see
 *    SELF_RECORDING_COMMANDS for why the record cannot settle otherwise;
 *  - this is the lazy-registration point: SessionStart no longer registers,
 *    so a session enters the log immediately before its first real event.
 *    Sessions that only read and exit never register at all.
 */
export function handlePostTool(rootDir: string, input: string): HookResult {
  try {
    const hook = parseHook(input)
    const session = strField(hook, 'session_id') ?? 'cli'
    const bound = resolveBound(rootDir, session)
    if (bound === null) return { ...OK }
    const { ctx, slug } = bound

    const toolName = strField(hook, 'tool_name')
    const toolInput = isObj(hook.tool_input) ? hook.tool_input : {}

    let type: 'file_touched' | 'command_run'
    let payload: Obj
    if (toolName === 'Edit' || toolName === 'MultiEdit' || toolName === 'Write') {
      const path = strField(toolInput, 'file_path')
      if (path === null) return { ...OK }
      type = 'file_touched'
      payload = { path, op: toolName === 'Write' ? 'write' : 'edit' }
    } else if (toolName === 'Bash') {
      const cmd = strField(toolInput, 'command')
      if (cmd === null) return { ...OK }
      if (isSelfRecordingCommand(cmd)) return { ...OK }
      type = 'command_run'
      // Redact BEFORE the append, because there is no after: the log is
      // append-only and committed, so a credential that lands here is a
      // credential in everyone's clone forever (security-hardening 3.1).
      // The exemption scan above still reads the raw text — redaction must
      // not change which commands are considered self-recording.
      payload = { cmd: redactCommand(cmd) }
    } else {
      return { ...OK }
    }

    // Lazy registration: one fold to see whether this session is already in
    // the log — the same read the Stop and UserPromptSubmit shims already do
    // on every invocation, and it only precedes an append that folds anyway.
    // "cli" is never a session identity (the fold skips it), so it is never
    // registered.
    if (session !== 'cli' && !ctx.foldState(slug).sessions.some((s) => s.id === session)) {
      ctx.appendAndProject(slug, 'session_started', { tool: HOOK_TOOL }, { session, source: 'hook' })
    }
    ctx.appendAndProject(slug, type, payload, { session, source: 'hook' })
    return { ...OK }
  } catch {
    return { ...OK }
  }
}

/**
 * Stop (task 3.4, BD2; drift-gated speed T1) — the write-back gate. Exit 2
 * blocks the stop and feeds stderr back to the agent; every other path
 * exits 0:
 *  - stop_hook_active → 0 (loop guard: we already blocked once)
 *  - unreadable stdin / missing session_id / unbound repo → 0 (never block
 *    sessions the sofar does not govern)
 *  - session not registered in the log → 0
 *  - session registered AND written back (session_ended folded) → 0
 *  - zero gate-relevant drift → 0 (speed T1: nothing moved since the last
 *    write-back, so there is nothing to write back — the empty-wait killer)
 * Write-back check is fold-based: only session_ended sets session.summary,
 * so a voided (corrected) session_ended does not count (BD23).
 *
 * Gate-relevant drift is the STOPPING SESSION'S OWN unwritten debt
 * (drift-signal 1.2) — mutation-class events carrying its id since its own
 * last write-back. Speed T1 used the initiative-wide counter OR'd with
 * derived activity, which mis-answered in both directions: a session that
 * only ran greps carried `activity` and got blocked with nothing to say,
 * while the OR existed solely to stop a sibling's write-back from exempting
 * a session that did owe one (the Phase 7 independent-gates law). Per-session
 * accounting makes that law structural — one session's write-back cannot
 * touch another's counter — and drops the read-only false positive with it.
 *
 * The gate still runs LAST and still only ever converts an exit-2 into an
 * exit-0. Fail closed: an error inside the drift computation enforces the
 * block — `computeDrift` is injectable for exactly that test seam.
 */
export function handleStop(
  rootDir: string,
  input: string,
  computeDrift: (state: InitiativeState, session: SessionState) => number = sessionDebt,
): HookResult {
  try {
    const hook = parseHook(input)
    if (hook.stop_hook_active === true) return { ...OK }

    const sessionId = strField(hook, 'session_id')
    if (sessionId === null) return { ...OK }

    const bound = resolveBound(rootDir, sessionId)
    if (bound === null) return { ...OK }
    const { ctx, slug } = bound

    const state = ctx.foldState(slug)
    const session = state.sessions.find((s) => s.id === sessionId)
    if (session === undefined) return { ...OK } // never registered — not ours to block
    if (session.summary !== undefined) return { ...OK } // write-back done

    // Drift gate (drift-signal 1.2): silent exit when THIS session owes
    // nothing — it wrote back, or it never mutated the record. NaN or a
    // throw is NOT zero — both enforce (fail closed, never a silent skip
    // of the gate).
    try {
      if (computeDrift(state, session) === 0) return { ...OK }
    } catch {
      // fall through to the block below
    }

    // Guard crossings RIDE the block; they never cause one (D3). By the time
    // we are here the gate has already decided to hold this session for its
    // missing write-back, so naming the rules its own work crossed costs
    // nothing and lands where the agent is already reading — while a guard
    // that could flip an exit 0 into an exit 2 would let one false positive
    // stop real work.
    const crossings = guardViolationLines(
      sessionGuardViolations(state, sessionId, session.ended),
      rootDir,
    )
    return {
      exitCode: 2,
      stdout: '',
      stderr: [STOP_BLOCK_MESSAGE, ...crossings].join('\n'),
    }
  } catch {
    return { ...OK }
  }
}

/**
 * SessionEnd (task 3.5) — mechanical close marker, fallback logging only.
 * Appends session_closed {reason}; the fold sets session.ended and nothing
 * else (BD21 — fabricating a session_ended here would clobber the
 * fold-derived current.next_action). Skipped when the session is unknown
 * (nothing to close) or already ended (write-back or a prior close won).
 */
export function handleSessionEnd(rootDir: string, input: string): HookResult {
  try {
    const hook = parseHook(input)
    const sessionId = strField(hook, 'session_id')
    if (sessionId === null) return { ...OK }

    const bound = resolveBound(rootDir, sessionId)
    if (bound === null) return { ...OK }
    const { ctx, slug } = bound

    const session = ctx.foldState(slug).sessions.find((s) => s.id === sessionId)
    if (session === undefined || session.ended !== undefined) return { ...OK }

    ctx.appendAndProject(slug, 'session_closed', { reason: strField(hook, 'reason') ?? 'unknown' }, {
      session: sessionId,
      source: 'hook',
    })
    return { ...OK }
  } catch {
    return { ...OK }
  }
}

/**
 * UserPromptSubmit (felt-cost 4.1/4.2, D5) — the batch-complete nudge.
 * When the session is registered and the initiative has accumulated ≥5
 * mechanical events since the last write-back, stdout (exit 0 =
 * additionalContext for this hook) carries ONE line nudging an in-flow
 * sofar_end_session — a write-back while context is warm makes the Stop
 * gate a fallback instead of a forced extra turn. Stateless: it re-fires
 * on every prompt until the write-back resets drift (staleness-line
 * precedent). Best-effort per BD22 — every failure path is silence.
 */
export const NUDGE_DRIFT_MIN = 5

/** Character budget for the parallel-wrap line (record-integrity 4.2). */
export const PARALLEL_WRAP_BUDGET = 420

/** Character budget for the live file-conflict line (writeback-collisions 2.1). */
export const FILE_CONFLICT_BUDGET = 300

/** Files named in full on the conflict line before it falls back to a count. */
export const FILE_CONFLICT_MAX_PATHS = 3

/** Character budget for the cross-initiative conflict line (record-index 2.2). */
export const CROSS_CONFLICT_BUDGET = 320

/** Files named in full on the cross-initiative line before it falls back to a count. */
export const CROSS_CONFLICT_MAX_PATHS = 3

/** Character budget for the reachable-peer line (peer-messaging 2.1). */
export const PEER_LINE_BUDGET = 300

/** Peers named in full on the peer line before it falls back to a count. */
export const PEER_MAX_NAMES = 3

function clipTo(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`
}

/**
 * Push state (record-integrity 4.4) — one derived line on EVERY prompt.
 *
 * 4.1 established the principle: read git rather than log it, because
 * record-hygiene D1 exempts git commands from PostToolUse and a logged push
 * would make the record un-settleable. 4.2 then hung the answer off the
 * parallel-wrap line, and that coupling was the residual defect — a session
 * learned whether its work was pushed ONLY when a sibling happened to end
 * with a write-back inside the window. A long-lived window therefore saw
 * push state once at SessionStart and thereafter by luck.
 *
 * The incident that exposed it: a window had committed a README rewrite, a
 * sibling pushed that commit as part of the 0.13.0 release, and the window
 * had no way to learn it — it had to reconstruct the answer from git log,
 * which is exactly the hand-reasoning 4.2 set out to abolish.
 *
 * Unbinding it is nearly free. The state is refs-only (no subprocess, no
 * commit-graph walk), the line is bounded by construction, and it re-fires
 * statelessly like the drift nudge beside it — repeating a true fact stays
 * cheaper than storing one, and D5 already rejected an "already told you"
 * marker for this family of lines.
 *
 * Repo-level by design: it reports HEAD against origin, never "your
 * commits". Attributing commits to sessions needs the graph walk core/git.ts
 * deliberately avoids, and time-window attribution misreads interleaved
 * parallel sessions. "Is the tip I can see on origin" is the question refs
 * answer honestly, and it is the one that unblocks a session deciding
 * whether to push.
 */
function gitStateLine(git: ReturnType<typeof readGitState>): string | null {
  if (git === null) return null
  if (git.upstream === null) return `sofar: ${git.branch} @ ${git.head}, never pushed.`
  return git.synced
    ? `sofar: ${git.branch} @ ${git.head}, pushed (in sync with origin/${git.branch}).`
    : `sofar: ${git.branch} @ ${git.head}, NOT pushed (origin/${git.branch} at ${git.upstream}).`
}

/**
 * Parallel wrap-ups (record-integrity 4.2) — what OTHER sessions finished
 * while this one was working.
 *
 * This is the line that answers the complaint this initiative started from:
 * a session had no way to learn that a sibling had wrapped up, so a human had
 * to say it out loud in every other window. Everything here is derived —
 * sibling write-backs come from the fold — so it costs no new events and no
 * new stored state. Push state used to ride along on this line; 4.4 moved it
 * to gitStateLine above, which renders unconditionally.
 *
 * Selection is deliberately narrow to stay quiet: only sessions that ENDED
 * with a real write-back (summary present, so a mechanical session_closed
 * does not qualify) inside THIS session's live span. Stateless and
 * re-firing, like the drift nudge it sits beside — there is no "already
 * told you" bit to keep, and repeating a true fact is cheaper than storing
 * one.
 *
 * The window opens at THIS session's last write-back, falling back to its
 * start (0.13.0). Two earlier rules were wrong:
 *  - 0.12.0 used `s.ended >= me.started`, which never closes — a sibling
 *    wrap-up kept being announced for the rest of the session's life.
 *  - 0.12.1 suppressed the line whenever `me.ended` was set, on the theory
 *    that an ended session is not working. That silenced a REAL parallel
 *    wrap-up in this repo (session 3c1146f3 wrapped while another session
 *    was live and nothing was reported), because a session that writes back
 *    mid-conversation and keeps working still has `ended` set. The hook
 *    firing at all is proof the session is alive.
 * Anchoring on the last write-back closes the window the moment you write
 * back and re-opens it for genuinely new sibling activity — the same
 * "since the last write-back" frame the drift counter already uses.
 *
 * That earlier phantom was really the identity split (5.1): the agent's own
 * replacement session id read as a sibling. With one identity per agent
 * there is nothing spurious left to report.
 *
 * Budget order is also deliberate: next_action is composed FIRST and the
 * summary absorbs whatever room is left. The summary is the least actionable
 * part of the line, and rendering it first meant a long one ate the next
 * action entirely (0.12.0 clipped mid-word at "it is f…"). D5 set that order
 * with push state in the reserved tail too; 4.4 moved push state onto its own
 * unconditional line, which only widens the room the summary inherits.
 */
function parallelWrapLine(state: InitiativeState, sessionId: string): string | null {
  const me = state.sessions.find((s) => s.id === sessionId)
  if (me === undefined) return null
  // Since my last write-back, else since I started. A write-back is the point
  // at which I have absorbed what the record holds, so it is the honest
  // boundary for "what changed that I have not accounted for".
  const since = me.ended ?? me.started

  const others = state.sessions
    .filter(
      (s): s is typeof s & { ended: string; summary: string } =>
        s.id !== sessionId && s.ended !== undefined && s.summary !== undefined && s.ended >= since,
    )
    .sort((a, b) => (a.ended < b.ended ? 1 : -1))
  if (others.length === 0) return null

  const newest = others[0]!
  const more = others.length > 1 ? ` (+${others.length - 1} more)` : ''
  const next = newest.next_action !== undefined ? ` — next: ${newest.next_action}` : ''

  // Reserve room for the actionable tail, then give the summary the rest.
  const head = `sofar: session ${newest.id} wrapped while you worked${more} — `
  const tail = `${next}.`
  const room = PARALLEL_WRAP_BUDGET - head.length - tail.length - 2 // 2 = the quotes
  const summary = room > 0 ? clipTo(newest.summary, room) : ''
  const body = summary.length > 0 ? `"${summary}"` : ''
  return clipTo(`${head}${body}${tail}`, PARALLEL_WRAP_BUDGET)
}

/**
 * Guard crossings (drift-hardening D3) — the mechanical tier's ONE user-facing
 * sentence, shared by the prompt line and the Stop message so the thing that
 * warns you and the thing that reports at exit can never word it differently.
 *
 * Composition follows D2 exactly: the rule renders VERBATIM and is never
 * clipped, and everything around it absorbs the budget instead — subjects drop
 * whole with a count pointer, rules beyond the cap drop whole with a pointer at
 * `sofar doctor`. Paths render relative to the repo (hooks log absolute ones),
 * which is exact rather than a truncation; commands, which are neither
 * normative nor bounded, clip like any other budgeted line.
 *
 * What this is NOT: a gate. Nothing here changes an exit code (D3) — the
 * Stop caller only ever appends these lines to a block it had already decided
 * to raise for a missing write-back.
 */
export const GUARD_SUBJECTS_MAX = 3
export const GUARD_RULES_MAX = 2
export const GUARD_CMD_BUDGET = 60

function guardSubject(v: GuardViolation, rootDir: string): string {
  if (v.domain === 'cmd') return clipTo(v.subject, GUARD_CMD_BUDGET)
  const rel = relative(rootDir, v.subject)
  return rel.length > 0 && !rel.startsWith('..') ? rel : v.subject
}

export function guardViolationLines(
  violations: readonly GuardViolation[],
  rootDir: string,
): string[] {
  if (violations.length === 0) return []
  const byRule = new Map<number, GuardViolation[]>()
  for (const v of violations) {
    const group = byRule.get(v.decision) ?? []
    group.push(v)
    byRule.set(v.decision, group)
  }

  const lines: string[] = []
  const ordinals = [...byRule.keys()].sort((a, b) => a - b)
  for (const ordinal of ordinals.slice(0, GUARD_RULES_MAX)) {
    const group = byRule.get(ordinal)!
    const head = group[0]!
    const named = group.slice(0, GUARD_SUBJECTS_MAX).map((v) => guardSubject(v, rootDir))
    const more = group.length > named.length ? ` (+${group.length - named.length} more)` : ''
    lines.push(
      `sofar: [D${ordinal}] guard crossed — "${head.rule}" — ${group.length} event(s): ` +
        `${named.join(', ')}${more} (guard: ${head.guard}).`,
    )
  }
  if (ordinals.length > GUARD_RULES_MAX) {
    lines.push(
      `sofar: …and ${ordinals.length - GUARD_RULES_MAX} more guarded rule(s) crossed — \`sofar doctor\` lists them.`,
    )
  }
  return lines
}

/**
 * Live file conflicts (writeback-collisions 2.1) — the file THIS session is
 * in is also being edited by another live session, right now.
 *
 * The companion to the write-time collision report on sofar_end_session:
 * that one tells you at the end that two threads of work diverged, this one
 * tells you while both are still moving, when scoping away is still cheap.
 * The derivation already existed and fed `sofar doctor` alone, which means
 * it only ever answered for someone who thought to run an audit — never for
 * the agent standing in the file.
 *
 * Narrow on purpose, like the wrap line beside it: only files THIS session
 * has actually touched, and only against siblings the fold still counts as
 * open. It reports a hazard, never a verdict — two sessions in one file is
 * routine when they are editing different regions, and this cannot know
 * which. What it buys is that the second one finds out before the clobber
 * instead of after.
 *
 * Self-closing without any "already told you" state (D5): the sibling
 * leaving the open set — a write-back, or the SessionEnd close — ends the
 * line on its own. Until then it re-fires statelessly, the same bargain the
 * drift nudge and push-state line already make.
 */
function myFileConflicts(state: InitiativeState, sessionId: string): FileConflict[] {
  return openSessionFileConflicts(state, sessionId).filter((c) => c.sessions.includes(sessionId))
}

function fileConflictLine(mine: FileConflict[], sessionId: string): string | null {
  if (mine.length === 0) return null

  const named = mine.slice(0, FILE_CONFLICT_MAX_PATHS).map((c) => {
    const others = c.sessions.filter((id) => id !== sessionId)
    return `${c.path} (session ${others.join(', ')})`
  })
  const more = mine.length > named.length ? ` (+${mine.length - named.length} more)` : ''
  const head = `sofar: ${mine.length} file(s) you touched are ALSO open in another live session — `
  return clipTo(`${head}${named.join('; ')}${more}.`, FILE_CONFLICT_BUDGET)
}

/**
 * The same hazard across the initiative boundary (record-index 2.2,
 * unblocking cross-initiative-conflicts 2.2).
 *
 * The line above stops at the record boundary because its derivation does: the
 * hook folds ONE initiative, so two agents on different branches editing one
 * file were invisible to both. The filesystem does not honour that boundary,
 * and neither does the damage.
 *
 * What blocked it was cost, not doubt. Folding every log on every prompt is
 * O(initiative count) — 18.9ms at 300, 64.1ms at 1000, against a budget the
 * shim already spends 63-67ms of — and the warm gate narrowed the constant
 * without changing the shape. Tier 0 changes the shape: the open set is
 * maintained incrementally by cursors, so this reads a small file and tails
 * only what the logs grew by.
 *
 * Refreshed here rather than merely read. A read-only shim would depend on
 * some other process having maintained the index, and an index nobody
 * refreshes reports an empty open set — silence that reads exactly like "no
 * conflict". D1 forbids that trade: absence must cost time, never correctness,
 * and refreshing is what makes a cold, stale, or deleted index answer right on
 * the first prompt that needs it.
 *
 * Its own try/catch, because this is the youngest thing on the path and the
 * lines below it (git state, the drift nudge) predate it and must not be
 * taken down by it.
 */
function myCrossConflicts(
  sofarDir: string,
  state: InitiativeState,
  slug: string,
  sessionId: string,
): CrossFileConflict[] {
  try {
    const files = openSessionFiles(state, sessionId)
      .filter((p) => p.session === sessionId)
      .map((p) => p.file)
    if (files.length === 0) return []
    return crossConflictsFromOpenSessions(refreshTier0(sofarDir), {
      initiative: slug,
      session: sessionId,
      files,
    })
  } catch {
    return []
  }
}

/**
 * A SEPARATE line from the same-initiative one, for the same reason the peer
 * line is separate: the two are different facts. "Another session in this
 * record" is someone whose write-back you will read; "another initiative" is
 * someone whose write-back lands in a record you never see, so the collision
 * has to be resolved between the two agents or not at all. Naming the
 * initiative is the actionable half — it is what tells you which record to
 * read and which branch the other agent is on.
 *
 * Holders on MY initiative are dropped from the rendering, not from the
 * derivation: they are already named on the line above, and repeating them
 * here would spend this line's budget restating it.
 */
function crossConflictLine(cross: CrossFileConflict[], slug: string): string | null {
  if (cross.length === 0) return null

  const named = cross.slice(0, CROSS_CONFLICT_MAX_PATHS).map((c) => {
    const others = c.holders
      .filter((h) => h.initiative !== slug)
      .map((h) => `${h.session} on ${h.initiative}`)
    return `${c.path} (session ${others.join(', ')})`
  })
  const more = cross.length > named.length ? ` (+${cross.length - named.length} more)` : ''
  const head = `sofar: ${cross.length} file(s) you touched are ALSO open in a live session on ANOTHER initiative — `
  return clipTo(`${head}${named.join('; ')}${more}.`, CROSS_CONFLICT_BUDGET)
}

/**
 * The address for the hazard the line above just reported (peer-messaging 2.1).
 *
 * 2.1 tells you a sibling is in your file; this tells you how to reach it. The
 * conflict line names a session id, which is the right key for the record and
 * useless as an address — so where the host's own registry knows that id as a
 * live Claude Code session, this hands over the name its `SendMessage` tool
 * addresses and stops there. sofar does not send: the agent reading this line
 * is already inside the host that owns the channel, so it can warn its sibling
 * with its own tool, under its own permissions, billed as its own turn.
 *
 * A SEPARATE line rather than more text on the conflict line. The two are
 * different speech acts — one reports a hazard, one offers an action — and
 * folding names into the path list would spend the conflict line's 300-char
 * budget on addresses, clipping the paths that are the more important half.
 * Keeping them apart also makes the degradation exact: when nothing resolves,
 * the conflict line is byte-identical to what shipped before this existed.
 *
 * Silence is the common case and not a failure. The sibling may be on another
 * tool, on another machine, or running a Claude Code without messaging — the
 * registry simply will not know it, and orientation-time reporting stays the
 * only channel, exactly as before. Nothing here may become the mechanism.
 *
 * The closing clause is the jurisdiction rule, placed where it bites: a
 * message is transport, never storage, so whatever comes back has to be
 * recorded or it dies with the session that heard it.
 *
 * It takes session ids rather than conflicts (record-index 2.2) because there
 * are now two hazard lines feeding it and an address does not care which one
 * named the sibling — a cross-initiative collision is exactly the case where
 * messaging matters MOST, since neither agent will ever read the other's
 * write-back. Same-initiative siblings are passed first, so a record with no
 * cross-initiative sibling still renders the byte-identical line.
 */
function reachablePeerLine(others: string[]): string | null {
  if (others.length === 0) return null

  const resolved = resolvePeers(others)
  const found = others
    .map((id) => resolved.get(id))
    .filter((p): p is Peer => p !== undefined)
  if (found.length === 0) return null

  // An ambiguous name reaches more than one live session, so naming it alone
  // would imply a precision we do not have. The host's own tie-breaker is the
  // working directory, so hand that over too and let the agent disambiguate.
  const named = found
    .slice(0, PEER_MAX_NAMES)
    .map((p) => (p.ambiguous ? `"${p.name}" (in ${p.cwd})` : `"${p.name}"`))
  const more = found.length > named.length ? `, +${found.length - named.length} more` : ''

  const one = found.length === 1
  const head = one
    ? 'sofar: that session is live in Claude Code as '
    : 'sofar: those sessions are live in Claude Code as '
  const tail = one
    ? ' — message it if your change affects its work, then RECORD what it says; a message is not in the record.'
    : ' — message them if your change affects their work, then RECORD what they say; a message is not in the record.'
  return clipTo(`${head}${named.join(', ')}${more}${tail}`, PEER_LINE_BUDGET)
}

export function handleUserPrompt(rootDir: string, input: string): HookResult {
  try {
    const sessionId = strField(parseHook(input), 'session_id')
    if (sessionId === null) return { ...OK }

    const bound = resolveBound(rootDir, sessionId)
    if (bound === null) return { ...OK }
    const { ctx, slug } = bound

    const state = ctx.foldState(slug)
    const me = state.sessions.find((s) => s.id === sessionId)
    if (me === undefined) return { ...OK } // not ours to nudge

    // Live hazard first (a sibling is IN this file now), then news (what a
    // sibling finished), then state (where the repo stands), then the nudge
    // (what to do about it). The conflict line leads because it is the only
    // one about work still in motion — the rest report settled facts.
    const lines: string[] = []
    const mine = myFileConflicts(state, sessionId)
    const conflict = fileConflictLine(mine, sessionId)
    if (conflict !== null) lines.push(conflict)

    // Then the same hazard from outside this record, which the fold above
    // structurally cannot see (record-index 2.2). Second because the sibling
    // you share an initiative with is the likelier collision and the cheaper
    // one to resolve — you will at least read each other's write-backs.
    const cross = myCrossConflicts(ctx.sofarDir, state, slug, sessionId)
    const crossLine = crossConflictLine(cross, slug)
    if (crossLine !== null) lines.push(crossLine)

    // Immediately after the hazards, never instead of them: the address is
    // only meaningful once you know what it is for, and the hazard lines still
    // stand alone when no peer resolves.
    const siblings = [
      ...new Set([
        ...mine.flatMap((c) => c.sessions),
        ...cross.flatMap((c) => c.holders.map((h) => h.session)),
      ]),
    ].filter((id) => id !== sessionId)
    const peer = reachablePeerLine(siblings)
    if (peer !== null) lines.push(peer)

    // A crossed rule outranks even the conflict hazard: it is the one line
    // here that says the work already done disagrees with a standing
    // constraint, and it is the surface the mechanical tier actually reaches
    // an agent through — a Stop-only warning would arrive after the fact
    // (D3), and a non-blocking Stop exit is not fed back to the model at all.
    lines.unshift(...guardViolationLines(sessionGuardViolations(state, sessionId, me.ended), rootDir))

    const wrap = parallelWrapLine(state, sessionId)
    if (wrap !== null) lines.push(wrap)

    const gitLine = gitStateLine(readGitState(rootDir))
    if (gitLine !== null) lines.push(gitLine)

    // YOUR debt, not the record's (drift-signal 1.2) — the same number the
    // Stop gate will enforce, so the warning and the block always agree. The
    // line asks THIS session to act, and the initiative-wide total nagged a
    // session that had just written back, for a sibling's edits it could not
    // speak to.
    const debt = sessionDebt(state, me)
    if (debt >= NUDGE_DRIFT_MIN) {
      lines.push(
        `sofar: ${debt} unwritten events in THIS session — if the current batch of work ` +
          `is complete, write back now with sofar_end_session (summary + next action) while context ` +
          `is warm; an unwritten session gets force-blocked at Stop.`,
      )
    }

    return lines.length === 0 ? { ...OK } : { ...OK, stdout: lines.join('\n') }
  } catch {
    return { ...OK }
  }
}

// ---------------------------------------------------------------------------
// `sofar event append` — the convention-dialect surface (task 5.1, BD30).
// ---------------------------------------------------------------------------

export interface AppendArgs {
  /** Event type (SPEC §Event types). */
  type: string
  /** Payload as a raw JSON-object string. */
  payload: string
  /** Envelope session id (dialect callers reuse one id all session). */
  session: string
  /** Envelope source — must name a SOURCES member. */
  source: string
  /** Envelope actor — must name an ACTORS member. */
  actor: string
  /** Optional explicit initiative; else branch → bindings.json (BD16). */
  slug?: string
}

/**
 * Append one validated event and regenerate projections — the surface that
 * lets a tool with NO MCP support (OpenCode, Codex, plain shell) drive the
 * full read → work → write-back loop through the CLI alone (the AGENTS.md
 * dialect). Unlike the hook subcommands above this is NOT best-effort
 * (BD22 exemption): an explicit caller deserves real errors, so any failure
 * exits 1 with the BD17 typed-error JSON on stderr and appends NOTHING.
 * Success prints {ok, event_id} JSON to stdout. All writes go through
 * ToolContext.appendAndProject — validate payload → append → regenerate —
 * the single mutation path.
 */
export function runAppend(rootDir: string, args: AppendArgs): HookResult {
  try {
    if (!(SOURCES as readonly string[]).includes(args.source)) {
      throw new ToolError('invalid_input', `--source must be one of: ${SOURCES.join('|')}`)
    }
    if (!(ACTORS as readonly string[]).includes(args.actor)) {
      throw new ToolError('invalid_input', `--actor must be one of: ${ACTORS.join('|')}`)
    }
    if (args.session.length === 0) {
      throw new ToolError('invalid_input', '--session must be a non-empty session id')
    }

    let payload: unknown
    try {
      payload = JSON.parse(args.payload)
    } catch (err) {
      throw new ToolError(
        'invalid_input',
        `--payload is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    if (!isObj(payload)) {
      throw new ToolError('invalid_input', '--payload must be a JSON object')
    }

    const ctx = createToolContext(rootDir)
    const slug = ctx.resolveInitiative(args.slug)
    // appendAndProject validates the payload against its type's schema BEFORE
    // any write — invalid type/payload throws here with zero appends.
    const event = ctx.appendAndProject(slug, args.type, payload, {
      session: args.session,
      source: args.source as Source,
      actor: args.actor as Actor,
    })
    return { exitCode: 0, stdout: `${JSON.stringify({ ok: true, event_id: event.id })}\n`, stderr: '' }
  } catch (err) {
    const shape =
      err instanceof ToolError
        ? err.toShape()
        : { code: 'io_error', message: err instanceof Error ? err.message : String(err) }
    return { exitCode: 1, stdout: '', stderr: `${JSON.stringify(shape)}\n` }
  }
}

// ---------------------------------------------------------------------------
// Commander wiring — thin: read stdin, run handler, mirror its result.
// ---------------------------------------------------------------------------

export async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '' // run by hand without piped input
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : (chunk as Buffer))
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * The hook name → handler map, exported so the hot-path entry (cli/fast.ts)
 * can dispatch a shim WITHOUT constructing the commander program. One source
 * of truth: registerEventCommand builds its subcommands from this same list,
 * so a hook can never exist on one path and not the other.
 */
export const SUBCOMMANDS: ReadonlyArray<{
  name: string
  description: string
  handler: (rootDir: string, input: string) => HookResult
}> = [
  {
    name: 'session-start',
    description:
      'SessionStart hook: register the session in the log, print the status projection (≤10,000 chars) as injected context',
    handler: handleSessionStart,
  },
  {
    name: 'post-tool',
    description:
      'PostToolUse hook: append mechanical file_touched (Edit|Write|MultiEdit) / command_run (Bash) events',
    handler: handlePostTool,
  },
  {
    name: 'user-prompt',
    description:
      'UserPromptSubmit hook: nudge an in-flow write-back (one additionalContext line) when drift since the last session_ended ≥5 events',
    handler: handleUserPrompt,
  },
  {
    name: 'stop',
    description:
      'Stop hook: exit 2 (blocking) when the registered session has not written back via session_ended; loop-guarded by stop_hook_active',
    handler: handleStop,
  },
  {
    name: 'session-end',
    description: 'SessionEnd hook: append a mechanical session_closed marker (fallback only)',
    handler: handleSessionEnd,
  },
]

/** Mirror a handler result onto the process (stdout/stderr/exit code). */
export function mirror(result: HookResult): void {
  if (result.stdout.length > 0) process.stdout.write(result.stdout)
  if (result.stderr.length > 0) {
    process.stderr.write(result.stderr.endsWith('\n') ? result.stderr : `${result.stderr}\n`)
  }
  process.exitCode = result.exitCode
}

export function registerEventCommand(program: Command): void {
  const event = program
    .command('event')
    .description(
      'append-side surface: hook subcommands read hook JSON from stdin (SPEC §Hooks); `append` is the convention dialect for MCP-less tools',
    )

  event
    .command('append [slug]')
    .description(
      'append one validated event and regenerate projections — the convention-dialect surface for tools without MCP (prints {ok, event_id} JSON)',
    )
    .requiredOption('--type <event_type>', 'event type (SPEC §Event types)')
    .requiredOption('--payload <json>', 'event payload as a JSON object string')
    .option('--session <id>', 'session id recorded on the envelope (reuse one id all session)', 'cli')
    .option('--source <source>', `envelope source: ${SOURCES.join('|')}`, 'cli')
    .option('--actor <actor>', `envelope actor: ${ACTORS.join('|')}`, 'agent')
    .option('--root <dir>', 'repo root containing .sofar/ (default: current directory)')
    .action(
      (
        slug: string | undefined,
        opts: { type: string; payload: string; session: string; source: string; actor: string; root?: string },
      ) => {
        mirror(
          runAppend(resolve(opts.root ?? process.cwd()), {
            type: opts.type,
            payload: opts.payload,
            session: opts.session,
            source: opts.source,
            actor: opts.actor,
            ...(slug !== undefined ? { slug } : {}),
          }),
        )
      },
    )

  for (const { name, description, handler } of SUBCOMMANDS) {
    event
      .command(name)
      .description(description)
      .option('--root <dir>', 'repo root containing .sofar/ (default: current directory)')
      .action(async (opts: { root?: string }) => {
        const input = await readStdin()
        mirror(handler(resolve(opts.root ?? process.cwd()), input))
      })
  }
}
