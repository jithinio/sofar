import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { validatePayload, isKnownEventType } from '@sofar/schema'
import type { ToolErrorCode, ToolErrorShape } from '@sofar/schema/tool-inputs'
import { makeEvent, SOURCES, type Actor, type EventEnvelope, type Source } from '../core/envelope'
import { appendEvent } from '../core/log'
import { foldLog, emptyState, type InitiativeState } from '../core/fold'
import { regenerateProjections } from '../projections/generator'

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
// Git branch → initiative resolution.
// ---------------------------------------------------------------------------

/**
 * Current branch from .git/HEAD without spawning git. Supports a
 * worktree-style .git FILE ("gitdir: <path>") by following it to that HEAD.
 * Returns null for detached HEAD or when no .git is readable.
 */
export function currentBranch(rootDir: string): string | null {
  try {
    const dotGit = join(rootDir, '.git')
    let headPath: string
    if (statSync(dotGit).isDirectory()) {
      headPath = join(dotGit, 'HEAD')
    } else {
      const gitdirMatch = /^gitdir:\s*(.+)\s*$/m.exec(readFileSync(dotGit, 'utf8'))
      if (!gitdirMatch) return null
      const gitDir = gitdirMatch[1]!.trim()
      headPath = join(isAbsolute(gitDir) ? gitDir : join(rootDir, gitDir), 'HEAD')
    }
    const head = readFileSync(headPath, 'utf8').trim()
    const refMatch = /^ref:\s*refs\/heads\/(.+)$/.exec(head)
    return refMatch ? refMatch[1]! : null
  } catch {
    return null
  }
}

/**
 * Available-initiatives suffix for unknown_initiative errors (initiative-list
 * 2.2): the dead-end becomes an orientation point — the caller learns what
 * exists without a second round-trip. Directory names only, no folds (this
 * runs on an error path); count-capped so a crowded record cannot bloat an
 * error message.
 */
function knownInitiatives(sofarDir: string): string {
  let slugs: string[]
  try {
    slugs = readdirSync(join(sofarDir, 'initiatives'), { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => d.name)
      .sort()
  } catch {
    slugs = []
  }
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
    if (!existsSync(initiativeDir(slug))) {
      throw new ToolError(
        'unknown_initiative',
        `initiative "${slug}" not found under .sofar/initiatives/; ${knownInitiatives(sofarDir)}`,
      )
    }
    return slug
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
    foldState,
    appendAndProject,
  }
}
