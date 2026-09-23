//! `js_log` cross-checked against the TypeScript engine's `fdlibmLog`
//! (core/fdlibm.ts, rust-core D33), bit for bit. Ignored by default: the
//! pairs are generated (~20 MB), and CI makes them on every target —
//! `node crates/sofar-core/tests/js_log_pairs.mjs > pairs.txt &&
//! SOFAR_JS_LOG_PAIRS=pairs.txt cargo test -p sofar-core --test
//! js_log_crosscheck -- --ignored`.

use sofar_core::js_math::js_log;

#[test]
#[ignore = "needs SOFAR_JS_LOG_PAIRS from js_log_pairs.mjs"]
fn every_input_logs_as_typescript_does() {
    let path = std::env::var("SOFAR_JS_LOG_PAIRS").expect("SOFAR_JS_LOG_PAIRS");
    let text = std::fs::read_to_string(path).unwrap();
    let mut checked = 0usize;
    let mut failures = Vec::new();
    let mut differ = 0usize;
    for line in text.lines().filter(|l| !l.is_empty()) {
        let (x, want) = line.split_once(' ').unwrap();
        let x = f64::from_bits(u64::from_str_radix(x, 16).unwrap());
        let want = u64::from_str_radix(want, 16).unwrap();
        let got = js_log(x).to_bits();
        // NaN payloads are not observable from JavaScript.
        let same = got == want || (f64::from_bits(got).is_nan() && f64::from_bits(want).is_nan());
        if !same {
            differ += 1;
        }
        if !same && failures.len() < 10 {
            failures.push(format!(
                "log({x:e}): rust {:e}, typescript {:e}",
                f64::from_bits(got),
                f64::from_bits(want)
            ));
        }
        checked += 1;
    }
    assert!(checked > 100_000, "only {checked} pairs");
    assert!(
        differ == 0,
        "{differ} of {checked} differ, e.g.\n{}",
        failures.join("\n")
    );
}
