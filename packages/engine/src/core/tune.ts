import { createHash } from 'node:crypto'
import { basename } from 'node:path'
import type { DiagnosticRow } from '@sofar/schema/diagnostics'
import type { EventEnvelope } from './envelope'
import type { SignalAvailability, SignalStatus } from './signals'

/**
 * `sofar tune --dry-run` detectors (self-improve 2.1, SPEC §Tune).
 *
 * Pure functions over inputs the caller has already read: envelope-valid
 * events in file order (the RAW log — the fold hides exactly the duplicates
 * one detector looks for) and the clone's diagnostics rows. No filesystem, no
 * clock, no randomness, so the same inputs render the same report byte for
 * byte, and a detector can be replayed against a log prefix.
 *
 * Three rules, each one from the audit (S1, S3, S5):
 * 1. A detector runs ONLY for a signal the availability map does not call
 *    unavailable on this clone; every other signal is reported UNKNOWN with
 *    the map's reason. A count is never printed for a signal nobody observes.
 * 2. Every finding cites immutable evidence — event ids, or the sha256 of a
 *    row's stored line — never prose, never a re-derivation.
 * 3. A detector states its coverage and its blind spot next to its count, and
 *    never labels a cause: a correction is a correction, not "shell
 *    mangling"; an edit to biome.json is an edit, not "friction".
 *
 * Detection only. No suggestion, no threshold, no ranking lives here — 2.3
 * owns proposals, and it consumes this report rather than the log.
 */

export const TUNE_REPORT_VERSION = 1
/** Evidence ids rendered per detector in the plain view; the JSON view carries them all. */
export const TUNE_EVIDENCE_SHOWN = 10

export interface TuneInputs {
  /** Per initiative, envelope-valid events in FILE order (readEvents, not the fold). */
  events: ReadonlyMap<string, readonly EventEnvelope[]>
  /** Diagnostics rows for the clone, any initiative. */
  rows: readonly DiagnosticRow[]
  /** The availability map for this clone, already degraded. */
  signals: readonly SignalAvailability[]
}

export interface TuneFinding {
  /** Initiative the evidence belongs to. */
  initiative: string
  /** What was found, in the detector's own terms — never a cause. */
  what: string
  /** Event ids (ulid) or row hashes (`row:` + 16 hex) — immutable references. */
  evidence: readonly string[]
}

export interface TuneDetectorReport {
  signal: string
  /** `unknown` mirrors the map's `unavailable`: nothing here observes it. */
  status: SignalStatus | 'unknown'
  /** Present only when the detector ran. */
  count?: number
  findings?: readonly TuneFinding[]
  /** What the count is over — the denominator, the event types, the rows. */
  coverage: string
  /** The blind spot the map names, repeated here so a reader of ONE line has it. */
  blind_spot: string
}

export interface TuneReport {
  version: typeof TUNE_REPORT_VERSION
  initiatives: readonly string[]
  /** Envelope-valid events read, per initiative — the corpus size behind every count. */
  events_read: Readonly<Record<string, number>>
  rows_read: number
  /** Highest event id read — a replay against the same prefix reproduces this report. */
  cutoff: string | null
  detectors: readonly TuneDetectorReport[]
}

/** sha256 of the row as the store wrote it (JSON.stringify), first 16 hex — the row's evidence id. */
export function rowHash(row: DiagnosticRow): string {
  return `row:${createHash('sha256').update(JSON.stringify(row)).digest('hex').slice(0, 16)}`
}

/** Files whose edit by an agent is worth counting — formatter and MCP configuration. */
export const FORMATTER_CONFIG_FILES: ReadonlySet<string> = new Set([
  'biome.json',
  'biome.jsonc',
  '.prettierrc',
  '.prettierrc.json',
  '.prettierrc.js',
  '.prettierrc.cjs',
  '.prettierrc.mjs',
  '.prettierrc.yaml',
  '.prettierrc.yml',
  '.prettierrc.toml',
  'prettier.config.js',
  'prettier.config.cjs',
  'prettier.config.mjs',
  '.editorconfig',
  '.markdownlint.json',
  '.markdownlint.jsonc',
  '.markdownlint.yaml',
  '.markdownlintrc',
  '.mcp.json',
])

type Detector = (inputs: TuneInputs, signal: SignalAvailability) => Omit<TuneDetectorReport, 'signal' | 'status' | 'blind_spot'>

const byId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

function sortedFindings(findings: TuneFinding[]): TuneFinding[] {
  return findings
    .map((f) => ({ ...f, evidence: [...f.evidence].sort(byId) }))
    .sort((a, b) => byId(a.initiative, b.initiative) || byId(a.evidence[0] ?? '', b.evidence[0] ?? '') || byId(a.what, b.what))
}

