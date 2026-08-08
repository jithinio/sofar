import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { isClosedInitiativeStatus, isResolvedTaskStatus } from '@sofar/schema'
import { join, relative } from 'node:path'
import {
  foldLog,
  openSessionFileConflicts,
  staleActivePhases,
  type InitiativeState,
  type OrphanTaskEvent,
} from '../core/fold'
import { readBindingsFile } from '../core/bindings'
import { crossConflictsFromStates } from '../core/cross-conflicts'
import { buildGraph, extractCitations, repoGeneral } from '../core/graph'
import { clip } from '../projections/templates/shared'
import {
  AGENTS_PROTOCOL_BLOCK,
  classifyProtocolBlock,
  hookCommand,
  PROTOCOL_BLOCK,
  SHIMS,
  SHIPPED_AGENTS_PROTOCOL_BLOCKS,
  SHIPPED_PROTOCOL_BLOCKS,
} from './init'
import {
  cssExcludesSofar,
  detectTailwindV4,
  findTailwindCssEntries,
  insertSofarExclusion,
  sofarExclusionDirective,
  sofarScanBaseDirective,
  SOURCE_NOT_SINCE,
  type TailwindV4Detection,
} from './scanners'
import { errMessage, fail, ok, type CmdResult } from './shared'
import {
  createSpinner,
  createStyle,
  padEndVisible,
  stderrCaps,
  stdoutCaps,
  symbolsFor,
  visibleWidth,
  type Caps,
  type SpinnerStream,
  type Style,
} from './ui'

/**
 * `sofar doctor [--fix]` (tasks 10.2/10.3 + 11.1/11.2/11.3) — audit a host repo:
 *   1. wiring integrity  — did init's artifacts survive? (shims, settings,
 *      .mcp.json, protocol blocks)
 *   2. record health     — logs fold without stub sessions or corrupt lines;
 *      no STALE PHASES (all tasks done but phase still open, 11.1); no
 *      UNTRACKED WORK (a wrapped session with real file activity but zero task
 *      changes — work missing from the plan, 11.3)
 *   3. concurrency        — no file under concurrent edit by ≥2 OPEN sessions
 *      (live clobber risk, 11.2)
 *   3b. decision guards   — has any work crossed a guarded rule (drift-hardening
 *      D3)? WARN only: a guard never moves an exit code, this one included.
 *   4. repo memory        — is every decision the record TREATS as repo-wide
 *      (cited from other initiatives, record-graph 2.3/3.3) named in the
 *      hand-written .sofar/repo.md? Both halves: decisions OBSERVED repo-general
 *      by cross-initiative citation, and facts DECLARED so by `sofar remember`
 *      (repo-memory-capture D1). Detection only: repo.md is never written.
 *   5. scanner hazards    — will a tree-wide class scanner (Tailwind v4)
 *      ingest .sofar/ because the entry stylesheet lacks a `@source not`
 *      exclusion?
 *
 * --fix is scoped to the ONE deterministic, safe repair (D-P10): inserting the
 * `@source not` exclusion after the `@import "tailwindcss"` line in each
 * unprotected entry stylesheet. Wiring gaps are reported, never auto-repaired
 * (re-run `sofar init` for those); the fix never touches record prose. It is
 * additionally version-gated (scanner-version-gate D1): `@source not` needs Tailwind >= 4.1, so
 * on 4.0.x — or when the resolved version cannot be established — the hazard is
 * reported with the pre-4.1 remedy and nothing is written.
 *
 * Exit code: 1 when any FAIL-level finding remains after fixes (so CI can gate
 * on it); 0 on a clean repo. WARN findings surface without failing.
 *
 * Rendering (cli-ui 2.4) is capability-gated: `caps.color` picks the styled
 * report (✓/⚠/✗ level marks, bold sections, dim └ hints) — the styled layout
 * is inherently color-coded (D1), so piped/NO_COLOR output keeps the
 * pre-styling plain bytes. A scan spinner covers the tree walk on stderr.
 */

export interface DoctorOptions {
  /** Apply the safe scanner fix (@source not insertion). */
  fix?: boolean
}

/** Progress channel for the tree-scan spinner — injectable for tests. */
export interface DoctorProgress {
  /** Spinner caps (default: stderrCaps() — progress lives on stderr). */
  caps?: Caps
  /** Spinner sink (default: process.stderr). */
  stream?: SpinnerStream
}

type Level = 'ok' | 'warn' | 'fail'

interface Finding {
  level: Level
  text: string
  /** Optional indented follow-up line (a fix suggestion or detail). */
  hint?: string
}

interface Section {
  title: string
  findings: Finding[]
}

