import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { validatePayload, isKnownEventType } from '@sofar/schema'
import type { ToolErrorCode, ToolErrorShape } from '@sofar/schema/tool-inputs'
import { makeEvent, SOURCES, type Actor, type EventEnvelope, type Source } from '../core/envelope'
import { appendEvent } from '../core/log'
import { foldLog, emptyState, type InitiativeState } from '../core/fold'
import { currentBranch } from '../core/git'
import { initiativeSlugs } from '../core/listing'
import { regenerateProjections } from '../projections/generator'

// Branch → initiative resolution reads git; the reader itself lives in core/
// (record-integrity 4.1) so projections can use it without depending on mcp/.
export { currentBranch } from '../core/git'

/**
 * Shared tool context: repo root, record paths (SPEC §Record layout),
 * initiative resolution from the current git branch + bindings.json (BD16),
 * the in-memory active session (BD15), and the single mutation path —
 * validate payload → append event → regenerate projections (SPEC §MCP tools).
 */

// ---------------------------------------------------------------------------
// Typed errors (shape + code union defined in @sofar/schema/tool-inputs).
// ---------------------------------------------------------------------------

export class ToolError extends Error {
  readonly code: ToolErrorCode
  readonly errors?: string[]

  constructor(code: ToolErrorCode, message: string, errors?: string[]) {
    super(message)
    this.name = 'ToolError'
    this.code = code
    if (errors !== undefined) this.errors = errors
  }

