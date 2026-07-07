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
   files, or ad-hoc notes. If it is worth keeping, it goes in the record.
2. Work that matches no existing initiative requires creating one first:
   run `sofar new <slug>` before proceeding.
3. Bindings (`.sofar/bindings.json`) resolve which record a session
   serves — the current git branch selects the initiative.

Session loop (every write is one `sofar event append` call):
- BEFORE any work: run `sofar status` and orient from it. Detail lives
  in `.sofar/initiatives/<slug>/plan.md` and `decisions.md`. Do not
  ask for context the record already answers.
- START: pick one unique session id, reuse it for every append this
  session, and register it:
  `sofar event append --type session_started --session <session-id> --source opencode --payload '{"tool":"opencode"}'`
  (put your tool's name in --source and the payload).
- DURING: log work as it happens with `sofar event append --session <session-id> --source <tool>` plus:
  task status:  `--type task_status_changed --payload '{"id":"<task-id>","status":"pending|active|done|blocked"}'`
  decisions:    `--type decision_logged --payload '{"chose":"...","over":"...","because":"..."}'`
  notes:        `--type note_added --payload '{"text":"..."}'`
- BEFORE FINISHING (MANDATORY): write back —
  `sofar event append --type session_ended --session <session-id> --source <tool> --payload '{"summary":"<what happened>","next_action":"<single next step>"}'`
  A session that skips this abandons its state and the next session starts blind.

Prohibitions:
- Never hand-edit generated projections (plan.md, decisions.md,
  sessions/*) — they are rebuilt from events.jsonl on every append.
- Never edit events.jsonl directly — truth is append-only, via the CLI.
- Corrections are new `correction` events referencing the bad event's id
  (then append the corrected event fresh); history is never rewritten.
<!-- /sofar:protocol -->
