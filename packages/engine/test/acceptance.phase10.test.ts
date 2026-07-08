import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { runInit } from '../src/cli/init'
import { runDoctor } from '../src/cli/doctor'

/**
 * Phase 10 acceptance (task 10.4, D-P10):
 *   - the init hint fires ONLY on Tailwind v4
 *   - `sofar doctor` flags a missing `.sofar` exclusion and passes a clean repo
 *   - `sofar doctor --fix` inserts the correct (stylesheet-relative) path and
 *     is idempotent
 */

const roots: string[] = []
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

function tmpRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'sofar-p10-'))
  roots.push(root)
  return root
}
function pkg(root: string, deps: Record<string, string>): void {
  writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: deps }, null, 2))
}
function css(root: string, rel: string, content: string): string {
  const path = join(root, rel)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
  return path
}

// ---------------------------------------------------------------------------
// 10.1 — init hint fires only on Tailwind v4.
// ---------------------------------------------------------------------------

describe('sofar init: scanner hint fires only on Tailwind v4', () => {
  it('prints the .sofar exclusion hint as final output when tailwindcss >= 4', () => {
    const root = tmpRepo()
    pkg(root, { tailwindcss: '^4.1.0' })
    const out = runInit(root).stdout
    expect(out).toContain('Tailwind v4 detected')
    expect(out).toContain('.sofar/ records')
    expect(out).toContain('sofar doctor --fix')
    expect(out.trimEnd().endsWith('@source not "<relative-path>/.sofar";')).toBe(true) // final output
  })

  it('stays silent for Tailwind v3', () => {
    const root = tmpRepo()
    pkg(root, { tailwindcss: '^3.4.0' })
    expect(runInit(root).stdout).not.toContain('Tailwind v4')
  })

  it('stays silent when there is no tailwind dependency', () => {
    const root = tmpRepo()
    pkg(root, { react: '^19' })
    expect(runInit(root).stdout).not.toContain('Tailwind v4')
  })
})

// ---------------------------------------------------------------------------
// 10.2 — doctor flags the missing exclusion, passes a clean repo.
// ---------------------------------------------------------------------------

describe('sofar doctor: audit', () => {
  it('flags a Tailwind v4 entry with no .sofar exclusion (exit 1)', () => {
    const root = tmpRepo()
    runInit(root)
    pkg(root, { tailwindcss: '^4.1.0' })
    css(root, 'src/app.css', '@import "tailwindcss";\nbody{}\n')

    const result = runDoctor(root)
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain('src/app.css')
    expect(result.stdout).toContain('no `@source not` exclusion')
    expect(result.stdout).toContain('1 problem found')
  })

  it('passes a clean repo (wired, no scanner hazard) with exit 0', () => {
    const root = tmpRepo()
    runInit(root)
    const result = runDoctor(root)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('no problems found')
    expect(result.stdout).toContain('Tailwind v4 absent')
  })

  it('passes a Tailwind v4 repo whose entry already excludes .sofar', () => {
    const root = tmpRepo()
    runInit(root)
    pkg(root, { tailwindcss: '^4.1.0' })
    css(root, 'src/app.css', '@import "tailwindcss";\n@source not "../.sofar";\nbody{}\n')

    const result = runDoctor(root)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('excludes .sofar from Tailwind scanning')
  })

  it('flags broken wiring — a removed hook shim (exit 1)', () => {
    const root = tmpRepo()
    runInit(root)
    unlinkSync(join(root, '.claude', 'hooks', 'stop.sh'))
    const result = runDoctor(root)
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain('hook shims missing: stop.sh')
  })

  it('refuses to run outside a .sofar record', () => {
    const root = tmpRepo()
    const result = runDoctor(root)
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('run `sofar init` first')
  })
})

// ---------------------------------------------------------------------------
// 10.3 — doctor --fix inserts the correct path, idempotent.
// ---------------------------------------------------------------------------

describe('sofar doctor --fix: insert the .sofar exclusion', () => {
  it('inserts the stylesheet-relative exclusion after the import (exit 0)', () => {
    const root = tmpRepo()
    runInit(root)
    pkg(root, { tailwindcss: '^4.1.0' })
    const app = css(root, 'src/app.css', '@import "tailwindcss";\n\nbody { color: red; }\n')

    const result = runDoctor(root, { fix: true })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('1 fix applied')
    expect(readFileSync(app, 'utf8')).toBe(
      '@import "tailwindcss";\n@source not "../.sofar";\n\nbody { color: red; }\n',
    )
  })

  it('computes the correct relative path for a nested stylesheet', () => {
    const root = tmpRepo()
    runInit(root)
    pkg(root, { tailwindcss: '^4.1.0' })
    const nested = css(root, 'src/styles/main.css', '@import "tailwindcss";\n')

    runDoctor(root, { fix: true })
    expect(readFileSync(nested, 'utf8')).toContain('@source not "../../.sofar";')
  })

  it('is idempotent — a second --fix changes nothing', () => {
    const root = tmpRepo()
    runInit(root)
    pkg(root, { tailwindcss: '^4.1.0' })
    const app = css(root, 'src/app.css', '@import "tailwindcss";\n')

    runDoctor(root, { fix: true })
    const afterFirst = readFileSync(app, 'utf8')

    const second = runDoctor(root, { fix: true })
    expect(second.exitCode).toBe(0)
    expect(second.stdout).not.toContain('fix applied')
    expect(readFileSync(app, 'utf8')).toBe(afterFirst) // byte-identical
  })
})
