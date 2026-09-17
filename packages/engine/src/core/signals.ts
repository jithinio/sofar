import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { diagnosticsDir } from './diagnostics'
import type { StateEnv } from './state-dir'

/**
 * Signal availability map (self-improve 1.3, SPEC §Diagnostics store).
 *
 * The audit's finding S1: the improvement loop was promised signals the log
 * cannot yield, and a miner that treats a missing signal as zero produces
 * confident nonsense. So every signal the loop may ever consume is listed
 * HERE, once, with what it is derived from and what must be true for it to
 * be derivable — and a consumer asks this module before it reports a number.
 * What this module calls `unavailable` a consumer prints as UNKNOWN, never as
 * zero, never as "no failures".
 *
 * Two layers. The STATIC layer is the contract: for each signal, its best
 * possible status and the reason it can never be better than that
 * (`partial` = derivable with a stated blind spot; `unavailable` = nothing in
 * this design observes it). The LIVE layer degrades the static status against
 * the actual clone: hooks not installed, the failure shim not wired, the
 * diagnostics store refused. A signal is `capturable` only when both agree.
 *
 * The map is code, not prose, so that a `tune --dry-run` (Phase 2) cannot
 * drift from it: the test pins the id set, and the CLI renders this list.
 */

export type SignalStatus = 'capturable' | 'partial' | 'unavailable'

export type SignalSource = 'record' | 'diagnostics' | 'git' | 'index' | 'none'

/** Environmental facts a signal may depend on. */
export type SignalRequirement =
  | 'post_tool_hook'
  | 'post_tool_failure_hook'
  | 'session_start_hook'
  | 'diagnostics_store'
  | 'driven_run'

export interface SignalSpec {
  id: string
  /** The question the signal answers, as a consumer would print it. */
  question: string
  source: SignalSource
  /** Best achievable status when every requirement is met. */
  ceiling: SignalStatus
  /** Why the ceiling is what it is — the blind spot, stated. */
  reason: string
  requires: readonly SignalRequirement[]
}

export interface SignalAvailability extends SignalSpec {
  /** Ceiling degraded by unmet requirements on THIS clone. */
  status: SignalStatus
  /** Requirements not met here, in declaration order. */
  missing: readonly SignalRequirement[]
}

export interface SignalEnvironment {
  post_tool_hook: boolean
  post_tool_failure_hook: boolean
  session_start_hook: boolean
  diagnostics_store: boolean
  /** Always true here: whether a signal applies is per RUN, and the run is what says so. */
  driven_run: boolean
}

