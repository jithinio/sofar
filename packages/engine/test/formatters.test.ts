import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  detectFormatterHazards,
  expandBraces,
  formatJSON,
  globToRegExp,
  hostShapedJSON,
  patternCoversSofar,
  resolveJsonStyle,
  stripJsonc,
} from '../src/cli/formatters'
import { runInit } from '../src/cli/init'
import { runDoctor } from '../src/cli/doctor'
import { runUninit } from '../src/cli/uninit'

/**
 * r1-fixes 1.4 (D7) — formatter defence:
 *   - init writes .mcp.json / .claude/settings.json in the host formatter's
 *     shape (Biome tabs, Prettier/editorconfig widths, short arrays inline),
 *     verified against what biome 2.5 and prettier 3 actually print
 *   - `sofar doctor` names Biome, Prettier and markdownlint reaching .sofar
 *     (exit 1) and passes once each excludes it
 *   - `sofar doctor --fix` writes each tool's documented exclusion, is
 *     idempotent, and is WITHHELD for configs it cannot round-trip
 */

const roots: string[] = []
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

function tmpRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'sofar-fmt-'))
  roots.push(root)
  return root
}
function file(root: string, rel: string, content: string): string {
  const path = join(root, rel)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
  return path
}
function read(root: string, rel: string): string {
  return readFileSync(join(root, rel), 'utf8')
}
function devDeps(root: string, deps: Record<string, string>): void {
  file(root, 'package.json', JSON.stringify({ devDependencies: deps }, null, 2))
}
function installed(root: string, name: string, version: string): void {
  file(root, `node_modules/${name}/package.json`, JSON.stringify({ name, version }))
}

/** What `biome format` (2.5.13, defaults) printed for init's .mcp.json. */
const MCP_BIOME = '{\n\t"mcpServers": {\n\t\t"sofar": {\n\t\t\t"command": "sofar",\n\t\t\t"args": ["mcp"]\n\t\t}\n\t}\n}\n'
/** What `prettier` (3, defaults) printed for it. */
const MCP_PRETTIER = '{\n  "mcpServers": {\n    "sofar": {\n      "command": "sofar",\n      "args": ["mcp"]\n    }\n  }\n}\n'

// ---------------------------------------------------------------------------
// Pure helpers.
// ---------------------------------------------------------------------------

describe('globs', () => {
  it('expands braces, nested and repeated', () => {
    expect(expandBraces('*.{json,md}')).toEqual(['*.json', '*.md'])
    expect(expandBraces('{a,b}/{c,d}')).toEqual(['a/c', 'a/d', 'b/c', 'b/d'])
    expect(expandBraces('x{a,{b,c}}')).toEqual(['xa', 'xb', 'xc'])
    expect(expandBraces('plain')).toEqual(['plain'])
  })

  it('matches segment-wise: * stays in a segment, ** spans them', () => {
    expect(globToRegExp('*.json').test('a.json')).toBe(true)
    expect(globToRegExp('*.json').test('dir/a.json')).toBe(false)
    expect(globToRegExp('**/*.json').test('dir/a.json')).toBe(true)
    expect(globToRegExp('**/*.json').test('a.json')).toBe(true)
    expect(globToRegExp('src/**').test('src/x/y.ts')).toBe(true)
    expect(globToRegExp('src/**').test('.sofar/x')).toBe(false)
    expect(globToRegExp('a?c').test('abc')).toBe(true)
    expect(globToRegExp('a.c').test('abc')).toBe(false)
  })

  it('recognizes every spelling of a .sofar exclusion, and the repo-wide **', () => {
    for (const p of ['.sofar', '.sofar/', '/.sofar', './.sofar', '**/.sofar', '.sofar/**', '**/.sofar/**', '!**/.sofar', '!!**/.sofar', '**']) {
      expect(patternCoversSofar(p), p).toBe(true)
    }
    for (const p of ['src/**', '.sofa', 'sofar', '**/*.ts', '.sofar-old']) {
      expect(patternCoversSofar(p), p).toBe(false)
    }
  })
})