function payloadStr(e: EventEnvelope, key: string): string | null {
  const v = (e.payload as Record<string, unknown>)[key]
  return typeof v === 'string' ? v : null
}

const detectors: Record<string, Detector> = {
  duplicate_session_starts(inputs) {
    const findings: TuneFinding[] = []
    for (const [slug, events] of inputs.events) {
      const starts = new Map<string, string[]>()
      for (const e of events) {
        if (e.type !== 'session_started' || e.session === 'cli') continue
        const list = starts.get(e.session) ?? []
        list.push(e.id)
        starts.set(e.session, list)
      }
      for (const [session, ids] of starts) {
        if (ids.length > 1) {
          findings.push({ initiative: slug, what: `session ${session} registered ${ids.length} times`, evidence: ids })
        }
      }
    }
    const sorted = sortedFindings(findings)
    return {
      count: sorted.length,
      findings: sorted,
      coverage: 'session_started lines per session id over the RAW valid events of every initiative read; corrupt lines excluded, "cli" excluded',
    }
  },

  corrections(inputs) {
    const findings: TuneFinding[] = []
    for (const [slug, events] of inputs.events) {
      const types = new Map(events.map((e) => [e.id, e.type] as const))
      for (const e of events) {
        if (e.type !== 'correction') continue
        const ref = payloadStr(e, 'ref') ?? '?'
        const target = types.get(ref)
        findings.push({
          initiative: slug,
          what: `correction of ${target ?? 'an event not in this log'}`,
          evidence: target !== undefined ? [e.id, ref] : [e.id],
        })
      }
    }
    const sorted = sortedFindings(findings)
    return {
      count: sorted.length,
      findings: sorted,
      coverage: 'correction events over every initiative read; evidence is the correction and its target when the target is in the same log',
    }
  },

  stalls(inputs) {
    const findings: TuneFinding[] = []
    for (const [slug, events] of inputs.events) {
      for (const e of events) {
        if (e.type === 'handoff' && payloadStr(e, 'reason') === 'stall') {
          findings.push({ initiative: slug, what: `handoff stall in run ${payloadStr(e, 'run') ?? '?'}`, evidence: [e.id] })
        } else if (e.type === 'run_stopped' && payloadStr(e, 'reason') === 'stall') {
          findings.push({ initiative: slug, what: `run ${payloadStr(e, 'run') ?? '?'} stopped on a stall streak`, evidence: [e.id] })
        }
      }
    }
    const sorted = sortedFindings(findings)
    return {
      count: sorted.length,
      findings: sorted,
      coverage: 'handoff{reason: stall} and run_stopped{reason: stall} over every initiative read — driven runs only',
    }
  },

  formatter_friction(inputs) {
    const findings: TuneFinding[] = []
    for (const [slug, events] of inputs.events) {
      const perFile = new Map<string, string[]>()
      for (const e of events) {
        if (e.type !== 'file_touched') continue
        const path = payloadStr(e, 'path')
        if (path === null || !FORMATTER_CONFIG_FILES.has(basename(path))) continue
        const list = perFile.get(path) ?? []
        list.push(e.id)
        perFile.set(path, list)
      }
      for (const [path, ids] of perFile) {
        findings.push({ initiative: slug, what: `${path} edited ${ids.length} time(s)`, evidence: ids })
      }
    }
    const sorted = sortedFindings(findings)
    return {
      count: sorted.reduce((n, f) => n + f.evidence.length, 0),
      findings: sorted,
      coverage: `file_touched whose basename is one of ${FORMATTER_CONFIG_FILES.size} formatter/MCP config names, over every initiative read`,
    }
  },

  tool_failure(inputs) {
    const findings: TuneFinding[] = []
    for (const [slug, events] of inputs.events) {
      const perHead = new Map<string, string[]>()
      for (const e of events) {
        if (e.type !== 'command_run' && e.type !== 'file_touched') continue
        if ((e.payload as { ok?: unknown }).ok !== false) continue
        const key =
          e.type === 'command_run'
            ? `command \`${(payloadStr(e, 'cmd') ?? '').trim().split(/\s+/, 1)[0] ?? ''}\``
            : `${payloadStr(e, 'op') ?? 'edit'} of ${payloadStr(e, 'path') ?? '?'}`
        const list = perHead.get(key) ?? []
        list.push(e.id)
        perHead.set(key, list)
      }
      for (const [key, ids] of perHead) {
        findings.push({ initiative: slug, what: `${key} failed ${ids.length} time(s)`, evidence: ids })
      }
    }
    const sorted = sortedFindings(findings)
    return {
      count: sorted.reduce((n, f) => n + f.evidence.length, 0),
      findings: sorted,
      coverage: 'command_run / file_touched with ok:false, grouped by leading command token or path; events without an ok field are UNKNOWN and not counted either way',
    }
  },

  mcp_rejections(inputs) {
    const perKey = new Map<string, { initiative: string; code: string; tool: string; evidence: string[] }>()
    let calls = 0
    for (const row of inputs.rows) {
      if (row.kind !== 'mcp_call') continue
      calls++
      const data = row.data as { tool: string; ok: boolean; code?: string }
      if (data.ok) continue
      const code = data.code ?? 'unknown_code'
      const key = `${row.initiative} ${data.tool} ${code}`
      const entry = perKey.get(key) ?? { initiative: row.initiative, code, tool: data.tool, evidence: [] }
      entry.evidence.push(rowHash(row))
      perKey.set(key, entry)
    }
    const findings = sortedFindings(
      [...perKey.values()].map((v) => ({
        initiative: v.initiative,
        what: `${v.tool} rejected ${v.evidence.length} time(s) with ${v.code}`,
        evidence: v.evidence,
      })),
    )
    return {
      count: findings.reduce((n, f) => n + f.evidence.length, 0),
      findings,
      coverage: `mcp_call rows with ok:false over ${calls} sofar MCP call row(s) in the store; other MCP servers unobserved`,
    }
  },

  bookkeeping_share(inputs) {
    const perInitiative = new Map<string, { exempt: number; mcp: number; tools: number; evidence: string[] }>()
    for (const row of inputs.rows) {
      if (row.kind !== 'tool_outcome' && row.kind !== 'mcp_call') continue
      const entry = perInitiative.get(row.initiative) ?? { exempt: 0, mcp: 0, tools: 0, evidence: [] }
      if (row.kind === 'mcp_call') {
        entry.mcp++
        entry.evidence.push(rowHash(row))
      } else {
        entry.tools++
        if ((row.data as { exempt?: boolean }).exempt === true) {
          entry.exempt++
          entry.evidence.push(rowHash(row))
        }
      }
      perInitiative.set(row.initiative, entry)
    }
    const findings = sortedFindings(
      [...perInitiative.entries()]
        .filter(([, v]) => v.tools + v.mcp > 0)
        .map(([initiative, v]) => {
          const denominator = v.tools + v.mcp
          const share = Math.round(((v.exempt + v.mcp) / denominator) * 100)
          return {
            initiative,
            what: `${v.exempt} exempt command(s) + ${v.mcp} sofar MCP call(s) over ${denominator} observed call(s) — at most ${share}%`,
            evidence: v.evidence,
          }
        }),
    )
    return {
      count: findings.length,
      findings,
      coverage: 'numerator: tool_outcome rows with exempt:true plus mcp_call rows; denominator: tool_outcome rows (Edit|Write|MultiEdit|Bash) plus mcp_call rows — an upper bound on the observed subset',
    }
  },

  injection_bytes(inputs) {
    const perInitiative = new Map<string, { bytes: number[]; memory: number[]; evidence: string[] }>()
    for (const row of inputs.rows) {
      if (row.kind !== 'injection') continue
      const data = row.data as { hook: string; bytes: number; memory_bytes?: number }
      if (data.hook !== 'SessionStart') continue
      const entry = perInitiative.get(row.initiative) ?? { bytes: [], memory: [], evidence: [] }
      entry.bytes.push(data.bytes)
      if (data.memory_bytes !== undefined) entry.memory.push(data.memory_bytes)
      entry.evidence.push(rowHash(row))
      perInitiative.set(row.initiative, entry)
    }
    const findings = sortedFindings(
      [...perInitiative.entries()].map(([initiative, v]) => {
        const sorted = [...v.bytes].sort((a, b) => a - b)
        const median = sorted[Math.floor(sorted.length / 2)] ?? 0
        const max = sorted[sorted.length - 1] ?? 0
        const memory = v.memory.length > 0 ? Math.max(...v.memory) : null
        return {
          initiative,
          what: `${v.bytes.length} SessionStart injection(s): median ${median} chars, max ${max}${memory !== null ? `, repo memory up to ${memory}` : ''}`,
          evidence: v.evidence,
        }
      }),
    )
    return {
      count: findings.reduce((n, f) => n + f.evidence.length, 0),
      findings,
      coverage: 'injection rows with hook SessionStart; chars of hook stdout, not tokens',
    }
  },
}

