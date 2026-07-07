import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { runAdopt, SUPERSEDED_START, SUPERSEDED_END } from '../src/cli/adopt'
import { runInit } from '../src/cli/init'
import { runNew } from '../src/cli/new'

/**
 * Task 8.2 — `sofar adopt <legacy-file> [slug] [--mark]` (BD46).
 * Command-level coverage: the three validation failures (typed-error JSON,
 * event append's style), brief contents (exact dialect templates with slug +
 * fresh session id baked in, retirement checklist, verification line), slug
 * resolution via positional and branch binding, and --mark idempotency.
 * The end-to-end "execute the brief as scripted shell" flow lives in
 * acceptance.phase8.
 */

const roots: string[] = []

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

function freshRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'sofar-adopt-'))
  roots.push(root)
  mkdirSync(join(root, '.git'), { recursive: true })
  writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  return root
}

const LEGACY = `# Initiative: legacy\n\n## Goal\nShip the widget.\n\nNext action: wire the API.\n`

/** Repo with .sofar, a bound initiative, and a legacy record file. */
function adoptableRepo(): string {
  const root = freshRepo()
  runInit(root)
  runNew(root, 'legacy-widget', { goal: 'Ship the widget.' })
  writeFileSync(join(root, 'legacy.md'), LEGACY)
  return root
}

function stderrJSON(result: { stderr: string }): { code: string; message: string } {
  return JSON.parse(result.stderr) as { code: string; message: string }
}

describe('sofar adopt validation (typed-error JSON, exit 1)', () => {
  it('rejects a missing legacy file', () => {
    const root = adoptableRepo()
    const result = runAdopt(root, 'no-such.md', 'legacy-widget')
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toBe('')
    const err = stderrJSON(result)
    expect(err.code).toBe('io_error')
    expect(err.message).toContain('no-such.md')
  })

  it('requires .sofar/ and points at sofar init', () => {
    const root = freshRepo()
    writeFileSync(join(root, 'legacy.md'), LEGACY)
    const result = runAdopt(root, 'legacy.md')
    expect(result.exitCode).toBe(1)
    const err = stderrJSON(result)
    expect(err.code).toBe('io_error')
    expect(err.message).toContain('sofar init')
  })

  it('requires a resolvable initiative and names sofar new', () => {
    const root = freshRepo()
    runInit(root) // .sofar exists, but no initiative and no binding
    writeFileSync(join(root, 'legacy.md'), LEGACY)

    const unbound = runAdopt(root, 'legacy.md')
    expect(unbound.exitCode).toBe(1)
    expect(stderrJSON(unbound).code).toBe('unknown_initiative')
    expect(stderrJSON(unbound).message).toContain('sofar new <slug>')

    const unknown = runAdopt(root, 'legacy.md', 'ghost')
    expect(unknown.exitCode).toBe(1)
    expect(stderrJSON(unknown).code).toBe('unknown_initiative')
    expect(stderrJSON(unknown).message).toContain('sofar new ghost')
  })
})

