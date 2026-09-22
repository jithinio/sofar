import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  classify,
  claudeMemoryDir,
  declinedDigests,
  importText,
  originOf,
  priorImports,
  readNativeEntries,
  recordDecline,
  secretLines,
  type Candidate,
} from '../core/native-memory'
import type { StateEnv } from '../core/state-dir'
import { createToolContext, ToolError } from '../mcp/context'
import { resolveSupersedes } from '../mcp/remember'
import { errMessage, fail, ok, type CmdResult } from './shared'

/**
 * `sofar remember --from-native` (memory-lead 2.4, D13/D14) — import Claude
 * Code auto-memory entries into repo memory, one operator approval at a time.
 *
 * The operator's ruling (D13) is the whole shape: import-only, off by default,
 * project and reference entries only, each shown for approval, nothing in the
 * record before that approval, and every import marked as native memory's
 * words. So this runs only on a terminal: from an agent's shell it appends
 * nothing and says how many entries wait, because an agent answering its own
 * prompt would be the agent deciding what the operator shares.
 */

export interface NativeImportIO {
  /** One question on the operator's terminal; null when there is none (an agent shell, CI, a pipe). */
  ask: ((question: string) => Promise<string>) | null
  now?: () => string
  env?: StateEnv
  home?: string
}

function describe(candidate: Candidate, index: number, total: number, slug: string): string {
  const { entry } = candidate
  const text = importText(entry)
  const flagged = secretLines(text)
  return [
    '',
    `[${index}/${total}] ${entry.file} — ${entry.type}${candidate.updates !== undefined ? `, a changed version of ${candidate.updates}` : ''}`,
    ...(entry.name !== undefined ? [`name: ${entry.name}`] : []),
    '',
    text,
    '',
    ...(flagged.length > 0
      ? [`⚠ ${flagged.length === 1 ? `line ${flagged[0]} of this entry looks like a secret` : `lines ${flagged.join(', ')} of this entry look like secrets`} — sofar has no secret scanner, so check before importing`]
      : []),
    `Import into ${slug}'s repo memory? It is committed and shared with everyone who clones this repo.`,
    '[y]es / [n]o, never offer again / [s]kip for now / [q]uit: ',
  ].join('\n')
}

export async function runNativeImport(
  rootDir: string,
  options: { dir?: string; initiative?: string },
  io: NativeImportIO,
): Promise<CmdResult> {
  const env = io.env ?? process.env
  const { dir, source } = claudeMemoryDir(rootDir, options.dir, env, io.home)
  if (!existsSync(dir)) {
    return fail(`sofar remember --from-native: no Claude memory directory at ${dir} (from ${source}) — pass --dir <path> if it lives elsewhere\n`)
  }
  const found = classify(readNativeEntries(dir), priorImports(join(rootDir, '.sofar')), declinedDigests(rootDir, env))
  const waiting = found.offered.length

  if (io.ask === null) {
    return fail(
      `sofar remember --from-native: importing native memory needs a terminal — the operator approves each entry (memory-lead D13), and an agent cannot approve on their behalf. ${waiting} entr${waiting === 1 ? 'y waits' : 'ies wait'} in ${dir}.\n`,
    )
  }

  const ctx = createToolContext(rootDir)
  let slug: string
  try {
    slug = ctx.resolveWriteInitiative(options.initiative)
  } catch (err) {
    if (err instanceof ToolError) return fail(`sofar remember --from-native: ${errMessage(err)}\n`)
    throw err
  }

  const imported: string[] = []
  let declined = 0
  let skipped = 0
  let unremembered = 0
  let stopped = false
  const now = io.now ?? (() => new Date().toISOString())
  for (let i = 0; i < found.offered.length; i++) {
    const candidate = found.offered[i]!
    const answer = (await io.ask(describe(candidate, i + 1, waiting, slug))).trim().toLowerCase()
    if (answer === 'q' || answer === 'quit') {
      stopped = true
      skipped += waiting - i
      break
    }
    if (answer === 'n' || answer === 'no') {
      declined++
      if (!recordDecline(rootDir, candidate.entry, now(), env)) unremembered++
      continue
    }
    if (answer !== 'y' && answer !== 'yes') {
      skipped++
      continue
    }
    try {
      const event = ctx.appendAndProject(
        slug,
        'memory_promoted',
        {
          text: importText(candidate.entry),
          origin: originOf(candidate.entry),
          ...(candidate.updates !== undefined ? { supersedes: resolveSupersedes(ctx, slug, candidate.updates) } : {}),
        },
        { session: 'cli', source: 'cli', actor: 'human' },
      )
      const ordinal = ctx.foldState(slug).memories.findIndex((m) => m.id === event.id) + 1
      imported.push(`${slug} M${ordinal}${candidate.updates !== undefined ? ` (supersedes ${candidate.updates})` : ''}`)
    } catch (err) {
      if (err instanceof ToolError) return fail(`sofar remember --from-native: ${errMessage(err)} — imported so far: ${imported.join(', ') || 'none'}\n`)
      throw err
    }
  }

  const notOffered = [
    found.notImportable > 0 ? `${found.notImportable} user, feedback or untyped (never imported, D13)` : '',
    found.alreadyImported > 0 ? `${found.alreadyImported} already imported` : '',
    found.declinedBefore > 0 ? `${found.declinedBefore} declined before on this clone` : '',
    found.empty > 0 ? `${found.empty} with no text` : '',
  ].filter((s) => s.length > 0)
  const lines = [
    `sofar remember --from-native: ${dir} (${source})`,
    `imported: ${imported.length > 0 ? imported.join(', ') : 'none'}`,
    ...(declined > 0 ? [`declined: ${declined}${unremembered > 0 ? ` (${unremembered} not remembered: the sofar state dir resolves inside this clone)` : ', remembered on this clone'}`] : []),
    ...(skipped > 0 ? [`skipped: ${skipped}${stopped ? ' (stopped early)' : ''} — offered again next time`] : []),
    ...(notOffered.length > 0 ? [`not offered: ${notOffered.join('; ')}`] : []),
    ...(imported.length > 0
      ? ['Each import is marked as Claude memory\'s words, not yours. Nothing is committed until you commit; name the handles in .sofar/repo.md if they belong there.']
      : []),
  ]
  return ok(`${lines.join('\n')}\n`)
}
