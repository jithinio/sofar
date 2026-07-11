import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { foldLog, freshnessTotal } from './fold'

/**
 * Initiative listing (initiative-list 1.2): the portfolio derivation behind
 * `sofar list` and get_state view:"initiatives". Read-side only — folds the
 * logs that exist and inverts bindings.json into a slug → branches map;
 * zero new event types. Tolerance matches the fold: a missing or unreadable
 * log, or corrupt bindings.json, degrades to a warning and a thinner entry,
 * never a failure — this is an orientation surface and must render on
 * damaged records too.
 *
 * Ordering (D pre-registered, 1.1): last envelope-valid event id (ulid)
 * descending — record recency, the resume-relevant order — then initiatives
 * that never logged an event, by slug ascending. Deterministic: the key is
 * already in the record.
 */

export interface InitiativeListEntry {
  slug: string
  /** Branches bound to this slug (bindings.json inverted), sorted. */
  branches: string[]
  goal: string
  tasks_done: number
  tasks_total: number
  active_phase: string | null
  next_action: string | null
  /**
   * Counted mechanical events since the last write-back (next-command 1.2)
   * — the staleness-detection freshness signal, portfolio-shaped: > 0 means
   * next_action predates record movement and may be stale. 0 when the last
   * event is the write-back AND when nothing ever wrote back (a never-
   * written-back record has no next_action to go stale — the render rule).
   */
  drift_events: number
  /** ulid of the last envelope-valid event (state.cursor) — the recency key. */
  last_event_id: string | null
}

export interface InitiativeListing {
  entries: InitiativeListEntry[]
  warnings: string[]
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * bindings.json, tolerantly: unreadable or malformed content warns and
 * yields no bindings — a broken bindings file must not hide the record.
 * Non-string values are skipped (same rule as the MCP context reader).
 */
function readBindingsTolerant(bindingsPath: string, warnings: string[]): Record<string, string> {
  if (!existsSync(bindingsPath)) return {}
  let decoded: unknown
  try {
    decoded = JSON.parse(readFileSync(bindingsPath, 'utf8'))
  } catch (err) {
    warnings.push(`bindings.json: not valid JSON — branch bindings omitted (${errMessage(err)})`)
    return {}
  }
  if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) {
    warnings.push('bindings.json: not a JSON object of branch → slug — branch bindings omitted')
    return {}
  }
  const bindings: Record<string, string> = {}
  for (const [branch, slug] of Object.entries(decoded)) {
    if (typeof slug === 'string') bindings[branch] = slug
  }
  return bindings
}

/** Every initiative directory under .sofar/initiatives, summarized. */
export function listInitiatives(rootDir: string): InitiativeListing {
  const warnings: string[] = []
  const entries: InitiativeListEntry[] = []
  const initiativesDir = join(rootDir, '.sofar', 'initiatives')
  if (!existsSync(initiativesDir)) return { entries, warnings } // not sofar-initialized — empty listing

  const branchesOf = new Map<string, string[]>()
  const bindings = readBindingsTolerant(join(rootDir, '.sofar', 'bindings.json'), warnings)
  for (const [branch, slug] of Object.entries(bindings)) {
    const branches = branchesOf.get(slug) ?? []
    branches.push(branch)
    branchesOf.set(slug, branches)
  }

  let slugs: string[]
  try {
    slugs = readdirSync(initiativesDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => d.name)
  } catch (err) {
    warnings.push(`cannot read ${initiativesDir}: ${errMessage(err)}`)
    return { entries, warnings }
  }

  for (const slug of slugs) {
    const entry: InitiativeListEntry = {
      slug,
      branches: (branchesOf.get(slug) ?? []).sort(),
      goal: '',
      tasks_done: 0,
      tasks_total: 0,
      active_phase: null,
      next_action: null,
      drift_events: 0,
      last_event_id: null,
    }
    const logPath = join(initiativesDir, slug, 'events.jsonl')
    if (existsSync(logPath)) {
      try {
        const { state, warnings: foldWarnings } = foldLog(logPath)
        warnings.push(...foldWarnings.map((w) => `${slug}: ${w}`))
        entry.goal = state.goal
        for (const phase of state.phases) {
          for (const task of phase.tasks) {
            entry.tasks_total += 1
            if (task.status === 'done') entry.tasks_done += 1
          }
        }
        entry.active_phase = state.current.active_phase
        entry.next_action = state.current.next_action
        if (state.freshness.last_writeback_ts !== null) {
          entry.drift_events = freshnessTotal(state.freshness)
        }
        entry.last_event_id = state.cursor
      } catch (err) {
        warnings.push(`${slug}: failed to read events.jsonl — listed without detail (${errMessage(err)})`)
      }
    }
    entries.push(entry)
  }

  entries.sort((a, b) => {
    if (a.last_event_id !== null && b.last_event_id !== null && a.last_event_id !== b.last_event_id) {
      return a.last_event_id > b.last_event_id ? -1 : 1 // ulid desc — most recent record first
    }
    if ((a.last_event_id === null) !== (b.last_event_id === null)) {
      return a.last_event_id === null ? 1 : -1 // never-logged initiatives sink
    }
    return a.slug.localeCompare(b.slug)
  })

  return { entries, warnings }
}
