import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * docs/ARCHITECTURE.md names every module that exists.
 *
 * An architecture document in a codebase moving at this pace is a liability
 * the moment it stops being true, because it will be BELIEVED after it stops
 * being true — by a new contributor, by a future session reading it as
 * orientation, by whoever renders it as a diagram. Prose rots quietly; nobody
 * notices a paragraph that no longer describes anything.
 *
 * So the doc is not maintained by discipline, it is maintained by this test.
 * Add a module without a line in ARCHITECTURE.md and the suite fails with the
 * module's name — the cheapest possible moment to write that line, while the
 * reason for the module is still in your head.
 *
 * It checks NAMING, not correctness: nothing here can tell whether the
 * sentence beside a module is still true. That is the honest limit of a
 * mechanical check, and it is still the difference between a doc that is
 * incomplete and one that is silently wrong about what exists.
 */

const here = fileURLToPath(new URL('.', import.meta.url))
const repoRoot = join(here, '..', '..', '..')
const docPath = join(repoRoot, 'docs', 'ARCHITECTURE.md')

/** Source roots the doc is responsible for. */
const SOURCE_ROOTS = [
  join(repoRoot, 'packages', 'engine', 'src'),
  join(repoRoot, 'packages', 'schema', 'src'),
]

/**
 * Ambient declarations describe no runtime behaviour, so there is nothing for
 * an architecture doc to say about them. Everything else must be named.
 */
const EXEMPT = new Set(['types.d.ts'])

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      sourceFiles(full, acc)
      continue
    }
    if (!entry.name.endsWith('.ts')) continue
    if (entry.name.endsWith('.test.ts')) continue
    if (EXEMPT.has(entry.name)) continue
    acc.push(full)
  }
  return acc
}

describe('architecture doc', () => {
  const doc = readFileSync(docPath, 'utf8')
  const modules = SOURCE_ROOTS.flatMap((root) => sourceFiles(root))

  it('has modules to check', () => {
    // Guards the guard: a resolution bug that found nothing would make every
    // assertion below pass vacuously and the whole test worthless.
    expect(modules.length).toBeGreaterThan(50)
  })

  it('names every module that exists', () => {
    const missing = modules
      .map((full) => full.slice(repoRoot.length + 1))
      .filter((rel) => {
        // Accept either the repo-relative path or the module's own name —
        // the doc groups some modules (cli/ui/*) by name in one line, and
        // forcing full paths there would buy nothing but noise.
        const name = rel.split('/').pop()!.replace(/\.ts$/, '')
        return !doc.includes(rel) && !doc.includes(`${name}.ts`) && !doc.includes(`\`${name}\``)
      })

    expect(missing, `not named in docs/ARCHITECTURE.md:\n  ${missing.join('\n  ')}`).toEqual([])
  })

  it('states the invariants that constrain every module', () => {
    // These are the load-bearing ones. A doc that dropped them would read as
    // a map of the code while omitting the rules the code is shaped by.
    for (const invariant of [
      'Zero model API calls',
      'The log is truth',
      'The index is derived',
      'Reported, never prevented',
      '100ms shim budget',
    ]) {
      expect(doc, `ARCHITECTURE.md no longer states: ${invariant}`).toContain(invariant)
    }
  })
})
