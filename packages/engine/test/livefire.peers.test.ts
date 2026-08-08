import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { livePeers } from '../src/core/peers'

/**
 * Live-fire: the UNDOCUMENTED registry contract, checked against a real one.
 *
 * Every other peer test runs against a fixture this repo wrote, which proves
 * the parser handles the shape we BELIEVE Claude Code writes and proves
 * nothing about the shape it actually writes. That belief is the single
 * external dependency the whole feature rests on, and no published contract
 * defends it — the format can change in any release, and the failure would be
 * silent by design (peer resolution degrading to "no peer" looks exactly like
 * a sibling on another tool).
 *
 * So this is the drift canary. It self-gates on CLAUDE_CODE_MESSAGING_SOCKET,
 * which Claude Code exports only to its own children when messaging is on:
 * absent in CI and in every other host, present when a Claude Code session
 * runs the suite. No flag to remember — it runs exactly when it can.
 *
 * When it fails, peer resolution has NOT broken; it has gone quiet. Re-read
 * the registry file named below and update core/peers.ts to match.
 */

const socket = process.env.CLAUDE_CODE_MESSAGING_SOCKET
const configDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
const pid = socket === undefined ? Number.NaN : Number(basename(socket, '.sock'))
const registryFile = Number.isInteger(pid) ? join(configDir, 'sessions', `${pid}.json`) : null
const canRun = registryFile !== null && existsSync(registryFile)

describe.skipIf(!canRun)('live-fire: Claude Code session registry', () => {
  it('still carries the four fields peer resolution depends on', () => {
    const raw = JSON.parse(readFileSync(registryFile!, 'utf8')) as Record<string, unknown>
    // Everything else in the file is deliberately ignored, so only these four
    // changing can take the feature down.
    expect(typeof raw.sessionId).toBe('string')
    expect(typeof raw.name).toBe('string')
    expect(typeof raw.cwd).toBe('string')
    expect(typeof raw.pid).toBe('number')
  })

  it('resolves the session running this suite', () => {
    const raw = JSON.parse(readFileSync(registryFile!, 'utf8')) as Record<string, unknown>
    const mine = livePeers().find((p) => p.sessionId === raw.sessionId)

    // The end-to-end claim: a session id sofar already stores becomes an
    // address the host's own SendMessage accepts.
    expect(mine).toBeDefined()
    expect(mine!.name.length).toBeGreaterThan(0)
    expect(mine!.cwd.length).toBeGreaterThan(0)
  })

  it('agrees with the socket path the host handed this process', () => {
    // The registry's own pid must be the one naming the socket we were given,
    // or the file-per-pid convention this module walks has changed.
    const raw = JSON.parse(readFileSync(registryFile!, 'utf8')) as Record<string, unknown>
    expect(raw.pid).toBe(pid)
  })
})
