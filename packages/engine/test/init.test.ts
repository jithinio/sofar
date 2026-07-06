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
  hookCommand,
  PROTOCOL_BLOCK,
  PROTOCOL_START,
  PROTOCOL_END,
  REPO_MD_STUB,
  runInit,
  SHIMS,
} from '../src/cli/init'

/**
 * Task 4.1 — `harness init`. Fresh-repo artifact contents, merge-not-clobber
 * for user-owned files, repo.md sanctity, and BYTE-LEVEL idempotency
 * (SPEC §Acceptance Phase 4 bullet 2: second run changes nothing).
 */

const here = fileURLToPath(new URL('.', import.meta.url))
const roots: string[] = []

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

/** Fresh temp repo: just .git/HEAD on main — no .harness, no .claude. */
function freshRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'harness-init-'))
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

describe('harness init on a fresh repo', () => {
  it('creates every artifact with the expected content', () => {
    const root = freshRepo()
    const result = runInit(root)
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout).toContain('created .harness/repo.md')

    // .harness/: repo.md stub + empty bindings
    expect(readFileSync(join(root, '.harness', 'repo.md'), 'utf8')).toBe(REPO_MD_STUB)
    expect(readFileSync(join(root, '.harness', 'bindings.json'), 'utf8')).toBe('{}\n')
    expect(statSync(join(root, '.harness', 'initiatives')).isDirectory()).toBe(true)

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
      mcpServers: { harness: { command: 'harness', args: ['mcp'] } },
    })

    // CLAUDE.md protocol block: markers + the three BD19 clauses + the loop
    const claudeMd = readFileSync(join(root, 'CLAUDE.md'), 'utf8')
    expect(claudeMd).toBe(PROTOCOL_BLOCK)
    expect(claudeMd).toContain(PROTOCOL_START)
    expect(claudeMd).toContain(PROTOCOL_END)
    expect(claudeMd).toMatch(/never in tool memory/i) // (a) total jurisdiction
    expect(claudeMd).toContain('harness new') // (b) create before unmatched work
    expect(claudeMd).toContain('bindings.json') // (c) bindings resolve the record
    expect(claudeMd).toContain('harness_get_state') // read-orient
    expect(claudeMd).toContain('harness_end_session') // write-back
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

describe('harness init merges — never clobbers — user files', () => {
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

  it('preserves other .mcp.json servers and an existing customized harness entry', () => {
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
    expect(merged.mcpServers.harness).toEqual({ command: 'harness', args: ['mcp'] })

    // customized harness entry survives a re-run
    const custom = { command: 'npx', args: ['harness', 'mcp'] }
    merged.mcpServers.harness = custom
    writeFileSync(join(root, '.mcp.json'), JSON.stringify(merged, null, 2))
    expect(runInit(root).exitCode).toBe(0)
    expect((readJSON(join(root, '.mcp.json')) as typeof merged).mcpServers.harness).toEqual(custom)
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

  it('never overwrites a hand-written repo.md', () => {
    const root = freshRepo()
    mkdirSync(join(root, '.harness'), { recursive: true })
    const custom = '# Our repo memory\n\nDeploy with make ship.\n'
    writeFileSync(join(root, '.harness', 'repo.md'), custom)

    expect(runInit(root).exitCode).toBe(0)
    expect(readFileSync(join(root, '.harness', 'repo.md'), 'utf8')).toBe(custom)
    expect(runInit(root).exitCode).toBe(0) // and re-init
    expect(readFileSync(join(root, '.harness', 'repo.md'), 'utf8')).toBe(custom)
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