describe('stripJsonc', () => {
  it('drops comments and trailing commas but not string contents', () => {
    const text = '{\n  // c\n  "a": "x // y", /* z */\n  "b": [1, 2,],\n}\n'
    expect(JSON.parse(stripJsonc(text))).toEqual({ a: 'x // y', b: [1, 2] })
  })
})

describe('formatJSON', () => {
  const value = { mcpServers: { sofar: { command: 'sofar', args: ['mcp'] } } }

  it('default style is Prettier’s: 2 spaces, short arrays inline, objects expanded', () => {
    expect(formatJSON(value)).toBe(MCP_PRETTIER)
  })

  it('a tab style is Biome’s default output', () => {
    expect(formatJSON(value, { indent: '\t', indentWidth: 2, lineWidth: 80, source: 'biome' })).toBe(MCP_BIOME)
  })

  it('keeps arrays of objects expanded and empties compact', () => {
    const out = formatJSON({ hooks: [{ type: 'command' }], env: {}, list: [], n: null })
    expect(out).toBe('{\n  "hooks": [\n    {\n      "type": "command"\n    }\n  ],\n  "env": {},\n  "list": [],\n  "n": null\n}\n')
  })

  it('breaks a scalar array one-per-line once it overflows the line width', () => {
    const out = formatJSON({ a: ['x', 'y'] }, { indent: '  ', indentWidth: 2, lineWidth: 10, source: 'default' })
    expect(out).toBe('{\n  "a": [\n    "x",\n    "y"\n  ]\n}\n')
  })

  it('skips undefined object values and nulls undefined array items, like JSON.stringify', () => {
    expect(formatJSON({ a: undefined, b: [undefined] })).toBe('{\n  "b": [null]\n}\n')
  })
})

// ---------------------------------------------------------------------------
// Style resolution.
// ---------------------------------------------------------------------------

describe('hostShapedJSON', () => {
  it('is the formatter shape with a config and the stringify shape without', () => {
    const root = tmpRepo()
    expect(hostShapedJSON(root, 'x.json', { a: [1] })).toBe('{\n  "a": [\n    1\n  ]\n}\n')
    file(root, '.editorconfig', '[*]\nindent_style = tab\n')
    expect(hostShapedJSON(root, 'x.json', { a: [1] })).toBe('{\n\t"a": [1]\n}\n')
  })
})