const MARKER: Record<Level, string> = { ok: '  ok  ', warn: '  WARN', fail: '  FAIL' }

// ---------------------------------------------------------------------------
// 1. Wiring integrity.
// ---------------------------------------------------------------------------

function fileHas(path: string, needle: string): boolean {
  if (!existsSync(path)) return false
  try {
    return readFileSync(path, 'utf8').includes(needle)
  } catch {
    return false
  }
}

function mcpHasSofar(rootDir: string): boolean {
  const path = join(rootDir, '.mcp.json')
  if (!existsSync(path)) return false
  try {
    const cfg = JSON.parse(readFileSync(path, 'utf8')) as unknown
    return (
      typeof cfg === 'object' &&
      cfg !== null &&
      typeof (cfg as Record<string, unknown>).mcpServers === 'object' &&
      (cfg as { mcpServers: Record<string, unknown> }).mcpServers !== null &&
      'sofar' in (cfg as { mcpServers: Record<string, unknown> }).mcpServers
    )
  } catch {
    return false
  }
}

function auditWiring(rootDir: string): Section {
  const findings: Finding[] = []
  const repair = 'run `sofar init` to (re)install it'

  const bindings = join(rootDir, '.sofar', 'bindings.json')
  findings.push(
    existsSync(bindings)
      ? { level: 'ok', text: '.sofar/bindings.json present' }
      : { level: 'fail', text: '.sofar/bindings.json missing', hint: repair },
  )

  const missingShims = SHIMS.filter(
    (shim) => !existsSync(join(rootDir, '.claude', 'hooks', shim.file)),
  ).map((shim) => shim.file)
  findings.push(
    missingShims.length === 0
      ? { level: 'ok', text: `hook shims installed (${SHIMS.length}/${SHIMS.length})` }
      : { level: 'fail', text: `hook shims missing: ${missingShims.join(', ')}`, hint: repair },
  )

  const settingsPath = join(rootDir, '.claude', 'settings.json')
  const missingHooks = SHIMS.filter((shim) => !fileHas(settingsPath, hookCommand(shim.file))).map(
    (shim) => shim.event,
  )
  findings.push(
    missingHooks.length === 0
      ? { level: 'ok', text: '.claude/settings.json hooks wired' }
      : { level: 'fail', text: `.claude/settings.json missing hooks: ${missingHooks.join(', ')}`, hint: repair },
  )

  findings.push(
    mcpHasSofar(rootDir)
      ? { level: 'ok', text: '.mcp.json sofar server registered' }
      : { level: 'fail', text: '.mcp.json sofar server not registered', hint: repair },
  )

  // Presence is not enough (speed-2 T6): a block installed by an older sofar
  // keeps directing agents by the old protocol forever, and nothing else in the
  // repo reveals it — `sofar upgrade` replaces the binary, not repo wiring.
  for (const { file, template, shipped } of [
    { file: 'CLAUDE.md', template: PROTOCOL_BLOCK, shipped: SHIPPED_PROTOCOL_BLOCKS },
    { file: 'AGENTS.md', template: AGENTS_PROTOCOL_BLOCK, shipped: SHIPPED_AGENTS_PROTOCOL_BLOCKS },
  ]) {
    const path = join(rootDir, file)
    const text = existsSync(path) ? readFileSync(path, 'utf8') : ''
    switch (classifyProtocolBlock(text, template, shipped)) {
      case 'current':
        findings.push({ level: 'ok', text: `${file} protocol block current` })
        break
      case 'stale':
        findings.push({
          level: 'warn',
          text: `${file} protocol block is from an older sofar`,
          hint: 'run `sofar init` to refresh it',
        })
        break
      case 'customized':
      case 'unterminated':
        // Not a fault — an edited block is the user's. Say so, so a repo that
        // silently misses protocol updates is at least visible.
        findings.push({
          level: 'warn',
          text: `${file} protocol block is customized — sofar will not refresh it`,
          hint: 'compare it against a fresh `sofar init` in a scratch repo',
        })
        break
      default:
        findings.push({ level: 'fail', text: `${file} protocol block missing`, hint: repair })
    }
  }

  return { title: 'Wiring integrity', findings }
}

// ---------------------------------------------------------------------------
// 2. Record health.
// ---------------------------------------------------------------------------

/** Below this many files, a session touching them without task changes is noise, not untracked work. */
const UNTRACKED_FILE_THRESHOLD = 3

interface Folded {
  slug: string
  state?: InitiativeState
  warnings: string[]
  orphans: OrphanTaskEvent[]
  /** Session ids seen on events here but never registered here (2.1). */
  unregistered: string[]
  error?: string
}

