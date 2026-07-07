# CLAUDE.md — sofar repo

## Initiative record (self-hosted)
This repo's initiative record lives in `.sofar/` — follow the installed
sofar protocol block below. The archived pre-migration prose
record (read-only) lives in docs/ under the pre-rename product name. `docs/SPEC.md` remains the authoritative
contracts.

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
