//! The ONLY mutation path (`appendAndProject`, `registerSession`, `ensureLane`
//! in `mcp/context.ts` and `cli/event.ts`): validate → mint → `O_APPEND` →
//! regenerate projections; a session's first hook event registers it under a
//! cross-process lock (r1-fixes 1.2); the quick lane is created on the first
//! captured edit (r1-fixes 2.6, D14).

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::SystemTime;

use crate::envelope::{Envelope, MakeEventInput, make_event, serialize_event};
use crate::fold::{
    FoldCheckpoint, append_to_checkpoint, empty_state, finalize_fold, replay_decoded,
};
use crate::home::{LaneAvailability, lane_availability};
use crate::json::{Json, Object};
use crate::layout::Layout;
use crate::lock::{LockOptions, with_file_lock};
use crate::log::{append_event, decode_lines};
use crate::payload::validate_payload;
use crate::projections::regenerate_projections;
use crate::status::QUICK_LANE;

/// The fixed goal the lane is created with (`QUICK_LANE_GOAL`).
pub const QUICK_LANE_GOAL: &str = "Quick work — ad-hoc fixes on branches bound to no initiative. Hook-captured: no plan, no write-back; a decision gets one line of why. A thread that keeps returning deserves its own record (sofar new <slug>).";

/// Fold cache (r1-fixes 2.7, D17; rust-core 3.3): one replay per log per
/// process. Keyed by the log's size and mtime, so any write this process did
/// not make — another hook, a sibling server, a branch switch — misses and
/// refolds; a write it DID make advances the checkpoint by exactly that line
/// ([`append_and_project`]). Every hit finalizes a clone, so a caller may
/// mutate what it gets. Bounded: the newest few logs only. Without it an
/// appending hook folded the log two to four times (registration check,
/// handler state, post-append projections), which on a 10 MB log is where
/// the native core lost to the TypeScript engine (perf 3.3, first run).
const FOLD_CACHE_MAX: usize = 8;

struct CachedFold {
    size: u64,
    mtime: Option<SystemTime>,
    cp: FoldCheckpoint,
}

static FOLDS: Mutex<Vec<(PathBuf, CachedFold)>> = Mutex::new(Vec::new());

fn with_folds<R>(f: impl FnOnce(&mut Vec<(PathBuf, CachedFold)>) -> R) -> R {
    let mut guard = FOLDS
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    f(&mut guard)
}

fn remember_fold(folds: &mut Vec<(PathBuf, CachedFold)>, log: &Path, entry: CachedFold) {
    folds.retain(|(p, _)| p != log);
    folds.push((log.to_path_buf(), entry));
    while folds.len() > FOLD_CACHE_MAX {
        folds.remove(0);
    }
}

fn stat_log(log: &Path) -> Option<(u64, Option<SystemTime>)> {
    let meta = std::fs::metadata(log).ok()?;
    Some((meta.len(), meta.modified().ok()))
}

/// Forget every cached fold (tests, and any caller that rewrote a log).
pub fn forget_folds() {
    with_folds(Vec::clear);
}

/// The folded state of one record, a missing log folding to the empty state
/// with its slug (`foldState`).
#[must_use]
pub fn fold_state(layout: &Layout, slug: &str) -> crate::fold::InitiativeState {
    let log = layout.events_path(slug);
    let mut state = match stat_log(&log) {
        None => {
            with_folds(|folds| folds.retain(|(p, _)| p != &log));
            empty_state()
        }
        Some((size, mtime)) => with_folds(|folds| {
            if let Some((_, hit)) = folds.iter().find(|(p, _)| p == &log)
                && hit.size == size
                && hit.mtime == mtime
            {
                return finalize_fold(&hit.cp).state;
            }
            match std::fs::read(&log) {
                Ok(bytes) => {
                    let text = String::from_utf8_lossy(&bytes);
                    let lines: Vec<&str> = text.split('\n').collect();
                    let count = if lines.last() == Some(&"") {
                        lines.len() - 1
                    } else {
                        lines.len()
                    };
                    let cp = replay_decoded(decode_lines(lines.iter().copied()), slug, count);
                    let state = finalize_fold(&cp).state;
                    remember_fold(folds, &log, CachedFold { size, mtime, cp });
                    state
                }
                Err(_) => empty_state(),
            }
        }),
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
    let before = with_folds(|folds| {
        folds
            .iter()
            .find(|(p, _)| p == &log)
            .map(|(_, hit)| hit.size)
    });
    append_event(&log, &event)
        .map_err(|e| format!("failed to append {event_type} to initiative \"{slug}\": {e}"))?;
    // Advance the checkpoint by the line just written (D17) — only when the
    // log now measures exactly cached + this line, which proves no other
    // writer landed in between. Any doubt drops the entry, and the fold
    // below reads the file like any other miss.
    if let Some(cached_size) = before {
        let line = serialize_event(&event);
        let advanced = stat_log(&log).is_some_and(|(size, mtime)| {
            size == cached_size + line.len() as u64 + 1
                && with_folds(|folds| {
                    let Some(entry) = folds.iter_mut().find(|(p, _)| p == &log) else {
                        return false;
                    };
                    if append_to_checkpoint(&mut entry.1.cp, &line) {
                        entry.1.size = size;
                        entry.1.mtime = mtime;
                        true
                    } else {
                        false
                    }
                })
        });
        if !advanced {
            with_folds(|folds| folds.retain(|(p, _)| p != &log));
        }
    }
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
pub fn register_lazily(layout: &Layout, slug: &str, session: &str, host_tool: &str) {
    if session != "cli" {
        register_session(layout, slug, session, host_tool, "hook");
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