function listInitiatives(rootDir: string): string[] {
  const dir = join(rootDir, '.sofar', 'initiatives')
  if (!existsSync(dir)) return []
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
  } catch {
    return []
  }
}

/** Fold every initiative with a log ONCE — record + concurrency checks share the result. */
function foldInitiatives(rootDir: string): Folded[] {
  return listInitiatives(rootDir)
    .filter((slug) => existsSync(join(rootDir, '.sofar', 'initiatives', slug, 'events.jsonl')))
    .map((slug) => {
      const logPath = join(rootDir, '.sofar', 'initiatives', slug, 'events.jsonl')
      try {
        const result = foldLog(logPath)
        return {
          slug,
          state: result.state,
          warnings: result.warnings,
          orphans: result.orphan_task_events,
          unregistered: result.unregistered_sessions,
        }
      } catch (err) {
        return { slug, warnings: [], orphans: [], unregistered: [], error: errMessage(err) }
      }
    })
}

/** Real (non-sentinel) file count from a session's derived activity. */
function realFileCount(files: string[]): number {
  return files.filter((f) => !f.startsWith('+')).length
}

function auditRecords(folded: Folded[]): Section {
  const findings: Finding[] = []
  if (folded.length === 0) {
    findings.push({ level: 'ok', text: 'no initiative logs yet — nothing to fold' })
    return { title: 'Record health', findings }
  }
  // Citation resolution needs the sibling slugs, so a cross-initiative
  // reference in a drop reason ("felt-cost D3") counts as cited.
  const knownSlugs = folded.map((f) => f.slug)

  for (const { slug, state, warnings, orphans, error } of folded) {
    if (error !== undefined || state === undefined) {
      findings.push({ level: 'fail', text: `${slug}: cannot read log — ${error ?? 'unknown error'}` })
      continue
    }
    const before = findings.length

    // Stub sessions (BD21): session_ended with no session_started.
    const stubs = state.sessions.filter((s) => s.tool === 'unknown').map((s) => s.id)
    if (stubs.length > 0) {
      findings.push({
        level: 'warn',
        text: `${slug}: ${stubs.length} stub session(s) — session_ended without session_started`,
        hint: `ids: ${stubs.join(', ')} (a hook or agent wrote back without registering the session)`,
      })
    }

    // Fold warnings (corrupt/unknown lines) — tolerated by design, surfaced here.
    if (warnings.length > 0) {
      findings.push({ level: 'warn', text: `${slug}: ${warnings.length} fold warning(s)`, hint: warnings[0]! })
    }

    // Stale phase (task 11.1): all tasks done but the phase never marked
    // done — detection extracted to core (staleness-detection 1.2) so the
    // status renders share it; the WARN text here is unchanged.
    for (const stale of staleActivePhases(state)) {
      findings.push({
        level: 'warn',
        text: `${slug}: phase "${stale.name}" — all ${stale.tasks_done} tasks done but phase still ${stale.status}`,
        hint: 'emit phase_status_changed to mark it done, else it keeps showing as the active phase',
      })
    }

    // Unexplained drop (task-drop-state 4.1): `dropped` closes a task without
    // delivering it, so the reason is the only record that a decision was made
    // at all. The tool refuses an empty note, but a log can predate that rule
    // or be written by hand — and a reason citing no decision leaves the
    // "why" wherever the author's context went. Cite-checked, not just present.
    for (const [taskId, note] of Object.entries(state.drop_notes)) {
      const cited = extractCitations(note, slug, knownSlugs).length > 0
      if (note.trim() === '') {
        findings.push({
          level: 'warn',
          text: `${slug}: task "${taskId}" dropped with no reason`,
          hint: 'a drop with no stated reason reads as forgotten rather than decided — re-emit task_status_changed with a note',
        })
      } else if (!cited) {
        findings.push({
          level: 'warn',
          text: `${slug}: task "${taskId}" dropped citing no decision`,
          hint: `reason recorded ("${note.slice(0, 60)}${note.length > 60 ? '…' : ''}") but it points at no D<n> — log the decision and cite it, so the drop survives the author's context`,
        })
      }
    }

    // Untracked work (task 11.3): a wrapped session that did real file work but
    // touched no plan task — its work is not reflected in the phase tree. Only
    // ended sessions (an open one may still add tasks); deterministic, so it
    // catches purely-untracked sessions, not mixed ones.
    for (const s of state.sessions) {
      if (s.ended === undefined || s.activity === undefined) continue
      if (realFileCount(s.activity.files) >= UNTRACKED_FILE_THRESHOLD && s.activity.task_changes.length === 0) {
        findings.push({
          level: 'warn',
          text: `${slug}: session ${s.id} touched ${realFileCount(s.activity.files)} files but changed no plan tasks`,
          hint: 'either the work is not tracked as tasks, or its tasks landed on a sibling session — adopt the hook session via start_session so files + task changes stay together',
        })
      }
    }

    // Misroute symptom (task 12.2, BD58): task_status_changed events whose id
    // the plan never absorbed — until now they only fold-warned generically.
    // A cluster of them usually means another initiative's task ids landed
    // here via a branch-switch misroute. One WARN per distinct orphan id.
    const byTask = new Map<string, OrphanTaskEvent[]>()
    for (const o of orphans) {
      const group = byTask.get(o.task_id) ?? []
      group.push(o)
      byTask.set(o.task_id, group)
    }
    for (const [taskId, group] of byTask) {
      const last = group[group.length - 1]!
      findings.push({
        level: 'warn',
        text: `${slug}: ${group.length} task event(s) for "${taskId}" — no such task in the plan`,
        hint: `possible misroute from another initiative (session ${last.session}, last event ${last.event_id}) — correct the event(s) or add the task`,
      })
    }

    if (findings.length === before) findings.push({ level: 'ok', text: `${slug}: folds clean` })
  }
  return { title: 'Record health', findings }
}

