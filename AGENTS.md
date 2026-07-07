# AGENTS.md — harness-build repo

Routing for any agent that auto-reads AGENTS.md (Codex, OpenCode, etc.).
This repo tracks its work in a harness record; orientation is mandatory.

1. BEFORE any work: read `docs/harness.md` (initiative record: plan,
   current state, decisions, session log) and `docs/SPEC.md` (authoritative
   contracts) IN FULL. Orient from them — do not ask the user for context
   they already answer.
2. Follow the protocol, engineering conventions, and guard-rails in
   `CLAUDE.md` (this directory). They bind every tool, not just Claude
   Code. The protocol rules there are the single source — they are not
   duplicated here.
3. BEFORE ending: append a Session log entry to `docs/harness.md` (what
   you did, where you left off, the single next action) and keep "Current
   state" accurate.

<!-- harness:protocol -->
## Harness protocol (jurisdiction is total)

This repo's work memory lives in harness records under `.harness/`. Drive
the whole loop with the `harness` CLI — no MCP support is required.
1. ALL work state lives in harness records — never in tool memory, scratch
   files, or ad-hoc notes. If it is worth keeping, it goes in the record.
2. Work that matches no existing initiative requires creating one first:
   run `harness new <slug>` before proceeding.
3. Bindings (`.harness/bindings.json`) resolve which record a session
   serves — the current git branch selects the initiative.

Session loop (every write is one `harness event append` call):
- BEFORE any work: run `harness status` and orient from it. Detail lives
  in `.harness/initiatives/<slug>/plan.md` and `decisions.md`. Do not
  ask for context the record already answers.
- START: pick one unique session id, reuse it for every append this
  session, and register it:
  `harness event append --type session_started --session <session-id> --source opencode --payload '{"tool":"opencode"}'`
  (put your tool's name in --source and the payload).
- DURING: log work as it happens with `harness event append --session <session-id> --source <tool>` plus:
  task status:  `--type task_status_changed --payload '{"id":"<task-id>","status":"pending|active|done|blocked"}'`
  decisions:    `--type decision_logged --payload '{"chose":"...","over":"...","because":"..."}'`
  notes:        `--type note_added --payload '{"text":"..."}'`
- BEFORE FINISHING (MANDATORY): write back —
  `harness event append --type session_ended --session <session-id> --source <tool> --payload '{"summary":"<what happened>","next_action":"<single next step>"}'`
  A session that skips this abandons its state and the next session starts blind.

Prohibitions:
- Never hand-edit generated projections (plan.md, decisions.md,
  sessions/*) — they are rebuilt from events.jsonl on every append.
- Never edit events.jsonl directly — truth is append-only, via the CLI.
- Corrections are new `correction` events referencing the bad event's id
  (then append the corrected event fresh); history is never rewritten.
<!-- /harness:protocol -->
