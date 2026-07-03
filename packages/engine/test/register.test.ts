import { describe, expect, it } from 'vitest'
import { mcpRegistration, mcpRegistrationJSON } from '../src/mcp/register'

describe('.mcp.json registration snippet (2.4)', () => {
  it('emits the harness server entry launching `harness mcp`', () => {
    expect(mcpRegistration()).toEqual({
      mcpServers: { harness: { command: 'harness', args: ['mcp'] } },
    })
  })

  it('returns a fresh object each call (safe for callers to mutate/merge)', () => {
    const a = mcpRegistration()
    const b = mcpRegistration()
    expect(a).not.toBe(b)
    a.mcpServers.harness.args.push('--root', '/tmp')
    expect(b.mcpServers.harness.args).toEqual(['mcp'])
  })

  it('JSON helper round-trips and ends with a newline', () => {
    const json = mcpRegistrationJSON()
    expect(json.endsWith('\n')).toBe(true)
    expect(JSON.parse(json)).toEqual(mcpRegistration())
  })
})
