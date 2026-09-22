import { describe, expect, it } from 'vitest'
import { LogBuilder, EPOCH } from './synthetic'
import { AGENT, HUMAN, Rng, TEAM100, growthBudget, initiativeText, shapes, writeSession } from './perf/corpus'

/**
 * rust-core 1.5 — the team100 generator is deterministic and its writer
 * profiles realise the numbers they are named for. The corpus itself is
 * generated into scratch by the perf harness (this file sits outside perf/ so the unit project runs it) (SOFAR_PERF_CELLS=team100…),
 * never checked in; this pins the generator so the cell means the same
 * thing on every machine.
 */

function sample(profile: typeof AGENT, sessions: number): { eventsPerSession: number; bytesPerEvent: number } {
  const b = new LogBuilder('sample', EPOCH - 86_400_000)
  const rng = new Rng(7)
  let events = 0
  for (let s = 0; s < sessions; s++) events += writeSession(b, rng, profile, `w-${s}`, s % 10, false)
  const bytes = Buffer.byteLength(b.text())
  return { eventsPerSession: events / sessions, bytesPerEvent: bytes / events }
}

describe('team100 corpus (rust-core 1.5)', () => {
  it('the agent profile realises ~14.3 events per session and ~593 bytes per event', () => {
    const s = sample(AGENT, 2_000)
    expect(Math.abs(s.eventsPerSession - AGENT.eventsPerSession) / AGENT.eventsPerSession).toBeLessThan(0.06)
    expect(Math.abs(s.bytesPerEvent - AGENT.bytesPerEvent) / AGENT.bytesPerEvent).toBeLessThan(0.06)
  })

  it('the human profile realises ~21 events per session and ~798 bytes per event', () => {
    const s = sample(HUMAN, 2_000)
    expect(Math.abs(s.eventsPerSession - HUMAN.eventsPerSession) / HUMAN.eventsPerSession).toBeLessThan(0.06)
    expect(Math.abs(s.bytesPerEvent - HUMAN.bytesPerEvent) / HUMAN.bytesPerEvent).toBeLessThan(0.06)
  })

  it('an initiative is the same bytes twice, and the shapes are a Zipf tail with the bound record largest', () => {
    const spec = { ...TEAM100, name: 'tiny', events: 3_000, writers: 7 }
    const sh = shapes(spec)
    expect(sh[0]!.slug).toBe('team-bound')
    expect(sh[0]!.events).toBeGreaterThan(sh[1]!.events)
    expect(sh.reduce((a, s) => a + s.events, 0)).toBeGreaterThan(spec.events * 0.98)
    const a = initiativeText(spec, sh[0]!, 0)
    const b = initiativeText(spec, sh[0]!, 0)
    expect(a.text).toBe(b.text)
    // every writer's last session on the bound record is open
    expect(a.openSessions).toBe(spec.writers)
    // whole sessions: the realised count lands within a session of the budget
    expect(a.lines).toBeGreaterThanOrEqual(sh[0]!.events * 0.95)
  })

  it('the growth budget follows from the profiles', () => {
    const g = growthBudget(TEAM100, 10)
    // 0.3 × 21 + 0.7 × 14.3 = 16.31 events per session
    expect(g.eventsPerUserWeek).toBe(163)
    expect(g.bytesPerUserWeek).toBe(Math.round((0.3 * 21 * 798 + 0.7 * 14.3 * 593) * 10))
  })
})
