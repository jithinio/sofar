import { readFileSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import { validateEnvelope, type EventEnvelope } from './envelope'
import {
  activityFromEdges,
  edgesForEvent,
  taskFilesFromEdges,
  type GraphEdge,
  type SessionActivity,
} from './adjacency'
import {
  coerceUnknownPlanStatuses,
  isKnownEventType,
  isResolvedTaskStatus,
  validatePayload,
  type CorrectionPayload,
  type DecisionLoggedPayload,
  type MemoryPromotedPayload,
  type FileTouchedPayload,
  type InitiativeCreatedPayload,
  type InitiativeStatus,
  type InitiativeStatusChangedPayload,
  type NoteAddedPayload,
  type PhaseStatus,
  type PhaseStatusChangedPayload,
  type PlanUpdatedPayload,
  type SessionClosedPayload,
  type SessionEndedPayload,
  type SessionStartedPayload,
  type TaskAddedPayload,
  type TaskStatus,
  type TaskStatusChangedPayload,
} from '@sofar/schema'

/**
 * Fold/replay: events.jsonl → InitiativeState (SPEC §State).
 *
 * Tolerance rules (CLAUDE.md): corrupt or unknown lines are skipped with a
 * warning, never fatal, never rewritten. A torn final line is just a corrupt
 * line. The fold is deterministic — the same log always produces a
 * deep-equal state and identical warnings.
 *
 * Corrections (BD8): a `correction` event voids the event its `ref` points
 * at — the target is skipped during replay. Replacement content, if any, is
 * appended as a fresh event by the corrector.
 */

export interface TaskState {
  id: string
  title: string
  status: TaskStatus
}

export interface PhaseState {
  name: string
  status: PhaseStatus
  tasks: TaskState[]
}

export interface DecisionState {
  id: string
  ts: string
  chose: string
  over: string
  because: string
  /**
   * Standing-constraint clause (drift-hardening D1), when the decision carries
   * one. Render contract: verbatim, never clipped, never aged out.
   */
  rule?: string
}

/** A fact promoted to repo memory — addressable as `<slug> M<n>`. */
export interface MemoryState {
  id: string
  ts: string
  text: string
}

/**
 * The derived-view vocabulary now lives in core/adjacency.ts, below both this
 * fold and the repo-wide graph (record-graph 4.1/4.2) — one emission rule, two
 * consumers. Re-exported here because this module is where the record's
 * readers have always found them.
 */
export {
  ACTIVITY_LIST_CAP,
  TASK_FILES_CAP,
  type GraphEdge,
  type SessionActivity,
} from './adjacency'

export interface SessionState {
  id: string
  tool: string
  model?: string
  started: string
  ended?: string
  summary?: string
  next_action?: string
  /** Reason from the session_closed that set `ended` (BD21/BD44), if any. */
  closed_reason?: string
  /** Present only when ≥1 mechanical event is attributed to this session (BD44). */
  activity?: SessionActivity
  /**
   * Drift THIS session owes (drift-signal 1.1): mutation-class events carrying
   * its id, appended after its OWN last write-back. Same window and same kinds
   * as `freshness` — asked of one session instead of the initiative.
   *
   * The distinction the initiative-wide counter cannot make. "Has the record
   * moved since the next_action was minted" is a question for a READER, and
   * initiative scope answers it correctly. "Do you owe a write-back" is a
   * question for the ACTOR, and initiative scope answers it wrongly in both
   * directions: a sibling's edits nag a session that has nothing to say, and
   * a sibling's write-back used to exempt one that does (speed T1 patched the
   * second direction by OR-ing in `activity` and left the first open).
   * Per-session accounting closes both at once, and the Phase 7
   * independent-gates law then holds by construction rather than by patch.
   *
   * `activity` is the neighbouring derivation and deliberately NOT this: it is
   * cumulative over the whole session and counts commands, so it answers "what
   * did this session do", never "what has it not written down".
   */
  unwritten: number
}

/** One un-absorbed note: appended after the last write-back (notes-in-digest 1.2). */
export interface NoteEntry {
  ts: string
  text: string
}

/**
 * Fold-time freshness (staleness-detection 1.1): how much MECHANICAL record
 * activity landed after the last write-back (session_ended). Derived purely
 * from event order in the log — zero new event types, any source incl. cli.
 * The counts are the drift signal behind "next action may be stale": every
 * counted event postdates the next_action the last write-back recorded.
 *
 * `notes` (notes-in-digest 1.2) carries the CONTENT for the one drift kind
 * that has prose: the counters say THAT the record moved, the notes say WHAT
 * changed. Same selection window as the counters by construction — living in
 * this struct means the session_ended reset clears both together, so signal
 * and content can never disagree. When nothing ever wrote back the window is
 * the whole log: every note is un-absorbed. Log order, uncapped here
 * (notes are hand-written, low-frequency); render surfaces cap and clip.
 */
export interface FreshnessState {
  /** Events appended after the last session_ended, by kind. */
  events_since_writeback: {
    /** file_touched */
    files: number
    /** command_run */
    commands: number
    /** task_status_changed */
    tasks: number
    /** note_added */
    notes: number
    /** decision_logged */
    decisions: number
    /** memory_promoted */
    memories: number
  }
  /**
   * How many of the counted mutations belong to NO registered session
   * (drift-signal 1.2) — envelope session "cli", or an id this log never
   * registered. A cross-cut of the same events, not a seventh kind, so it is
   * never summed into freshnessTotal.
   *
   * This is the drift that has no other candidate writer. A sibling's edits
   * carry its id and are gated on its own Stop; unattributed work — an agent
   * running `sofar update-task` through the shell, where the CLI cannot know
   * the session id — is owed by whoever is still here. Session-scoped gating
   * alone would let it out of the building unwritten.
   */
  unattributed_mutations: number
  /** Notes in the window, {ts, text} in log order — notes.length === counts.notes. */
  notes: NoteEntry[]
  /** ts of the last session_ended, or null when nothing ever wrote back. */
  last_writeback_ts: string | null
}

/**
 * Total drift since the last write-back — the "N events" of the staleness line.
 *
 * `commands` is counted in the struct above but deliberately NOT summed here
 * (drift-signal D1). Speed T1 included command_run on a premise its own record
 * disproves — "pure reads emit no events so they naturally never gate" — when
 * an agent reads through Bash constantly: command_run is 57% of every event in
 * this repo's records, and re-running one test suite eight times registered
 * eight drift. Drift asks whether the recorded next_action is now wrong.
 * Editing a file can make it wrong; `rg`, `sed -n` and `npm test` cannot, so
 * counting them made the warning track how chatty the agent was. The count
 * stays in the struct — the log is still the forensic record of what ran, and
 * describeActivity still reports it per session — it just stops being
 * staleness.
 */
export function freshnessTotal(freshness: FreshnessState): number {
  const c = freshness.events_since_writeback
  return c.files + c.tasks + c.notes + c.decisions + c.memories
}

/**
 * What ONE session owes the record (drift-signal 1.2): its own unwritten
 * mutations, plus the drift no session owns. The single definition the Stop
 * gate and the write-back nudge share, so the thing that blocks you and the
 * thing that warned you can never disagree — the property speed T1 valued in
 * reusing freshnessTotal, kept while fixing what freshnessTotal was measuring.
 *
 * Note what is absent: a sibling's attributed work. That session carries its
 * own debt to its own Stop gate, which is what makes concurrent gates
 * independent (the Phase 7 law) without the OR speed T1 needed.
 */
export function sessionDebt(state: InitiativeState, session: SessionState): number {
  return session.unwritten + state.freshness.unattributed_mutations
}

/**
 * Standing constraints (drift-hardening D1): every decision carrying a
 * `rule`, with its 1-based ordinal in log order — the D<n> handle the
 * citation grammar resolves. The single selector behind the digest section,
 * the full-status section, and the update_task point-of-use reminder, so no
 * surface can disagree with another about what the law says.
 */
export function standingRules(
  decisions: readonly DecisionState[],
): Array<{ ordinal: number; rule: string }> {
  const rules: Array<{ ordinal: number; rule: string }> = []
  decisions.forEach((d, i) => {
    if (d.rule !== undefined) rules.push({ ordinal: i + 1, rule: d.rule })
  })
  return rules
}

export interface InitiativeState {
  slug: string
  goal: string
  /**
   * The initiative's own status. `active` unless an initiative_status_changed
   * event says otherwise, so a log written before that event existed folds
   * exactly as it always did — the default is what makes this additive.
   *
   * Closed-ness is DERIVED (isClosedInitiativeStatus), never stored as a
   * second flag that could disagree with the status it summarises.
   */
  status: InitiativeStatus
  /** ts of the event that set the CURRENT status; null while never set. */
  status_ts: string | null
  /**
   * Reason given with the current status — required for `dropped`, optional
   * for the rest. Reopening (status back to `active`) overwrites both this and
   * status_ts, so they always describe the status actually in force rather
   * than accumulating a closure the record has since undone.
   */
  status_note: string | null
  phases: PhaseState[]
  decisions: DecisionState[]
  /**
   * Facts promoted to repo memory, log order — `M<n>` is index + 1, the same
   * way `D<n>` indexes decisions. Uncapped here (promotions are hand-written
   * and rare); render surfaces cap.
   */
  memories: MemoryState[]
  sessions: SessionState[]
  files_touched: string[]
  /**
   * File-locality hints (speed T4): task id → file paths touched while that
   * task was ACTIVE, deduped, most-recent-first, capped at TASK_FILES_CAP.
   * Derived purely from existing file_touched events at replay time (any
   * session/source, payload-valid, unvoided) — zero new event types; a
   * file_touched attributes to EVERY task active at that point in the log.
   */
  task_files: Record<string, string[]>
  /**
   * Task id → the reason given when it was dropped (task-drop-state D3).
   * A drop is the one way a task closes without being delivered, so the
   * reason is the whole record of it — kept addressable so surfaces can
   * show it and doctor can audit that one was given at all.
   */
  drop_notes: Record<string, string>
  current: {
    active_phase: string | null
    next_action: string | null
    blocked_on?: string
  }
  freshness: FreshnessState
  cursor: string | null
}

/**
 * A task_status_changed that applied to no task: skipped at replay AND its
 * id is absent from the final plan (task 12.2, BD58). Replay-time skips that
 * a later task_added / plan_updated legitimizes (clock-skew ordering,
 * D-sync-1 rider b) are NOT orphans — only ids the plan never knew are the
 * misroute symptom doctor audits for.
 */
export interface OrphanTaskEvent {
  /** ulid of the orphaned task_status_changed event */
  event_id: string
  ts: string
  /** envelope.session of the writer — the misrouted session, if any */
  session: string
  task_id: string
  status: TaskStatus
}

export interface FoldResult {
  state: InitiativeState
  warnings: string[]
  orphan_task_events: OrphanTaskEvent[]
  /**
   * Per-log adjacency (record-graph 4.1/4.2): every edge this log's events
   * contribute, in replay order, slug-qualified and directly unionable into
   * the repo-wide graph. Emitted by the SAME replay that builds the state —
   * `task_files` and each session's `activity` are pure functions of it — so
   * buildGraph joins logs instead of re-walking events, and the
   * "which tasks were active" rule exists once.
   */
  edges: GraphEdge[]
  /**
   * Session ids that appear on events in THIS log but were never registered
   * here by a session_started (record-integrity 2.1). The fold deliberately
   * attaches activity to registered sessions only (BD21/BD44), so before this
   * existed such events were counted by freshness and files_touched while
   * being attributable to no session at all — invisible mass.
   *
   * A non-empty list means events arrived from a session living somewhere
   * else: the misroute signature. Sorted; "cli" is never a session identity
   * and never appears.
   */
  unregistered_sessions: string[]
}

export function emptyState(): InitiativeState {
  return {
    slug: '',
    goal: '',
    status: 'active',
    status_ts: null,
    status_note: null,
    phases: [],
    decisions: [],
    memories: [],
    sessions: [],
    files_touched: [],
    task_files: {},
    drop_notes: {},
    current: { active_phase: null, next_action: null },
    freshness: emptyFreshness(),
    cursor: null,
  }
}

function emptyFreshness(): FreshnessState {
  return {
    events_since_writeback: { files: 0, commands: 0, tasks: 0, notes: 0, decisions: 0, memories: 0 },
    unattributed_mutations: 0,
    notes: [],
    last_writeback_ts: null,
  }
}

export interface ParsedLine {
  lineNo: number
  event: EventEnvelope
}

/**
 * Fold a log file. The file must exist; foldLines is the pure core.
 *
 * The initiative slug comes from the record layout
 * (.sofar/initiatives/<slug>/events.jsonl) rather than from the log's
 * contents: it scopes the emitted adjacency's task node ids, and the
 * directory is what buildGraph unions by — the same identity a
 * misrouted envelope.initiative would disagree with.
 */
export function foldLog(logPath: string): FoldResult {
  return foldLines(readFileSync(logPath, 'utf8').split('\n'), basename(dirname(logPath)))
}

/**
 * Pass 1 in isolation (record-graph 1.2): tolerant decode + correction
 * voiding + the convergent ulid sort, with no state replay. Extracted so the
 * repo-wide graph derivation reuses ONE tolerant decoder instead of forking
 * its own — the graph replays adjacency where the fold replays state, but
 * both must skip the same corrupt lines and honor the same corrections.
 * Voided events are returned (not filtered): the fold still advances its
 * cursor over them, since sync moves events by envelope.
 */
export interface DecodedLog {
  /** Envelope-valid events in ulid order (stable — a duplicated id keeps file order). */
  parsed: ParsedLine[]
  /** Event ids voided by a `correction` (BD8). */
  voided: Set<string>
  /** Decode warnings, in file order (they describe lines, not events). */
  warnings: string[]
}

export function decodeLines(lines: readonly string[]): DecodedLog {
  const warnings: string[] = []
  const parsed: ParsedLine[] = []

  lines.forEach((raw, index) => {
    const lineNo = index + 1
    const line = raw.trim()
    if (line.length === 0) return // blank/trailing lines are not corruption

    let decoded: unknown
    try {
      decoded = JSON.parse(line)
    } catch {
      warnings.push(`line ${lineNo}: unparseable JSON — skipped (torn or corrupt line)`)
      return
    }

    const check = validateEnvelope(decoded)
    if (!check.ok) {
      const detail = check.errors.map((e) => `${e.field}: ${e.message}`).join('; ')
      warnings.push(`line ${lineNo}: invalid envelope (${detail}) — skipped`)
      return
    }

    parsed.push({ lineNo, event: check.event })
  })

  const voided = new Set<string>()
  for (const { event } of parsed) {
    if (event.type !== 'correction') continue
    if (validatePayload('correction', event.payload).ok) {
      voided.add((event.payload as unknown as CorrectionPayload).ref)
    }
  }

  // Convergent fold (task 13.1, D-sync-1): replay order is NORMATIVELY ulid
  // id order, not file order — the same event SET folds to a deep-equal
  // state on every replica, so cross-import and compaction cannot fork
  // states. Stable sort: a duplicated id keeps file order. Pass-1 decode
  // warnings stay in file order (they describe lines, not events).
  parsed.sort((a, b) => (a.event.id < b.event.id ? -1 : a.event.id > b.event.id ? 1 : 0))

  return { parsed, voided, warnings }
}

export function foldLines(lines: readonly string[], slug = ''): FoldResult {
  const { parsed, voided, warnings } = decodeLines(lines)

  // Pass 2 — replay in id order.
  const state = emptyState()
  const blockNotes = new Map<string, string>() // task id → note from its blocking event
  const edges: GraphEdge[] = [] // per-log adjacency, emitted as this replay goes (4.1/4.2)
  const seenSessions = new Set<string>() // every session id on any event (record-integrity 2.1)
  const orphanCandidates: OrphanTaskEvent[] = [] // task 12.2: replay-time skips, filtered against the final plan below

  for (const { lineNo, event } of parsed) {
    // Cursor tracks the last envelope-valid event: sync (export/import)
    // moves events by envelope, regardless of payload validity.
    state.cursor = event.id

    if (voided.has(event.id)) continue

    if (!isKnownEventType(event.type)) {
      warnings.push(`line ${lineNo}: unknown event type "${event.type}" — skipped`)
      continue
    }

    // Forward compat (D2): a plan_updated from a newer engine may carry a
    // status this build cannot read. Coerce those tasks rather than let one
    // of them reject the whole plan — see coerceUnknownPlanStatuses.
    if (event.type === 'plan_updated') {
      for (const c of coerceUnknownPlanStatuses(event.payload)) {
        warnings.push(
          `line ${lineNo}: ${c.path} ("${c.subject}") has status "${c.status}", which this ` +
            `build does not know — counted as pending; upgrade sofar to read it correctly`,
        )
      }
    }

    const payloadCheck = validatePayload(event.type, event.payload)
    if (!payloadCheck.ok) {
      warnings.push(`line ${lineNo}: invalid ${event.type} payload (${payloadCheck.errors.join('; ')}) — skipped`)
      continue
    }

    if (event.session !== 'cli') seenSessions.add(event.session)
    applyEvent(state, event, blockNotes, warnings, lineNo)
    // Adjacency is emitted AFTER applyEvent, against the plan as it now
    // stands: a task_status_changed that activates a task takes effect for
    // the file_touched events that follow it, exactly as the pre-consolidation
    // recordTaskFiles did (it read the same mutated state.phases).
    edges.push(...edgesForEvent(event, slug, activeTaskIds(state)))
    recordFreshness(state, event)

    // Orphan candidate (task 12.2): a task_status_changed that applyEvent
    // just skipped — the id is not (yet) in the plan.
    if (event.type === 'task_status_changed') {
      const p = event.payload as unknown as TaskStatusChangedPayload
      if (findTask(state, p.id) === undefined) {
        orphanCandidates.push({
          event_id: event.id,
          ts: event.ts,
          session: event.session,
          task_id: p.id,
          status: p.status,
        })
      }
    }
  }

  state.task_files = taskFilesFromEdges(edges)
  attachActivity(state, activityFromEdges(edges))
  deriveCurrent(state, blockNotes)
  // Keep only ids the FINAL plan never absorbed (a later task_added /
  // plan_updated clears the candidate — that skip was ordering, not misroute).
  const orphans = orphanCandidates.filter((c) => findTask(state, c.task_id) === undefined)
  const registered = new Set(state.sessions.map((s) => s.id))
  const unregistered = [...seenSessions].filter((id) => !registered.has(id)).sort()
  return { state, warnings, orphan_task_events: orphans, edges, unregistered_sessions: unregistered }
}

/** Task ids ACTIVE right now — the attribution window `worked` edges use. */
function activeTaskIds(state: InitiativeState): string[] {
  const ids: string[] = []
  for (const phase of state.phases) {
    for (const task of phase.tasks) if (task.status === 'active') ids.push(task.id)
  }
  return ids
}

/**
 * Attach derived activity to REGISTERED sessions only — events carrying a
 * session id with no session_started here stay unattached (the same no-stub
 * rule as session_closed, BD21). Registration is a PER-LOG fact and this is
 * the only place it applies: the repo-wide graph deliberately treats a
 * session id as one identity across every log, which is what makes the
 * cross-initiative join possible in the first place.
 */
function attachActivity(state: InitiativeState, derived: Map<string, SessionActivity>): void {
  for (const session of state.sessions) {
    const activity = derived.get(session.id)
    if (activity !== undefined) session.activity = activity
  }
}

// ---------------------------------------------------------------------------
// Fold-time freshness (staleness-detection 1.1).
// ---------------------------------------------------------------------------

/**
 * Count mechanical drift after the last write-back. Runs on payload-valid,
 * unvoided events only (same guard as applyEvent/recordActivity), on ANY
 * session/source including "cli" — a cli-appended task change stales the
 * next_action exactly as an agent edit does. session_ended is the ONLY
 * reset: it is the write-back that mints a new next_action; a mechanical
 * session_closed carries no summary and resets nothing.
 *
 * The SAME pass keeps each session's own `unwritten` debt (drift-signal 1.1),
 * so the two counters can never disagree about what a mutation is or when the
 * window opens — one rule, two scopes. Runs after applyEvent, so a session is
 * already registered (or stubbed) by the time its events reach here; events
 * from a session this log never registered stay unattributed, the same no-stub
 * rule attachActivity follows.
 */
function recordFreshness(state: InitiativeState, event: EventEnvelope): void {
  const counts = state.freshness.events_since_writeback
  const own = state.sessions.find((s) => s.id === event.session)
  /** Count one mutation for the initiative and for whoever must write it back. */
  const mutation = (bump: () => void): void => {
    bump()
    if (own !== undefined) own.unwritten += 1
    else state.freshness.unattributed_mutations += 1
  }

  switch (event.type) {
    case 'session_ended': {
      state.freshness = { ...emptyFreshness(), last_writeback_ts: event.ts }
      // A write-back may name a session other than the envelope's (the MCP
      // tool takes session_id explicitly), and it is the NAMED session whose
      // debt it settles — resolved exactly as applyEvent resolves it.
      const p = event.payload as unknown as SessionEndedPayload
      const ended = state.sessions.find((s) => s.id === (p.session_id ?? event.session))
      if (ended !== undefined) ended.unwritten = 0
      break
    }
    case 'file_touched':
      mutation(() => (counts.files += 1))
      break
    case 'command_run':
      // Counted for the record, never for drift — see freshnessTotal (D1).
      counts.commands += 1
      break
    case 'task_status_changed':
      mutation(() => (counts.tasks += 1))
      break
    case 'note_added':
      mutation(() => (counts.notes += 1))
      state.freshness.notes.push({
        ts: event.ts,
        text: (event.payload as unknown as NoteAddedPayload).text,
      })
      break
    case 'decision_logged':
      mutation(() => (counts.decisions += 1))
      break
    case 'memory_promoted':
      mutation(() => (counts.memories += 1))
      break
  }
}

// ---------------------------------------------------------------------------
// Cross-session derivations (Phase 11, D-P11) — read-only over folded state.
// ---------------------------------------------------------------------------

export interface FileConflict {
  /** A file path touched by more than one still-open session. */
  path: string
  /** The open sessions (started, no write-back) that touched it. */
  sessions: string[]
}

/** A phase whose tasks are all done but that was never marked done (D-P11). */
export interface StalePhase {
  name: string
  /** The lagging status the phase is stuck on — never 'done'. */
  status: PhaseStatus
  /** How many tasks are done (== the phase's task total). */
  tasks_done: number
}

/**
 * Stale-active-phase detection (staleness-detection 1.2): every task in the
 * phase is RESOLVED but the phase itself was never closed — the missing
 * phase_status_changed keeps it presenting as live work. Extracted from
 * doctor's inline D-P11 check so ONE detector feeds both surfaces (doctor
 * WARN + status renders). Empty phases are never stale (nothing was
 * completed); order follows the plan's phase order — deterministic.
 *
 * Resolved means done OR dropped (task-drop-state D1). A phase whose tasks
 * were all dropped is finished with, and an all-dropped phase left pending
 * would otherwise reproduce exactly the false "queued work" signal this
 * whole initiative exists to remove.
 */
export function staleActivePhases(state: InitiativeState): StalePhase[] {
  const stale: StalePhase[] = []
  for (const phase of state.phases) {
    if (phase.status === 'done' || phase.status === 'dropped' || phase.tasks.length === 0) continue
    if (phase.tasks.every((t) => isResolvedTaskStatus(t.status))) {
      stale.push({ name: phase.name, status: phase.status, tasks_done: phase.tasks.length })
    }
  }
  return stale
}

/**
 * Live concurrent-edit hazards: files touched by ≥2 sessions that are still
 * OPEN (session_started with no session_ended/session_closed). Ended sessions
 * are treated as wrapped, so this fires only in the genuine live-overlap
 * window — the "another agent is in this file right now" signal. Deterministic
 * (sorted by path); the "+N more" activity sentinel is not a real file and is
 * skipped.
 *
 * `alsoLiveSessionId` counts one named session as open even though `ended` is
 * set (writeback-collisions 2.1). A session that writes back mid-flight and
 * keeps working has `ended` — the drift nudge actively asks for exactly that
 * — so the plain rule drops it, and the hook surface would go silent for the
 * rest of a session precisely when the agent is most likely to be deep in a
 * file. Only the CALLER may be re-admitted this way, never siblings: the hook
 * firing is proof the caller is alive (the 0.12.1 lesson from
 * parallelWrapLine), whereas a sibling with no session_closed might be a
 * crashed process that would linger as a false conflict forever. Doctor,
 * which asks the same question about sessions it is not, passes nothing and
 * is unaffected.
 */
export function openSessionFileConflicts(
  state: InitiativeState,
  alsoLiveSessionId?: string,
): FileConflict[] {
  const byFile = new Map<string, string[]>()
  for (const session of state.sessions) {
    const live = session.ended === undefined || session.id === alsoLiveSessionId
    if (!live || session.activity === undefined) continue
    for (const file of session.activity.files) {
      if (file.startsWith('+')) continue // the "+N more" overflow sentinel
      const owners = byFile.get(file) ?? []
      owners.push(session.id)
      byFile.set(file, owners)
    }
  }
  const conflicts: FileConflict[] = []
  for (const [path, sessions] of byFile) {
    if (sessions.length >= 2) conflicts.push({ path, sessions })
  }
  conflicts.sort((a, b) => a.path.localeCompare(b.path))
  return conflicts
}

/** A concurrent session's write-back that lost the next_action scalar (task 12.4). */
export interface ParallelWriteback {
  session_id: string
  tool: string
  ended: string
  next_action: string
}

/**
 * Parallel write-backs (task 12.4, BD58 family): current.next_action is a
 * single scalar derived from the last session_ended (BD9), so when
 * concurrent same-initiative sessions each write back, the losers' next
 * actions vanish from every resume surface. This surfaces exactly those:
 * ended sessions with a next_action whose [started, ended] interval
 * OVERLAPS the reference session's — parallel threads of work, not
 * superseded history (a session that ended before the reference started is
 * sequential; its next action lost on purpose). Duplicates of the
 * reference's text are agreement, not a collision, and are dropped.
 * Deterministic: newest-ended first.
 *
 * The reference defaults to the WINNER — max (ended, array order) among
 * next_action-bearing sessions — which is what the read surfaces want: the
 * scalar a resuming agent is about to trust, plus what it swallowed.
 *
 * `referenceSessionId` pins a different session instead, for the write-time
 * surface (writeback-collisions 1.2): sofar_end_session answers "what
 * differs from what I JUST wrote", and the caller is not reliably the
 * winner — same-millisecond `ended` timestamps are common (one process, one
 * clock tick), and ties are broken by state.sessions order, which follows
 * session_started, not who appended last. Asking the fold who won would
 * make the answer depend on that unrelated ordering. An id that names no
 * next_action-bearing session falls back to the winner.
 */
export function overlappingWritebacks(
  state: InitiativeState,
  referenceSessionId?: string,
): ParallelWriteback[] {
  const wrapped = state.sessions.filter(
    (s): s is SessionState & { ended: string; next_action: string } =>
      s.ended !== undefined && s.next_action !== undefined,
  )
  if (wrapped.length < 2) return []
  let reference =
    referenceSessionId === undefined
      ? undefined
      : wrapped.find((s) => s.id === referenceSessionId)
  if (reference === undefined) {
    reference = wrapped[0]!
    for (const s of wrapped) {
      if (s.ended >= reference.ended) reference = s
    }
  }
  const ref = reference
  return wrapped
    .filter(
      (s) =>
        s !== ref &&
        s.next_action !== ref.next_action &&
        s.started <= ref.ended &&
        s.ended >= ref.started,
    )
    .sort((a, b) => (a.ended < b.ended ? 1 : a.ended > b.ended ? -1 : 0))
    .map((s) => ({ session_id: s.id, tool: s.tool, ended: s.ended, next_action: s.next_action }))
}

function findTask(state: InitiativeState, id: string): TaskState | undefined {
  for (const phase of state.phases) {
    const task = phase.tasks.find((t) => t.id === id)
    if (task) return task
  }
  return undefined
}

function findOrCreatePhase(
  state: InitiativeState,
  name: string,
  warnings: string[],
  lineNo: number,
): PhaseState {
  let phase = state.phases.find((p) => p.name === name)
  if (!phase) {
    warnings.push(`line ${lineNo}: phase "${name}" not in plan — created implicitly`)
    phase = { name, status: 'pending', tasks: [] }
    state.phases.push(phase)
  }
  return phase
}

function applyEvent(
  state: InitiativeState,
  event: EventEnvelope,
  blockNotes: Map<string, string>,
  warnings: string[],
  lineNo: number,
): void {
  switch (event.type) {
    case 'initiative_created': {
      const p = event.payload as unknown as InitiativeCreatedPayload
      state.slug = p.slug
      state.goal = p.goal
      break
    }
    case 'initiative_status_changed': {
      const p = event.payload as unknown as InitiativeStatusChangedPayload
      state.status = p.status
      state.status_ts = event.ts
      state.status_note = p.note ?? null
      break
    }
    case 'plan_updated': {
      const p = event.payload as unknown as PlanUpdatedPayload
      if (p.plan.goal !== undefined) state.goal = p.plan.goal
      state.phases = p.plan.phases.map((phase) => ({
        name: phase.name,
        status: phase.status ?? 'pending',
        tasks: phase.tasks.map((task) => ({
          id: task.id,
          title: task.title,
          status: task.status ?? 'pending',
        })),
      }))
      break
    }
    case 'phase_status_changed': {
      const p = event.payload as unknown as PhaseStatusChangedPayload
      const phase = findOrCreatePhase(state, p.phase, warnings, lineNo)
      phase.status = p.status
      break
    }
    case 'task_added': {
      const p = event.payload as unknown as TaskAddedPayload
      if (findTask(state, p.id)) {
        warnings.push(`line ${lineNo}: task "${p.id}" already exists — task_added skipped`)
        break
      }
      const phase = findOrCreatePhase(state, p.phase, warnings, lineNo)
      phase.tasks.push({ id: p.id, title: p.title, status: p.status ?? 'pending' })
      break
    }
    case 'task_status_changed': {
      const p = event.payload as unknown as TaskStatusChangedPayload
      const task = findTask(state, p.id)
      if (!task) {
        warnings.push(`line ${lineNo}: task "${p.id}" not found — task_status_changed skipped`)
        break
      }
      task.status = p.status
      if (p.status === 'blocked' && p.note) {
        blockNotes.set(p.id, p.note)
      } else if (p.status !== 'blocked') {
        blockNotes.delete(p.id)
      }
      // A drop's reason is retained; un-dropping the task discards it, so a
      // task that gets revived does not carry a stale justification.
      if (p.status === 'dropped') {
        state.drop_notes[p.id] = p.note ?? ''
      } else {
        delete state.drop_notes[p.id]
      }
      break
    }
    case 'decision_logged': {
      const p = event.payload as unknown as DecisionLoggedPayload
      state.decisions.push({
        id: event.id,
        ts: event.ts,
        chose: p.chose,
        over: p.over,
        because: p.because,
        // Absent stays absent — a missing rule must not serialize as a key.
        ...(p.rule !== undefined ? { rule: p.rule } : {}),
      })
      break
    }
    case 'memory_promoted': {
      const p = event.payload as unknown as MemoryPromotedPayload
      state.memories.push({ id: event.id, ts: event.ts, text: p.text })
      break
    }
    case 'session_started': {
      const p = event.payload as unknown as SessionStartedPayload
      if (state.sessions.some((s) => s.id === event.session)) {
        warnings.push(`line ${lineNo}: session "${event.session}" already started — skipped`)
        break
      }
      const session: SessionState = {
        id: event.session,
        tool: p.tool,
        started: event.ts,
        unwritten: 0,
      }
      if (p.model !== undefined) session.model = p.model
      state.sessions.push(session)
      break
    }
    case 'session_ended': {
      const p = event.payload as unknown as SessionEndedPayload
      const sid = p.session_id ?? event.session
      let session = state.sessions.find((s) => s.id === sid)
      if (!session) {
        warnings.push(`line ${lineNo}: session "${sid}" ended without session_started — stub created`)
        session = { id: sid, tool: 'unknown', started: event.ts, unwritten: 0 }
        state.sessions.push(session)
      }
      session.ended = event.ts
      session.summary = p.summary
      session.next_action = p.next_action
      state.current.next_action = p.next_action
      break
    }
    case 'session_closed': {
      // Mechanical close (SessionEnd hook fallback): sets ended only (plus
      // the close reason for the 7.2 derived resume line, BD44). Never
      // touches summary/next_action — those belong to session_ended (the
      // write-back), and never creates stub sessions (a close marker for an
      // unregistered session carries no information).
      const p = event.payload as unknown as SessionClosedPayload
      const session = state.sessions.find((s) => s.id === event.session)
      if (!session) {
        warnings.push(
          `line ${lineNo}: session "${event.session}" closed without session_started — skipped`,
        )
        break
      }
      if (session.ended === undefined) {
        session.ended = event.ts
        session.closed_reason = p.reason
      }
      break
    }
    case 'file_touched': {
      const p = event.payload as unknown as FileTouchedPayload
      if (!state.files_touched.includes(p.path)) state.files_touched.push(p.path)
      break
    }
    case 'command_run':
    case 'note_added':
    case 'correction':
      // Log-only for state purposes: commands and notes live in the record
      // (projections may surface them); corrections were applied in pass 1.
      break
  }
}

function deriveCurrent(state: InitiativeState, blockNotes: Map<string, string>): void {
  const active = state.phases.find((p) => p.status === 'active')
  state.current.active_phase = active ? active.name : null

  const blocked: string[] = []
  for (const phase of state.phases) {
    if (phase.status === 'blocked') blocked.push(`phase ${phase.name}`)
    for (const task of phase.tasks) {
      if (task.status === 'blocked') {
        const note = blockNotes.get(task.id)
        blocked.push(note ? `task ${task.id}: ${note}` : `task ${task.id} (${task.title})`)
      }
    }
  }
  if (blocked.length > 0) {
    state.current.blocked_on = blocked.join('; ')
  }
}