export const SIGNALS: readonly SignalSpec[] = [
  {
    id: 'tool_success',
    question: 'Did a recorded command or edit succeed?',
    source: 'record',
    ceiling: 'capturable',
    reason:
      'command_run/file_touched carry ok:true since self-improve 1.2 (host fired PostToolUse). Events before that, or from an engine without capture, have no ok field: report UNKNOWN per event, never success.',
    requires: ['post_tool_hook'],
  },
  {
    id: 'tool_failure',
    question: 'Did a recorded command or edit fail, and with what exit status?',
    source: 'record',
    ceiling: 'capturable',
    reason:
      'Claude Code fires PostToolUse only on exit 0, so failures reach the record ONLY through the PostToolUseFailure shim (ok:false, exit). A clone without that shim has no failing commands in its record — absence is not success.',
    requires: ['post_tool_failure_hook'],
  },
  {
    id: 'exit_status_on_success',
    question: 'What exit status did a SUCCESSFUL command return?',
    source: 'record',
    ceiling: 'partial',
    reason:
      'Recorded only when the host puts a numeric exit_code in tool_response. Claude Code transcripts observed 2026-09-15 carried none on success (stdout, stderr, interrupted only), so most successes have ok:true and no exit — read exit as UNKNOWN, not 0.',
    requires: ['post_tool_hook'],
  },
  {
    id: 'error_text',
    question: 'What did a failing tool call say?',
    source: 'diagnostics',
    ceiling: 'partial',
    reason:
      'tool_failure rows hold stderr then the host summary, redacted and clipped to 512 characters. Never in the record. A clipped or redacted row is evidence of a failure class, not of its full text.',
    requires: ['post_tool_failure_hook', 'diagnostics_store'],
  },
  {
    id: 'mcp_rejections',
    question: 'How often are sofar MCP calls rejected, and with which typed code?',
    source: 'diagnostics',
    ceiling: 'partial',
    reason:
      'mcp_call rows are written by the sofar server for its OWN tools only; other MCP servers are never observed. A rejection appends nothing to the record, so the record alone shows zero rejections regardless of the truth.',
    requires: ['diagnostics_store'],
  },
  {
    id: 'bookkeeping_share',
    question: 'What share of the agent\'s calls were sofar/git bookkeeping?',
    source: 'diagnostics',
    ceiling: 'partial',
    reason:
      'Numerator: exempt command rows (git, sofar) plus mcp_call rows. Denominator: tool_outcome rows (Edit|Write|MultiEdit|Bash only) plus sofar mcp_call rows. Read, Grep, Glob, WebFetch, subagents and other MCP servers never fire the hook, so the share is an UPPER bound on the observed subset, never the true share.',
    requires: ['post_tool_hook', 'diagnostics_store'],
  },
  {
    id: 'read_only_tool_calls',
    question: 'How many Read/Grep/Glob and other non-mutating calls did a session make?',
    source: 'none',
    ceiling: 'unavailable',
    reason:
      'The PostToolUse matcher is Edit|Write|MultiEdit|Bash by design (record-hygiene D1 keeps reads out of the record); widening it would put every read on the 100ms hook path. Nothing observes these calls.',
    requires: [],
  },
  {
    id: 'duplicate_session_starts',
    question: 'Did one session register itself more than once?',
    source: 'record',
    ceiling: 'capturable',
    reason:
      'Count session_started lines per session id over the RAW valid events — the fold deduplicates them, so a folded state hides exactly this. Classify separately from corrupt lines.',
    requires: [],
  },
  {
    id: 'corrections',
    question: 'How many events were corrected, and which?',
    source: 'record',
    ceiling: 'partial',
    reason:
      'correction events and their targets are observable. WHY is not: a correction of a shell-mangled write-back and a legitimate change of mind are the same event. Report the count and the targets; never label the cause.',
    requires: [],
  },
  {
    id: 'stalls',
    question: 'How often did a driven session end without a usable handoff?',
    source: 'record',
    ceiling: 'partial',
    reason:
      'handoff{reason: stall} and run_stopped{reason: stall} are recorded for driven runs only. A launch the driver could not attribute to a session records a stall too (session-driver D3), but a manual session that wedged records nothing — absence outside a run is not "no stalls".',
    requires: ['driven_run'],
  },
  {
    id: 'formatter_friction',
    question: 'Did an agent edit a formatter or MCP config file it should not have needed to?',
    source: 'record',
    ceiling: 'partial',
    reason:
      'file_touched paths (biome.json, .prettierrc, .mcp.json, …) are observable. Whether the edit was friction or intended is not; the fix-side signal is r1-fixes 1.4\'s doctor check, not this path list.',
    requires: ['post_tool_hook'],
  },
  {
    id: 'injection_bytes',
    question: 'How much did SessionStart put in front of the model, and how much of it was repo memory?',
    source: 'diagnostics',
    ceiling: 'capturable',
    reason:
      'injection rows: bytes of the whole hook stdout and of the repo-memory portion. Bytes, not tokens — tokenization is the host\'s, and sofar never calls a model to count.',
    requires: ['session_start_hook', 'diagnostics_store'],
  },
  {
    id: 'memory_use',
    question: 'Was a promoted memory USED by the sessions it was injected into?',
    source: 'index',
    ceiling: 'unavailable',
    reason:
      'Only "no observed citation" is derivable (reach index citations in recorded prose) and it does not mean unused: an agent follows an injected rule without citing it. Usefulness is UNKNOWN by design; never delete or demote a memory on frequency alone.',
    requires: [],
  },
  {
    id: 'historical_digest_bytes',
    question: 'How large was the digest a PAST session actually saw?',
    source: 'none',
    ceiling: 'unavailable',
    reason:
      'Re-rendering an event prefix with today\'s renderer yields a SIMULATED digest: the renderer version, repo.md contents, git state and session identity of the time are not in the record. Forward-looking injection rows are the honest substitute.',
    requires: [],
  },
  {
    id: 'hook_latency',
    question: 'How long did each hook take on the agent\'s critical path?',
    source: 'none',
    ceiling: 'unavailable',
    reason:
      'Hooks record no timing of their own; speed T2\'s 100ms budget is pinned by a CI latency test, not observed in the field. Adding a timer is a later task with its own cost measurement.',
    requires: [],
  },
  {
    id: 'session_cost',
    question: 'What did a session cost in tokens or dollars?',
    source: 'record',
    ceiling: 'partial',
    reason:
      'handoff.tokens is recorded only for driven runs whose adapter reports usage (claude-code yes, codex no — session-driver D9); cost_usd is not recorded at all (rejected in session-driver). Manual sessions have no cost signal anywhere in sofar.',
    requires: ['driven_run'],
  },
]

