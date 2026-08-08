import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { livePeers, resolvePeers } from '../src/core/peers'

/**
 * Task 1.1 — peer resolution against Claude Code's session registry.
 *
 * The registry is an UNDOCUMENTED foreign format, so the coverage that
 * matters is the degradation ladder, not the happy path: every way the file
 * can be missing, unreadable, malformed, or shaped differently must resolve
 * to "no peer" rather than throw, because this sits on the UserPromptSubmit
 * hook path where an exception costs the user their turn.
 *
 * `CLAUDE_CONFIG_DIR` is the seam — it lets a test point the reader at a
 * fixture directory without touching the developer's real ~/.claude.
 */

const roots: string[] = []

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

/** A config dir with a sessions/ registry inside, plus the env that selects it. */
function freshRegistry(): { env: Record<string, string | undefined>; dir: string } {
  const root = mkdtempSync(join(tmpdir(), 'sofar-peers-'))
  roots.push(root)
  const dir = join(root, 'sessions')
  mkdirSync(dir, { recursive: true })
  return { env: { CLAUDE_CONFIG_DIR: root }, dir }
}

/** The registry's own filename convention is <pid>.json. */
function writeEntry(dir: string, pid: number, entry: Record<string, unknown>): void {
  writeFileSync(join(dir, `${pid}.json`), JSON.stringify(entry))
}

function entryFor(pid: number, sessionId: string, name: string, cwd = '/repo'): Record<string, unknown> {
  return {
    pid,
    sessionId,
    cwd,
    name,
    // Fields we deliberately ignore, present so the fixture matches reality.
    startedAt: 1786162730427,
    version: '2.1.226',
    peerProtocol: 1,
    kind: 'interactive',
    messagingSocketPath: `/tmp/cc-socks/${pid}.sock`,
    nameSource: 'derived',
    status: 'busy',
  }
}

/** No process can hold this: above every platform's pid ceiling. */
const DEAD_PID = 2_147_483_646

describe('peer resolution', () => {
  it('resolves a live session id to the name SendMessage addresses', () => {
    const { env, dir } = freshRegistry()
    writeEntry(dir, process.pid, entryFor(process.pid, 'sess-alpha', 'sofar-47'))

    const peers = resolvePeers(['sess-alpha'], env)
    expect(peers.get('sess-alpha')).toEqual({
      sessionId: 'sess-alpha',
      name: 'sofar-47',
      cwd: '/repo',
      ambiguous: false,
    })
  })

  it('omits a session id the registry does not know', () => {
    const { env, dir } = freshRegistry()
    writeEntry(dir, process.pid, entryFor(process.pid, 'sess-alpha', 'sofar-47'))

    expect(resolvePeers(['sess-nobody'], env).size).toBe(0)
  })

  it('returns empty when the registry directory is absent', () => {
    const root = mkdtempSync(join(tmpdir(), 'sofar-peers-'))
    roots.push(root)
    // No sessions/ subdirectory at all — a host without the feature.
    expect(livePeers({ CLAUDE_CONFIG_DIR: root })).toEqual([])
    expect(resolvePeers(['sess-alpha'], { CLAUDE_CONFIG_DIR: root }).size).toBe(0)
  })

  it('skips a malformed file without losing its neighbours', () => {
    const { env, dir } = freshRegistry()
    writeFileSync(join(dir, '999.json'), '{ this is not json')
    writeEntry(dir, process.pid, entryFor(process.pid, 'sess-alpha', 'sofar-47'))

    const peers = resolvePeers(['sess-alpha'], env)
    expect(peers.get('sess-alpha')?.name).toBe('sofar-47')
  })

  it('skips an entry whose fields changed type (registry shape drift)', () => {
    const { env, dir } = freshRegistry()
    // The exact failure this module exists to absorb: the format moved and
    // `name` is no longer a string. It must read as "no peer", never throw.
    writeEntry(dir, process.pid, { ...entryFor(process.pid, 'sess-alpha', 'x'), name: { value: 'sofar-47' } })

    expect(() => resolvePeers(['sess-alpha'], env)).not.toThrow()
    expect(resolvePeers(['sess-alpha'], env).size).toBe(0)
  })

  it('skips an entry whose process is gone', () => {
    const { env, dir } = freshRegistry()
    writeEntry(dir, DEAD_PID, entryFor(DEAD_PID, 'sess-ghost', 'sofar-99'))

    expect(resolvePeers(['sess-ghost'], env).size).toBe(0)
  })

  it('flags a name that reaches more than one live session', () => {
    const { env, dir } = freshRegistry()
    // Claude Code derives the default name from the folder, so two sessions
    // in one repo collide routinely. The bare name no longer addresses either.
    writeEntry(dir, process.pid, entryFor(process.pid, 'sess-alpha', 'sofar-47', '/repo/a'))
    writeEntry(dir, process.ppid, entryFor(process.ppid, 'sess-beta', 'sofar-47', '/repo/b'))

    const peers = resolvePeers(['sess-alpha', 'sess-beta'], env)
    expect(peers.get('sess-alpha')?.ambiguous).toBe(true)
    expect(peers.get('sess-beta')?.ambiguous).toBe(true)
  })

  it('flags ambiguity from the whole live set, not just the ids asked about', () => {
    const { env, dir } = freshRegistry()
    writeEntry(dir, process.pid, entryFor(process.pid, 'sess-alpha', 'sofar-47', '/repo/a'))
    writeEntry(dir, process.ppid, entryFor(process.ppid, 'sess-beta', 'sofar-47', '/repo/b'))

    // Only alpha collided with us, but the name still reaches beta too.
    expect(resolvePeers(['sess-alpha'], env).get('sess-alpha')?.ambiguous).toBe(true)
  })

  it('ignores non-JSON files in the registry directory', () => {
    const { env, dir } = freshRegistry()
    writeFileSync(join(dir, 'README'), 'not a registry entry')
    writeEntry(dir, process.pid, entryFor(process.pid, 'sess-alpha', 'sofar-47'))

    expect(livePeers(env)).toHaveLength(1)
  })

  it('asks nothing of the filesystem when there is nothing to resolve', () => {
    // A bogus config dir would throw on readdir if it were consulted.
    expect(resolvePeers([], { CLAUDE_CONFIG_DIR: '/nonexistent/sofar-peers' }).size).toBe(0)
  })
})