describe('the migration brief', () => {
  it('carries the goal line, all four dialect templates, and the checklists', () => {
    const root = adoptableRepo()
    const result = runAdopt(root, 'legacy.md', 'legacy-widget')
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('')
    const brief = result.stdout

    // (1) goal line: replay <file> into <slug>
    expect(brief).toContain('replay legacy.md into initiative "legacy-widget"')

    // (2) exact dialect templates — slug + ONE fresh session id baked in
    const ids = [...brief.matchAll(/--session (\S+)/g)].map((m) => m[1])
    expect(ids).toHaveLength(5)
    expect(new Set(ids).size).toBe(1)
    expect(ids[0]).toMatch(/^migration-[0-9A-HJKMNP-TV-Z]{26}$/)
    const append = `sofar event append legacy-widget --session ${ids[0]} --actor human`
    expect(brief).toContain(`${append} --type session_started --payload '{"tool":"migration"}'`)
    expect(brief).toContain(`${append} --type plan_updated`)
    expect(brief).toContain('"plan":{"goal":') // filled PlanStructure skeleton
    expect(brief).toContain('"phases":[{"name":')
    expect(brief).toContain(`${append} --type decision_logged`)
    expect(brief).toContain('"chose":"<what was chosen>","over":"<what was rejected>","because":"<why>"')
    expect(brief).toContain(`${append} --type note_added`)
    expect(brief).toContain(`${append} --type session_ended`)
    expect(brief).toContain('"summary":"migrated from legacy.md"') // seeded summary
    expect(brief).toContain('"next_action":"<next action from legacy.md>"')

    // (3) repo knowledge move, (4) retirement checklist, (5) verification
    expect(brief).toContain('.sofar/repo.md')
    expect(brief).toContain('Delete the legacy prose protocol section from CLAUDE.md')
    expect(brief).toContain('<!-- sofar:protocol -->')
    expect(brief).toContain('archive or delete')
    expect(brief).toContain('sofar status legacy-widget')
  })

  it('suggests a fresh session id per run and resolves the slug from the branch binding', () => {
    const root = adoptableRepo() // runNew bound main → legacy-widget
    const first = runAdopt(root, 'legacy.md')
    const second = runAdopt(root, 'legacy.md')
    expect(first.exitCode).toBe(0)
    expect(second.exitCode).toBe(0)
    expect(first.stdout).toContain('initiative "legacy-widget"')
    const idOf = (s: string): string => /--session (\S+)/.exec(s)![1]!
    expect(idOf(first.stdout)).not.toBe(idOf(second.stdout))
  })
})

describe('adopt --mark', () => {
  it('prepends the superseded banner between markers, preserving the record', () => {
    const root = adoptableRepo()
    const result = runAdopt(root, 'legacy.md', 'legacy-widget', { mark: true })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('marked legacy.md superseded')

    const marked = readFileSync(join(root, 'legacy.md'), 'utf8')
    expect(marked.startsWith(`${SUPERSEDED_START}\n`)).toBe(true)
    expect(marked).toContain(SUPERSEDED_END)
    expect(marked).toMatch(
      /SUPERSEDED — this record migrated to \.sofar\/initiatives\/legacy-widget\/ on \d{4}-\d{2}-\d{2}\./,
    )
    expect(marked).toContain('Do not update this file; truth lives in the sofar record.')
    expect(marked.endsWith(LEGACY)).toBe(true) // original content byte-preserved below
  })

  it('is idempotent: a second --mark run changes zero bytes', () => {
    const root = adoptableRepo()
    runAdopt(root, 'legacy.md', 'legacy-widget', { mark: true })
    const before = readFileSync(join(root, 'legacy.md'), 'utf8')

    const second = runAdopt(root, 'legacy.md', 'legacy-widget', { mark: true })
    expect(second.exitCode).toBe(0)
    expect(second.stdout).toContain('already marked superseded — no change')
    expect(readFileSync(join(root, 'legacy.md'), 'utf8')).toBe(before)
  })

  it('still stamps a file whose BODY quotes the marker (idempotency is head-anchored)', () => {
    // Field finding from the self-host migration: the archived prose record QUOTED
    // "<!-- sofar:superseded -->" inside a decision entry, and --mark
    // wrongly reported it as already marked.
    const root = adoptableRepo()
    const legacyPath = join(root, 'legacy.md')
    const quoting = `${LEGACY}\n## BD46\nadopt --mark stamps between ${SUPERSEDED_START} markers.\n`
    writeFileSync(legacyPath, quoting)

    const result = runAdopt(root, 'legacy.md', 'legacy-widget', { mark: true })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('marked legacy.md superseded')
    const marked = readFileSync(legacyPath, 'utf8')
    expect(marked.startsWith(`${SUPERSEDED_START}\n`)).toBe(true)
    expect(marked.endsWith(quoting)).toBe(true)

    const second = runAdopt(root, 'legacy.md', 'legacy-widget', { mark: true })
    expect(second.stdout).toContain('already marked superseded — no change')
    expect(readFileSync(legacyPath, 'utf8')).toBe(marked)
  })
})
