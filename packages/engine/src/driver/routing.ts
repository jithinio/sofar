import type { RunPolicy, TaskRoute } from '@sofar/schema'
import { inertOptions, policyUnavailable, type Adapter } from './adapter'
import type { PermissionSurface } from './permissions'

/**
 * Per-task routing (session-driver 3.2, D10): which agent, model and effort a
 * task is launched with, decided from the plan and the run — never inferred.
 *
 * Two rules, and everything here is one of them.
 *
 * RUN OVER TASK. A `route` on a task is a HINT. What the run states — the
 * model/effort `run_started.surface` recorded, or this driver's own flags —
 * wins, and the hint fills only what the run left open. The reason is the one
 * that makes `--resume` take the run's surface over the resuming driver's
 * flags (2.4, D8): a run whose second half ran a different model than its own
 * record names is two runs wearing one id, and the record would name the
 * model half its sessions never used. An overridden hint is not silently
 * dropped, though — it is stated before the run starts (D9), because an
 * operator who wrote `route.model` into the plan and got something else
 * should hear it from the driver.
 *
 * NO SILENT FALLBACK. `route.agent` is the one field that cannot be honoured
 * halfway. A run that cannot reach the named adapter, or whose policy that
 * adapter cannot run, REFUSES — before `run_started`, so nothing is recorded
 * and nothing has to be unwound. Running the task on the default agent
 * instead would be the trap D9 names: an unattended run discovered from the
 * transcript rather than from the driver.
 *
 * Nothing here is recorded. The plan already carries the hint and the launched
 * session's own `session_started` carries the tool and model it actually ran,
 * so a third copy on the handoff is the one that goes stale (D3).
 */

/** A route that cannot be honoured: refused before the run, never worked around. */
export class RouteError extends Error {}

/** What a task can be routed to, and what the run has already pinned. */
export interface RoutingOptions {
  /** The run's default adapter (`--agent`), recorded in `run_started.adapter`. */
  adapter: Adapter
  /**
   * Adapters a task may name in `route.agent`, by name. The default adapter is
   * always reachable under its own name whether or not it appears here; every
   * other name is a refusal, because the alternative is guessing.
   */
  agents?: ReadonlyMap<string, Adapter>
  /** The surface the run pinned — its model/effort outrank any task's. */
  surface?: PermissionSurface
  /** This driver's own routing flags, behind the surface and ahead of the task. */
  model?: string
  effort?: string
  /**
   * The run's policy. A ROUTED adapter that cannot run it is refused here —
   * the default adapter is checked by the driver itself, with its own sentence.
   */
  policy: RunPolicy
  /** The run's cost cap, for the inert-option lines a routed adapter earns. */
  costCapUsd?: number
}

/** One task's resolved route: what `launch()` is actually called with. */
export interface Route {
  adapter: Adapter
  model?: string
  effort?: string
  /**
   * Hints this route did not honour, as progress lines (D9): overridden by
   * the run, or unhonourable by the adapter's own capabilities. Empty when the
   * task asked for nothing it did not get.
   */
  inert: string[]
}

/**
 * The adapter named by `agent`, or a refusal. The default adapter answers to
 * its own name so a plan can route to it explicitly — useful in a run whose
 * `--agent` is something else, and harmless in one where it is not.
 */
function adapterFor(taskId: string, agent: string, options: RoutingOptions): Adapter {
  if (agent === options.adapter.name) return options.adapter
  const found = options.agents?.get(agent)
  if (found === undefined) {
    const reachable = [options.adapter.name, ...(options.agents?.keys() ?? [])]
    throw new RouteError(
      `task ${taskId} routes to agent "${agent}", which this run cannot reach — it can launch ${[...new Set(reachable)].join(', ')}`,
    )
  }
  // The policy check belongs HERE and not only in the preview: a task the plan
  // grows mid-run gets the same refusal at its own launch, which is what makes
  // the preview an early warning rather than the only guard.
  const unavailable = policyUnavailable(found.capabilities, options.policy)
  if (unavailable !== null) {
    throw new RouteError(
      `task ${taskId} routes to ${agent}, which cannot run this run's \`${options.policy}\` policy: ${unavailable}`,
    )
  }
  return found
}

/**
 * Resolve one task's route. Throws `RouteError` when `route.agent` names an
 * adapter the run cannot reach; every other conflict resolves in the run's
 * favour and says so in `inert`.
 */
export function resolveRoute(
  taskId: string,
  route: TaskRoute | undefined,
  options: RoutingOptions,
): Route {
  const adapter = route?.agent !== undefined ? adapterFor(taskId, route.agent, options) : options.adapter
  const inert: string[] = []

  const pin = (
    field: 'model' | 'effort',
    pinned: string | undefined,
    honoured: boolean,
  ): string | undefined => {
    const hint = route?.[field]
    if (pinned !== undefined) {
      if (hint !== undefined && hint !== pinned) {
        inert.push(
          `task ${taskId} hints ${field} ${hint}, but this run pinned ${field} ${pinned} — the run's pin wins`,
        )
      }
      return pinned
    }
    if (hint !== undefined && !honoured) {
      inert.push(
        `task ${taskId} hints ${field} ${hint}, but the ${adapter.name} adapter honours no ${field} hint — it does not reach the session`,
      )
    }
    return hint
  }

  const model = pin('model', options.surface?.model ?? options.model, adapter.capabilities.model)
  const effort = pin('effort', options.surface?.effort ?? options.effort, adapter.capabilities.effort)
  return {
    adapter,
    ...(model !== undefined ? { model } : {}),
    ...(effort !== undefined ? { effort } : {}),
    inert,
  }
}

/** A task as the router sees it: an id and whatever the plan says about where it runs. */
export interface RoutableTask {
  id: string
  route?: TaskRoute
}

/**
 * Resolve every queued task's route BEFORE the run starts, and return what the
 * operator should hear first (D9). Throws — with nothing recorded — when a task
 * names an agent the run cannot reach, or when a routed adapter cannot run the
 * run's policy: a threshold run whose codex-routed session has no gauge and no
 * nudge is not a threshold run, and discovering that six sessions in is worse
 * than not starting.
 *
 * The queue is read as it stands. A session that adds a routed task mid-run is
 * resolved at ITS launch, where the same `RouteError` stops the run with the
 * same sentence — this is the early half of one check, not a different one.
 */
export function previewRoutes(tasks: readonly RoutableTask[], options: RoutingOptions): string[] {
  const lines: string[] = []
  const routed = new Map<string, { adapter: Adapter; tasks: string[] }>()
  for (const task of tasks) {
    const route = resolveRoute(task.id, task.route, options)
    lines.push(...route.inert)
    if (route.adapter === options.adapter) continue
    const entry = routed.get(route.adapter.name) ?? { adapter: route.adapter, tasks: [] }
    entry.tasks.push(task.id)
    routed.set(route.adapter.name, entry)
  }

  for (const [name, entry] of routed) {
    // The run's own inert options, restated for the sessions the default
    // adapter will not launch: an allow-list that reaches most of a run and
    // not the two codex-routed sessions is exactly the silent trap D9 names.
    for (const line of inertOptions(entry.adapter.capabilities, {
      ...(options.surface !== undefined ? { surface: options.surface } : {}),
      ...(options.costCapUsd !== undefined ? { costCapUsd: options.costCapUsd } : {}),
    })) {
      lines.push(`task ${entry.tasks.join(', ')} routed to ${name}: ${line}`)
    }
  }
  return lines
}
