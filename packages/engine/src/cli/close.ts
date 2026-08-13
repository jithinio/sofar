import { existsSync } from 'node:fs'
import type { InitiativeStatus } from '@sofar/schema'
import { BindingsAbort } from '../core/bindings'
import { applyClose } from '../mcp/close-initiative'
import { createToolContext, ToolError } from '../mcp/context'
import { renderConfirmation, renderFailure } from './new'
import { errMessage, fail, ok, type CmdResult } from './shared'
import { type Caps, stderrCaps, stdoutCaps } from './ui'

/**
 * `sofar close [slug] [--drop] [--reason <text>]` (SPEC §CLI) — record that an
 * initiative is finished, and take every branch off it.
 *
 * Two steps, in this order: append initiative_status_changed, then remove
 * EVERY bindings.json entry pointing at the slug (D1 — not just the current
 * branch; a closed record should have no branch aimed at it). The append comes
 * first because the log is truth: a crash between the two leaves a record
 * correctly marked closed with a stale binding, which `sofar doctor` reports
 * and re-running close repairs. The reverse order would leave branches
 * silently unbound from a record that never closed — invisible and unfixable
 * by repetition.
 *
 * Unbinding is safe because resolution is session-first: the session that
 * closed it keeps its record until it ends, while a new session on the
 * now-unbound branch is told to start or switch instead of landing on
 * finished work.
 *
 * Idempotent: closing an already-closed initiative to the same status appends
 * nothing and simply ensures no branch is left bound — so re-running it is
 * the repair for the stale-binding case, never a second event in the log.
 */

export interface CloseOptions {
  /** --drop → `dropped` (abandoned); default `done` (finished). */
  drop?: boolean
  /** Reason. REQUIRED for a drop (task-drop-state D3). */
  reason?: string
}

export function runClose(
  rootDir: string,
  slug?: string,
  options: CloseOptions = {},
  caps: Caps = stdoutCaps(),
  errCaps: Caps = stderrCaps(),
): CmdResult {
  const ctx = createToolContext(rootDir)
  const status: InitiativeStatus = options.drop === true ? 'dropped' : 'done'
  const reason = options.reason?.trim() ?? ''

  // A drop is the one close that records something was NOT delivered
  // (task-drop-state D3). Caught here rather than at the payload validator so
  // the message names the flag the user actually types.
  if (status === 'dropped' && reason.length === 0) {
    return fail(
      renderFailure(
        'sofar close: --drop needs a reason — pass `--reason <text>` saying why it was abandoned',
        errCaps,
      ),
    )
  }

  let resolved: string
  try {
    resolved = ctx.resolveInitiative(slug)
  } catch (err) {
    if (err instanceof ToolError) return fail(renderFailure(`sofar close: ${err.message}`, errCaps))
    throw err
  }
  if (!existsSync(ctx.initiativeDir(resolved))) {
    return fail(
      renderFailure(
        `sofar close: initiative "${resolved}" not found under .sofar/initiatives/`,
        errCaps,
      ),
    )
  }

  const report: string[] = []
  try {
    const { event_id, unbound, overrides } = applyClose(ctx, resolved, status, reason)
    report.push(
      event_id === null
        ? `${resolved} is already ${status} — no second event appended`
        : `closed ${resolved} as ${status}${reason.length > 0 ? ` — ${reason}` : ''}`,
    )
    // The audit refuses nothing (5.2), so this is not a warning the user can
    // clear by re-running — it is what the log now says, read back to them at
    // the one moment they can still do something about it.
    if (overrides.length > 0) {
      report.push(
        `closed with ${overrides.length} finding(s) OVERRIDDEN — recorded on the event and rendered from here on:`,
      )
      // No bullet character: renderConfirmation already marks every detail
      // line with its own elbow, and two markers on one line read as a nested
      // list that is not there (cli-ui D1).
      for (const finding of overrides) report.push(`  ${finding}`)
    }
    report.push(
      unbound.length === 0
        ? 'no branch was bound to it'
        : `unbound ${unbound.length === 1 ? 'branch' : 'branches'} ${unbound.map((b) => `"${b}"`).join(', ')}`,
    )
    report.push(`reopen it by working on it again: sofar switch ${resolved}`)
  } catch (err) {
    if (err instanceof BindingsAbort || err instanceof ToolError) {
      return fail(renderFailure(`sofar close: ${errMessage(err)}`, errCaps))
    }
    throw err
  }

  return ok(`${renderConfirmation(report, caps)}\n`)
}
