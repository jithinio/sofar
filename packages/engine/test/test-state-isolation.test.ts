import { homedir } from 'node:os'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { stateBase } from '../src/core/state-dir'

// Sentinel for vitest.config.ts: the suite must never resolve per-clone state
// into the developer's real ~/.local/state — spawned hooks inherit this env.
describe('test state isolation', () => {
  it('runs with XDG_STATE_HOME outside the real home state dir', () => {
    const real = join(homedir(), '.local', 'state')
    expect(process.env.XDG_STATE_HOME).toBeTruthy()
    const rel = relative(real, stateBase())
    expect(rel === '' || !rel.startsWith('..')).toBe(false)
  })
})