/** One session's footprint in one initiative (record-integrity 2.1). */
interface Footprint {
  slug: string
  registered: boolean
  /** Registered here and not yet ended — the split is still moving (3.2). */
  open: boolean
}

/**
 * Split sessions (record-integrity 2.1/2.2) — one session id with events in
 * more than one initiative. This is data corruption, not hygiene, so it
 * reports at FAIL: the session's work is torn across records and no single
 * fold can show it whole.
 *
 * Two shapes, both caught here:
 *  - TORN — registered (session_started) in ≥2 initiatives. Its MCP writes
 *    and its hook writes went to different logs.
 *  - LEAKED — events in an initiative that never registered it, so the fold
 *    attributes them to nobody while they still inflate that initiative's
 *    freshness counters and files_touched.
 *
 * Phase 1 stops new splits at the source (writes now follow the session home),
 * so severity grades by LIVENESS rather than shape (D3): a split whose
 * sessions have all ENDED is settled history — unrepairable by construction,
 * since no event carries a self-evident misplacement marker — and reports at
 * WARN so it stays visible without permanently failing the audit. A split
 * with a session still OPEN is a pre-fix session actively tearing right now,
 * and reports at FAIL. Deterministic: sessions sorted by id, footprints by
 * slug.
 */
/**
 * Initiative lifecycle (initiative-lifecycle 4.3) — the two ways a record's
 * status and its surroundings fall out of step.
 *
 * Both are the initiative-level mirror of checks that already exist one level
 * down: a stale ACTIVE phase whose tasks are all resolved, and a drop with no
 * stated reason. The same false signal reads worse up here — a whole record
 * that looks like live work when it is finished is what every orienting
 * surface then repeats.
 */
function auditLifecycle(rootDir: string, folded: Folded[]): Section {
  const findings: Finding[] = []

  let bindings: Record<string, unknown> = {}
  try {
    bindings = readBindingsFile(join(rootDir, '.sofar', 'bindings.json'))
  } catch {
    bindings = {} // malformed — auditWiring owns that finding, not this one
  }

  for (const { slug, state } of folded) {
    if (state === undefined) continue

    // Closing unbinds every branch, so a bound branch on a closed record means
    // something put it back: a hand-edit, or a merge that resurrected the
    // entry. Re-running close is the repair — it is idempotent by design.
    if (isClosedInitiativeStatus(state.status)) {
      const bound = Object.keys(bindings)
        .filter((branch) => bindings[branch] === slug)
        .sort()
      if (bound.length > 0) {
        findings.push({
          level: 'warn',
          text: `${slug}: closed (${state.status}) but still bound to ${bound.map((b) => `"${b}"`).join(', ')}`,
          hint: `a new session on that branch would land on finished work — re-run \`sofar close ${slug}\` (idempotent) or \`sofar switch ${slug}\` to reopen it`,
        })
      }
      continue
    }

    // Every phase resolved but the initiative never closed — the mirror of the
    // stale-phase axis, one level up. Nothing remains to do, yet the record
    // still counts as live everywhere: `sofar next` lists it, the statusline
    // shows it, and a fresh session resumes work that is over.
    if (state.phases.length > 0 && state.phases.every((p) => isResolvedTaskStatus(p.status))) {
      findings.push({
        level: 'warn',
        text: `${slug}: all ${state.phases.length} phase(s) resolved but the initiative is still active`,
        hint: `nothing remains, yet it still reads as live work everywhere — close it with \`sofar close ${slug}\``,
      })
    }
  }

  if (findings.length === 0) {
    findings.push({ level: 'ok', text: 'no closed initiative still bound, no finished record left open' })
  }
  return { title: 'Initiative lifecycle', findings }
}

