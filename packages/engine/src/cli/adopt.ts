import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'
import { ulid } from 'ulid'
import type { ToolErrorShape } from '@harness/schema/tool-inputs'
import { createToolContext, ToolError } from '../mcp/context'
import { ok, type CmdResult } from './shared'

/**
 * `harness adopt <legacy-file> [slug] [--mark]` (task 8.2, SPEC §CLI, BD46) —
 * guided migration for repos with a pre-harness prose record (hand-maintained
 * harness.md + a prose protocol in CLAUDE.md).
 *
 * The command mechanizes environment checks and marking; it does NOT parse
 * the legacy markdown — freeform parsing is fragile, so an agent (any tool)
 * executes the printed MIGRATION BRIEF verbatim and transcribes the legacy
 * content itself. The CLI carries the protocol (BD4 philosophy): every write
 * in the brief is a validated `harness event append`.
 *
 * Validation (all failures exit 1 with the BD17 typed-error JSON on stderr,
 * event append's error style): the legacy file must exist, .harness/ must
 * exist (run `harness init` first), and the target initiative must resolve
 * (positional slug wins, else branch binding; else create one with
 * `harness new <slug>`).
 *
 * --mark prepends an idempotent SUPERSEDED banner between
 * `<!-- harness:superseded -->` markers so the legacy file can never again
 * masquerade as truth; a second --mark run changes zero bytes.
 */

export interface AdoptOptions {
  /** Prepend the idempotent SUPERSEDED banner to the legacy file. */
  mark?: boolean
}

export const SUPERSEDED_START = '<!-- harness:superseded -->'
export const SUPERSEDED_END = '<!-- /harness:superseded -->'

function supersededBanner(slug: string): string {
  const date = new Date().toISOString().slice(0, 10)
  return [
    SUPERSEDED_START,
    `SUPERSEDED — this record migrated to .harness/initiatives/${slug}/ on ${date}.`,
    'Do not update this file; truth lives in the harness record.',
    SUPERSEDED_END,
    '',
    '',
  ].join('\n')
}

function typedFail(shape: ToolErrorShape): CmdResult {
  return { exitCode: 1, stdout: '', stderr: `${JSON.stringify(shape)}\n` }
}

/**
 * THE MIGRATION BRIEF — a complete, self-contained instruction block an
 * agent can execute verbatim: exact dialect commands with the initiative and
 * a fresh session id baked in, the repo-knowledge move, the protocol
 * retirement checklist, and the verification line.
 */
export function renderMigrationBrief(args: {
  legacyFile: string
  slug: string
  sessionId: string
}): string {
  const { legacyFile: file, slug, sessionId } = args
  const append = `harness event append ${slug} --session ${sessionId} --actor human`
  return `# Harness migration brief — replay ${file} into initiative "${slug}"

Goal: replay the state recorded in ${file} into the harness initiative
"${slug}", so that \`harness status ${slug}\` reproduces it. Execute the
steps in order and transcribe the legacy content yourself — nothing below
parses ${file} for you.

Use ONE session id for every command. Fresh suggested id: ${sessionId}

Step 1 — transcribe the plan (one command). Fill this skeleton from
${file}: every phase and task, statuses as recorded there
(pending|active|done|blocked), the goal from its goal line:

  ${append} --type plan_updated --payload '{"plan":{"goal":"<goal line from ${file}>","phases":[{"name":"<phase 1 name>","status":"done","tasks":[{"id":"1.1","title":"<task title>","status":"done"}]},{"name":"<phase 2 name>","status":"active","tasks":[{"id":"2.1","title":"<task title>","status":"pending"}]}]}}'

Step 2 — replay every decision recorded in ${file}, oldest first (one
command per decision):

  ${append} --type decision_logged --payload '{"chose":"<what was chosen>","over":"<what was rejected>","because":"<why>"}'

Step 3 — carry over anything durable that fits neither plan nor decisions:

  ${append} --type note_added --payload '{"text":"<the note>"}'

Step 4 — close the migration session. Fill next_action from ${file}'s own
next action / "left off" line:

  ${append} --type session_ended --payload '{"summary":"migrated from ${file}","next_action":"<next action from ${file}>"}'

Step 5 — move durable REPO knowledge (build/test commands, conventions,
gotchas — true of the repo across initiatives, not initiative state) out of
${file} into .harness/repo.md.

Step 6 — retire the legacy protocol:
  - [ ] Delete the legacy prose protocol section from CLAUDE.md — keep only
        the harness marker block (<!-- harness:protocol --> … <!-- /harness:protocol -->).
  - [ ] Run \`harness status ${slug}\` and compare against ${file}: goal,
        phases, tasks, decisions, and next action must all be reproduced.
  - [ ] Only after status reproduces the legacy state: archive or delete
        ${file} (or stamp it superseded with
        \`harness adopt ${file} ${slug} --mark\`).

Verify: run \`harness status ${slug}\` and compare it against ${file}.
`
}

export function runAdopt(
  rootDir: string,
  legacyFile: string,
  slug?: string,
  options: AdoptOptions = {},
): CmdResult {
  const legacyPath = isAbsolute(legacyFile) ? legacyFile : join(rootDir, legacyFile)
  // Brief/banner texts use the repo-relative form — stable across machines.
  const displayFile = isAbsolute(legacyFile) ? relative(rootDir, legacyPath) : legacyFile

  if (!existsSync(legacyPath) || !statSync(legacyPath).isFile()) {
    return typedFail({
      code: 'io_error',
      message: `legacy file not found: ${legacyFile} — pass the path of the pre-harness record to migrate`,
    })
  }

  const ctx = createToolContext(rootDir)
  if (!existsSync(ctx.harnessDir)) {
    return typedFail({
      code: 'io_error',
      message: `no .harness/ found under ${rootDir} — run \`harness init\` first, then \`harness new <slug>\` for the target initiative`,
    })
  }

  let resolved: string
  try {
    resolved = ctx.resolveInitiative(slug)
  } catch (err) {
    const hint = ` — create the target initiative with \`harness new ${slug ?? '<slug>'}\` first`
    if (err instanceof ToolError) {
      return typedFail({ code: err.code, message: `${err.message}${hint}` })
    }
    return typedFail({
      code: 'io_error',
      message: `${err instanceof Error ? err.message : String(err)}${hint}`,
    })
  }

  const brief = renderMigrationBrief({
    legacyFile: displayFile,
    slug: resolved,
    sessionId: `migration-${ulid()}`,
  })

  const lines: string[] = [brief]
  if (options.mark === true) {
    const content = readFileSync(legacyPath, 'utf8')
    if (content.includes(SUPERSEDED_START)) {
      lines.push(`${displayFile} already marked superseded — no change`)
    } else {
      writeFileSync(legacyPath, `${supersededBanner(resolved)}${content}`, 'utf8')
      lines.push(`marked ${displayFile} superseded (banner prepended)`)
    }
  }
  return ok(`${lines.join('\n')}\n`)
}
