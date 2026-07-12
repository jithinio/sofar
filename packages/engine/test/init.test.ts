import { createHash } from 'node:crypto'
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import {
  AGENTS_PROTOCOL_BLOCK,
  GITATTRIBUTES_LINE,
  hookCommand,
  PROTOCOL_BLOCK,
  PROTOCOL_START,
  PROTOCOL_END,
  REPO_MD_STUB,
  runInit,
  SHIMS,
  STATUSLINE_HINT,
  STATUSLINE_SETTINGS_ENTRY,
} from '../src/cli/init'

/**
 * Task 4.1 — `sofar init`. Fresh-repo artifact contents, merge-not-clobber
 * for user-owned files, repo.md sanctity, and BYTE-LEVEL idempotency
 * (SPEC §Acceptance Phase 4 bullet 2: second run changes nothing).
 */

const here = fileURLToPath(new URL('.', import.meta.url))
const roots: string[] = []

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

/** Fresh temp repo: just .git/HEAD on main — no .sofar, no .claude. */
function freshRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'sofar-init-'))
  roots.push(root)
  mkdirSync(join(root, '.git'), { recursive: true })
  writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  return root
}

/** relpath → { sha256, mode } for every file under dir (idempotency probe). */
function hashTree(dir: string): Map<string, { sha: string; mode: number }> {
  const out = new Map<string, { sha: string; mode: number }>()
  const walk = (d: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const path = join(d, entry.name)
      if (entry.isDirectory()) walk(path)
      else {
        out.set(relative(dir, path), {
          sha: createHash('sha256').update(readFileSync(path)).digest('hex'),
          mode: statSync(path).mode & 0o777,
        })
      }
    }
  }
  walk(dir)
  return out
}

function readJSON(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
}

describe('sofar init on a fresh repo', () => {
  it('creates every artifact with the expected content', () => {
    const root = freshRepo()
    const result = runInit(root)
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout).toContain('created .sofar/repo.md')

    // .sofar/: repo.md stub + empty bindings
    expect(readFileSync(join(root, '.sofar', 'repo.md'), 'utf8')).toBe(REPO_MD_STUB)
    expect(readFileSync(join(root, '.sofar', 'bindings.json'), 'utf8')).toBe('{}\n')
    expect(statSync(join(root, '.sofar', 'initiatives')).isDirectory()).toBe(true)

    // .gitattributes: union-merge rule for committed event logs (team-readiness T2)
    expect(readFileSync(join(root, '.gitattributes'), 'utf8')).toBe(`${GITATTRIBUTES_LINE}\n`)

    // Shims: exact source text (bundled, not read from disk), executable
    for (const shim of SHIMS) {
      const path = join(root, '.claude', 'hooks', shim.file)
      const source = readFileSync(join(here, '..', 'src', 'hooks', shim.file), 'utf8')
      expect(readFileSync(path, 'utf8')).toBe(source)
      expect(statSync(path).mode & 0o777).toBe(0o755)
      expect(shim.text).toBe(source) // the inlined text IS the source
    }

    // settings.json hooks block — exact contract shape
    const settings = readJSON(join(root, '.claude', 'settings.json'))
    expect(settings.hooks).toEqual({
      SessionStart: [
        { hooks: [{ type: 'command', command: '$CLAUDE_PROJECT_DIR/.claude/hooks/session-start.sh' }] },
      ],
      UserPromptSubmit: [
        {
          hooks: [
            { type: 'command', command: '$CLAUDE_PROJECT_DIR/.claude/hooks/user-prompt-submit.sh' },
          ],
        },
      ],
      PostToolUse: [
        {
          matcher: 'Edit|Write|MultiEdit|Bash',
          hooks: [{ type: 'command', command: '$CLAUDE_PROJECT_DIR/.claude/hooks/post-tool-use.sh' }],
        },
      ],
      Stop: [{ hooks: [{ type: 'command', command: '$CLAUDE_PROJECT_DIR/.claude/hooks/stop.sh' }] }],
      SessionEnd: [
        { hooks: [{ type: 'command', command: '$CLAUDE_PROJECT_DIR/.claude/hooks/session-end.sh' }] },
      ],
    })

    // .mcp.json registration (register.ts snippet)
    expect(readJSON(join(root, '.mcp.json'))).toEqual({
      mcpServers: { sofar: { command: 'sofar', args: ['mcp'] } },
    })

    // CLAUDE.md protocol block: markers + the three BD19 clauses + the loop
    const claudeMd = readFileSync(join(root, 'CLAUDE.md'), 'utf8')
    expect(claudeMd).toBe(PROTOCOL_BLOCK)
    expect(claudeMd).toContain(PROTOCOL_START)
    expect(claudeMd).toContain(PROTOCOL_END)
    expect(claudeMd).toMatch(/never in tool memory/i) // (a) total jurisdiction
    expect(claudeMd).toContain('sofar new') // (b) create before unmatched work
    expect(claudeMd).toContain('bindings.json') // (c) bindings resolve the record
    expect(claudeMd).toContain('sofar_get_state') // read-orient
    expect(claudeMd).toContain('sofar_end_session') // write-back

    // AGENTS.md convention dialect: same markers, same three BD19 clauses,
    // but a CLI-only loop (no MCP assumptions — task 5.1, BD31)
    const agentsMd = readFileSync(join(root, 'AGENTS.md'), 'utf8')
    expect(agentsMd).toBe(AGENTS_PROTOCOL_BLOCK)
    expect(agentsMd).toContain(PROTOCOL_START)
    expect(agentsMd).toContain(PROTOCOL_END)
    expect(agentsMd).toMatch(/never in tool memory/i) // (a) total jurisdiction
    expect(agentsMd).toContain('sofar new') // (b) create before unmatched work
    expect(agentsMd).toContain('bindings.json') // (c) bindings resolve the record
    expect(agentsMd).toContain('sofar status') // read-orient (CLI, not MCP)
    expect(agentsMd).toContain('--type session_started') // start via event append
    expect(agentsMd).toContain('--type session_ended') // write-back via event append
    expect(agentsMd).toContain('MANDATORY') // compensating control for no Stop hook
    expect(agentsMd).not.toContain('sofar_') // no MCP tool names — dialect is CLI-only
  })

  it('is byte-level idempotent: second run changes no file (acceptance bullet 2)', () => {
    const root = freshRepo()
    runInit(root)
    const first = hashTree(root)

    const second = runInit(root)
    expect(second.exitCode).toBe(0)
    expect(second.stdout).toContain('already initialized — nothing to do')
    expect(hashTree(root)).toEqual(first)
  })
})