function auditSplitSessions(folded: Folded[]): Section {
  const footprints = new Map<string, Footprint[]>()
  const add = (id: string, slug: string, registered: boolean, open = false): void => {
    if (id === 'cli') return
    const list = footprints.get(id) ?? []
    list.push({ slug, registered, open })
    footprints.set(id, list)
  }
  for (const { slug, state, unregistered } of folded) {
    if (state !== undefined) {
      for (const s of state.sessions) add(s.id, slug, true, s.ended === undefined)
    }
    for (const id of unregistered) add(id, slug, false)
  }

  const findings: Finding[] = []
  const split = [...footprints.entries()]
    .filter(([, list]) => list.length > 1)
    .sort(([a], [b]) => a.localeCompare(b))

  for (const [id, list] of split) {
    list.sort((a, b) => a.slug.localeCompare(b.slug))
    const homes = list.filter((f) => f.registered).map((f) => f.slug)
    const leaked = list.filter((f) => !f.registered).map((f) => f.slug)
    const shape = homes.length > 1 ? 'torn' : 'leaked'
    const live = list.some((f) => f.open)
    let hint: string
    if (homes.length > 1) {
      hint = `registered in ${homes.join(', ')} — its writes were split across ${homes.length} records`
    } else if (homes.length === 1) {
      hint = `registered in ${homes[0]!}; events also landed in ${leaked.join(', ')} where it is unknown`
    } else {
      hint = `registered nowhere; events landed in ${leaked.join(', ')} — no log claims this session`
    }
    hint += live
      ? ' — this session is still OPEN: end it before more events tear'
      : ' — settled history (all sessions ended); the write pin prevents new splits'
    findings.push({
      level: live ? 'fail' : 'warn',
      text: `session ${id} spans ${list.length} initiatives (${shape}${live ? ', live' : ', history'}): ${list.map((f) => f.slug).join(', ')}`,
      hint,
    })
  }

  if (findings.length === 0) {
    findings.push({ level: 'ok', text: 'no session spans more than one initiative' })
  }
  return { title: 'Session routing', findings }
}

/**
 * Decision guards (drift-hardening D3) — the retrospective half of the
 * mechanical tier. The hooks warn a session about its OWN crossings while it
 * works; this axis answers the other question, over the whole record: which
 * guarded rules has this initiative's work crossed, by whom, and where.
 *
 * WARN, never FAIL — a guard is advisory by construction (D3), and doctor's
 * exit code is the same exit code the rule says a violation must not move.
 * The rule text is reproduced VERBATIM (D2): this is a surface, so the
 * never-clip contract binds it exactly as it binds the digest.
 */
function auditGuards(rootDir: string, folded: Folded[]): Section {
  const findings: Finding[] = []
  let guarded = 0
  for (const { slug, state } of folded) {
    if (state === undefined) continue
    guarded += state.decisions.filter((d) => d.guard !== undefined).length
    for (const v of state.guard_violations) {
      const rel = relative(rootDir, v.subject)
      const where = v.domain === 'path' && rel.length > 0 && !rel.startsWith('..') ? rel : v.subject
      findings.push({
        level: 'warn',
        text: `${slug}: [D${v.decision}] guard crossed — ${where}`,
        hint: `"${v.rule}" (guard: ${v.guard}; session ${v.session}, event ${v.event_id})`,
      })
    }
  }
  if (findings.length === 0) {
    findings.push({
      level: 'ok',
      text:
        guarded === 0
          ? 'no decision carries a guard'
          : `no work crosses any of the ${guarded} guarded rule(s)`,
    })
  }
  return { title: 'Decision guards', findings }
}

