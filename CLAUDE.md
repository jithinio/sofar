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
- Zero model API calls (SPEC §Architectural invariants): sofar itself never
  calls a model — no API keys, no inference costs, no user content sent
  anywhere. Cheap-model or Batch-API bookkeeping is rejected (felt-cost D3);
  revisiting requires a new Decision that cites this one.

<!-- sofar:protocol -->
## Sofar protocol (jurisdiction is total)

This repo's work memory lives in sofar records under `.sofar/`.
1. ALL work state lives in sofar records — never in tool memory, scratch
   files, or ad-hoc notes. If it is worth keeping, it goes in the record.
2. Work that matches no existing initiative requires creating one first:
   run `sofar new <slug>` before proceeding.
3. Bindings (`.sofar/bindings.json`) resolve which record a session
   serves — the current git branch selects the initiative.

Session loop:
- START: orient from the record — call `sofar_get_state` (MCP) or run
  `sofar status`. Do not ask for context the record already answers.
  Then call `sofar_start_session` passing the `session_id` from the
  injected context line ("Session: <id> — …") so your events attach to
  YOUR session — never omit it when that line is present (omitting mints
  a separate session id and orphans the hook-registered one).
- DURING: log decisions (`sofar_log_decision`) and task status changes
  (`sofar_update_task`) as they happen.
- BEFORE FINISHING: write back with `sofar_end_session` (summary +
  next action). The Stop hook blocks sessions that skip this.
<!-- /sofar:protocol -->