describe('sofar init merges — never clobbers — user files', () => {
  it('preserves unrelated settings.json content and pre-existing hook entries', () => {
    const root = freshRepo()
    mkdirSync(join(root, '.claude'), { recursive: true })
    const userSettings = {
      permissions: { allow: ['Bash(npm test)'] },
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo pre' }] }],
        SessionStart: [{ hooks: [{ type: 'command', command: 'echo user-start' }] }],
      },
    }
    writeFileSync(join(root, '.claude', 'settings.json'), JSON.stringify(userSettings, null, 2))

    expect(runInit(root).exitCode).toBe(0)

    const merged = readJSON(join(root, '.claude', 'settings.json'))
    expect(merged.permissions).toEqual({ allow: ['Bash(npm test)'] })
    const hooks = merged.hooks as Record<string, unknown[]>
    expect(hooks.PreToolUse).toEqual(userSettings.hooks.PreToolUse) // untouched
    // user's SessionStart entry kept, ours appended after it
    expect(hooks.SessionStart).toEqual([
      { hooks: [{ type: 'command', command: 'echo user-start' }] },
      { hooks: [{ type: 'command', command: hookCommand('session-start.sh') }] },
    ])
    expect(hooks.Stop).toHaveLength(1)
  })

  it('preserves other .mcp.json servers and an existing customized sofar entry', () => {
    const root = freshRepo()
    writeFileSync(
      join(root, '.mcp.json'),
      JSON.stringify({ mcpServers: { other: { command: 'other-server', args: [] } } }, null, 2),
    )
    expect(runInit(root).exitCode).toBe(0)
    const merged = readJSON(join(root, '.mcp.json')) as {
      mcpServers: Record<string, unknown>
    }
    expect(merged.mcpServers.other).toEqual({ command: 'other-server', args: [] })
    expect(merged.mcpServers.sofar).toEqual({ command: 'sofar', args: ['mcp'] })

    // customized sofar entry survives a re-run
    const custom = { command: 'npx', args: ['sofar', 'mcp'] }
    merged.mcpServers.sofar = custom
    writeFileSync(join(root, '.mcp.json'), JSON.stringify(merged, null, 2))
    expect(runInit(root).exitCode).toBe(0)
    expect((readJSON(join(root, '.mcp.json')) as typeof merged).mcpServers.sofar).toEqual(custom)
  })

  it('appends the protocol block to an existing CLAUDE.md and never edits inside markers', () => {
    const root = freshRepo()
    const userContent = '# My project\n\nHouse rules live here.\n'
    writeFileSync(join(root, 'CLAUDE.md'), userContent)

    expect(runInit(root).exitCode).toBe(0)
    const appended = readFileSync(join(root, 'CLAUDE.md'), 'utf8')
    expect(appended.startsWith(userContent)).toBe(true)
    expect(appended).toContain(PROTOCOL_START)

    // hand-edit INSIDE the markers → re-init leaves the whole file alone
    const edited = appended.replace('jurisdiction is total', 'jurisdiction is total (amended)')
    writeFileSync(join(root, 'CLAUDE.md'), edited)
    expect(runInit(root).exitCode).toBe(0)
    expect(readFileSync(join(root, 'CLAUDE.md'), 'utf8')).toBe(edited)
  })

  it('appends the dialect block to an existing AGENTS.md and skips once markers exist', () => {
    const root = freshRepo()
    const userContent = '# Agent notes\n\nBuild with make.\n'
    writeFileSync(join(root, 'AGENTS.md'), userContent)

    expect(runInit(root).exitCode).toBe(0)
    const appended = readFileSync(join(root, 'AGENTS.md'), 'utf8')
    expect(appended.startsWith(userContent)).toBe(true) // merge, not clobber
    expect(appended).toContain(PROTOCOL_START)
    expect(appended.endsWith(AGENTS_PROTOCOL_BLOCK)).toBe(true)

    // hand-edit INSIDE the markers → re-init leaves the whole file alone
    const edited = appended.replace('jurisdiction is total', 'jurisdiction is total (amended)')
    writeFileSync(join(root, 'AGENTS.md'), edited)
    expect(runInit(root).exitCode).toBe(0)
    expect(readFileSync(join(root, 'AGENTS.md'), 'utf8')).toBe(edited)
  })

  it('merges the union-merge rule into an existing .gitattributes — never clobbers (T2)', () => {
    const root = freshRepo()
    writeFileSync(join(root, '.gitattributes'), '*.png binary\n')

    expect(runInit(root).exitCode).toBe(0)
    expect(readFileSync(join(root, '.gitattributes'), 'utf8')).toBe(
      `*.png binary\n${GITATTRIBUTES_LINE}\n`,
    )

    // double-init adds nothing
    const again = runInit(root)
    expect(again.exitCode).toBe(0)
    expect(again.stdout).toContain('unchanged .gitattributes')
    expect(readFileSync(join(root, '.gitattributes'), 'utf8')).toBe(
      `*.png binary\n${GITATTRIBUTES_LINE}\n`,
    )
  })

  it('adds a newline seam when the existing .gitattributes lacks a trailing one', () => {
    const root = freshRepo()
    writeFileSync(join(root, '.gitattributes'), '*.png binary')
    expect(runInit(root).exitCode).toBe(0)
    expect(readFileSync(join(root, '.gitattributes'), 'utf8')).toBe(
      `*.png binary\n${GITATTRIBUTES_LINE}\n`,
    )
  })

  it('a user-customized events.jsonl rule wins over ours', () => {
    const root = freshRepo()
    const custom = '.sofar/**/events.jsonl -merge\n'
    writeFileSync(join(root, '.gitattributes'), custom)

    const result = runInit(root)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('unchanged .gitattributes (events.jsonl rule present)')
    expect(readFileSync(join(root, '.gitattributes'), 'utf8')).toBe(custom)
  })

  it('never overwrites a hand-written repo.md', () => {
    const root = freshRepo()
    mkdirSync(join(root, '.sofar'), { recursive: true })
    const custom = '# Our repo memory\n\nDeploy with make ship.\n'
    writeFileSync(join(root, '.sofar', 'repo.md'), custom)

    expect(runInit(root).exitCode).toBe(0)
    expect(readFileSync(join(root, '.sofar', 'repo.md'), 'utf8')).toBe(custom)
    expect(runInit(root).exitCode).toBe(0) // and re-init
    expect(readFileSync(join(root, '.sofar', 'repo.md'), 'utf8')).toBe(custom)
  })

  it('refuses to touch an unparseable settings.json (exit 1, file intact)', () => {
    const root = freshRepo()
    mkdirSync(join(root, '.claude'), { recursive: true })
    writeFileSync(join(root, '.claude', 'settings.json'), '{ not json')

    const result = runInit(root)
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('.claude/settings.json is not valid JSON')
    expect(readFileSync(join(root, '.claude', 'settings.json'), 'utf8')).toBe('{ not json')
  })
})