/** Signals a detector exists for, in map order — the rest are UNKNOWN by construction. */
export const TUNE_DETECTOR_SIGNALS: readonly string[] = Object.keys(detectors)

const anyEvent = (inputs: TuneInputs, test: (e: EventEnvelope) => boolean): boolean => {
  for (const events of inputs.events.values()) if (events.some(test)) return true
  return false
}
const anyRow = (inputs: TuneInputs, kinds: readonly string[]): boolean => inputs.rows.some((r) => kinds.includes(r.kind))

/**
 * The CORPUS half of rule 1 (self-improve 2.2). The map degrades against the
 * clone — settings text, store path — but a clone can pass that and still hold
 * a log no hook, store or driver ever wrote to: a Codex repo carries Claude's
 * settings file and fires none of it; a log written by an engine before
 * capture has no `ok` field and no row. Replayed over 13 real units, the
 * ungated detectors printed a number on every one of them. So a detector whose
 * source only a hook, the store or a driven run produces runs only when the
 * corpus shows that source at least once; otherwise it is UNKNOWN. Detectors
 * over events sofar writes itself (session_started, correction) need no gate.
 */
const CORPUS_SOURCES: Readonly<Record<string, { needs: string; seen: (inputs: TuneInputs) => boolean }>> = {
  stalls: {
    needs: 'no driven run (run_started, handoff or run_stopped)',
    seen: (i) => anyEvent(i, (e) => e.type === 'run_started' || e.type === 'handoff' || e.type === 'run_stopped'),
  },
  formatter_friction: {
    needs: 'no file_touched event — the host never fired the edit hook',
    seen: (i) => anyEvent(i, (e) => e.type === 'file_touched'),
  },
  tool_failure: {
    needs: 'no command_run / file_touched carrying ok — written before capture',
    seen: (i) => anyEvent(i, (e) => (e.type === 'command_run' || e.type === 'file_touched') && 'ok' in (e.payload as object)),
  },
  mcp_rejections: { needs: 'no mcp_call row', seen: (i) => anyRow(i, ['mcp_call']) },
  bookkeeping_share: { needs: 'no tool_outcome or mcp_call row', seen: (i) => anyRow(i, ['tool_outcome', 'mcp_call']) },
  injection_bytes: { needs: 'no injection row', seen: (i) => anyRow(i, ['injection']) },
}

