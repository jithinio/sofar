import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createToolContext, currentBranch, ToolError } from '../mcp/context'
import { errMessage, fail, ok, type CmdResult } from './shared'
import { type Caps, createStyle, stderrCaps, stdoutCaps, symbolsFor } from './ui'

/**
 * `sofar new <slug> [--goal <text>]` / `sofar switch <slug>` (task 4.2,
 * SPEC §CLI) — create/select an initiative and bind the current branch to it
 * in .sofar/bindings.json.
 *
 * new: creates .sofar/initiatives/<slug>/, appends initiative_created
 * (source 'cli', actor 'human' — the human is directing the CLI), binds the
 * branch (unless --no-bind), regenerates projections. switch: rebinds the
 * branch to an EXISTING initiative. Neither ever creates a log for a typo:
 * slugs are validated, and switch refuses unknown slugs.
 */

export const SLUG_RE = /^[a-z0-9-]+$/

/** Non-empty goal required by the initiative_created schema when --goal is omitted. */
export const DEFAULT_GOAL = '(goal not recorded yet — set one with sofar_update_plan)'

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
      `.sofar/bindings.json is not valid JSON — refusing to modify it (${errMessage(err)})`,
    )
  }
  if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) {
    throw new BindingsAbort('.sofar/bindings.json must be a JSON object of branch → slug')
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
// Confirmation styling (cli-ui 2.5). Wording is identical styled or plain —
// caps only add the ✓/✗ mark, color, and the dim └ detail rail — so piped
// output stays byte-identical to the unstyled report. Failure text lands on
// stderr, so it styles under the STDERR stream's caps (errCaps): a stdout
// TTY must not push escapes into a redirected stderr.
// ---------------------------------------------------------------------------

export function renderConfirmation(report: string[], caps: Caps): string {
  const [result = '', ...details] = report
  if (!caps.color) return report.join('\n')
  const style = createStyle(true)
  const symbols = symbolsFor(caps.unicode)
  return [
    `${style.success(symbols.ok)} ${result}`,
    ...details.map((line) => style.dim(`  ${symbols.elbow} ${line}`)),
  ].join('\n')
}

export function renderFailure(message: string, caps: Caps): string {
  if (!caps.color) return message
  return `${createStyle(true).error(symbolsFor(caps.unicode).fail)} ${message}`
}

// ---------------------------------------------------------------------------
// Commands.
// ---------------------------------------------------------------------------

export function runNew(
  rootDir: string,
  slug: string,
  options: NewOptions = {},
  caps: Caps = stdoutCaps(),
  errCaps: Caps = stderrCaps(),
): CmdResult {
  if (!SLUG_RE.test(slug)) {
    return fail(
      renderFailure(
        `sofar new: invalid slug "${slug}" — slugs are lowercase letters, digits, and hyphens only ([a-z0-9-]+)`,
        errCaps,
      ),
    )
  }

  const ctx = createToolContext(rootDir)
  if (existsSync(ctx.initiativeDir(slug))) {
    return fail(
      renderFailure(
        `sofar new: initiative "${slug}" already exists — use \`sofar switch ${slug}\` to bind this branch to it`,
        errCaps,
      ),
    )
  }

  // Resolve the branch BEFORE creating anything, so a bind failure leaves
  // the repo untouched.
  const bind = options.bind !== false
  const branch = bind ? currentBranch(rootDir) : null
  if (bind && branch === null) {
    return fail(
      renderFailure(
        `sofar new: ${NO_BRANCH_HINT} — re-run with --no-bind and add the binding to .sofar/bindings.json yourself`,
        errCaps,
      ),
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
    report.push(`created .sofar/initiatives/${slug}/ (goal: ${goal})`)
    if (bind && branch !== null) {
      mkdirSync(ctx.sofarDir, { recursive: true })
      writeBinding(ctx.bindingsPath, branch, slug)
      report.push(`bound branch "${branch}" → ${slug}`)
    }
  } catch (err) {
    if (err instanceof BindingsAbort || err instanceof ToolError) {
      return fail(renderFailure(`sofar new: ${errMessage(err)}`, errCaps))
    }
    throw err
  }
  return ok(`${renderConfirmation(report, caps)}\n`)
}

export function runSwitch(
  rootDir: string,
  slug: string,
  caps: Caps = stdoutCaps(),
  errCaps: Caps = stderrCaps(),
): CmdResult {
  const ctx = createToolContext(rootDir)
  if (!existsSync(ctx.initiativeDir(slug))) {
    return fail(
      renderFailure(
        `sofar switch: initiative "${slug}" not found under .sofar/initiatives/ — create it with \`sofar new ${slug}\``,
        errCaps,
      ),
    )
  }

  const branch = currentBranch(rootDir)
  if (branch === null) {
    return fail(
      renderFailure(
        `sofar switch: ${NO_BRANCH_HINT} — add the binding to .sofar/bindings.json yourself`,
        errCaps,
      ),
    )
  }

  try {
    mkdirSync(ctx.sofarDir, { recursive: true })
    const changed = writeBinding(ctx.bindingsPath, branch, slug)
    const line = changed
      ? `bound branch "${branch}" → ${slug}`
      : `branch "${branch}" already bound to ${slug} — nothing to do`
    return ok(`${renderConfirmation([line], caps)}\n`)
  } catch (err) {
    if (err instanceof BindingsAbort) {
      return fail(renderFailure(`sofar switch: ${err.message}`, errCaps))
    }
    throw err
  }
}
