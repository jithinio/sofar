/**
 * The natural logarithm, owned (rust-core D33): fdlibm's `__ieee754_log`,
 * written out in TypeScript so its bits are the same on every Node.
 *
 * `Math.log` is V8's compiled fdlibm, and each official Node build compiles
 * it with its own floating-point contraction: clang fuses every `a * b + c`
 * on macOS arm64, gcc fuses two sites on Linux arm64, and x86-64 fuses none
 * (rust-core 2.11, CI run 35794294826). So the same BM25 code ranked
 * differently depending on which Node ran it, and the Rust core had no single
 * answer to match. JavaScript arithmetic never contracts, so this port is
 * bit-stable by the language's own semantics. The Rust core runs the same
 * algorithm unfused (crates/sofar-core/src/js_math.rs), and
 * tests/js_log_crosscheck.rs holds the two together bit for bit.
 *
 * Every lessons and lexicon score goes through it (lexicon.ts rankLexical,
 * index-lexicon.ts rankLexicon, lessons.ts indexFloor). Nothing that feeds a
 * compared output calls Math.log.
 */

const LN2_HI = 6.93147180369123816490e-1 // 3fe62e42 fee00000
const LN2_LO = 1.90821492927058770002e-10 // 3dea39ef 35793c76
const TWO54 = 1.8014398509481984e16 // 43500000 00000000
const LG1 = 6.66666666666673513e-1 // 3FE55555 55555593
const LG2 = 3.999999999940941908e-1 // 3FD99999 9997FA04
const LG3 = 2.857142874366239149e-1 // 3FD24924 94229359
const LG4 = 2.222219843214978396e-1 // 3FCC71C5 1D8E78AF
const LG5 = 1.818357216161805012e-1 // 3FC74664 96CB03DE
const LG6 = 1.531383769920937332e-1 // 3FC39A09 D078C69F
const LG7 = 1.479819860511658591e-1 // 3FC2F112 DF3E5244

// One double, read and written as two 32-bit words. Node runs on big-endian
// hosts too (s390x), so which word is high is asked, not assumed.
const f64 = new Float64Array(1)
const u32 = new Uint32Array(f64.buffer)
const HI = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1 ? 1 : 0
const LO = 1 - HI

/** `log(x)`, bit for bit what fdlibm's e_log.c returns with no contraction. */
export function fdlibmLog(x: number): number {
  f64[0] = x
  let hx = u32[HI]! | 0
  const lx = u32[LO]! | 0
  let k = 0
  if (hx < 0x00100000) {
    // x < 2**-1022
    if (((hx & 0x7fffffff) | lx) === 0) return -Infinity // log(+-0)
    if (hx < 0) return NaN // log(-#)
    k -= 54
    x *= TWO54 // subnormal: scale up
    f64[0] = x
    hx = u32[HI]! | 0
  }
  if (hx >= 0x7ff00000) return x + x
  k += (hx >> 20) - 1023
  hx &= 0x000fffff
  const i = (hx + 0x95f64) & 0x100000
  // Normalize x or x/2.
  f64[0] = x
  u32[HI] = (hx | (i ^ 0x3ff00000)) >>> 0
  x = f64[0]
  k += i >> 20
  const f = x - 1.0
  if ((0x000fffff & (2 + hx)) < 3) {
    // -2**-20 <= f < 2**-20
    if (f === 0) {
      if (k === 0) return 0
      return k * LN2_HI + k * LN2_LO
    }
    const R = f * f * (0.5 - 0.33333333333333333 * f)
    if (k === 0) return f - R
    return k * LN2_HI - (R - k * LN2_LO - f)
  }
  const s = f / (2.0 + f)
  const dk = k
  const z = s * s
  let j = hx - 0x6147a
  const w = z * z
  const jj = 0x6b851 - hx
  const t1 = w * (LG2 + w * (LG4 + w * LG6))
  const t2 = z * (LG1 + w * (LG3 + w * (LG5 + w * LG7)))
  j |= jj
  const R = t2 + t1
  if (j > 0) {
    const hfsq = 0.5 * f * f
    if (k === 0) return f - (hfsq - s * (hfsq + R))
    return dk * LN2_HI - (hfsq - (s * (hfsq + R) + dk * LN2_LO) - f)
  }
  if (k === 0) return f - s * (f - R)
  return dk * LN2_HI - (s * (f - R) - dk * LN2_LO - f)
}
