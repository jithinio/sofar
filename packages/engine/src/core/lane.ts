/**
 * The quick-work lane (r1-fixes 2.6, D14) — the standing per-repo record that
 * ad-hoc work lands in when nothing else resolves.
 *
 * A 1–3 minute fix on a branch bound to no initiative used to pay the whole
 * ceremony to be recorded at all: `sofar new`, a plan, sofar_start_session,
 * a write-back — or, far more often, paid nothing and was recorded nowhere,
 * because the hooks drop every event for an unbound branch (initiative-
 * lifecycle D4). The lane is the third option: a reserved slug, `quick`,
 * that RESOLUTION FALLS BACK TO. It is never a binding and never a home:
 *
 *  - bindings.json is never written for it. `sofar new`/`switch` move the
 *    branch off the lane the moment the work turns out to be a project, and
 *    nothing a hook did in between has to be undone.
 *  - a registration in the lane never beats a bound branch (homeInitiative
 *    skips it whenever a real slug is preferred), so a session that began as
 *    quick work follows the branch when it is bound — the split-session tear
 *    record-integrity 1.2 fixed cannot come back through the lane.
 *  - it names nothing: fixed slug, fixed goal. The SessionStart block still
 *    says a project needs its own record — the lane is where quick work is
 *    recalled from, not a default initiative (r1-fixes D1 rejected that).
 *
 * The lane creates itself on the first captured PostToolUse edit (never at
 * SessionStart — that path appends nothing, record-hygiene D2), and it can be
 * turned off by closing it: a closed lane is not a fallback, and the hooks
 * discard again exactly as they did before it existed.
 */

/** The reserved slug. `sofar new quick` refuses: the lane creates itself. */
export const QUICK_LANE = 'quick'

/** The fixed goal the lane is created with — it describes the lane, never the project. */
export const QUICK_LANE_GOAL =
  'Quick work — ad-hoc fixes on branches bound to no initiative. Hook-captured: no plan, no write-back; a decision gets one line of why. A thread that keeps returning deserves its own record (sofar new <slug>).'

/** How many recent lane sessions the SessionStart block names. */
export const LANE_RECENT_SESSIONS = 5
