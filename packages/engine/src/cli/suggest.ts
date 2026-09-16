import type { EventEnvelope } from '../core/envelope'
import { readEvents } from '../core/cursor'
import { appendEvent } from '../core/log'
import { makeEvent } from '../core/envelope'
import { initiativeSlugs } from '../core/listing'
import { readSignalEnvironment, signalAvailability } from '../core/signals'
import {
  checkVerb,
  deriveCandidates,
  proposedPayload,
  renderSuggestions,
  suggestionStates,
  type SuggestionState,
  type Verb,
} from '../core/suggest'
import { detect, TUNE_EVIDENCE_SHOWN, TUNE_REPORT_VERSION } from '../core/tune'
import { readDiagnostics } from '../core/diagnostics'
import { version as ENGINE_VERSION } from '../../package.json'
import { createToolContext, ToolError } from '../mcp/context'
import { errMessage, fail, ok, type CmdResult } from './shared'

/**
 * `sofar suggest` (SPEC §Suggestions, self-improve 2.3).
 *
 * `--dry-run` derives loss rows from the TRUSTED detectors and prints them,
 * writing nothing. Every persisting path is an explicit verb — `record`,
 * `approve`, `reject`, `revert` — so a shell history says plainly which
 * invocation changed the record. The lifecycle rules (staleness, suppression
 * of rejected equivalents, the open cap) live in core/suggest.ts; this file
 * reads the log, obeys the answer, and appends one event.
 */

export interface SuggestOptions {
  slug?: string
  dryRun?: boolean
  all?: boolean
  json?: boolean
  list?: boolean
  reason?: string
  session?: string
}

/** Every initiative's raw events — the whole repo, since a candidate is found by hash. */
function readAll(ctx: ReturnType<typeof createToolContext>): {
  events: Map<string, readonly EventEnvelope[]>
  warnings: string[]
} {
  const events = new Map<string, readonly EventEnvelope[]>()
  const warnings: string[] = []
  for (const slug of initiativeSlugs(ctx.sofarDir)) {
    const read = readEvents(ctx.eventsPath(slug))
    events.set(slug, read.events)
    for (const w of read.warnings) warnings.push(`${slug}: ${w}`)
  }
  return { events, warnings }
}

function statesFor(rootDir: string, ctx: ReturnType<typeof createToolContext>, scope: readonly string[] | null): {
  states: SuggestionState[]
  warnings: string[]
} {
  const { events, warnings } = readAll(ctx)
  const inScope = new Map(scope === null ? events : [...events].filter(([slug]) => scope.includes(slug)))
  const rows = readDiagnostics(rootDir).rows.filter((r) => inScope.has(r.initiative))
  const report = detect({ events: inScope, rows, signals: signalAvailability(readSignalEnvironment(rootDir)) })
  return { states: suggestionStates(deriveCandidates(report), events), warnings }
}

/** `sofar suggest [slug] --dry-run|--list [--all] [--json]` — reads only. */
export function runSuggest(rootDir: string, options: SuggestOptions = {}): CmdResult {
  const listing = options.list === true
  if (!listing && options.dryRun !== true) {
    return fail(
      'sofar suggest: reading requires `--dry-run` (derive candidates) or `--list` (the recorded ones) — both write nothing; `record`, `approve`, `reject` and `revert` are the verbs that write.',
    )
  }
  const ctx = createToolContext(rootDir)
  let scope: string[] | null
  try {
    scope = options.all === true ? null : [ctx.resolveInitiative(options.slug)]
  } catch (err) {
    if (err instanceof ToolError) return fail(`sofar suggest: ${err.message} (usage: sofar suggest [slug|--all] --dry-run)`)
    return fail(`sofar suggest: ${errMessage(err)}`)
  }
  try {
    const { states, warnings } = statesFor(rootDir, ctx, scope)
    const inScope = states.filter((s) => scope === null || scope.includes(s.scope))
    // --dry-run answers "what does the record support now"; --list adds the
    // ones already recorded, including those whose evidence has moved.
    const shown = listing ? inScope : inScope.filter((s) => s.derived !== undefined)
    const warn = warnings.map((w) => `warning: ${w}`).join('\n')
    if (options.json === true) {
      return ok(`${JSON.stringify({ version: TUNE_REPORT_VERSION, engine: ENGINE_VERSION, suggestions: shown })}\n`, warn)
    }
    return ok(renderSuggestions(shown, TUNE_EVIDENCE_SHOWN), warn)
  } catch (err) {
    return fail(`sofar suggest: ${errMessage(err)}`)
  }
}

const NEEDS_REASON: ReadonlySet<Verb> = new Set(['reject', 'revert'])

const PAST: Readonly<Record<Verb, string>> = {
  record: 'recorded',
  approve: 'approved',
  reject: 'rejected',
  revert: 'reverted',
}

const EVENT_OF: Readonly<Record<Verb, string>> = {
  record: 'suggestion_proposed',
  approve: 'suggestion_approved',
  reject: 'suggestion_rejected',
  revert: 'suggestion_reverted',
}

/** `sofar suggest <verb> <candidate>` — the only paths that write. */
export function runSuggestVerb(rootDir: string, verb: Verb, candidateId: string, options: SuggestOptions = {}): CmdResult {
  if (NEEDS_REASON.has(verb) && (options.reason ?? '').trim().length === 0) {
    return fail(`sofar suggest ${verb}: --reason is required — a ${verb} nobody explained reads as an accident`)
  }
  const ctx = createToolContext(rootDir)
  try {
    const { states, warnings } = statesFor(rootDir, ctx, null)
    const verdict = checkVerb(verb, candidateId, states)
    if (!verdict.ok) return fail(`sofar suggest ${verb}: ${verdict.message}`)
    const state = verdict.state
    // checkVerb has already refused `record` for a candidate the record no
    // longer derives, so this is the narrowing, not a second rule.
    const derived = state.derived
    if (verb === 'record' && derived === undefined) {
      return fail(`sofar suggest record: candidate ${state.candidate} is no longer derivable`)
    }
    const payload: Record<string, unknown> =
      derived !== undefined && verb === 'record'
        ? { ...proposedPayload(derived, ENGINE_VERSION, TUNE_REPORT_VERSION) }
        : { candidate: state.candidate, ...(options.reason !== undefined ? { reason: options.reason } : {}) }
    const event = makeEvent({
      initiative: state.scope,
      session: options.session ?? 'cli',
      source: 'cli',
      actor: 'human',
      type: EVENT_OF[verb],
      payload,
    })
    appendEvent(ctx.eventsPath(state.scope), event)
    const lines = [`${PAST[verb]} ${state.candidate} — ${state.signal} in ${state.scope} (${event.id})`]
    if (verb === 'record') lines.push('a loss row, not a fix: nothing is applied, and Phase 3 is what turns an approved row into work')
    const warn = [...(verdict.warning !== undefined ? [`warning: ${verdict.warning}`] : []), ...warnings.map((w) => `warning: ${w}`)].join('\n')
    return ok(`${lines.join('\n')}\n`, warn)
  } catch (err) {
    if (err instanceof ToolError) return fail(`sofar suggest ${verb}: ${err.message}`)
    return fail(`sofar suggest ${verb}: ${errMessage(err)}`)
  }
}
