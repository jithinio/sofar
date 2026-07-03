# CLAUDE.md — harness-build repo

## Harness protocol (follow strictly — this repo dogfoods its own product)
This repo tracks initiative state in `harness.md`.
1. BEFORE any work: read `harness.md` and `SPEC.md` in full. Orient from
   them. Do not ask the user for context they already answer.
2. DURING work: when you complete a task, flip its checkbox in `harness.md`
   and update "Current state". When you make a design choice or abandon an
   approach, append it to "Decisions" immediately — decision, reason, what
   was rejected and why.
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
  SPEC.md §Acceptance define "done" — do not mark a task complete without
  its criteria passing.
- Commits: small, one per task where possible, message prefixed with the
  task id (e.g. "1.3: atomic append with O_APPEND").
- Errors: never corrupt the log. Unknown/corrupt event lines are skipped
  with a warning during fold, never fatal, never rewritten.

## Guard-rails (scope law for the Fable window)
- DO NOT build: any UI, the sync service/backend, team/identity features,
  telemetry emission. The state server serves JSON on localhost — nothing
  more.
- Schema lives ONLY in src/schema/ (event payloads) and
  src/projections/templates/. If a change wants to touch schema from
  anywhere else, stop and restructure.
- If a task seems to require violating a guard-rail, do not proceed —
  log the conflict in Decisions and surface it to the user.
- SPEC.md is authoritative over improvisation. Deviations require a
  Decision entry.
