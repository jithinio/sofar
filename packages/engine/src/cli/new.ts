import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createToolContext, currentBranch, ToolError } from '../mcp/context'
import { errMessage, fail, ok, type CmdResult } from './shared'

/**
 * `harness new <slug> [--goal <text>]` / `harness switch <slug>` (task 4.2,
 * SPEC §CLI) — create/select an initiative and bind the current branch to it
 * in .harness/bindings.json.
 *
 * new: creates .harness/initiatives/<slug>/, appends initiative_created
 * (source 'cli', actor 'human' — the human is directing the CLI), binds the
 * branch (unless --no-bind), regenerates projections. switch: rebinds the
 * branch to an EXISTING initiative. Neither ever creates a log for a typo:
 * slugs are validated, and switch refuses unknown slugs.
 */

export const SLUG_RE = /^[a-z0-9-]+$/

/** Non-empty goal required by the initiative_created schema when --goal is omitted. */
export const DEFAULT_GOAL = '(goal not recorded yet — set one with harness_update_plan)'

const NO_BRANCH_HINT =
  'not inside a git repo (or HEAD is detached), so there is no branch to bind'

export interface NewOptions {
  goal?: string
  /** commander --no-bind → bind: false; default true. */
  bind?: boolean
}

// ---------------------------------------------------------------------------
// bindings.json read-modify-write (merge — other branches' bindings survive).
// ---------------------------------------------------------------------------

class BindingsAbort extends Error {}

function readBindingsFile(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {}
  let decoded: unknown
  try {
    decoded = JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    throw new BindingsAbort(
      `.harness/bindings.json is not valid JSON — refusing to modify it (${errMessage(err)})`,
    )
  }
  if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) {
    throw new BindingsAbort('.harness/bindings.json must be a JSON object of branch → slug')
  }
  return decoded as Record<string, unknown>
}

/** Bind branch → slug; returns false when the binding was already in place. */
function writeBinding(path: string, branch: string, slug: string): boolean {
  const bindings = readBindingsFile(path)
  if (bindings[branch] === slug) return false
  bindings[branch] = slug
  writeFileSync(path, `${JSON.stringify(bindings, null, 2)}\n`, 'utf8')
  return true
}

// ---------------------------------------------------------------------------
// Commands.
// ---------------------------------------------------------------------------

export function runNew(rootDir: string, slug: string, options: NewOptions = {}): CmdResult {
  if (!SLUG_RE.test(slug)) {
    return fail(
      `harness new: invalid slug "${slug}" — slugs are lowercase letters, digits, and hyphens only ([a-z0-9-]+)`,
    )
  }

  const ctx = createToolContext(rootDir)
  if (existsSync(ctx.initiativeDir(slug))) {
    return fail(
      `harness new: initiative "${slug}" already exists — use \`harness switch ${slug}\` to bind this branch to it`,
    )
  }

  // Resolve the branch BEFORE creating anything, so a bind failure leaves
  // the repo untouched.
  const bind = options.bind !== false
  const branch = bind ? currentBranch(rootDir) : null
  if (bind && branch === null) {
    return fail(
      `harness new: ${NO_BRANCH_HINT} — re-run with --no-bind and add the binding to .harness/bindings.json yourself`,
    )
  }

  const goal = options.goal !== undefined && options.goal.trim().length > 0
    ? options.goal.trim()
    : DEFAULT_GOAL

  const report: string[] = []
  try {
    mkdirSync(ctx.initiativeDir(slug), { recursive: true })
    ctx.appendAndProject(slug, 'initiative_created', { slug, goal }, {
      session: 'cli',
      source: 'cli',
      actor: 'human',
    })
    report.push(`created .harness/initiatives/${slug}/ (goal: ${goal})`)
    if (bind && branch !== null) {
      mkdirSync(ctx.harnessDir, { recursive: true })
      writeBinding(ctx.bindingsPath, branch, slug)
      report.push(`bound branch "${branch}" → ${slug}`)
    }
  } catch (err) {
    if (err instanceof BindingsAbort || err instanceof ToolError) {
      return fail(`harness new: ${errMessage(err)}`)
    }
    throw err
  }
  return ok(`${report.join('\n')}\n`)
}

export function runSwitch(rootDir: string, slug: string): CmdResult {
  const ctx = createToolContext(rootDir)
  if (!existsSync(ctx.initiativeDir(slug))) {
    return fail(
      `harness switch: initiative "${slug}" not found under .harness/initiatives/ — create it with \`harness new ${slug}\``,
    )
  }

  const branch = currentBranch(rootDir)
  if (branch === null) {
    return fail(
      `harness switch: ${NO_BRANCH_HINT} — add the binding to .harness/bindings.json yourself`,
    )
  }

  try {
    mkdirSync(ctx.harnessDir, { recursive: true })
    const changed = writeBinding(ctx.bindingsPath, branch, slug)
    return ok(
      changed
        ? `bound branch "${branch}" → ${slug}\n`
        : `branch "${branch}" already bound to ${slug} — nothing to do\n`,
    )
  } catch (err) {
    if (err instanceof BindingsAbort) return fail(`harness switch: ${err.message}`)
    throw err
  }
}
