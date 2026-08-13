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
  docs/SPEC.md §Acceptance criteria define "done" — do not mark a task
  complete without its criteria passing.
- Commits: small, one per task where possible, message prefixed with the
  task id (e.g. "1.3: atomic append with O_APPEND").
- Errors: never corrupt the log. Unknown/corrupt event lines are skipped
  with a warning during fold, never fatal, never rewritten.

### Citing things (the § rule)
`§` cites a section of a HAND-WRITTEN document only — docs/SPEC.md,
docs/FORMAT.md, CLAUDE.md. NEVER a generated file (plan.md, decisions.md,
memory.md, sessions/*.md): those render from events.jsonl, so a heading
there is a projection that templates can change, while the id underneath
is truth. Never a function's output either.

- Name the target VERBATIM and WHOLE — a `##`/`###` heading, or one of
  SPEC's `**Bold label**` sub-sections: `§Acceptance criteria`, not
  `§Acceptance`; `§Event envelope`, not `§Envelope`.
- Keep the citation on ONE line. A `§Sync` / `client` line-wrap is
  unresolvable by search even though it reads fine.
- CLOSE it when the next word could read as part of the heading — comma,
  parens, or reword. `§Acceptance criteria, Phase 4` ✓ · `(§CLI UI)` ✓ ·
  `the ladder in §CLI UI:` ✓ · `§CLI UI ladder` ✗ (is the section named
  "CLI UI ladder"?).
- Numbered docs take the number: `FORMAT.md §5.5`.

Tasks, phases and decisions are NOT document sections — cite them by id,
never with `§`: `record-index 4.2`, `cross-initiative-conflicts 2.2`,
`speed T2`, `Phase 3 — Contract + proof`, `D17`, `felt-cost D3`.

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
- START: the SessionStart hook has ALREADY injected the record above —
  goal, progress, next action, decisions, rejected approaches. Do not
  call `sofar_get_state` to re-read it: that digest is the same
  projection rendered with fewer fields, so it can only tell you less.
  Reach for it only when the injected block is missing or truncated, or
  to read a DIFFERENT initiative.
  Do still call `sofar_start_session`, passing the `session_id` from the
  injected context line ("Session: <id> — …"). It is not bookkeeping: it
  pins which record your writes land in — without it they follow the
  branch binding, which moves mid-session — and attaches them to YOUR
  session rather than minting a separate id that orphans the
  hook-registered one.
- RE-HOME the moment the work turns out to belong to a DIFFERENT record
  than the one injected: call `sofar_start_session` again with that
  `initiative` (plus the same `session_id`). Passing `initiative` to any
  other tool routes ONE write; re-homing moves the SESSION. That
  distinction is the whole point — `sofar_end_session` takes no
  `initiative` and always follows the home, so a session that only ever
  targets writes one at a time still files its write-back, the event the
  next session reads first, in the wrong record.
- DURING: log decisions (`sofar_log_decision`) and task status changes
  (`sofar_update_task`) as they happen. An operational fact you learn is
  NOT a decision — a release command, a failure mode and how it is
  diagnosed, a convention every later session needs. Promote it with
  `sofar_remember` the moment you learn it, or it lives only in your own
  context and dies with the session.
- BEFORE FINISHING: write back with `sofar_end_session` (summary +
  next action). The Stop hook blocks sessions that skip this.
- ORDER MATTERS: write back BEFORE the final commit, then commit code and
  record together. git and sofar commands are exempt from the record
  (record-hygiene D1), so a write-back followed by a commit leaves the tree
  clean; committing first and writing back after guarantees trailing dirt.
<!-- /sofar:protocol -->