describe('resolveJsonStyle', () => {
  it('is the 2-space default in a repo with no formatter', () => {
    const root = tmpRepo()
    expect(resolveJsonStyle(root, '.mcp.json')).toMatchObject({ indent: '  ', source: 'default' })
  })

  it('Biome present → its defaults (tab, 80)', () => {
    const root = tmpRepo()
    file(root, 'biome.json', '{}')
    expect(resolveJsonStyle(root, '.mcp.json')).toMatchObject({ indent: '\t', indentWidth: 2, lineWidth: 80, source: 'biome' })
  })

  it('Biome formatter options apply, json.formatter overriding formatter', () => {
    const root = tmpRepo()
    file(root, 'biome.json', JSON.stringify({ formatter: { indentStyle: 'space', indentWidth: 4, lineWidth: 100 }, json: { formatter: { indentWidth: 3 } } }))
    expect(resolveJsonStyle(root, '.mcp.json')).toMatchObject({ indent: '   ', indentWidth: 3, lineWidth: 100, source: 'biome' })
  })

  it('a biome.jsonc with comments still decides the shape', () => {
    const root = tmpRepo()
    file(root, 'biome.jsonc', '{\n  // spaces please\n  "formatter": { "indentStyle": "space" },\n}\n')
    expect(resolveJsonStyle(root, '.mcp.json')).toMatchObject({ indent: '  ', source: 'biome' })
  })

  it('Biome with its formatter off, or the file excluded, yields to the next source', () => {
    const root = tmpRepo()
    file(root, 'biome.json', JSON.stringify({ formatter: { enabled: false } }))
    expect(resolveJsonStyle(root, '.mcp.json').source).toBe('default')
    file(root, 'biome.json', JSON.stringify({ files: { includes: ['**', '!.mcp.json'] } }))
    expect(resolveJsonStyle(root, '.mcp.json').source).toBe('default')
    expect(resolveJsonStyle(root, '.claude/settings.json').source).toBe('biome')
    file(root, 'biome.json', JSON.stringify({ files: { includes: ['src/**'] } }))
    expect(resolveJsonStyle(root, '.mcp.json').source).toBe('default')
  })

  it('Biome 2 reads .editorconfig by default; Biome 1 does not', () => {
    const root = tmpRepo()
    file(root, '.editorconfig', 'root = true\n\n[*]\nindent_style = space\nindent_size = 4\n')
    file(root, 'biome.json', JSON.stringify({ $schema: 'https://biomejs.dev/schemas/2.2.0/schema.json' }))
    expect(resolveJsonStyle(root, '.mcp.json')).toMatchObject({ indent: '    ', source: 'biome' })
    file(root, 'biome.json', JSON.stringify({ $schema: 'https://biomejs.dev/schemas/1.9.4/schema.json' }))
    expect(resolveJsonStyle(root, '.mcp.json')).toMatchObject({ indent: '\t', source: 'biome' })
    file(root, 'biome.json', JSON.stringify({ $schema: 'https://biomejs.dev/schemas/1.9.4/schema.json', formatter: { useEditorconfig: true } }))
    expect(resolveJsonStyle(root, '.mcp.json')).toMatchObject({ indent: '    ', source: 'biome' })
  })

  it('Prettier: JSON config, YAML config, package.json key, and .editorconfig underneath', () => {
    const root = tmpRepo()
    file(root, '.prettierrc', JSON.stringify({ useTabs: true, printWidth: 120 }))
    expect(resolveJsonStyle(root, '.mcp.json')).toMatchObject({ indent: '\t', lineWidth: 120, source: 'prettier' })
    file(root, '.prettierrc', 'useTabs: false\ntabWidth: 4  # wide\n')
    expect(resolveJsonStyle(root, '.mcp.json')).toMatchObject({ indent: '    ', source: 'prettier' })
    rmSync(join(root, '.prettierrc'))
    file(root, 'package.json', JSON.stringify({ prettier: { tabWidth: 3 } }))
    expect(resolveJsonStyle(root, '.mcp.json')).toMatchObject({ indent: '   ', source: 'prettier' })
    file(root, 'package.json', JSON.stringify({ devDependencies: { prettier: '^3' } }))
    file(root, '.editorconfig', '[*.json]\nindent_style = tab\n')
    expect(resolveJsonStyle(root, '.mcp.json')).toMatchObject({ indent: '\t', source: 'prettier' })
    file(root, '.prettierignore', '.mcp.json\n')
    expect(resolveJsonStyle(root, '.mcp.json')).toMatchObject({ indent: '\t', source: 'editorconfig' })
  })

  it('.editorconfig alone: sections match by path, later sections win, indent_size = tab reads tab_width', () => {
    const root = tmpRepo()
    file(root, '.editorconfig', '[*]\nindent_style = space\nindent_size = 4\n\n[*.{json,jsonc}]\nindent_style = tab\nindent_size = tab\ntab_width = 8\nmax_line_length = 100\n\n[src/**]\nindent_size = 2\n')
    expect(resolveJsonStyle(root, '.mcp.json')).toMatchObject({ indent: '\t', indentWidth: 8, lineWidth: 100, source: 'editorconfig' })
    expect(resolveJsonStyle(root, '.claude/settings.json')).toMatchObject({ indent: '\t', source: 'editorconfig' })
    expect(resolveJsonStyle(root, 'src/x.ts')).toMatchObject({ indent: '  ', source: 'editorconfig' })
  })
})

// ---------------------------------------------------------------------------
// init writes the host formatter's shape.
// ---------------------------------------------------------------------------

