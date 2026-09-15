# AGENTS.md — sofar repo

Routing for any agent that auto-reads AGENTS.md (Codex, OpenCode, etc.).
This repo tracks its work in a sofar record; orientation is mandatory.

1. BEFORE any work: run `sofar status` and orient from the record in
   `.sofar/` (detail in `.sofar/initiatives/<slug>/plan.md` and
   `decisions.md`; authoritative contracts in `docs/SPEC.md`). Do not ask
   the user for context the record already answers. (the archived pre-migration
   record lives in docs/ under the pre-rename product name — history only,
   never written.)
2. Follow the protocol, engineering conventions, and guard-rails in
   `CLAUDE.md` (this directory). They bind every tool, not just Claude
   Code. The protocol rules there are the single source — they are not
   duplicated here.

<!-- sofar:protocol -->
## Sofar protocol (jurisdiction is total)

This repo's work memory lives in sofar records under `.sofar/`. Drive
the whole loop with the `sofar` CLI — no MCP support is required.
1. ALL work state lives in sofar records — never in tool memory, scratch
   files, ad-hoc notes, or a message from another session. If it is worth
   keeping, it goes in the record.
2. Work that matches no existing initiative requires creating one first:
   run `sofar new <slug> --goal "<one line>"` before proceeding, then
   append its plan (PLAN below). One initiative per project or roadmap —
   its features and roadmap items are phases and tasks inside it, never
   initiatives of their own.
3. Bindings (`.sofar/bindings.json`) resolve which record a session
   serves — the current git branch selects the initiative.

Session loop (every write is one `sofar event append` call):
- BEFORE any work: run `sofar status` and orient from it. Detail lives
  in `.sofar/initiatives/<slug>/plan.md` and `decisions.md`. Do not
  ask for context the record already answers.
- RECORD: every append takes an optional LEADING slug —
  `sofar event append <slug> --type …` — naming the record it lands in.
  Omit it and the write follows the current branch's binding, which is not
  the same thing as the record you registered in and can move mid-session.
  So decide the slug once, before the first append, and pass it on EVERY
  append this session — above all on the session_ended one, because a
  write-back filed in the wrong record is the event the next session reads
  first. If the work belongs to a record other than the one `sofar status`
  shows, that is the slug to pass, every time; there is no session-level
  re-homing on this path. `sofar remember` takes the same record as
  `--initiative <slug>`, and follows the branch without it.
- START: pick one unique session id, reuse it for every append this
  session, and register it (repeating it is a harmless no-op):
  `sofar event append <slug> --type session_started --session <session-id> --source <tool> --payload '{"tool":"<tool>"}'`
  (<tool> is your agent's name — codex, cursor, opencode; any name works).
- PLAN: a new initiative gets its plan before the first edit, and a plan
  is replanned the same way when phases or tasks change. plan_updated is
  a FULL replace — resend every phase and task, with statuses, each time:
  `sofar event append <slug> --session <session-id> --source <tool> --type plan_updated --payload '{"plan":{"goal":"<goal>","phases":[{"name":"Phase 1 — <name>","status":"active","tasks":[{"id":"1.1","title":"<task>","status":"pending"}]}]}}'`
- DURING: log work as it happens with `sofar event append <slug> --session <session-id> --source <tool>` plus:
  task status:  `--type task_status_changed --payload '{"id":"<task-id>","status":"pending|active|done|blocked|dropped"}'`
  phase status: `--type phase_status_changed --payload '{"phase":"<phase name as in the plan>","status":"active|done"}'`
  decisions:    `--type decision_logged --payload '{"chose":"...","over":"...","because":"..."}'`
  notes:        `--type note_added --payload '{"text":"..."}'`
  Every other event type, its fields and who writes it: `sofar event types`.
- DURING, for operational facts: a release command, a failure mode and how
  it is diagnosed, a convention every later session needs is NOT a decision.
  Promote it the moment you learn it with `sofar remember "<fact>"`, or it
  lives only in your own context and dies with the session.
- DRIVING: when the operator asks for the work to run under sofar drive
  ("run this in sofar drive"), write back FIRST (the session_ended append
  below) — the run's first session resumes from your next_action — then
  start it with `sofar drive <slug> --detach`, adding `--allow` for what
  proving a task needs (the test command) and `--session-timeout`. Relay
  what it prints: the run id, every warning, how to stop it. Do not append
  to that record again while the run goes. `sofar drive <slug> --stop`
  ends it. A sandbox with no network cannot host a run.
- BEFORE FINISHING (MANDATORY): write back —
  `sofar event append <slug> --type session_ended --session <session-id> --source <tool> --payload '{"summary":"<what happened>","next_action":"<single next step>"}'`
  A session that skips this abandons its state and the next session starts blind.

Prohibitions:
- Never hand-edit generated projections (plan.md, decisions.md,
  sessions/*) — they are rebuilt from events.jsonl on every append.
- Never edit events.jsonl directly — truth is append-only, via the CLI.
- Corrections are new `correction` events referencing the bad event's id
  (then append the corrected event fresh); history is never rewritten.
<!-- /sofar:protocol -->
