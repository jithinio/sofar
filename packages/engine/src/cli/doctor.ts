import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { foldLog } from '../core/fold'
import { hookCommand, PROTOCOL_START, SHIMS } from './init'
import {
  cssExcludesSofar,
  detectTailwindV4,
  findTailwindCssEntries,
  insertSofarExclusion,
  sofarExclusionDirective,
} from './scanners'
import { errMessage, fail, ok, type CmdResult } from './shared'

/**
 * `sofar doctor [--fix]` (tasks 10.2/10.3, D-P10) — audit a host repo for
 *   1. wiring integrity  — did init's artifacts survive? (shims, settings,
 *      .mcp.json, protocol blocks)
 *   2. record health     — do the initiative logs fold without stub sessions
 *      or corrupt lines?
 *   3. scanner hazards    — will a tree-wide class scanner (Tailwind v4)
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
 */

export interface DoctorOptions {
  /** Apply the safe scanner fix (@source not insertion). */
  fix?: boolean
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

function auditRecords(rootDir: string): Section {
  const findings: Finding[] = []
  const slugs = listInitiatives(rootDir)
  const withLog = slugs.filter((slug) =>
    existsSync(join(rootDir, '.sofar', 'initiatives', slug, 'events.jsonl')),
  )
  if (withLog.length === 0) {
    findings.push({ level: 'ok', text: 'no initiative logs yet — nothing to fold' })
    return { title: 'Record health', findings }
  }

  for (const slug of withLog) {
    const logPath = join(rootDir, '.sofar', 'initiatives', slug, 'events.jsonl')
    let result: ReturnType<typeof foldLog>
    try {
      result = foldLog(logPath)
    } catch (err) {
      findings.push({ level: 'fail', text: `${slug}: cannot read log — ${errMessage(err)}` })
      continue
    }
    const stubs = result.state.sessions.filter((s) => s.tool === 'unknown').map((s) => s.id)
    if (stubs.length > 0) {
      findings.push({
        level: 'warn',
        text: `${slug}: ${stubs.length} stub session(s) — session_ended without session_started`,
        hint: `ids: ${stubs.join(', ')} (a hook or agent wrote back without registering the session)`,
      })
    }
    if (result.warnings.length > 0) {
      findings.push({
        level: 'warn',
        text: `${slug}: ${result.warnings.length} fold warning(s)`,
        hint: result.warnings[0]!,
      })
    }
    if (stubs.length === 0 && result.warnings.length === 0) {
      findings.push({ level: 'ok', text: `${slug}: folds clean` })
    }
  }
  return { title: 'Record health', findings }
}

// ---------------------------------------------------------------------------
// 3. Scanner hazards (+ --fix).
// ---------------------------------------------------------------------------

function auditScanners(rootDir: string, fix: boolean): Section {
  const findings: Finding[] = []
  const tw = detectTailwindV4(rootDir)
  if (!tw.v4) {
    findings.push({ level: 'ok', text: 'no tree-wide class scanner detected (Tailwind v4 absent)' })
    return { title: 'Scanner hazards', findings }
  }

  const entries = findTailwindCssEntries(rootDir)
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

export function runDoctor(rootDir: string, options: DoctorOptions = {}): CmdResult {
  const fix = options.fix === true
  if (!existsSync(join(rootDir, '.sofar'))) {
    return fail('sofar doctor: no .sofar/ record here — run `sofar init` first')
  }

  const sections = [auditWiring(rootDir), auditRecords(rootDir), auditScanners(rootDir, fix)]

  const lines: string[] = [`sofar doctor — ${rootDir}`, '']
  let fails = 0
  let warns = 0
  let fixesApplied = 0
  for (const section of sections) {
    lines.push(`${section.title}:`)
    for (const f of section.findings) {
      if (f.level === 'fail') fails++
      if (f.level === 'warn') warns++
      if (f.level === 'ok' && f.text.includes('added `@source not')) fixesApplied++
      lines.push(`${MARKER[f.level]}  ${f.text}`)
      if (f.hint !== undefined) lines.push(`          ${f.hint}`)
    }
    lines.push('')
  }

  const parts: string[] = []
  if (fixesApplied > 0) parts.push(`${fixesApplied} fix${fixesApplied === 1 ? '' : 'es'} applied`)
  parts.push(fails === 0 ? 'no problems found' : `${fails} problem${fails === 1 ? '' : 's'} found`)
  if (warns > 0) parts.push(`${warns} warning${warns === 1 ? '' : 's'}`)
  lines.push(`sofar doctor: ${parts.join(', ')}`)

  const stdout = `${lines.join('\n')}\n`
  return fails === 0 ? ok(stdout) : { exitCode: 1, stdout, stderr: '' }
}