describe('sofar init: formatter-friendly JSON', () => {
  it('writes Biome’s exact output under biome.json and stays idempotent', () => {
    const root = tmpRepo()
    file(root, 'biome.json', JSON.stringify({ files: { includes: ['**', '!**/.sofar'] } }))
    expect(runInit(root).exitCode).toBe(0)
    expect(read(root, '.mcp.json')).toBe(MCP_BIOME)
    expect(read(root, '.claude/settings.json')).toContain('\n\t"hooks": {\n\t\t"SessionStart": [\n\t\t\t{\n\t\t\t\t"hooks": [\n\t\t\t\t\t{\n\t\t\t\t\t\t"type": "command",')
    const second = runInit(root)
    expect(second.stdout).toContain('unchanged .mcp.json')
    expect(second.stdout).toContain('unchanged .claude/settings.json')
  })

  it('keeps the plain JSON.stringify form with no formatter configured (Phase 8 byte-identical round-trips)', () => {
    const root = tmpRepo()
    runInit(root)
    expect(read(root, '.mcp.json')).toBe('{\n  "mcpServers": {\n    "sofar": {\n      "command": "sofar",\n      "args": [\n        "mcp"\n      ]\n    }\n  }\n}\n')
  })

  it('writes Prettier’s exact output under a Prettier config', () => {
    const root = tmpRepo()
    file(root, '.prettierrc', '{}')
    file(root, '.prettierignore', '.sofar/\n')
    runInit(root)
    expect(read(root, '.mcp.json')).toBe(MCP_PRETTIER)
  })

  it('a merged .mcp.json keeps the user’s servers and takes the shape too', () => {
    const root = tmpRepo()
    file(root, '.prettierrc', '{ "useTabs": true }')
    file(root, '.prettierignore', '.sofar/\n')
    file(root, '.mcp.json', '{"mcpServers":{"other":{"command":"x","args":["a","b"]}}}')
    runInit(root)
    expect(read(root, '.mcp.json')).toBe(
      '{\n\t"mcpServers": {\n\t\t"other": {\n\t\t\t"command": "x",\n\t\t\t"args": ["a", "b"]\n\t\t},\n\t\t"sofar": {\n\t\t\t"command": "sofar",\n\t\t\t"args": ["mcp"]\n\t\t}\n\t}\n}\n',
    )
  })

  it('uninit rewrites in the same shape', () => {
    const root = tmpRepo()
    file(root, 'biome.json', JSON.stringify({ files: { includes: ['**', '!**/.sofar'] } }))
    file(root, '.mcp.json', JSON.stringify({ mcpServers: { other: { command: 'x' } } }))
    runInit(root)
    expect(runUninit(root).exitCode).toBe(0)
    expect(read(root, '.mcp.json')).toBe('{\n\t"mcpServers": {\n\t\t"other": {\n\t\t\t"command": "x"\n\t\t}\n\t}\n}\n')
  })

  it('prints the formatter hint (before the scanner hint) only while a tool still reaches .sofar', () => {
    const root = tmpRepo()
    file(root, 'biome.json', JSON.stringify({ $schema: 'https://biomejs.dev/schemas/2.2.0/schema.json' }))
    file(root, '.prettierrc', '{}')
    file(root, 'package.json', JSON.stringify({ dependencies: { tailwindcss: '^4.1.0' } }))
    const out = runInit(root).stdout
    expect(out).toContain('note: Biome 2, Prettier detected — they will process .sofar/ records')
    expect(out).toContain('    biome.json: add "!**/.sofar" in files.includes')
    expect(out).toContain('    .prettierignore: add `.sofar/`')
    expect(out.indexOf('Biome 2, Prettier detected')).toBeLessThan(out.indexOf('Tailwind v4 detected'))

    const clean = tmpRepo()
    file(clean, 'biome.json', JSON.stringify({ files: { includes: ['**', '!**/.sofar'] } }))
    expect(runInit(clean).stdout).not.toContain('detected')
  })
})

// ---------------------------------------------------------------------------
// doctor: audit + --fix.
// ---------------------------------------------------------------------------