function auditConcurrency(folded: Folded[]): Section {
  const findings: Finding[] = []
  let conflictTotal = 0
  for (const { slug, state } of folded) {
    if (state === undefined) continue
    for (const c of openSessionFileConflicts(state)) {
      conflictTotal++
      findings.push({
        level: 'warn',
        text: `${slug}: ${c.path} — touched by ${c.sessions.length} open sessions`,
        hint: `sessions ${c.sessions.join(', ')} are both in-flight on this file (concurrent-edit / clobber risk)`,
      })
    }
  }
  // The boundary the per-slug loop above cannot see (cross-initiative-conflicts
  // 3.1). A clobber is physical: two agents in one file overwrite each other
  // whether or not they serve the same record, and until now NOTHING reported
  // that — the hook folds a single slug, and the loop above detects per-slug.
  //
  // Ungated here on purpose. core/graph.ts's law is that cross-record
  // derivations stay off the hot path because a shim can afford one log where
  // this reads N; doctor is the other side of that bargain — an audit, run on
  // demand, where the exhaustive answer is the whole point and milliseconds
  // are not. So however narrow the live surfaces are, the complete answer
  // always exists behind one command.
  const states = folded.filter((f): f is Folded & { state: InitiativeState } => f.state !== undefined)
  const crossed = crossConflictsFromStates(states)
  for (const c of crossed) {
    conflictTotal++
    findings.push({
      level: 'warn',
      text: `${c.path} — held across ${c.initiatives.length} initiatives (${c.initiatives.join(', ')})`,
      hint: `${c.holders.map((h) => `${h.session} in ${h.initiative}`).join('; ')} — a clobber does not respect the initiative boundary`,
    })
  }

  if (conflictTotal === 0) {
    findings.push({ level: 'ok', text: 'no files under concurrent edit by multiple open sessions' })
  }
  return { title: 'Concurrency', findings }
}

// ---------------------------------------------------------------------------
// 3. Repo memory — repo-general decisions absent from .sofar/repo.md.
// ---------------------------------------------------------------------------

/**
 * Repo-generality is OBSERVED, not declared (record-graph 2.3): a decision
 * cited FROM initiatives other than its own is repo-general by behaviour.
 * Such a decision is repo-wide law that a new session only meets if the
 * hand-written repo.md — the one file every SessionStart injects — names it.
 *
 * DETECTION ONLY. repo.md is hand-written per SPEC §Record layout and sofar
 * never generates or rewrites it; both the curation and the SessionStart
 * token budget are the author's. So this reports and stops at WARN.
 *
 * "Names it" is literal, and deliberately the record's OWN citation grammar:
 * a QUALIFIED handle, `<slug> D<n>`. Prose matching would be inference (D3)
 * and would go stale the moment either text is reworded; the qualified handle
 * is stable, greppable, and the same form the decisions cite each other by.
 * Unqualified `D<n>` cannot count — repo.md has no home initiative, so the
 * handle would be ambiguous across every log in the repo.
 */
function auditRepoMemory(rootDir: string, folded: Folded[]): Section {
  const findings: Finding[] = []
  const graph = buildGraph(rootDir)
  const general = repoGeneral(graph)
  // The DECLARED half (repo-memory-capture D1): operational knowledge whose
  // repo-wide scope its author knew at capture time. Observation cannot reach
  // it — a fact that was never written down produces no citation behaviour to
  // read — so promotion is what puts it in front of this axis at all.
  const promoted = folded.flatMap(({ slug, state }) =>
    (state?.memories ?? []).map((memory, index) => ({
      slug,
      ordinal: index + 1,
      text: memory.text,
    })),
  )

  if (general.length === 0 && promoted.length === 0) {
    findings.push({
      level: 'ok',
      text: 'nothing observed as repo-general and nothing promoted (no decision cited from outside its own initiative, no memory_promoted events)',
    })
    return { title: 'Repo memory', findings }
  }

  const repoMd = join(rootDir, '.sofar', 'repo.md')
  let prose = ''
  try {
    prose = readFileSync(repoMd, 'utf8')
  } catch {
    // Missing or unreadable repo.md names nothing — every finding below fires,
    // which is the honest answer (init writes the stub; a deleted one is a gap).
  }
  const named = new Set(
    extractCitations(prose, '', listInitiatives(rootDir), { memories: true })
      .filter((c) => c.qualified)
      .map((c) => `${c.slug} ${c.handle}`),
  )

  for (const decision of general) {
    const handle = `${decision.initiative} D${decision.ordinal}`
    if (named.has(handle)) continue
    findings.push({
      level: 'warn',
      text: `${handle} is repo-general — cited from ${decision.cited_by.join(', ')} — but .sofar/repo.md never names it`,
      hint: `chose: ${clip(decision.chose, 120)} — write it into repo.md by hand, citing \`${handle}\` (sofar never generates repo.md)`,
    })
  }
  for (const memory of promoted) {
    const handle = `${memory.slug} M${memory.ordinal}`
    if (named.has(handle)) continue
    findings.push({
      level: 'warn',
      text: `${handle} was promoted to repo memory but .sofar/repo.md never names it`,
      hint: `${clip(memory.text, 120)} — write it into repo.md by hand, citing \`${handle}\` (sofar never generates repo.md)`,
    })
  }
  if (findings.length === 0) {
    const parts: string[] = []
    if (general.length > 0) {
      parts.push(`${general.length} repo-general decision${general.length === 1 ? '' : 's'}`)
    }
    if (promoted.length > 0) {
      parts.push(`${promoted.length} promoted ${promoted.length === 1 ? 'memory' : 'memories'}`)
    }
    findings.push({ level: 'ok', text: `all ${parts.join(' and ')} named in .sofar/repo.md` })
  }
  return { title: 'Repo memory', findings }
}

