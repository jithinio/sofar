//! The driver's task queue (`core/drive-queue.ts`, session-driver 1.2),
//! as the surfaces that watch a run name the task in flight (drive-visibility
//! 3.2 prompt line, 3.3 statusline): within a phase the `active` task, else
//! the first `pending`; phases active-first, then plan order; done, blocked
//! and dropped phases skipped; blocked tasks never queued.

use crate::fold::{InitiativeState, PhaseState, TaskState};

/// `nextTask`: the task a run would take next, or None when nothing is queued.
#[must_use]
pub fn next_task(state: &InitiativeState) -> Option<&TaskState> {
    queued_tasks(state).into_iter().next()
}

/// `queuedTasks`: every task the run could still reach, in reach order.
#[must_use]
pub fn queued_tasks(state: &InitiativeState) -> Vec<&TaskState> {
    let mut queued = Vec::new();
    for phase in ordered_phases(state) {
        if phase.status != "pending" && phase.status != "active" {
            continue;
        }
        for status in ["active", "pending"] {
            queued.extend(phase.tasks.iter().filter(|t| t.status == status));
        }
    }
    queued
}

fn ordered_phases(state: &InitiativeState) -> Vec<&PhaseState> {
    let active = state
        .current
        .active_phase
        .as_deref()
        .and_then(|name| state.phases.iter().find(|p| p.name == name));
    match active {
        None => state.phases.iter().collect(),
        Some(active) => std::iter::once(active)
            .chain(state.phases.iter().filter(|p| !std::ptr::eq(*p, active)))
            .collect(),
    }
}