  toShape(): ToolErrorShape {
    return {
      code: this.code,
      message: this.message,
      ...(this.errors !== undefined ? { errors: this.errors } : {}),
    }
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// ---------------------------------------------------------------------------
// Session semantics (BD15): one in-memory active session per server process.
// ---------------------------------------------------------------------------

export interface ActiveSession {
  id: string
  tool: string
  /** Initiative the session was started on — end_session has no initiative arg. */
  initiative: string
}

export interface SessionBox {
  get(): ActiveSession | null
  set(session: ActiveSession | null): void
}

/** Envelope source mapping: the session's tool if it names a known source, else 'cli'. */
export function toSource(tool: string | undefined): Source {
  return tool !== undefined && (SOURCES as readonly string[]).includes(tool)
    ? (tool as Source)
    : 'cli'
}

// ---------------------------------------------------------------------------
// Session → home initiative (record-integrity 1.1, D1).
// ---------------------------------------------------------------------------

// initiativeSlugs moved to core/listing (cross-initiative-conflicts 2.1) so the
// core derivation can reach it without core importing mcp; imported for local
// use and re-exported, unchanged, for every caller that already had it here.
export { initiativeSlugs }

/**
 * ts of this log's session_started for `sessionId`, or null. The substring
 * pre-filter matters: the overwhelmingly common answer is "not here", and it
 * is reached without parsing a single line.
 */
function registeredAt(logPath: string, sessionId: string): string | null {
  let text: string
  try {
    text = readFileSync(logPath, 'utf8')
  } catch {
    return null // no log yet, or unreadable — indistinguishable and both "no"
  }
  if (!text.includes(sessionId)) return null
  for (const line of text.split('\n')) {
    if (line.length === 0 || !line.includes(sessionId)) continue
    try {
      const event: unknown = JSON.parse(line)
      if (
        typeof event === 'object' &&
        event !== null &&
        (event as Record<string, unknown>).type === 'session_started' &&
        (event as Record<string, unknown>).session === sessionId
      ) {
        const ts = (event as Record<string, unknown>).ts
        if (typeof ts === 'string') return ts
      }
    } catch {
      // torn/corrupt line — same tolerance as the fold, never fatal
    }
  }
  return null
}

/**
 * True when this log MAY hold an event newer than `ts`.
 *
 * mtime is a sound upper bound on the timestamps a log contains: an event's ts
 * is stamped immediately before its append, so a file untouched since `ts`
 * cannot hold anything stamped after it. Every failure mode — an unreadable
 * stat, an unparseable ts, a checkout that bumped mtime without appending —
 * answers `true` and costs a read, never a wrong answer.
 */
function modifiedAfter(logPath: string, ts: string): boolean {
  const cutoff = Date.parse(ts)
  if (Number.isNaN(cutoff)) return true
  try {
    return statSync(logPath).mtimeMs >= cutoff
  } catch {
    return true
  }
}

/**
 * A session's HOME initiative: the one whose log registered it with
 * session_started (record-integrity D1 — derived from the truth log, never
 * copied into a second store that could desync).
 *
 * The LATEST session_started wins, across every log including the branch-bound
 * one (D9). `preferred` is read first and seeds the candidate, so branch and
 * registration agreeing still settles in one read and still breaks a tie — but
 * it no longer short-circuits the scan, and that difference is the whole fix.
 *
 * What the short-circuit cost: lazy registration (D2) means an agent that runs
 * ONE tool before calling sofar_start_session gets registered on the BRANCH by
 * the PostToolUse hook. When it then names an initiative explicitly —
 * start_session's deliberate re-home, which appends a SECOND, later
 * session_started — the branch registration was stale by seconds and won
 * anyway, because `preferred` returned before any sibling was read. Latest-wins
 * was already the documented rule; the short-circuit above it meant the rule
 * only ever applied to logs the branch was NOT bound to.
 *
 * The session was then torn in half for the rest of its life: decisions and
 * task updates followed the MCP pin to the real record, while every hook event,
 * the injected SessionStart digest on resume, and the Stop write-back gate
 * followed the branch to the wrong one — so Stop blocked on debt in a log the
 * write-back could never reach. Observed live in the brillo record, where
 * `instant-navigations` collected 12 command_run events belonging to
 * `setup-completion-system`.
 *
 * The scan cannot be skipped, because "is there a later registration" is not
 * answerable from the preferred log alone. It is kept cheap by mtime instead: a
 * log untouched since the standing candidate registered is pruned without being
 * read, leaving only the handful of initiatives actually worked this session
 * (measured on a 40-log, 9.7 MB record: 8.95ms full scan, 0.50ms pruned, 2 logs
 * read).
 *
 * Returns null when no log has registered the session — a brand-new session,
 * whose home is legitimately the current branch (lazy registration, D2).
 *
 * Best-effort by contract (BD22): an unreadable log is skipped, never fatal.
 */
export function homeInitiative(
  sofarDir: string,
  sessionId: string,
  preferred?: string | null,
): string | null {
  if (sessionId.length === 0 || sessionId === 'cli') return null

  const eventsPathFor = (slug: string): string =>
    join(sofarDir, 'initiatives', slug, 'events.jsonl')

  let home: string | null = null
  let latest = ''
  if (preferred != null) {
    const ts = registeredAt(eventsPathFor(preferred), sessionId)
    if (ts !== null) {
      home = preferred
      latest = ts
    }
  }

  for (const slug of initiativeSlugs(sofarDir)) {
    if (slug === preferred) continue // already read above
    const path = eventsPathFor(slug)
    // Only a STRICTLY later registration can displace the candidate, so a log
    // that cannot hold one is never opened.
    if (latest !== '' && !modifiedAfter(path, latest)) continue
    const ts = registeredAt(path, sessionId)
    if (ts !== null && ts > latest) {
      latest = ts
      home = slug
    }
  }
  return home
}

/** How a resolution was reached — the surfaces render the two differently. */
export type ResolvedVia = 'session' | 'branch'

export interface ResolvedInitiative {
  slug: string
  via: ResolvedVia
}

/**
 * Session-before-branch resolution, for ANY process (initiative-lifecycle 1.2).
 *
 * The single shared precedence: compute branch → bindings.json first, but do
 * NOT trust it blindly — pass it as the PREFERRED candidate so the common case
 * (branch and registration agree) settles in one file read, while a registered
 * session whose branch no longer points at its initiative still resolves
 * through its home. An unbound branch is a miss here rather than an error: a
 * registered session resolves anyway, which is exactly what makes closing —
 * and the unbinding it does — safe mid-session.
 *
 * Cross-process by construction: the home is DERIVED from the truth logs
 * (homeInitiative), never from an in-memory pin a hook or statusline process
 * could not see, and never from a second store that could desync from the log
 * it summarises (record-integrity D1). Measured on a 22-initiative, 2.8 MB
 * record: 0.07 ms when the branch agrees, 2.9 ms for the full scan on a miss,
 * against a ~55 ms statusline.
 *
 * Returns null only when NEITHER answers — no pin and no binding — which is
 * the one case the hooks drop silently and the orienting surfaces name (D4).
 */
export function resolveSessionFirst(
  ctx: ToolContext,
  sessionId?: string | null,
): ResolvedInitiative | null {
  let branchSlug: string | null = null
  try {
    branchSlug = ctx.resolveInitiative()
  } catch {
    branchSlug = null // unbound/detached — a registered session may still answer
  }
  if (sessionId != null && sessionId.length > 0) {
    const home = homeInitiative(ctx.sofarDir, sessionId, branchSlug)
    if (home !== null) return { slug: home, via: home === branchSlug ? 'branch' : 'session' }
  }
  if (branchSlug === null) return null
  return { slug: branchSlug, via: 'branch' }
}

/**
 * Available-initiatives suffix for unknown_initiative errors (initiative-list
 * 2.2): the dead-end becomes an orientation point — the caller learns what
 * exists without a second round-trip. Directory names only, no folds (this
 * runs on an error path); count-capped so a crowded record cannot bloat an
 * error message.
 */
function knownInitiatives(sofarDir: string): string {
  const slugs = initiativeSlugs(sofarDir)
  if (slugs.length === 0) return 'no initiatives exist yet — create one with `sofar new <slug>`'
  const MAX_LISTED = 10
  const listed = slugs.slice(0, MAX_LISTED).join(', ')
  const more = slugs.length > MAX_LISTED ? `, …+${slugs.length - MAX_LISTED} more` : ''
  return `available initiatives: ${listed}${more} (details: sofar list)`
}

// ---------------------------------------------------------------------------
// Context.
// ---------------------------------------------------------------------------

export interface AppendOptions {
  /** Envelope session override (default: active session id, else "cli"). */
  session?: string
  /** Envelope source override (default: mapped from the active session's tool). */
  source?: Source
  /** Envelope actor override (default: "agent" — MCP/hook appends; CLI passes "human"). */
  actor?: Actor
}

export interface ToolContext {
  rootDir: string
  sofarDir: string
  bindingsPath: string
  session: SessionBox
  initiativeDir(slug: string): string
  eventsPath(slug: string): string
  /** Explicit arg wins; else current branch → bindings.json; else typed error. */
  resolveInitiative(explicit?: string): string
  /**
   * Write-tool resolution (task 12.1, BD58): explicit arg wins; else the
   * ACTIVE session's pinned initiative; else branch → bindings.json. Pinning
   * means a concurrent branch switch on the shared checkout cannot misroute
   * an already-started session's writes — the Phase 11 incident's root cause.
   */
  resolveWriteInitiative(explicit?: string): string
  /** Fold an initiative's log (missing log = empty state, slug filled in). */
  foldState(slug: string): InitiativeState
  /** The ONLY mutation path: validate payload → append → regenerate projections. */
  appendAndProject(
    slug: string,
    type: string,
    payload: Record<string, unknown>,
    options?: AppendOptions,
  ): EventEnvelope
}

export function createToolContext(rootDir: string): ToolContext {
  const sofarDir = join(rootDir, '.sofar')
  const bindingsPath = join(sofarDir, 'bindings.json')
  const initiativeDir = (slug: string): string => join(sofarDir, 'initiatives', slug)
  const eventsPath = (slug: string): string => join(initiativeDir(slug), 'events.jsonl')

  let active: ActiveSession | null = null
  const session: SessionBox = {
    get: () => active,
    set: (next) => {
      active = next
    },
  }

  function readBindings(): Record<string, string> {
    if (!existsSync(bindingsPath)) return {}
    let decoded: unknown
    try {
      decoded = JSON.parse(readFileSync(bindingsPath, 'utf8'))
    } catch (err) {
      throw new ToolError('io_error', `.sofar/bindings.json is not valid JSON: ${errMessage(err)}`)
    }
    if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) {
      throw new ToolError('io_error', '.sofar/bindings.json must be a JSON object of branch → slug')
    }
    const bindings: Record<string, string> = {}
    for (const [branch, slug] of Object.entries(decoded)) {
      if (typeof slug === 'string') bindings[branch] = slug
    }
    return bindings
  }

  /**
   * A slug becomes a path, so it must never be able to name one.
   *
   * The tool layer validates `initiative` against SLUG_RE, but that is not the
   * only way a slug reaches here: bindings.json is a COMMITTED, team-shared
   * file, and `--initiative` flags reach the CLI directly. Both bypass the
   * schema. So the containment check lives at the single choke point every
   * resolution passes through, and is stated in terms of the resolved path
   * rather than the string — `..`, an absolute path, a symlinked slug
   * directory, and a unicode separator all fail the same way.
   */
  const initiativesRoot = join(sofarDir, 'initiatives')
  function assertContained(slug: string): void {
    const dir = resolve(initiativeDir(slug))
    const root = resolve(initiativesRoot)
    if (dir !== join(root, slug) || !dir.startsWith(root + sep)) {
      throw new ToolError(
        'unknown_initiative',
        `invalid initiative "${slug}" — slugs are lowercase letters, digits, and hyphens ([a-z0-9-]+), never a path`,
      )
    }
  }

  function resolveInitiative(explicit?: string): string {
    let slug: string
    if (explicit !== undefined) {
      slug = explicit
    } else {
      const branch = currentBranch(rootDir)
      if (branch === null) {
        throw new ToolError(
          'unknown_initiative',
          `no current git branch found under ${rootDir} (not a repo, or detached HEAD) — pass \`initiative\` explicitly; ${knownInitiatives(sofarDir)}`,
        )
      }
      const bound = readBindings()[branch]
      if (bound === undefined) {
        throw new ToolError(
          'unknown_initiative',
          `no initiative bound to branch "${branch}" in .sofar/bindings.json — pass \`initiative\` explicitly or bind the branch; ${knownInitiatives(sofarDir)}`,
        )
      }
      slug = bound
    }
    assertContained(slug)
    if (!existsSync(initiativeDir(slug))) {
      throw new ToolError(
        'unknown_initiative',
        `initiative "${slug}" not found under .sofar/initiatives/; ${knownInitiatives(sofarDir)}`,
      )
    }
    return slug
  }

  function resolveWriteInitiative(explicit?: string): string {
    if (explicit === undefined) {
      const active = session.get()
      // Route through resolveInitiative's explicit path so a pinned slug
      // whose directory vanished mid-session still errors typed.
      if (active !== null) return resolveInitiative(active.initiative)
    }
    return resolveInitiative(explicit)
  }

  function foldState(slug: string): InitiativeState {
    const logPath = eventsPath(slug)
    let state: InitiativeState
    if (!existsSync(logPath)) {
      state = emptyState()
    } else {
      try {
        state = foldLog(logPath).state
      } catch (err) {
        throw new ToolError('io_error', `failed to read ${logPath}: ${errMessage(err)}`)
      }
    }
    if (state.slug === '') state.slug = slug
    return state
  }

  function appendAndProject(
    slug: string,
    type: string,
    payload: Record<string, unknown>,
    options?: AppendOptions,
  ): EventEnvelope {
    // Belt and braces: tool arg validation should make this unreachable, but
    // an invalid payload must never reach the log.
    const check = validatePayload(type, payload)
    if (!check.ok) {
      throw new ToolError(
        isKnownEventType(type) ? 'invalid_input' : 'unknown_event',
        `refusing to append invalid ${type} payload`,
        check.errors,
      )
    }
    const current = session.get()
    const event = makeEvent({
      initiative: slug,
      session: options?.session ?? current?.id ?? 'cli',
      source: options?.source ?? toSource(current?.tool),
      actor: options?.actor ?? 'agent',
      type,
      payload,
    })
    try {
      appendEvent(eventsPath(slug), event)
      regenerateProjections(initiativeDir(slug), foldState(slug))
    } catch (err) {
      if (err instanceof ToolError) throw err
      throw new ToolError(
        'io_error',
        `failed to append ${type} to initiative "${slug}": ${errMessage(err)}`,
      )
    }
    return event
  }

  return {
    rootDir,
    sofarDir,
    bindingsPath,
    session,
    initiativeDir,
    eventsPath,
    resolveInitiative,
    resolveWriteInitiative,
    foldState,
    appendAndProject,
  }
}