// ---------------------------------------------------------------------------
// 4. Scanner hazards (+ --fix).
// ---------------------------------------------------------------------------

interface ScanProgress {
  caps: Caps
  stream?: SpinnerStream
}

/**
 * The tree walk is doctor's one genuinely long step (every other check is a
 * handful of stats/reads), so the scan spinner wraps exactly this — and ONLY
 * when stderr can animate (a real TTY): piped/CI runs must stay byte-identical
 * to the unstyled command, so the spinner kernel's static-line fallback is
 * skipped too (the same policy as the upgrade spinner).
 */
function scanEntries(rootDir: string, progress: ScanProgress): string[] {
  if (!progress.caps.animate) return findTailwindCssEntries(rootDir)
  const spinner = createSpinner({
    caps: progress.caps,
    text: 'scanning tree for Tailwind entry stylesheets',
    useCase: 'scan',
    ...(progress.stream !== undefined ? { stream: progress.stream } : {}),
  }).start()
  let entries: string[]
  try {
    entries = findTailwindCssEntries(rootDir)
  } catch (err) {
    spinner.fail(`tree scan failed — ${errMessage(err)}`)
    throw err
  }
  spinner.succeed(
    `tree scan: ${entries.length} Tailwind entry stylesheet${entries.length === 1 ? '' : 's'}`,
  )
  return entries
}

/**
 * Why `--fix` is withheld, and what to do instead. `@source not` landed in
 * Tailwind 4.1; on 4.0.x it parses as an unquoted path and breaks the build,
 * so the hazard is still reported but the write never happens (scanner-version-gate D1). The
 * escape hatch we name works on 4.0: narrowing the import's scan base.
 */
function sourceNotUnavailableHint(
  tw: TailwindV4Detection,
  cssFile: string,
  rootDir: string,
): string {
  const found =
    tw.installed !== undefined
      ? `tailwindcss ${tw.installed} installed`
      : `tailwindcss ${tw.range} declared, not installed — resolved version unknown`
  return `${found}; \`@source not\` needs >= ${SOURCE_NOT_SINCE}, so --fix would break your build — upgrade tailwindcss and rerun, or narrow the scan base by hand: \`${sofarScanBaseDirective(cssFile, rootDir)}\` (relative to this stylesheet; templates outside it stop being scanned)`
}

function auditScanners(rootDir: string, fix: boolean, progress: ScanProgress): Section {
  const findings: Finding[] = []
  const tw = detectTailwindV4(rootDir)
  if (!tw.v4) {
    findings.push({ level: 'ok', text: 'no tree-wide class scanner detected (Tailwind v4 absent)' })
    return { title: 'Scanner hazards', findings }
  }

  const entries = scanEntries(rootDir, progress)
  if (entries.length === 0) {
    findings.push({
      level: 'warn',
      text: `Tailwind v4 present (tailwindcss ${tw.range}) but no \`@import "tailwindcss"\` entry stylesheet found`,
      hint: 'if you add one, run `sofar doctor --fix` to exclude .sofar from scanning',
    })
    return { title: 'Scanner hazards', findings }
  }

  for (const entry of entries) {
    const rel = relative(rootDir, entry)
    let content: string
    try {
      content = readFileSync(entry, 'utf8')
    } catch (err) {
      findings.push({ level: 'fail', text: `${rel}: cannot read — ${errMessage(err)}` })
      continue
    }
    if (cssExcludesSofar(content, entry, rootDir)) {
      findings.push({ level: 'ok', text: `${rel}: excludes .sofar from Tailwind scanning` })
      continue
    }
    if (fix && tw.sourceNot) {
      const { content: next, changed } = insertSofarExclusion(content, entry, rootDir)
      if (changed) {
        try {
          writeFileSync(entry, next, 'utf8')
        } catch (err) {
          findings.push({ level: 'fail', text: `${rel}: fix failed — ${errMessage(err)}` })
          continue
        }
        findings.push({
          level: 'ok',
          text: `${rel}: added \`${sofarExclusionDirective(entry, rootDir)}\``,
        })
        continue
      }
    }
    findings.push({
      level: 'fail',
      text: `${rel}: Tailwind v4 will scan .sofar/ — no \`@source not\` exclusion`,
      hint: !tw.sourceNot
        ? sourceNotUnavailableHint(tw, entry, rootDir)
        : fix
          ? 'could not place the exclusion (no `@import "tailwindcss"` line to anchor on)'
          : `fix: sofar doctor --fix   (or add \`${sofarExclusionDirective(entry, rootDir)}\` after the import)`,
    })
  }
  return { title: 'Scanner hazards', findings }
}