describe('sofar init --statusline (opt-in rent-meter wiring, D4 informed re-test)', () => {
  it('wires statusLine on a fresh repo alongside the hooks — and prints no hint', () => {
    const root = freshRepo()
    const result = runInit(root, { statusline: true })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('created .claude/settings.json (statusLine wired)')
    expect(result.stdout).not.toContain('sofar init --statusline') // hint is for the unwired

    const settings = readJSON(join(root, '.claude', 'settings.json'))
    expect(settings.statusLine).toEqual(STATUSLINE_SETTINGS_ENTRY)
    expect(Object.keys(settings.hooks as object)).toHaveLength(5) // hooks untouched by the flag
  })

  it('is byte-level idempotent: a second --statusline run changes no file', () => {
    const root = freshRepo()
    runInit(root, { statusline: true })
    const first = hashTree(root)

    const second = runInit(root, { statusline: true })
    expect(second.exitCode).toBe(0)
    expect(second.stdout).toContain('already initialized — nothing to do')
    expect(second.stdout).toContain('unchanged .claude/settings.json (statusLine already wired)')
    expect(hashTree(root)).toEqual(first)
  })

  it('never clobbers an existing statusLine — theirs wins, whatever it is', () => {
    const root = freshRepo()
    mkdirSync(join(root, '.claude'), { recursive: true })
    const custom = { statusLine: { type: 'command', command: 'my-own-statusline.sh' } }
    writeFileSync(join(root, '.claude', 'settings.json'), JSON.stringify(custom, null, 2))

    const result = runInit(root, { statusline: true })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('(existing statusLine kept)')
    expect(readJSON(join(root, '.claude', 'settings.json')).statusLine).toEqual(custom.statusLine)
  })

  it('wires into an already-inited repo (flag added on a later run)', () => {
    const root = freshRepo()
    runInit(root)
    const result = runInit(root, { statusline: true })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('updated .claude/settings.json (statusLine wired)')
    expect(readJSON(join(root, '.claude', 'settings.json')).statusLine).toEqual(
      STATUSLINE_SETTINGS_ENTRY,
    )
  })

  it('plain init hints at the flag while unwired, and stops once wired', () => {
    const root = freshRepo()
    const unwired = runInit(root)
    expect(unwired.stdout).toContain(STATUSLINE_HINT)
    expect(unwired.stdout).toContain('sofar init --statusline')
    expect(unwired.stdout).toContain('shadows a personal') // the D4 trade, named

    runInit(root, { statusline: true })
    const wired = runInit(root)
    expect(wired.stdout).not.toContain('sofar init --statusline')
  })

  it('a custom statusLine also silences the hint — the user already chose', () => {
    const root = freshRepo()
    mkdirSync(join(root, '.claude'), { recursive: true })
    writeFileSync(
      join(root, '.claude', 'settings.json'),
      JSON.stringify({ statusLine: { type: 'command', command: 'my-own.sh' } }, null, 2),
    )
    expect(runInit(root).stdout).not.toContain('sofar init --statusline')
  })
})

