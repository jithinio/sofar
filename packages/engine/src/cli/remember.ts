import { createToolContext, ToolError } from '../mcp/context'
import { errMessage, fail, ok, type CmdResult } from './shared'
import { renderConfirmation, renderFailure } from './new'
import { type Caps, stderrCaps, stdoutCaps } from './ui'

/**
 * `sofar remember <text>` (SPEC §CLI) — the human-facing half of the capture
 * path the record was missing (repo-memory-capture D1); agents reach the same
 * append through the sofar_remember MCP tool.
 *
 * Appends memory_promoted and reports the `<slug> M<n>` handle, because that
 * handle is the whole point: it is what .sofar/repo.md must name for `sofar
 * doctor` to stop reporting the promotion. The ordinal comes from folding
 * AFTER the append rather than counting beforehand — the fold is the only
 * thing that decides what M<n> means, and a concurrent append must not be able
 * to hand two promotions the same number.
 */
export function runRemember(
  rootDir: string,
  text: string,
  options: { initiative?: string } = {},
  caps: Caps = stdoutCaps(),
  errCaps: Caps = stderrCaps(),
): CmdResult {
  if (text.trim().length === 0) {
    return fail(renderFailure('sofar remember: nothing to remember (text is empty)', errCaps))
  }

  const ctx = createToolContext(rootDir)
  try {
    const slug = ctx.resolveWriteInitiative(options.initiative)
    const event = ctx.appendAndProject(slug, 'memory_promoted', { text: text.trim() }, {
      session: 'cli',
      source: 'cli',
      actor: 'human',
    })
    const ordinal = ctx.foldState(slug).memories.findIndex((m) => m.id === event.id) + 1
    const handle = `${slug} M${ordinal}`
    return ok(
      `${renderConfirmation(
        [
          `promoted ${handle}`,
          text.trim(),
          `name it in .sofar/repo.md citing \`${handle}\` — sofar never writes repo.md, and doctor reports this until it does`,
        ],
        caps,
      )}\n`,
    )
  } catch (err) {
    if (err instanceof ToolError) {
      return fail(renderFailure(`sofar remember: ${errMessage(err)}`, errCaps))
    }
    throw err
  }
}
