import type { TaskRoute } from '@sofar/schema'
import type { InitiativeState, PhaseState } from './fold'

/**
 * The driver's task queue (session-driver 1.2), apart from the driver so the
 * surfaces that watch a run — the prompt line and the statusline
 * (drive-visibility 3.2, 3.3), both on the hot path — name the task in flight
 * by the driver's own rule without bundling the driver. `driver/drive.ts`
 * re-exports both, so its callers are unchanged.
 */

export interface DriveTask {
  /** Phase the task belongs to — reported, never recorded (the task id is the key). */
  phase: string
  id: string
  title: string
  /** Where the plan says this task wants to run (3.2); resolved by `resolveRoute`. */
  route?: TaskRoute
}

/**
 * The next task to run: within a phase, the one already `active` if there is
 * one, else the first `pending`. Phases are tried active-first and then in
 * plan order, so a run continues past a phase boundary rather than stopping
 * at one — `done`, `blocked` and `dropped` phases are skipped entirely.
 *
 * `blocked` tasks are skipped for the same reason the loop stops on one it
 * caused: a blocked task is waiting on the operator, and relaunching a session
 * onto it would burn a session re-discovering that.
 */
export function nextTask(state: InitiativeState): DriveTask | undefined {
  return queuedTasks(state)[0]
}

/**
 * Every task this run could still reach, in the order it would reach them —
 * `nextTask` is the head of this list, by construction rather than by a second
 * traversal that could disagree with it. The routing preview walks the whole
 * queue (3.2), because a run refuses to start on a route it cannot honour and
 * the task carrying it may be five sessions away.
 */
export function queuedTasks(state: InitiativeState): DriveTask[] {
  const queued: DriveTask[] = []
  for (const phase of orderedPhases(state)) {
    if (phase.status !== 'pending' && phase.status !== 'active') continue
    // Active before pending WITHIN the phase, so the head of this list is the
    // task the loop would take next even when an earlier sibling is pending.
    for (const status of ['active', 'pending'] as const) {
      for (const task of phase.tasks) {
        if (task.status !== status) continue
        queued.push({
          phase: phase.name,
          id: task.id,
          title: task.title,
          ...(task.route !== undefined ? { route: task.route } : {}),
        })
      }
    }
  }
  return queued
}

function orderedPhases(state: InitiativeState): PhaseState[] {
  const active = state.phases.find((p) => p.name === state.current.active_phase)
  if (active === undefined) return [...state.phases]
  return [active, ...state.phases.filter((p) => p !== active)]
}