describe('confirmation styling (cli-ui 2.5)', () => {
  const styled = { color: true, unicode: true, animate: false }
  const piped = { color: false, unicode: true, animate: false }

  it('renders dim └ rails on detail lines and a green ✓ on the result line', () => {
    const root = freshRepo()
    const result = runInit(root, {}, styled)
    expect(result.exitCode).toBe(0)
    // The report block ends at the blank line before the (unstyled) hint.
    const lines = (result.stdout.split('\n\n')[0] ?? '').split('\n')
    expect(lines.at(-1)).toBe('\x1b[32m✓\x1b[39m sofar init: done (12 changes)')
    expect(lines[0]).toBe('\x1b[2m  └ created .sofar/repo.md\x1b[22m')
    for (const line of lines.slice(0, -1)) {
      expect(line.startsWith('\x1b[2m  └ ')).toBe(true)
      expect(line.endsWith('\x1b[22m')).toBe(true)
    }
  })

  it('piped output is byte-identical to the historical plain report + opt-in hint', () => {
    const root = freshRepo()
    expect(runInit(root, {}, piped).stdout).toBe(
      [
        'created .sofar/repo.md',
        'created .sofar/bindings.json',
        'created .gitattributes (union merge for event logs)',
        'created .claude/hooks/session-start.sh',
        'created .claude/hooks/user-prompt-submit.sh',
        'created .claude/hooks/post-tool-use.sh',
        'created .claude/hooks/stop.sh',
        'created .claude/hooks/session-end.sh',
        'created .claude/settings.json',
        'created .mcp.json',
        'created CLAUDE.md (sofar protocol block)',
        'created AGENTS.md (sofar protocol block)',
        'sofar init: done (12 changes)',
        '',
        STATUSLINE_HINT,
        '',
      ].join('\n'),
    )
  })

  it('marks the abort path with a red ✗, wording unchanged', () => {
    const root = freshRepo()
    mkdirSync(join(root, '.claude'), { recursive: true })
    writeFileSync(join(root, '.claude', 'settings.json'), '{ not json')
    // Failure text is stderr-bound: it styles under the stderr caps (arg 4),
    // never under the stdout caps.
    const result = runInit(root, {}, styled, styled)
    expect(result.exitCode).toBe(1)
    expect(result.stderr.startsWith('\x1b[31m✗\x1b[39m sofar init:')).toBe(true)
    expect(runInit(root, {}, styled, piped).stderr.startsWith('sofar init:')).toBe(true)
  })
})
