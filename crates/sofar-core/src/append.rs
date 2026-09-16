//! The ONLY mutation path (`appendAndProject`, `registerSession`, `ensureLane`
//! in `mcp/context.ts` and `cli/event.ts`): validate → mint → `O_APPEND` →
//! regenerate projections; a session's first hook event registers it under a
//! cross-process lock (r1-fixes 1.2); the quick lane is created on the first
//! captured edit (r1-fixes 2.6, D14).

use std::path::Path;

use crate::envelope::{Envelope, MakeEventInput, make_event};
use crate::fold::empty_state;
use crate::home::{LaneAvailability, lane_availability};
use crate::json::{Json, Object};
use crate::layout::Layout;
use crate::lock::{LockOptions, with_file_lock};
use crate::log::append_event;
use crate::payload::validate_payload;
use crate::projections::regenerate_projections;
use crate::snapshot::{fold_file, state_of};
use crate::status::QUICK_LANE;

/// The fixed goal the lane is created with (`QUICK_LANE_GOAL`).
pub const QUICK_LANE_GOAL: &str = "Quick work — ad-hoc fixes on branches bound to no initiative. Hook-captured: no plan, no write-back; a decision gets one line of why. A thread that keeps returning deserves its own record (sofar new <slug>).";

/// The folded state of one record, a missing log folding to the empty state
/// with its slug (`foldState`).
#[must_use]
pub fn fold_state(layout: &Layout, slug: &str) -> crate::fold::InitiativeState {
    let log = layout.events_path(slug);
    let mut state = if log.exists() {
        match fold_file(&log, slug) {
            Ok(snapshot) => state_of(&snapshot).state,
            Err(_) => empty_state(),
        }
    } else {
        empty_state()
    };
    if state.slug.is_empty() {
        slug.clone_into(&mut state.slug);
    }
    state
}

/// `appendAndProject`: refuse an invalid payload, append, regenerate every
/// projection. Errors are strings the caller swallows (a hook is best-effort).
pub fn append_and_project(
    layout: &Layout,
    slug: &str,
    event_type: &str,
    payload: Object,
    session: &str,
    source: &'static str,
) -> Result<Envelope, String> {
    validate_payload(event_type, &Json::Obj(payload.clone())).map_err(|errors| {
        format!(
            "refusing to append invalid {event_type} payload: {}",
            errors.join("; ")
        )
    })?;
    let event = make_event(MakeEventInput {
        initiative: slug.to_owned(),
        session: session.to_owned(),
        source,
        actor: "agent",
        event_type: event_type.to_owned(),
        payload,
    })?;
    let log = layout.events_path(slug);
    if let Some(dir) = log.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    append_event(&log, &event)
        .map_err(|e| format!("failed to append {event_type} to initiative \"{slug}\": {e}"))?;
    let state = fold_state(layout, slug);
    regenerate_projections(&layout.initiative_dir(slug), &state).map_err(|e| e.to_string())?;
    Ok(event)
}

fn registered(layout: &Layout, slug: &str, session_id: &str) -> bool {
    fold_state(layout, slug)
        .sessions
        .iter()
        .any(|s| s.id == session_id)
}

/// `registerSession`: append `session_started` once per (initiative, session),
/// double-checked under `locks/<slug>.<sha256(session)[..24]>.lock`.
pub fn register_session(
    layout: &Layout,
    slug: &str,
    session_id: &str,
    tool: &str,
    source: &'static str,
) {
    if registered(layout, slug, session_id) {
        return;
    }
    let section = || {
        if !registered(layout, slug, session_id) {
            let mut payload = Object::with_capacity(1);
            payload.insert("tool", Json::Str(tool.to_owned()));
            let _ =
                append_and_project(layout, slug, "session_started", payload, session_id, source);
        }
    };
    match layout.register_lock_path(slug, session_id) {
        Some(lock) => with_file_lock(&lock, LockOptions::default(), section),
        None => section(),
    }
}

/// `registerLazily`: `cli` is never a session identity.
pub fn register_lazily(layout: &Layout, slug: &str, session: &str) {
    if session != "cli" {
        register_session(layout, slug, session, "claude-code", "hook");
    }
}

/// `ensureLane`: create the quick lane when this branch is bound to nothing
/// and the lane can catch the work; true when it exists afterwards.
#[must_use]
pub fn ensure_lane(layout: &Layout) -> bool {
    if lane_availability(layout) != LaneAvailability::Ready {
        return false;
    }
    let create = || {
        if layout.events_path(QUICK_LANE).exists() {
            return;
        }
        let _ = std::fs::create_dir_all(layout.initiative_dir(QUICK_LANE));
        let mut payload = Object::with_capacity(2);
        payload.insert("slug", Json::Str(QUICK_LANE.to_owned()));
        payload.insert("goal", Json::Str(QUICK_LANE_GOAL.to_owned()));
        let _ = append_and_project(
            layout,
            QUICK_LANE,
            "initiative_created",
            payload,
            "cli",
            "hook",
        );
    };
    match layout.ensure_index_dir() {
        Ok(dir) => with_file_lock(
            &dir.join("locks").join(format!("{QUICK_LANE}.create.lock")),
            LockOptions::default(),
            create,
        ),
        Err(_) => create(),
    }
    true
}

/// A path's directory exists — for callers that must not create one.
#[must_use]
pub fn parent_exists(path: &Path) -> bool {
    path.parent().is_some_and(Path::exists)
}
