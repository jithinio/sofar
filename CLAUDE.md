# CLAUDE.md — harness-build repo

## Harness protocol (follow strictly — this repo dogfoods its own product)
This repo tracks initiative state in `docs/harness.md`.
1. BEFORE any work: read `docs/harness.md` and `docs/SPEC.md` in full.
   Orient from them. Do not ask the user for context they already answer.
2. DURING work: when you complete a task, flip its checkbox in
   `docs/harness.md` and update "Current state". When you make a design
   choice or abandon an approach, append it to "Decisions" immediately —
   decision, reason, what was rejected and why.
3. BEFORE ending or when asked to wrap up: append a Session log entry
   (what you did, where you left off, the single next action) and ensure
   "Current state" is accurate. The record must let a session with zero
   context — including a different model or tool — resume without asking
   the user anything.

## Engineering conventions
- TypeScript strict mode; Node ≥18; ES modules.
- Dependencies: @modelcontextprotocol/sdk, commander, chokidar (watcher),
  ulid. Nothing else without logging a Decision.
- Tests: vitest; every core module ships with tests; acceptance criteria in
  docs/SPEC.md §Acceptance define "done" — do not mark a task complete
  without its criteria passing.
- Commits: small, one per task where possible, message prefixed with the
  task id (e.g. "1.3: atomic append with O_APPEND").
- Errors: never corrupt the log. Unknown/corrupt event lines are skipped
  with a warning during fold, never fatal, never rewritten.

## Guard-rails (scope law for the Fable window)
- DO NOT build: any UI, the sync service/backend, team/identity features,
  telemetry emission. The state server serves JSON on localhost — nothing
  more.
- Schema lives ONLY in packages/schema/src/ (event payloads) and
  packages/engine/src/projections/templates/. If a change wants to touch
  schema from anywhere else, stop and restructure.
- If a task seems to require violating a guard-rail, do not proceed —
  log the conflict in Decisions and surface it to the user.
- docs/SPEC.md is authoritative over improvisation. Deviations require a
  Decision entry.

<!-- harness:protocol -->
## Harness protocol (jurisdiction is total)

This repo's work memory lives in harness records under `.harness/`.
1. ALL work state lives in harness records — never in tool memory, scratch
   files, or ad-hoc notes. If it is worth keeping, it goes in the record.
2. Work that matches no existing initiative requires creating one first:
   run `harness new <slug>` before proceeding.
3. Bindings (`.harness/bindings.json`) resolve which record a session
   serves — the current git branch selects the initiative.

Session loop:
- START: orient from the record — call `harness_get_state` (MCP) or run
  `harness status`. Do not ask for context the record already answers.
  Then call `harness_start_session` passing the `session_id` from the
  injected context line ("Session: <id> — …") so your events attach to
  YOUR session — never omit it when that line is present (omitting mints
  a separate session id and orphans the hook-registered one).
- DURING: log decisions (`harness_log_decision`) and task status changes
  (`harness_update_task`) as they happen.
- BEFORE FINISHING: write back with `harness_end_session` (summary +
  next action). The Stop hook blocks sessions that skip this.
<!-- /harness:protocol -->
