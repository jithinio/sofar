//! `Math.log` as Node computes it, bit for bit (rust-core D2).
//!
//! V8's `Math.log` is fdlibm's `__ieee754_log` (`base::ieee754::log`), not
//! the platform libm Rust's `f64::ln` calls: on this machine 4.2% of a
//! million BM25 inputs differed in the last bit, which is enough to move a
//! lessons score across a cut (`LESSON_OVER_SHARE`, the runner-up ratio, the
//! corpus floor) or to reorder a tie. And V8 is compiled with floating-point
//! contraction, so on aarch64 every `a * b + c` in fdlibm is ONE fused
//! multiply-add, while baseline x86-64 has no FMA to fuse into. `madd` is
//! that one difference; everything else is fdlibm as written.
//!
//! Proven per target by `tests/js_log_crosscheck.rs` against pairs the same
//! machine's Node generates (CI's core matrix, every target).

/// `a * b + c` as V8's build computes it on this target.
#[cfg(target_arch = "aarch64")]
#[inline]
fn madd(a: f64, b: f64, c: f64) -> f64 {
    a.mul_add(b, c)
}

/// `a * b + c` as V8's build computes it on this target.
#[cfg(not(target_arch = "aarch64"))]
#[inline]
fn madd(a: f64, b: f64, c: f64) -> f64 {
    a * b + c
}

/// `Math.log(x)`.
#[must_use]
#[allow(
    clippy::unreadable_literal,
    clippy::excessive_precision,
    clippy::many_single_char_names,
    clippy::cast_possible_wrap,
    clippy::cast_sign_loss,
    clippy::cast_possible_truncation,
    clippy::float_cmp,
    reason = "fdlibm e_log.c, ported as written: its word arithmetic and its constants"
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
    const THIRD: f64 = 0.33333333333333333;

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
    if (0x000f_ffff & (2 + hx)) < 3 {
        // -2**-20 <= f < 2**-20
        if f == 0.0 {
            if k == 0 {
                return 0.0;
            }
            let dk = f64::from(k);
            return madd(dk, LN2_HI, dk * LN2_LO);
        }
        let r = f * f * madd(-THIRD, f, 0.5);
        if k == 0 {
            return f - r;
        }
        let dk = f64::from(k);
        return madd(dk, LN2_HI, -(madd(-dk, LN2_LO, r) - f));
    }
    let s = f / (2.0 + f);
    let dk = f64::from(k);
    let z = s * s;
    let mut i = hx - 0x6147a;
    let w = z * z;
    let j = 0x6b851 - hx;
    let t1 = w * madd(w, madd(w, LG6, LG4), LG2);
    let t2 = z * madd(w, madd(w, madd(w, LG7, LG5), LG3), LG1);
    i |= j;
    let r = t2 + t1;
    if i > 0 {
        let hfsq = 0.5 * f * f;
        if k == 0 {
            f - madd(-s, hfsq + r, hfsq)
        } else {
            madd(dk, LN2_HI, -((hfsq - madd(s, hfsq + r, dk * LN2_LO)) - f))
        }
    } else if k == 0 {
        madd(-s, f - r, f)
    } else {
        madd(dk, LN2_HI, -(madd(s, f - r, -(dk * LN2_LO)) - f))
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
