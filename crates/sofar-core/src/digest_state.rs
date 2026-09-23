//! The state the session-start digest can reach (`projections/templates/
//! digest-state.ts`, rust-core 4.4): what the digest cache stores so a hit
//! renders without folding. The cut is the TypeScript one, reader by reader:
//! `files_touched` dropped; `summary` kept only on the newest session that
//! has one; `activity` kept only for open sessions, the last unwritten one
//! and the lane's recent ones; `next_action` kept only for the winning
//! write-back and the sessions that overlap it. Elsewhere each becomes a
//! placeholder that keeps its presence test true.
//!
//! `render_status(&digest_state(s), o) == render_status(s, o)` is a contract,
//! pinned by the tests below over this repo's real logs and edge cases.

use std::collections::HashSet;

use crate::fold::{InitiativeState, SessionActivity, SessionState};
use crate::status::LANE_RECENT_SESSIONS;
use crate::text::cmp_utf16;

fn empty_activity() -> SessionActivity {
    SessionActivity {
        files: Vec::new(),
        commands: 0,
        task_changes: Vec::new(),
        failed: None,
        last_test: None,
    }
}

/// Indices of the sessions whose activity a reader can render.
fn activity_kept(sessions: &[SessionState]) -> HashSet<usize> {
    let mut keep = HashSet::new();
    // Open sessions: open_session_files reads their files for the conflict lines.
    for (i, s) in sessions.iter().enumerate() {
        if s.ended.is_none() && s.activity.is_some() {
            keep.insert(i);
        }
    }
    // last_unwritten_with_activity: newest first, stopping at a written-back one.
    for (i, s) in sessions.iter().enumerate().rev() {
        if s.summary.is_some() {
            break;
        }
        if s.activity.is_some() {
            keep.insert(i);
            break;
        }
    }
    // The lane block: the newest LANE_RECENT_SESSIONS with activity.
    for (i, _) in sessions
        .iter()
        .enumerate()
        .rev()
        .filter(|(_, s)| s.activity.is_some())
        .take(LANE_RECENT_SESSIONS)
    {
        keep.insert(i);
    }
    keep
}

/// Indices whose `next_action` text `overlapping_writebacks` can read.
fn next_action_kept(sessions: &[SessionState]) -> HashSet<usize> {
    let wrapped: Vec<usize> = sessions
        .iter()
        .enumerate()
        .filter(|(_, s)| s.ended.is_some() && s.next_action.is_some())
        .map(|(i, _)| i)
        .collect();
    let mut keep = HashSet::new();
    let Some(&first) = wrapped.first() else {
        return keep;
    };
    let ended = |i: usize| sessions[i].ended.as_deref().unwrap_or_default();
    // The winner, as overlapping_writebacks picks it: max ended, the later
    // array position winning a tie.
    let mut winner = first;
    for &i in &wrapped {
        if cmp_utf16(ended(i), ended(winner)).is_ge() {
            winner = i;
        }
    }
    keep.insert(winner);
    let (w_started, w_ended) = (sessions[winner].started.as_str(), ended(winner));
    for &i in &wrapped {
        if cmp_utf16(&sessions[i].started, w_ended).is_le()
            && cmp_utf16(ended(i), w_started).is_ge()
        {
            keep.insert(i);
        }
    }
    keep
}

