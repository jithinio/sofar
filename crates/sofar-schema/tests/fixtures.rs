//! The generated types must accept every payload the conformance fixtures
//! carry: each known-type line in the synthetic and real records deserialises
//! into its payload struct. Shape only — validation RULES are sofar-core's.

use std::path::Path;

use sofar_schema::*;

fn fixture_logs() -> Vec<std::path::PathBuf> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/engine/test/conformance/fixtures");
    let mut out = Vec::new();
    for set in ["synthetic", "records"] {
        let Ok(names) = std::fs::read_dir(root.join(set)) else {
            continue;
        };
        for name in names.flatten() {
            let inits = name.path().join("dot-sofar/initiatives");
            let Ok(slugs) = std::fs::read_dir(inits) else {
                continue;
            };
            for slug in slugs.flatten() {
                let log = slug.path().join("events.jsonl");
                if log.is_file() {
                    out.push(log);
                }
            }
        }
    }
    out
}

/// Deserialise `payload` as the type `kind` names; `None` for an unknown type.
fn accepts(kind: &str, payload: &serde_json::Value) -> Option<Result<(), serde_json::Error>> {
    macro_rules! as_ {
        ($t:ty) => {
            Some(serde_json::from_value::<$t>(payload.clone()).map(|_| ()))
        };
    }
    match kind {
        "initiative_created" => as_!(InitiativeCreatedPayload),
        "initiative_status_changed" => as_!(InitiativeStatusChangedPayload),
        "plan_updated" => as_!(PlanUpdatedPayload),
        "phase_status_changed" => as_!(PhaseStatusChangedPayload),
        "task_added" => as_!(TaskAddedPayload),
        "task_status_changed" => as_!(TaskStatusChangedPayload),
        "decision_logged" => as_!(DecisionLoggedPayload),
        "session_started" => as_!(SessionStartedPayload),
        "session_ended" => as_!(SessionEndedPayload),
        "session_closed" => as_!(SessionClosedPayload),
        "file_touched" => as_!(FileTouchedPayload),
        "command_run" => as_!(CommandRunPayload),
        "note_added" => as_!(NoteAddedPayload),
        "memory_promoted" => as_!(MemoryPromotedPayload),
        "review_recorded" => as_!(ReviewRecordedPayload),
        "run_started" => as_!(RunStartedPayload),
        "handoff" => as_!(HandoffPayload),
        "run_stopped" => as_!(RunStoppedPayload),
        "run_stop_requested" => as_!(RunStopRequestedPayload),
        "correction" => as_!(CorrectionPayload),
        _ => None,
    }
}

#[test]
fn every_fixture_payload_deserialises_into_its_generated_type() {
    let logs = fixture_logs();
    assert!(
        logs.len() > 20,
        "expected the 1.2 fixtures next to this workspace, found {}",
        logs.len()
    );
    let mut seen = std::collections::BTreeMap::<String, usize>::new();
    let mut rejected = Vec::new();
    for log in &logs {
        let text = std::fs::read_to_string(log).unwrap();
        for (i, line) in text.lines().enumerate() {
            let Ok(serde_json::Value::Object(ev)) =
                serde_json::from_str::<serde_json::Value>(line.trim())
            else {
                continue; // corrupt lines are the fold's business, not the schema's
            };
            let (Some(kind), Some(payload)) =
                (ev.get("type").and_then(|t| t.as_str()), ev.get("payload"))
            else {
                continue;
            };
            if !payload.is_object() {
                continue; // syn.corrupt carries a non-object payload on purpose
            }
            // The synthetic `corrupt` record deliberately carries payloads the
            // validators reject (a task_status_changed with no id); the generated
            // types reject those too. Anywhere else, a rejection means a generated
            // type is narrower than the TypeScript one.
            let corrupt = log.to_string_lossy().contains("/synthetic/corrupt/");
            match accepts(kind, payload) {
                Some(Ok(())) => *seen.entry(kind.to_owned()).or_default() += 1,
                Some(Err(e)) if !corrupt => {
                    rejected.push(format!("{}:{}: {kind}: {e}", log.display(), i + 1));
                }
                None | Some(Err(_)) => {}
            }
        }
    }
    assert!(
        rejected.is_empty(),
        "generated types rejected real payloads:\n{}",
        rejected.join("\n")
    );
    // Every payload type the schema knows appears in the fixtures at least once.
    for kind in [
        "initiative_created",
        "initiative_status_changed",
        "plan_updated",
        "phase_status_changed",
        "task_added",
        "task_status_changed",
        "decision_logged",
        "session_started",
        "session_ended",
        "session_closed",
        "file_touched",
        "command_run",
        "note_added",
        "memory_promoted",
        "review_recorded",
        "run_started",
        "handoff",
        "run_stopped",
        "run_stop_requested",
        "correction",
    ] {
        assert!(
            seen.contains_key(kind),
            "no fixture carries a `{kind}` payload: {seen:?}"
        );
    }
}

#[test]
fn enums_round_trip_as_their_wire_strings() {
    assert_eq!(
        serde_json::to_string(&TaskStatus::Blocked).unwrap(),
        "\"blocked\""
    );
    assert_eq!(
        serde_json::from_str::<InitiativeStatus>("\"superseded\"").unwrap(),
        InitiativeStatus::Superseded
    );
    assert_eq!(
        serde_json::to_string(&RunStopReason::CostCap).unwrap(),
        "\"cost_cap\""
    );
    assert!(serde_json::from_str::<TaskStatus>("\"wip\"").is_err());
}
