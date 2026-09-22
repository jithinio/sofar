//! `fileMentions` / `mentionDepth` cross-checked against the TypeScript
//! extractor (memory-lead 2.1 mirror, rust-core D29). Ignored by default: the
//! pairs file is generated from the records on this machine —
//! `SOFAR_MENTIONS_PAIRS=<jsonl> cargo test -p sofar-core --test
//! mentions_crosscheck -- --ignored`, each line
//! `{"text", "mentions": [...], "depths": [...]}` with depths against
//! `/repo/src/core/fold.ts`.

use sofar_core::file_mentions::{file_mentions, mention_depth};
use sofar_core::json::{self, Json};

#[test]
#[ignore = "needs SOFAR_MENTIONS_PAIRS from the TypeScript extractor"]
fn every_text_extracts_as_typescript_does() {
    let path = std::env::var("SOFAR_MENTIONS_PAIRS").expect("SOFAR_MENTIONS_PAIRS");
    let text = std::fs::read_to_string(path).unwrap();
    let mut checked = 0;
    let mut failures = Vec::new();
    for line in text.lines().filter(|l| !l.is_empty()) {
        let pair = json::parse(line).unwrap();
        let pair = pair.as_obj().unwrap();
        let input = pair.get("text").and_then(Json::as_str).unwrap();
        let want: Vec<String> = pair
            .get("mentions")
            .and_then(Json::as_arr)
            .unwrap()
            .iter()
            .map(|m| m.as_str().unwrap().to_owned())
            .collect();
        let got = file_mentions(input);
        let depths: Vec<f64> = got
            .iter()
            .map(|m| sofar_core::json::usize_to_f64(mention_depth(m, "/repo/src/core/fold.ts")))
            .collect();
        let want_depths: Vec<f64> = pair
            .get("depths")
            .and_then(Json::as_arr)
            .unwrap()
            .iter()
            .map(|d| d.as_f64().unwrap())
            .collect();
        if got != want || depths != want_depths {
            failures.push(format!("{input:?}\n  want {want:?}\n  got  {got:?}"));
        }
        checked += 1;
    }
    assert!(
        failures.is_empty(),
        "{} of {checked} differ:\n{}",
        failures.len(),
        failures.join("\n")
    );
    assert!(checked > 0);
}