describe('sofar doctor: formatter hazards', () => {
  it('reports the absent case as ok', () => {
    const root = tmpRepo()
    runInit(root)
    const r = runDoctor(root)
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('Formatter hazards:\n  ok    no formatter or linter reaching .sofar detected')
  })

  it('flags Biome 2 reaching .sofar (exit 1) and --fix writes files.includes in Biome’s own shape, idempotently', () => {
    const root = tmpRepo()
    runInit(root)
    file(root, 'biome.json', '{\n  "$schema": "https://biomejs.dev/schemas/2.2.0/schema.json",\n  "linter": { "enabled": true }\n}\n')
    const before = runDoctor(root)
    expect(before.exitCode).toBe(1)
    expect(before.stdout).toContain('FAIL  Biome 2 (biome.json) will process .sofar/ — no exclusion in biome.json')
    expect(before.stdout).toContain('fix: sofar doctor --fix   (or add "!**/.sofar" in files.includes to biome.json)')

    const fixed = runDoctor(root, { fix: true })
    expect(fixed.exitCode).toBe(0)
    expect(fixed.stdout).toContain('1 fix applied')
    expect(read(root, 'biome.json')).toBe(
      '{\n\t"$schema": "https://biomejs.dev/schemas/2.2.0/schema.json",\n\t"linter": {\n\t\t"enabled": true\n\t},\n\t"files": {\n\t\t"includes": ["**", "!**/.sofar"]\n\t}\n}\n',
    )
    const again = runDoctor(root, { fix: true })
    expect(again.stdout).not.toContain('fix applied')
    expect(again.stdout).toContain('ok    Biome 2 (biome.json): excludes .sofar (biome.json)')
    expect(read(root, 'biome.json')).toBe(read(root, 'biome.json'))
  })

  it('appends to an existing includes list rather than replacing it', () => {
    const root = tmpRepo()
    runInit(root)
    file(root, 'biome.json', JSON.stringify({ files: { includes: ['src/**', 'biome.json', '!**/dist'] } }))
    // `src/**` never reaches .sofar — already excluded by narrowing, nothing to write.
    expect(runDoctor(root).stdout).toContain('Biome 2 (biome.json): excludes .sofar')
    file(root, 'biome.json', JSON.stringify({ files: { includes: ['**', '!**/dist'] } }))
    runDoctor(root, { fix: true })
    expect(JSON.parse(read(root, 'biome.json'))).toEqual({ files: { includes: ['**', '!**/dist', '!**/.sofar'] } })
  })

  it('Biome 1 gets files.ignore; the installed binary decides the dialect over $schema', () => {
    const root = tmpRepo()
    runInit(root)
    file(root, 'biome.json', JSON.stringify({ $schema: 'https://biomejs.dev/schemas/1.9.4/schema.json' }))
    runDoctor(root, { fix: true })
    expect(JSON.parse(read(root, 'biome.json'))).toMatchObject({ files: { ignore: ['.sofar'] } })

    const upgraded = tmpRepo()
    runInit(upgraded)
    file(upgraded, 'biome.json', JSON.stringify({ $schema: 'https://biomejs.dev/schemas/1.9.4/schema.json' }))
    installed(upgraded, '@biomejs/biome', '2.5.13')
    runDoctor(upgraded, { fix: true })
    expect(JSON.parse(read(upgraded, 'biome.json'))).toMatchObject({ files: { includes: ['**', '!**/.sofar'] } })
  })

  it('withholds the write for a biome.jsonc with comments, naming the line (FAIL, bytes intact)', () => {
    const root = tmpRepo()
    runInit(root)
    const text = '{\n  // keep me\n  "$schema": "https://biomejs.dev/schemas/2.2.0/schema.json"\n}\n'
    file(root, 'biome.jsonc', text)
    const r = runDoctor(root, { fix: true })
    expect(r.exitCode).toBe(1)
    expect(r.stdout).not.toContain('fix applied')
    expect(r.stdout).toContain('biome.jsonc carries comments, which a rewrite would drop — add it by hand and rerun: "!**/.sofar" in files.includes')
    expect(read(root, 'biome.jsonc')).toBe(text)
  })

  it('withholds when the Biome major is unknowable, and when only the dependency is present', () => {
    const root = tmpRepo()
    runInit(root)
    file(root, 'biome.json', '{}')
    const r = runDoctor(root, { fix: true })
    expect(r.exitCode).toBe(1)
    expect(r.stdout).toContain('Biome major version unknown')
    expect(r.stdout).toContain('"!**/.sofar" in files.includes (Biome 2) or ".sofar" in files.ignore (Biome 1)')
    expect(read(root, 'biome.json')).toBe('{}')

    const depOnly = tmpRepo()
    runInit(depOnly)
    devDeps(depOnly, { '@biomejs/biome': '^2.0.0' })
    const d = runDoctor(depOnly, { fix: true })
    expect(d.exitCode).toBe(1)
    expect(d.stdout).toContain('Biome 2 (package.json dependency) will process .sofar/')
    expect(d.stdout).toContain('no biome.json to write into')
  })

  it('Prettier: flags, fixes by appending .sofar/ to .prettierignore, and recognizes every spelling', () => {
    const root = tmpRepo()
    runInit(root)
    devDeps(root, { prettier: '^3.0.0' })
    file(root, '.prettierignore', 'dist')
    const before = runDoctor(root)
    expect(before.exitCode).toBe(1)
    expect(before.stdout).toContain('Prettier (package.json dependency) will process .sofar/ — no exclusion in .prettierignore')
    const fixed = runDoctor(root, { fix: true })
    expect(fixed.exitCode).toBe(0)
    expect(fixed.stdout).toContain('Prettier (package.json dependency): added `.sofar/` to .prettierignore')
    expect(read(root, '.prettierignore')).toBe('dist\n.sofar/\n')
    runDoctor(root, { fix: true })
    expect(read(root, '.prettierignore')).toBe('dist\n.sofar/\n')

    for (const line of ['.sofar', '/.sofar/', '**/.sofar/**']) {
      const r = tmpRepo()
      runInit(r)
      file(r, '.prettierrc.json', '{}')
      file(r, '.prettierignore', `# ignore\n${line}\n`)
      expect(runDoctor(r).stdout, line).toContain('Prettier (.prettierrc.json): excludes .sofar')
    }
  })

  it('creates .prettierignore when there is none', () => {
    const root = tmpRepo()
    runInit(root)
    file(root, 'prettier.config.js', 'module.exports = {}')
    runDoctor(root, { fix: true })
    expect(read(root, '.prettierignore')).toBe('.sofar/\n')
  })

  it('markdownlint-cli: .markdownlintignore; markdownlint-cli2: ignores in its config', () => {
    const cli = tmpRepo()
    runInit(cli)
    file(cli, '.markdownlint.json', '{ "MD013": false }')
    expect(runDoctor(cli).stdout).toContain('markdownlint (.markdownlint.json) will process .sofar/ — no exclusion in .markdownlintignore')
    runDoctor(cli, { fix: true })
    expect(read(cli, '.markdownlintignore')).toBe('.sofar/\n')
    expect(runDoctor(cli).stdout).toContain('markdownlint (.markdownlint.json): excludes .sofar (.markdownlintignore)')

    const cli2 = tmpRepo()
    runInit(cli2)
    file(cli2, '.markdownlint-cli2.jsonc', '{ "config": { "MD013": false } }')
    expect(runDoctor(cli2).stdout).toContain('markdownlint-cli2 (.markdownlint-cli2.jsonc) will process .sofar/')
    runDoctor(cli2, { fix: true })
    expect(JSON.parse(read(cli2, '.markdownlint-cli2.jsonc'))).toEqual({ config: { MD013: false }, ignores: ['**/.sofar/**'] })
    expect(runDoctor(cli2, { fix: true }).stdout).not.toContain('fix applied')

    const cli2Dep = tmpRepo()
    runInit(cli2Dep)
    devDeps(cli2Dep, { 'markdownlint-cli2': '^0.15.0' })
    runDoctor(cli2Dep, { fix: true })
    expect(JSON.parse(read(cli2Dep, '.markdownlint-cli2.jsonc'))).toEqual({ ignores: ['**/.sofar/**'] })

    const yaml = tmpRepo()
    runInit(yaml)
    file(yaml, '.markdownlint-cli2.yaml', 'config:\n  MD013: false\n')
    const r = runDoctor(yaml, { fix: true })
    expect(r.exitCode).toBe(1)
    expect(r.stdout).toContain('.markdownlint-cli2.yaml is not JSON (YAML or a script)')
  })

  it('detects hazards in a fixed order, independently', () => {
    const root = tmpRepo()
    file(root, 'biome.json', JSON.stringify({ $schema: 'https://biomejs.dev/schemas/2.2.0/schema.json' }))
    file(root, '.prettierrc', '{}')
    file(root, '.markdownlint.yaml', 'default: true\n')
    expect(detectFormatterHazards(root).map((h) => h.tool)).toEqual(['biome', 'prettier', 'markdownlint'])
  })
})
