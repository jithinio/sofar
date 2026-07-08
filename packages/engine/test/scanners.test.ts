import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  cssExcludesSofar,
  detectTailwindV4,
  findTailwindCssEntries,
  insertSofarExclusion,
  sofarExclusionDirective,
  sofarRelativePath,
  tailwindRangeIsV4Plus,
} from '../src/cli/scanners'

/**
 * Phase 10 (D-P10) — pure scanner-defense helpers: Tailwind v4 detection,
 * entry-stylesheet discovery, and the `.sofar` exclusion directive (path
 * resolved relative to the STYLESHEET, per Tailwind's contract).
 */

const roots: string[] = []
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})
function tmp(): string {
  const r = mkdtempSync(join(tmpdir(), 'sofar-scan-'))
  roots.push(r)
  return r
}
function write(root: string, rel: string, content: string): string {
  const path = join(root, rel)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
  return path
}

describe('tailwindRangeIsV4Plus', () => {
  it('fires for lower-bound >= 4', () => {
    for (const r of ['^4.0.0', '~4.1', '>=4.0.0', '4', '4.x', '4.1.7', 'v4.0.0', '  ^4 ']) {
      expect(tailwindRangeIsV4Plus(r), r).toBe(true)
    }
  })
  it('stays quiet for v3 or ambiguous ranges (conservative — fires only on clear v4)', () => {
    for (const r of ['^3.4.1', '~3', '>=3', '3 || 4', 'latest', 'next', '*', 'workspace:*']) {
      expect(tailwindRangeIsV4Plus(r), r).toBe(false)
    }
  })
})

describe('detectTailwindV4', () => {
  it('reads tailwindcss from any dependency field', () => {
    const root = tmp()
    writeFileSync(join(root, 'package.json'), JSON.stringify({ devDependencies: { tailwindcss: '^4.1.0' } }))
    expect(detectTailwindV4(root)).toEqual({ v4: true, range: '^4.1.0' })
  })
  it('reports v3 as not-v4 but keeps the range', () => {
    const root = tmp()
    writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { tailwindcss: '^3.4.0' } }))
    expect(detectTailwindV4(root)).toEqual({ v4: false, range: '^3.4.0' })
  })
  it('returns v4:false for a missing, unparseable, or tailwind-less package.json', () => {
    expect(detectTailwindV4(tmp())).toEqual({ v4: false }) // no package.json
    const bad = tmp()
    writeFileSync(join(bad, 'package.json'), '{ not json')
    expect(detectTailwindV4(bad)).toEqual({ v4: false })
    const none = tmp()
    writeFileSync(join(none, 'package.json'), JSON.stringify({ dependencies: { react: '^19' } }))
    expect(detectTailwindV4(none)).toEqual({ v4: false })
  })
})

describe('findTailwindCssEntries', () => {
  it('finds @import "tailwindcss" stylesheets and skips dot-dirs and node_modules', () => {
    const root = tmp()
    const entry = write(root, 'src/app.css', '@import "tailwindcss";\nbody{}\n')
    write(root, 'src/other.css', '.x{color:red}\n') // no import
    write(root, 'node_modules/pkg/x.css', '@import "tailwindcss";\n') // skipped dir
    write(root, '.sofar/initiatives/x/plan.md', '@import "tailwindcss";\n') // dot-dir, and not css
    expect(findTailwindCssEntries(root)).toEqual([entry])
  })
})

describe('the .sofar exclusion directive', () => {
  it('resolves the path relative to the stylesheet, forward-slashed and dot-anchored', () => {
    const root = tmp()
    expect(sofarRelativePath(join(root, 'src', 'app.css'), root)).toBe('../.sofar')
    expect(sofarRelativePath(join(root, 'src', 'styles', 'main.css'), root)).toBe('../../.sofar')
    expect(sofarRelativePath(join(root, 'app.css'), root)).toBe('./.sofar') // css at root → dot-anchored
    expect(sofarExclusionDirective(join(root, 'src', 'app.css'), root)).toBe('@source not "../.sofar";')
  })

  it('cssExcludesSofar recognizes plain, globbed, and ancestor exclusions', () => {
    const root = tmp()
    const css = join(root, 'src', 'app.css')
    expect(cssExcludesSofar('@source not "../.sofar";', css, root)).toBe(true)
    expect(cssExcludesSofar("@source not '../.sofar/**/*';", css, root)).toBe(true)
    expect(cssExcludesSofar('@source not "..";', css, root)).toBe(true) // repo root covers .sofar
    expect(cssExcludesSofar('@source not "../public";', css, root)).toBe(false)
    expect(cssExcludesSofar('body{}', css, root)).toBe(false)
  })
})

describe('insertSofarExclusion', () => {
  it('inserts the directive on the line after the import, preserving the rest', () => {
    const root = tmp()
    const css = join(root, 'src', 'app.css')
    const src = '@import "tailwindcss";\n\nbody { color: red; }\n'
    const { content, changed } = insertSofarExclusion(src, css, root)
    expect(changed).toBe(true)
    expect(content).toBe('@import "tailwindcss";\n@source not "../.sofar";\n\nbody { color: red; }\n')
  })

  it('is idempotent — a stylesheet already excluding .sofar is untouched', () => {
    const root = tmp()
    const css = join(root, 'src', 'app.css')
    const once = insertSofarExclusion('@import "tailwindcss";\n', css, root).content
    expect(insertSofarExclusion(once, css, root)).toEqual({ content: once, changed: false })
  })

  it('leaves a stylesheet with no tailwind import unchanged', () => {
    const root = tmp()
    const css = join(root, 'src', 'app.css')
    expect(insertSofarExclusion('.x{}', css, root)).toEqual({ content: '.x{}', changed: false })
  })
})
