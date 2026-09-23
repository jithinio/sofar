//! The natural logarithm, owned (rust-core D33): fdlibm's `__ieee754_log`,
//! unfused, on every target — the same algorithm the TypeScript engine runs
//! as `core/fdlibm.ts` in place of `Math.log`.
//!
//! `Math.log` itself is not one function: each official Node build compiles
//! V8's fdlibm with its own contraction (clang fuses every `a * b + c` on
//! macOS arm64, gcc two sites on Linux arm64, x86-64 none), and `f64::ln` is
//! the platform libm, which differed from Node in the last bit on 4.2% of a
//! million BM25 inputs. An ulp moves a lessons score across a cut
//! (`LESSON_OVER_SHARE`, the runner-up ratio, the corpus floor). Owning the
//! function on both sides makes conformance bit-identity to one algorithm.
//! Rust never contracts floating point without an explicit `mul_add`, and
//! JavaScript never does, so both are the same on every platform.
//!
//! `tests/js_log_crosscheck.rs` proves it against the TypeScript port on
//! every CI target; CI run 35794294826 also showed this unfused form equal
//! to x86-64 Node's own `Math.log` on Linux, macOS and Windows.

/// `log(x)`, bit for bit what fdlibm's `e_log.c` returns with no contraction.
#[must_use]
#[allow(
    clippy::unreadable_literal,
    clippy::excessive_precision,
    clippy::many_single_char_names,
    clippy::cast_possible_wrap,
    clippy::cast_sign_loss,
    clippy::cast_possible_truncation,
    clippy::float_cmp,
    clippy::suboptimal_flops,
    reason = "fdlibm e_log.c, ported as written: its word arithmetic, its constants, and no fused multiply-add"
)]
pub fn js_log(x: f64) -> f64 {
    const LN2_HI: f64 = 6.93147180369123816490e-01; // 3fe62e42 fee00000
    const LN2_LO: f64 = 1.90821492927058770002e-10; // 3dea39ef 35793c76
    const TWO54: f64 = 1.80143985094819840000e+16; // 43500000 00000000
    const LG1: f64 = 6.666666666666735130e-01; // 3FE55555 55555593
    const LG2: f64 = 3.999999999940941908e-01; // 3FD99999 9997FA04
    const LG3: f64 = 2.857142874366239149e-01; // 3FD24924 94229359
    const LG4: f64 = 2.222219843214978396e-01; // 3FCC71C5 1D8E78AF
    const LG5: f64 = 1.818357216161805012e-01; // 3FC74664 96CB03DE
    const LG6: f64 = 1.531383769920937332e-01; // 3FC39A09 D078C69F
    const LG7: f64 = 1.479819860511658591e-01; // 3FC2F112 DF3E5244

    let mut x = x;
    let mut hx = (x.to_bits() >> 32) as u32 as i32;
    let lx = x.to_bits() as u32;
    let mut k: i32 = 0;
    if hx < 0x0010_0000 {
        // x < 2**-1022
        if ((hx & 0x7fff_ffff) as u32 | lx) == 0 {
            return f64::NEG_INFINITY; // log(+-0)
        }
        if hx < 0 {
            return f64::NAN; // log(-#)
        }
        k -= 54;
        x *= TWO54; // subnormal: scale up
        hx = (x.to_bits() >> 32) as u32 as i32;
    }
    if hx >= 0x7ff0_0000 {
        return x + x;
    }
    k += (hx >> 20) - 1023;
    hx &= 0x000f_ffff;
    let i = (hx + 0x95f64) & 0x10_0000;
    // Normalize x or x/2.
    let high = (hx | (i ^ 0x3ff0_0000)) as u32;
    x = f64::from_bits((u64::from(high) << 32) | (x.to_bits() & 0xffff_ffff));
    k += i >> 20;
    let f = x - 1.0;
    let dk = f64::from(k);
    if (0x000f_ffff & (2 + hx)) < 3 {
        // -2**-20 <= f < 2**-20
        if f == 0.0 {
            return if k == 0 {
                0.0
            } else {
                dk * LN2_HI + dk * LN2_LO
            };
        }
        let r = f * f * (0.5 - 0.33333333333333333 * f);
        return if k == 0 {
            f - r
        } else {
            dk * LN2_HI - ((r - dk * LN2_LO) - f)
        };
    }
    let s = f / (2.0 + f);
    let z = s * s;
    let mut i = hx - 0x6147a;
    let w = z * z;
    let j = 0x6b851 - hx;
    let t1 = w * (LG2 + w * (LG4 + w * LG6));
    let t2 = z * (LG1 + w * (LG3 + w * (LG5 + w * LG7)));
    i |= j;
    let r = t2 + t1;
    if i > 0 {
        let hfsq = 0.5 * f * f;
        if k == 0 {
            f - (hfsq - s * (hfsq + r))
        } else {
            dk * LN2_HI - ((hfsq - (s * (hfsq + r) + dk * LN2_LO)) - f)
        }
    } else if k == 0 {
        f - s * (f - r)
    } else {
        dk * LN2_HI - ((s * (f - r) - dk * LN2_LO) - f)
    }
}

#[cfg(test)]
#[allow(clippy::float_cmp, reason = "exact values")]
mod tests {
    use super::js_log;

    #[test]
    fn edges_are_fdlibms() {
        assert_eq!(js_log(1.0).to_bits(), 0.0f64.to_bits());
        assert_eq!(js_log(0.0), f64::NEG_INFINITY);
        assert_eq!(js_log(-0.0), f64::NEG_INFINITY);
        assert!(js_log(-1.0).is_nan());
        assert!(js_log(f64::NAN).is_nan());
        assert_eq!(js_log(f64::INFINITY), f64::INFINITY);
        assert_eq!(js_log(std::f64::consts::E), 1.0);
        // Subnormal: scaled up by 2**54, and still within an ulp of the exact value.
        let tiny = js_log(5e-324);
        assert!((tiny - -744.440_071_921_381_3).abs() < 1e-12);
    }
}
