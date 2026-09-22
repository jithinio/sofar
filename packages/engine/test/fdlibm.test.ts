import { describe, expect, it } from 'vitest'
import { fdlibmLog } from '../src/core/fdlibm'

// rust-core D33: the owned logarithm. Bit-identity with the Rust core is
// crates/sofar-core/tests/js_log_crosscheck.rs; this pins the function itself.

const bits = (x: number): string => {
  const view = new DataView(new ArrayBuffer(8))
  view.setFloat64(0, x)
  return view.getBigUint64(0).toString(16).padStart(16, '0')
}

describe('fdlibmLog', () => {
  it('is fdlibm at the edges', () => {
    expect(fdlibmLog(1)).toBe(0)
    expect(Object.is(fdlibmLog(1), 0)).toBe(true)
    expect(fdlibmLog(0)).toBe(-Infinity)
    expect(fdlibmLog(-0)).toBe(-Infinity)
    expect(fdlibmLog(-1)).toBeNaN()
    expect(fdlibmLog(NaN)).toBeNaN()
    expect(fdlibmLog(Infinity)).toBe(Infinity)
    expect(fdlibmLog(Math.E)).toBe(1)
    expect(fdlibmLog(2)).toBe(Math.LN2)
    expect(fdlibmLog(5e-324)).toBeCloseTo(-744.4400719213812, 12)
  })

  it('pins values where Node builds disagree with each other', () => {
    // BM25 IDF inputs whose Math.log differs in the last bit between the
    // macOS arm64 (fused) and x86-64 (unfused) Node builds: the owned value
    // is the unfused one, on every Node.
    expect(bits(fdlibmLog(1.2307692307692308))).toBe(bits(0.20763936477824457)) // macOS arm64 Node: …455
    expect(bits(fdlibmLog(1.2941176470588236))).toBe(bits(0.2578291093020998)) // macOS arm64 Node: …985
    expect(bits(fdlibmLog(5.142857142857143))).toBe(bits(1.637608789400797)) // macOS arm64 Node: …967
  })

  it('stays within an ulp of Math.log', () => {
    for (let n = 1; n <= 2_000; n++) {
      const x = 1 + (n - 0.5) / 1.5
      expect(Math.abs(fdlibmLog(x) - Math.log(x))).toBeLessThanOrEqual(Number.EPSILON * Math.abs(Math.log(x)))
    }
  })
})
