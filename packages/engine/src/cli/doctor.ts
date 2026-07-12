import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import {
  foldLog,
  openSessionFileConflicts,
  staleActivePhases,
  type InitiativeState,
  type OrphanTaskEvent,
} from '../core/fold'
import { hookCommand, PROTOCOL_START, SHIMS } from './init'
import {
  cssExcludesSofar,
  detectTailwindV4,
  findTailwindCssEntries,
  insertSofarExclusion,
  sofarExclusionDirective,
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
 *   4. scanner hazards    — will a tree-wide class scanner (Tailwind v4)
 *      ingest .sofar/ because the entry stylesheet lacks a `@source not`
 *      exclusion?
 *
 * --fix is scoped to the ONE deterministic, safe repair (D-P10): inserting the
 * `@source not` exclusion after the `@import "tailwindcss"` line in each
 * unprotected entry stylesheet. Wiring gaps are reported, never auto-repaired
 * (re-run `sofar init` for those); the fix never touches record prose.
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

  for (const file of ['CLAUDE.md', 'AGENTS.md']) {
    findings.push(
      fileHas(join(rootDir, file), PROTOCOL_START)
        ? { level: 'ok', text: `${file} protocol block present` }
        : { level: 'fail', text: `${file} protocol block missing`, hint: repair },
    )
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
        return { slug, state: result.state, warnings: result.warnings, orphans: result.orphan_task_events }
      } catch (err) {
        return { slug, warnings: [], orphans: [], error: errMessage(err) }
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
  if (conflictTotal === 0) {
    findings.push({ level: 'ok', text: 'no files under concurrent edit by multiple open sessions' })
  }
  return { title: 'Concurrency', findings }
}

// ---------------------------------------------------------------------------
// 3. Scanner hazards (+ --fix).
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
    if (fix) {
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
      hint: fix
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
    auditConcurrency(folded),
    auditScanners(rootDir, fix, { caps: progress.caps ?? stderrCaps(), stream: progress.stream }),
  ]

  const tally = tallyOf(sections)
  const stdout = caps.color
    ? renderStyled(rootDir, sections, tally, caps)
    : renderPlain(rootDir, sections, tally)
  return tally.fails === 0 ? ok(stdout) : { exitCode: 1, stdout, stderr: '' }
}