/** Run every detector the map allows; report everything else UNKNOWN. Pure. */
export function detect(inputs: TuneInputs): TuneReport {
  const initiatives = [...inputs.events.keys()].sort(byId)
  const events_read: Record<string, number> = {}
  let cutoff: string | null = null
  for (const slug of initiatives) {
    const events = inputs.events.get(slug) ?? []
    events_read[slug] = events.length
    for (const e of events) if (cutoff === null || e.id > cutoff) cutoff = e.id
  }
  const detectorReports: TuneDetectorReport[] = inputs.signals.map((signal) => {
    const detector = detectors[signal.id]
    if (detector === undefined || signal.status === 'unavailable') {
      return {
        signal: signal.id,
        status: 'unknown',
        coverage:
          detector === undefined
            ? 'no detector — nothing in tune observes this signal'
            : `not observable on this clone: missing ${signal.missing.join(', ')}`,
        blind_spot: signal.reason,
      }
    }
    const source = CORPUS_SOURCES[signal.id]
    if (source !== undefined && !source.seen(inputs)) {
      return { signal: signal.id, status: 'unknown', coverage: `not observed in this corpus: ${source.needs}`, blind_spot: signal.reason }
    }
    return { signal: signal.id, status: signal.status, ...detector(inputs, signal), blind_spot: signal.reason }
  })
  return {
    version: TUNE_REPORT_VERSION,
    initiatives,
    events_read,
    rows_read: inputs.rows.length,
    cutoff,
    detectors: detectorReports,
  }
}

/** Byte-plain rendering — one block per detector, evidence capped, nothing volatile. */
export function renderTuneReport(report: TuneReport): string {
  const ran = report.detectors.filter((d) => d.status !== 'unknown')
  const unknown = report.detectors.filter((d) => d.status === 'unknown')
  const lines = [
    `sofar tune --dry-run (report v${report.version}) — detection only: nothing is proposed, applied or written`,
    `corpus: ${report.initiatives.length} initiative(s), ${Object.values(report.events_read).reduce((n, c) => n + c, 0)} event(s), ${report.rows_read} diagnostics row(s)${report.cutoff !== null ? `, through ${report.cutoff}` : ''}`,
    '',
  ]
  for (const d of ran) {
    lines.push(`${d.signal} [${d.status}] — ${d.count ?? 0}`)
    lines.push(`  over: ${d.coverage}`)
    if (d.status === 'partial') lines.push(`  blind spot: ${d.blind_spot}`)
    for (const f of d.findings ?? []) {
      const shown = f.evidence.slice(0, TUNE_EVIDENCE_SHOWN)
      const more = f.evidence.length - shown.length
      lines.push(`  - ${f.initiative}: ${f.what}`)
      lines.push(`    evidence: ${shown.join(', ')}${more > 0 ? ` +${more} more` : ''}`)
    }
    lines.push('')
  }
  if (unknown.length > 0) {
    lines.push('UNKNOWN — not observed here, never zero:')
    for (const d of unknown) lines.push(`  ${d.signal}: ${d.coverage}`)
  }
  return `${lines.join('\n').trimEnd()}\n`
}