// ---------------------------------------------------------------------------
// Command.
// ---------------------------------------------------------------------------

interface Tally {
  fails: number
  warns: number
  fixesApplied: number
}

function tallyOf(sections: Section[]): Tally {
  const tally: Tally = { fails: 0, warns: 0, fixesApplied: 0 }
  for (const section of sections) {
    for (const f of section.findings) {
      if (f.level === 'fail') tally.fails++
      if (f.level === 'warn') tally.warns++
      if (f.level === 'ok' && f.text.includes('added `@source not')) tally.fixesApplied++
    }
  }
  return tally
}

/** Summary fragments, each count colored by its own severity (identity when plain). */
function summaryParts(tally: Tally, style: Style): string[] {
  const parts: string[] = []
  if (tally.fixesApplied > 0) {
    parts.push(style.success(`${tally.fixesApplied} fix${tally.fixesApplied === 1 ? '' : 'es'} applied`))
  }
  parts.push(
    tally.fails === 0
      ? style.success('no problems found')
      : style.error(`${tally.fails} problem${tally.fails === 1 ? '' : 's'} found`),
  )
  if (tally.warns > 0) parts.push(style.warn(`${tally.warns} warning${tally.warns === 1 ? '' : 's'}`))
  return parts
}

/** The pre-cli-ui plain report — the piped/NO_COLOR contract, byte-stable. */
function renderPlain(rootDir: string, sections: Section[], tally: Tally): string {
  const lines: string[] = [`sofar doctor — ${rootDir}`, '']
  for (const section of sections) {
    lines.push(`${section.title}:`)
    for (const f of section.findings) {
      lines.push(`${MARKER[f.level]}  ${f.text}`)
      if (f.hint !== undefined) lines.push(`          ${f.hint}`)
    }
    lines.push('')
  }
  lines.push(`sofar doctor: ${summaryParts(tally, createStyle(false)).join(', ')}`)
  return `${lines.join('\n')}\n`
}

/** Styled report (cli-ui 2.4): ✓/⚠/✗ level marks, bold sections, dim └ hints. */
function renderStyled(rootDir: string, sections: Section[], tally: Tally, caps: Caps): string {
  const style = createStyle(true)
  const sym = symbolsFor(caps.unicode)
  const mark: Record<Level, string> = {
    ok: style.success(sym.ok),
    warn: style.warn(sym.warn),
    fail: style.error(sym.fail),
  }
  // ASCII fallback marks are uneven (√ / !! / ×) — pad so finding texts stay columnar.
  const markWidth = Math.max(...[sym.ok, sym.warn, sym.fail].map((s) => visibleWidth(s)))
  const lines: string[] = [`${style.bold('sofar doctor')} ${style.dim(`— ${rootDir}`)}`, '']
  for (const section of sections) {
    lines.push(style.bold(`${section.title}:`))
    for (const f of section.findings) {
      lines.push(`  ${padEndVisible(mark[f.level], markWidth)} ${f.text}`)
      if (f.hint !== undefined) {
        lines.push(style.dim(`${' '.repeat(markWidth + 3)}${sym.elbow} ${f.hint}`))
      }
    }
    lines.push('')
  }
  lines.push(style.bold(`sofar doctor: ${summaryParts(tally, style).join(', ')}`))
  return `${lines.join('\n')}\n`
}

export function runDoctor(
  rootDir: string,
  options: DoctorOptions = {},
  caps: Caps = stdoutCaps(),
  progress: DoctorProgress = {},
): CmdResult {
  const fix = options.fix === true
  if (!existsSync(join(rootDir, '.sofar'))) {
    return fail('sofar doctor: no .sofar/ record here — run `sofar init` first')
  }

  const folded = foldInitiatives(rootDir)
  const sections = [
    auditWiring(rootDir),
    auditRecords(folded),
    auditLifecycle(rootDir, folded),
    auditSplitSessions(folded),
    auditConcurrency(folded),
    auditGuards(rootDir, folded),
    auditRepoMemory(rootDir, folded),
    auditScanners(rootDir, fix, { caps: progress.caps ?? stderrCaps(), stream: progress.stream }),
  ]

  const tally = tallyOf(sections)
  const stdout = caps.color
    ? renderStyled(rootDir, sections, tally, caps)
    : renderPlain(rootDir, sections, tally)
  return tally.fails === 0 ? ok(stdout) : { exitCode: 1, stdout, stderr: '' }
}
