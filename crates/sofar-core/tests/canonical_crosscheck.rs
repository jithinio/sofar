//! Byte-for-byte cross-check of the Rust envelope path against the
//! TypeScript reference (`validateEnvelope` + `serializeEvent`) over real
//! logs. Ignored by default because the pairs file is generated, not
//! committed: each line is `<log line>\t<expected>`, where expected is the
//! canonical serialization, `UNPARSEABLE`, or `INVALID <detail>`.
//!
//! Generate with `packages/engine/test/conformance/canon-pairs.ts` (it walks
//! `packages/engine/test/conformance/fixtures` — 60 logs, ~8 MB), then:
//!
//! ```text
//! SOFAR_CANON_PAIRS=/path/to/pairs.tsv cargo test -p sofar-core --test canonical_crosscheck -- --ignored
//! ```

use sofar_core::envelope::{error_detail, serialize_event, validate_envelope};
use sofar_core::json;

#[test]
#[ignore = "needs SOFAR_CANON_PAIRS, generated from the TypeScript reference"]
fn every_fixture_line_matches_the_typescript_reference() {
    let path = std::env::var("SOFAR_CANON_PAIRS").expect("SOFAR_CANON_PAIRS");
    let text = std::fs::read_to_string(&path).expect("pairs file");
    let mut checked = 0usize;
    let mut mismatches = Vec::new();
    for (i, line) in text.lines().enumerate() {
        let Some((input, expected)) = line.split_once('\t') else {
            continue;
        };
        let actual = match json::parse(input) {
            Err(_) => "UNPARSEABLE".to_owned(),
            Ok(value) => match validate_envelope(value) {
                Err(errors) => format!("INVALID {}", error_detail(&errors)),
                Ok(event) => serialize_event(&event),
            },
        };
        checked += 1;
        if actual != expected {
            mismatches.push(format!(
                "pair {}:\n  input:    {input}\n  expected: {expected}\n  actual:   {actual}",
                i + 1
            ));
        }
    }
    assert!(checked > 0, "no pairs in {path}");
    assert!(
        mismatches.is_empty(),
        "{} of {checked} mismatched:\n{}",
        mismatches.len(),
        mismatches.join("\n")
    );
    eprintln!("{checked} lines byte-identical to the TypeScript reference");
}