/** Read the clone's hook wiring and store state — the facts the live layer degrades against. */
export function readSignalEnvironment(rootDir: string, env: StateEnv = process.env): SignalEnvironment {
  // Claude Code's settings or Cursor's hooks.json, from either shim home — a
  // repo set up for Cursor alone keeps its shims under .cursor/hooks/sofar/
  // (r1-fixes 7.1, D36).
  const configs = [join(rootDir, '.claude', 'settings.json'), join(rootDir, '.cursor', 'hooks.json')]
    .map((path) => (existsSync(path) ? safeRead(path) : ''))
    .join('\n')
  const wired = (shim: string): boolean =>
    configs.includes(`.claude/hooks/${shim}`) || configs.includes(`.cursor/hooks/sofar/${shim}`)
  return {
    post_tool_hook: wired('post-tool-use.sh'),
    post_tool_failure_hook: wired('post-tool-use-failure.sh'),
    session_start_hook: wired('session-start.sh'),
    diagnostics_store: diagnosticsDir(rootDir, env) !== null,
    driven_run: true,
  }
}

function safeRead(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

/** The static contract degraded against one environment. */
export function signalAvailability(environment: SignalEnvironment): SignalAvailability[] {
  return SIGNALS.map((spec) => {
    const missing = spec.requires.filter((req) => !environment[req])
    return { ...spec, missing, status: missing.length > 0 ? 'unavailable' : spec.ceiling }
  })
}

/** One signal by id, or null when the id is not in the map — a consumer asking for an unlisted signal is a bug. */
export function signalById(id: string, environment: SignalEnvironment): SignalAvailability | null {
  return signalAvailability(environment).find((s) => s.id === id) ?? null
}

export const REQUIREMENT_LABELS: Record<SignalRequirement, string> = {
  post_tool_hook: 'PostToolUse shim wired in .claude/settings.json',
  post_tool_failure_hook: 'PostToolUseFailure shim wired in .claude/settings.json (sofar init on ≥ the version that ships it)',
  session_start_hook: 'SessionStart shim wired in .claude/settings.json',
  diagnostics_store: 'diagnostics store not refused (XDG_STATE_HOME outside the repo)',
  driven_run: 'applies to sofar drive runs only',
}

/** Plain-text rendering for `sofar diagnostics --signals` — byte-plain, one signal per block. */
export function renderSignals(list: readonly SignalAvailability[]): string {
  const counts = { capturable: 0, partial: 0, unavailable: 0 }
  for (const s of list) counts[s.status]++
  const lines = [
    `signals: ${list.length} — ${counts.capturable} capturable, ${counts.partial} partial, ${counts.unavailable} unavailable`,
    'a consumer prints UNKNOWN for anything not capturable; partial means derivable with the stated blind spot',
    '',
  ]
  for (const s of list) {
    lines.push(`${s.id} [${s.status}] — ${s.question}`)
    lines.push(`  source: ${s.source}; ceiling: ${s.ceiling}`)
    lines.push(`  ${s.reason}`)
    if (s.missing.length > 0) {
      lines.push(`  missing here: ${s.missing.map((m) => REQUIREMENT_LABELS[m]).join('; ')}`)
    }
    lines.push('')
  }
  return `${lines.join('\n').trimEnd()}\n`
}
