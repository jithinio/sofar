# SPEC.md — Harness v1 engine contracts (authoritative)

## Repo layout (npm workspaces monorepo — see BD11)
```
harness/                 # workspace root: toolchain devDeps, shared tsconfig
  packages/
    schema/              # @harness/schema — the ONLY schema home
      src/events.ts      #   event payload types + validation (source-shipped
      src/tool-inputs.ts #   internal pkg — main/types point at src, no build
      test/              #   step yet); tool-inputs = MCP tool arg schemas
    engine/              # harness — the npm bin (CLI + MCP server + hooks)
      src/core/          # envelope.ts, log.ts (append), fold.ts, cursor.ts
      src/mcp/           # server.ts + one file per tool
      src/cli/           # commands: init, new, switch, status, export,
                         # import, event (used by hook shims), serve
      src/projections/   # generator.ts + templates/ (plan.md, decisions.md,
                         # status)
      src/hooks/         # shim script sources, installed to .claude/hooks/
      test/
  docs/                  # harness.md (initiative record), SPEC.md, CLAUDE.md
```
Future packages (ui, sync, adapters) join packages/* post-v1; the
engine-only scope law still applies during the Fable window.

## Record layout (what the engine manages inside a user repo)
```
.harness/
  repo.md                      # repo-scoped memory (hand-written, NOT generated)
  bindings.json                # { "<git-branch-or-worktree>": "<slug>" }
  initiatives/<slug>/
    events.jsonl               # TRUTH — append-only
    plan.md                    # generated projection
    decisions.md               # generated projection
    sessions/<session-id>.md   # generated per-session summaries
```

## Event envelope (v1 — stable; payloads evolve, envelope does not)
One JSON object per line in events.jsonl:
```json
{"v":1,"id":"<ulid>","ts":"<ISO8601>","initiative":"<slug>",
 "session":"<session-id|cli>","source":"claude-code|opencode|codex|cli|hook",
 "actor":"agent|human","type":"<event_type>","payload":{}}
```
Rules: ulid ids (sortable); appends are atomic single-line writes with
O_APPEND; a reader must tolerate a torn final line (skip + warn); events are
immutable — corrections are new events of type `correction` referencing the
target id.

## Event types (payload schemas in packages/schema/ — the swappable part)
initiative_created · plan_updated (full plan structure) ·
phase_status_changed · task_added · task_status_changed (id, status:
pending|active|done|blocked) · decision_logged (chose, over, because) ·
session_started (tool, model?) · session_ended (summary, next_action) ·
session_closed (reason — mechanical close from the SessionEnd hook; never
carries summary/next_action, added Phase 3, BD21) ·
file_touched (path, op) · command_run (cmd) · note_added · correction (ref)

## State (result of fold)
InitiativeState = { slug, goal, phases[ {name, status, tasks[ {id, title,
status} ]} ], decisions[], sessions[ {id, tool, model?, started, ended?,
summary?, next_action?} ],
files_touched[], current: {active_phase, next_action, blocked_on?},
cursor: <last event id> }

## Cursor primitive (sync-ready contract)
`export(sinceId?) → NDJSON stream of events` ; `import(stream)` appends
events not already present (dedupe by id — idempotent). Per-initiative
streams; ordering by ulid. This is the entire future sync interface.

## MCP tools (server name: harness)
- harness_get_state({initiative?}) → InitiativeState (resolves initiative
  from bindings.json + current branch when omitted)
- harness_start_session({initiative?, tool, model?}) → {session_id}
- harness_end_session({session_id, summary, next_action}) → ok
- harness_update_task({initiative?, task_id, status, note?}) → ok
- harness_log_decision({initiative?, chose, over, because}) → ok
- harness_update_plan({initiative?, plan}) → ok   # full-structure replace
- harness_add_note({initiative?, text}) → ok
Every tool = validate payload → append event → regenerate projections →
return. No tool mutates state except via an event.

## Hooks (installed by `harness init` as standalone scripts in .claude/hooks/)
- SessionStart shim → `harness event session-start` then prints the status
  projection to stdout (context injection). HARD LIMIT: output ≤10,000
  chars — projection generator must guarantee this.
- PostToolUse shim (matcher: Edit|Write|MultiEdit|Bash) → appends
  file_touched / command_run from stdin JSON (tool_name, tool_input).
- Stop shim → reads stdin JSON; if stop_hook_active is true → exit 0
  (loop guard). Else if no session_ended event exists for this session_id →
  exit 2 with stderr: "Write back to the harness record before finishing:
  call harness_end_session (or update harness.md per protocol)." Else exit 0.
- SessionEnd shim → appends mechanical session-close marker (fallback only;
  cannot feed back to the agent).
Shims contain no logic — they invoke the harness CLI.

## CLI
- `harness init` — create .harness/, write repo.md stub, install hook shims
  + .claude/settings.json hooks block, emit .mcp.json registration, append
  protocol blocks to CLAUDE.md and AGENTS.md (idempotent; the AGENTS.md
  block is the CLI convention dialect for MCP-less tools — added Phase 5,
  BD31). Each installed protocol block
  MUST include: (a) all work state lives in harness records — never in tool
  memory or scratch files; (b) work matching no existing initiative requires
  creating one (harness new) before proceeding; (c) bindings resolve which
  record a session serves. [Field finding, Jul 4: singular-record protocol
  caused a second initiative's state to leak into Claude Code native memory
  + a scratch dir — jurisdiction must be total, not per-file.]
- `harness new <slug> [--goal]` / `harness switch <slug>` — create/select
  initiative; bind current branch in bindings.json.
- `harness status [slug]` — fold and print: goal, progress %, phase tree
  with statuses, next action, blocked, last session.
- `harness export [slug] [--since <id>]` / `harness import <file|-> [slug]`
  — per-initiative NDJSON over the §Cursor primitive; slug resolves like
  status (explicit wins, else branch binding) (extended Phase 4, BD28)
- `harness event <subcommand>` — append-side surface: session-start,
  post-tool, stop, session-end are internal subcommands for the hook shims;
  `event append --type <event_type> --payload <json-object> [--session <id>]
  [--source <source>] [--actor <actor>] [slug]` is the convention-dialect
  surface for MCP-less tools — validate payload, append ONE event,
  regenerate projections, print {ok, event_id} JSON; any failure exits 1
  with the typed-error JSON and appends nothing (added Phase 5, BD30; slug
  resolves like status).
- `harness serve [--port 4173]` — chokidar watch on .harness/ → GET /state
  (JSON InitiativeState per initiative), Server-Sent Events on change.
- `harness mcp [--root <dir>]` — start the stdio MCP server (server name:
  harness) exposing §MCP tools; --root overrides the repo root (default:
  cwd). Added in Phase 2 (BD13); `harness init` registers it in .mcp.json.

## Acceptance criteria (definition of done)
- **Phase 1:** 1k concurrent appends from 4 processes → zero lost/interleaved
  lines; fold of a log with an injected corrupt line succeeds with warning;
  replay is deterministic (same log → deep-equal state); export/import
  round-trip is idempotent (re-import adds zero events).
- **Phase 2:** each tool call appends exactly its event and projections
  regenerate; invalid payloads rejected with typed errors; get_state resolves
  initiative from branch binding.
- **Phase 3:** SessionStart output verified ≤10k chars on a large synthetic
  initiative; Stop shim blocks a session lacking session_ended and passes one
  that has it; stop_hook_active loop guard verified; PostToolUse produces
  file_touched for an Edit and command_run for a Bash call.
- **Phase 4:** `harness init` on a fresh repo yields a working end-to-end
  loop (start session → tool events → end session → status shows it);
  init is idempotent (second run changes nothing); serve pushes an SSE on
  append within 500ms.
- **Phase 5:** AGENTS.md dialect drives a manual OpenCode session through
  read→work→write-back; the Jul 7 Fable→Opus handoff is executed and scored
  on the Phase 0 scorecard as an arm-C run.
