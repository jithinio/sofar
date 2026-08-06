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

  it('never hands a pre-4.1 repo the `@source not` line it cannot parse (scanner-version-gate D1)', () => {
    const root = tmpRepo()
    pkg(root, { tailwindcss: '^4.0.17' })
    const out = runInit(root).stdout
    expect(out).toContain('Tailwind v4 detected')
    expect(out).toContain('needs Tailwind >= 4.1')
    expect(out).toContain('@import "tailwindcss" source("<your-template-dir>");')
    expect(out).not.toContain('@source not "<relative-path>/.sofar";')
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

// ---------------------------------------------------------------------------
// scanner-version-gate D1 — `@source not` is version-gated: it landed in Tailwind 4.1, and on
// 4.0.x it parses as an unquoted path, breaking the build --fix set out to
// protect. Regression: --fix must report, not write.
// ---------------------------------------------------------------------------

describe('sofar doctor --fix: the 4.1 gate on `@source not`', () => {
  function install(root: string, version: string): void {
    const dir = join(root, 'node_modules', 'tailwindcss')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'tailwindcss', version }))
  }

  it('withholds the write on an installed 4.0.x and names the pre-4.1 remedy', () => {
    const root = tmpRepo()
    runInit(root)
    pkg(root, { tailwindcss: '^4.0.17' })
    install(root, '4.0.17')
    const source = '@import "tailwindcss";\n\nbody { color: red; }\n'
    const app = css(root, 'src/app.css', source)

    const result = runDoctor(root, { fix: true })
    expect(readFileSync(app, 'utf8')).toBe(source) // byte-identical — nothing written
    expect(result.stdout).not.toContain('fix applied')
    expect(result.exitCode).toBe(1) // the hazard is real and still reported
    expect(result.stdout).toContain('tailwindcss 4.0.17 installed')
    expect(result.stdout).toContain('needs >= 4.1')
    // The suggested base is stylesheet-relative: for src/app.css that is `./`
    // (= src/). Suggesting a literal "./src" here would resolve to src/src.
    expect(result.stdout).toContain('@import "tailwindcss" source("./");')
  })

  it('withholds the write when the range floor is below 4.1 and deps are absent', () => {
    const root = tmpRepo()
    runInit(root)
    pkg(root, { tailwindcss: '^4' }) // admits 4.1, guarantees 4.0
    const source = '@import "tailwindcss";\n'
    const app = css(root, 'src/app.css', source)

    const result = runDoctor(root, { fix: true })
    expect(readFileSync(app, 'utf8')).toBe(source)
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain('resolved version unknown')
  })

  it('still fixes when node_modules proves >= 4.1 under an open range', () => {
    const root = tmpRepo()
    runInit(root)
    pkg(root, { tailwindcss: '^4' })
    install(root, '4.1.13')
    const app = css(root, 'src/app.css', '@import "tailwindcss";\n')

    const result = runDoctor(root, { fix: true })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('1 fix applied')
    expect(readFileSync(app, 'utf8')).toContain('@source not "../.sofar";')
  })

  it('passes a 4.0 repo that narrowed the import scan base instead', () => {
    const root = tmpRepo()
    runInit(root)
    pkg(root, { tailwindcss: '^4.0.17' })
    install(root, '4.0.17')
    css(root, 'src/app.css', '@import "tailwindcss" source("./");\nbody{}\n')

    const result = runDoctor(root)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('excludes .sofar from Tailwind scanning')
  })
})