/// `digestState`.
#[must_use]
pub fn digest_state(state: &InitiativeState) -> InitiativeState {
    let sessions = &state.sessions;
    let newest_summary = sessions.iter().rposition(|s| s.summary.is_some());
    let keep_activity = activity_kept(sessions);
    let keep_next = next_action_kept(sessions);
    let mut cut = state.clone();
    cut.files_touched = Vec::new();
    for (i, s) in cut.sessions.iter_mut().enumerate() {
        if s.summary.is_some() && Some(i) != newest_summary {
            s.summary = Some(String::new());
        }
        if s.activity.is_some() && !keep_activity.contains(&i) {
            s.activity = Some(empty_activity());
        }
        if s.next_action.is_some() && !keep_next.contains(&i) {
            s.next_action = Some(String::new());
        }
    }
    cut
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::GitState;
    use crate::index_tier1::RepoRule;
    use crate::snapshot::{fold_file, state_of};
    use crate::status::{NeighbourRecord, StatusOptions, render_status};
    use std::path::Path;

    fn options_matrix() -> Vec<(&'static str, StatusOptions)> {
        let notices = vec![
            "Recent work elsewhere: x (2h ago)".to_owned(),
            "Cold resume: last event 3 days ago".to_owned(),
        ];
        let git = GitState {
            branch: "main".into(),
            head: "abc1234".into(),
            head_full: format!("{:0<40}", "abc1234"),
            upstream: Some("abc1234".into()),
            upstream_full: Some(format!("{:0<40}", "abc1234")),
            synced: true,
        };
        let neighbours = vec![NeighbourRecord {
            initiative: "other".into(),
            paths: 3,
            decisions: 2,
        }];
        let rules = vec![RepoRule {
            initiative: "other".into(),
            ordinal: 1.0,
            ts: "2026-09-01T00:00:00.000Z".into(),
            rule: "Never do the thing.".into(),
            quote: None,
        }];
        let base = StatusOptions::default;
        vec![
            ("none", base()),
            (
                "session",
                StatusOptions {
                    session_id: Some("s-1".into()),
                    ..base()
                },
            ),
            (
                "everything",
                StatusOptions {
                    session_id: Some("s-1".into()),
                    git: Some(git.clone()),
                    neighbours,
                    repo_rules: rules,
                    notices: notices.clone(),
                    repo_memory: Some("# Repo memory\n\n- a fact\n".into()),
                    ..base()
                },
            ),
            (
                "huge repo memory",
                StatusOptions {
                    repo_memory: Some(format!(
                        "# Repo memory\n\n{}",
                        "- a long operational fact line\n".repeat(400)
                    )),
                    notices: notices.clone(),
                    ..base()
                },
            ),
            (
                "activity off",
                StatusOptions {
                    activity: Some(false),
                    session_id: Some("s-1".into()),
                    ..base()
                },
            ),
            (
                "retire off",
                StatusOptions {
                    retire: false,
                    ..base()
                },
            ),
            (
                "lane",
                StatusOptions {
                    lane: true,
                    session_id: Some("s-1".into()),
                    ..base()
                },
            ),
            (
                "lane everything",
                StatusOptions {
                    lane: true,
                    git: Some(git),
                    notices,
                    repo_memory: Some("- m\n".into()),
                    ..base()
                },
            ),
        ]
    }

    fn assert_parity(name: &str, state: &InitiativeState) {
        let cut = digest_state(state);
        for (label, options) in options_matrix() {
            assert_eq!(
                render_status(&cut, &options),
                render_status(state, &options),
                "{name} / {label}"
            );
        }
    }

    #[test]
    fn every_real_log_renders_the_same_digest() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../.sofar/initiatives");
        let mut checked = 0;
        for entry in std::fs::read_dir(&dir).expect("the repo's record") {
            let path = entry.unwrap().path();
            let log = path.join("events.jsonl");
            if !log.exists() {
                continue;
            }
            let slug = path.file_name().unwrap().to_string_lossy().into_owned();
            let state = state_of(&fold_file(&log, &slug).unwrap()).state;
            assert_parity(&slug, &state);
            checked += 1;
        }
        assert!(checked > 5, "only {checked} records");
    }

    fn session(id: &str, ended: Option<&str>) -> SessionState {
        SessionState {
            id: id.into(),
            tool: "t".into(),
            model: None,
            started: format!("2026-09-2{}T00:00:00.000Z", id.len()),
            ended: ended.map(str::to_owned),
            summary: None,
            next_action: None,
            closed_reason: None,
            activity: None,
            handoff: None,
            unwritten: 0,
        }
    }

    fn act(file: &str) -> SessionActivity {
        SessionActivity {
            files: vec![file.into()],
            commands: 1,
            ..empty_activity()
        }
    }

    #[test]
    fn the_edge_cases_a_reader_can_reach() {
        let base = crate::fold::empty_state();
        let with = |sessions: Vec<SessionState>| InitiativeState {
            sessions,
            ..base.clone()
        };
        // Open sessions sharing a file (conflict lines) beside a written-back one.
        let mut a = session("a", None);
        a.activity = Some(act("x"));
        let mut b = session("bb", None);
        b.activity = Some(act("x"));
        let mut c = session("ccc", Some("2026-09-24T00:00:00.000Z"));
        c.summary = Some("done".into());
        c.next_action = Some("n1".into());
        assert_parity("conflicts", &with(vec![a, b, c]));
        // An unwritten session newer than the last write-back.
        let mut a = session("a", Some("2026-09-21T01:00:00.000Z"));
        a.summary = Some("old".into());
        a.next_action = Some("n".into());
        let mut b = session("bb", Some("2026-09-22T01:00:00.000Z"));
        b.activity = Some(act("y"));
        assert_parity("derived resume", &with(vec![a, b]));
        // Overlapping write-backs with differing next actions.
        let mut a = session("a", Some("2026-09-29T00:00:00.000Z"));
        a.summary = Some("x".into());
        a.next_action = Some("one".into());
        let mut b = session("bb", Some("2026-09-29T00:00:00.000Z"));
        b.summary = Some("y".into());
        b.next_action = Some("two".into());
        assert_parity("parallel", &with(vec![a, b]));
    }
}
