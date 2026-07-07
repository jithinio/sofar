# SPEC.md — Sofar v1 engine contracts (authoritative)

## Repo layout (npm workspaces monorepo — see BD11)
```
sofar/                   # workspace root: toolchain devDeps, shared tsconfig
  packages/
    schema/              # @sofar/schema — the ONLY schema home
      src/events.ts      #   event payload types + validation (source-shipped
      src/tool-inputs.ts #   internal pkg — main/types point at src, no build
      test/              #   step yet); tool-inputs = MCP tool arg schemas
    engine/              # sofar — the npm bin (CLI + MCP server + hooks)
      src/core/          # envelope.ts, log.ts (append), fold.ts, cursor.ts
      src/mcp/           # server.ts + one file per tool
      src/cli/           # commands: init, new, switch, status, export,
                         # import, event (used by hook shims), serve
      src/projections/   # generator.ts + templates/ (plan.md, decisions.md,
                         # status)
      src/hooks/         # shim script sources, installed to .claude/hooks/
      test/
  CLAUDE.md              # protocol — repo root so cold sessions auto-load
                         # it (BD34); points at docs/SPEC.md
  AGENTS.md              # thin router for AGENTS.md-reading tools (Codex,
                         # OpenCode) → CLAUDE.md + docs/ (BD35)
  docs/                  # SPEC.md, opencode-adapter.md, and the archived
                         # pre-migration prose record (pre-rename name)
```
Future packages (ui, sync, adapters) join packages/* post-v1; the
engine-only scope law still applies during the Fable window.

## Record layout (what the engine manages inside a user repo)
```
.sofar/
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
summary?, next_action?, closed_reason?, activity?} ],
files_touched[], current: {active_phase, next_action, blocked_on?},
cursor: <last event id> }
activity (Phase 7, BD44) = derived per-session aggregation of mechanical
events attributed by envelope.session (session "cli" excluded; unregistered
session ids stay unattached): { files[] deduped in first-touch order,
commands count, task_changes[] as "<id> → <status>" in log order } — lists
capped at 20 entries + "+N more" sentinel; present only when ≥1 such event
exists. closed_reason = the session_closed reason when that close set ended.

## Cursor primitive (sync-ready contract)
`export(sinceId?) → NDJSON stream of events` ; `import(stream)` appends
events not already present (dedupe by id — idempotent). Per-initiative
streams; ordering by ulid. This is the entire future sync interface.

## MCP tools (server name: sofar)
- sofar_get_state({initiative?}) → InitiativeState (resolves initiative
  from bindings.json + current branch when omitted)
- sofar_start_session({initiative?, tool, model?, session_id?}) →
  {session_id} — session_id (from the SessionStart context "Session:" line)
  adopts exactly that OPEN session; an ended id is a typed invalid_input
  error; an unknown id is registered via session_started; omitted → mint a
  fresh ulid. No open-session heuristic (adopt-by-id, Phase 7, BD43).
- sofar_end_session({session_id, summary, next_action}) → ok
- sofar_update_task({initiative?, task_id, status, note?}) → ok
- sofar_log_decision({initiative?, chose, over, because}) → ok
- sofar_update_plan({initiative?, plan}) → ok   # full-structure replace
- sofar_add_note({initiative?, text}) → ok
Every tool = validate payload → append event → regenerate projections →
return. No tool mutates state except via an event.

## Hooks (installed by `sofar init` as standalone scripts in .claude/hooks/)
- SessionStart shim → `sofar event session-start` then prints the status
  projection to stdout (context injection). The block opens with a
  `Session: <id> — when calling sofar_start_session, pass this as
  session_id.` line carrying the hook-registered session id (adopt-by-id,
  Phase 7, BD43). Includes a "Repo memory" section
  sourced from .sofar/repo.md when it exists and is not the untouched init
  stub, budget-clipped to ~1,500 chars (added Phase 6, BD40). HARD LIMIT:
  output ≤10,000 chars — projection generator must guarantee this.
- PostToolUse shim (matcher: Edit|Write|MultiEdit|Bash) → appends
  file_touched / command_run from stdin JSON (tool_name, tool_input).
- Stop shim → reads stdin JSON; if stop_hook_active is true → exit 0
  (loop guard). Else if no session_ended event exists for this session_id →
  exit 2 with stderr: "Write back to the sofar record before finishing: call
  sofar_end_session (or append session_ended via `sofar event append`)."
  Else exit 0.
- SessionEnd shim → appends mechanical session-close marker (fallback only;
  cannot feed back to the agent).
Shims contain no logic — they invoke the sofar CLI.

## CLI
- `sofar init` — create .sofar/, write repo.md stub, install hook shims
  + .claude/settings.json hooks block, emit .mcp.json registration, append
  protocol blocks to CLAUDE.md and AGENTS.md (idempotent; the AGENTS.md
  block is the CLI convention dialect for MCP-less tools — added Phase 5,
  BD31). Each installed protocol block
  MUST include: (a) all work state lives in sofar records — never in tool
  memory or scratch files; (b) work matching no existing initiative requires
  creating one (sofar new) before proceeding; (c) bindings resolve which
  record a session serves. [Field finding, Jul 4: singular-record protocol
  caused a second initiative's state to leak into Claude Code native memory
  + a scratch dir — jurisdiction must be total, not per-file.]
- `sofar uninit [--purge]` — exact inverse of init, surgical: remove the
  four hook shims, our settings.json hook entries (matched on the shim path),
  .mcp.json's sofar server, and the protocol blocks (markers + one seam
  blank line), preserving all user content; .sofar/ is kept with a notice
  unless --purge deletes it (--purge alone may also delete files the run
  emptied — the byte-clean round-trip). Idempotent (added Phase 8, BD45).
- `sofar new <slug> [--goal]` / `sofar switch <slug>` — create/select
  initiative; bind current branch in bindings.json.
- `sofar adopt <legacy-file> [slug] [--mark]` — guided migration for
  pre-sofar prose records: validates env (legacy file, .sofar/, target
  initiative — positional wins, else branch binding), prints a self-contained
  MIGRATION BRIEF (exact `sofar event append` replay templates with the
  slug + a fresh session id baked in, repo-knowledge move, protocol
  retirement checklist, verification line) for an agent to execute; --mark
  stamps an idempotent SUPERSEDED banner into the legacy file. NO freeform
  markdown parsing — the agent transcribes (added Phase 8, BD46).
- `sofar status [slug]` — fold and print: goal, progress %, phase tree
  with statuses, next action, blocked, last session.
- `sofar export [slug] [--since <id>]` / `sofar import <file|-> [slug]`
  — per-initiative NDJSON over the §Cursor primitive; slug resolves like
  status (explicit wins, else branch binding) (extended Phase 4, BD28)
- `sofar event <subcommand>` — append-side surface: session-start,
  post-tool, stop, session-end are internal subcommands for the hook shims;
  `event append --type <event_type> --payload <json-object> [--session <id>]
  [--source <source>] [--actor <actor>] [slug]` is the convention-dialect
  surface for MCP-less tools — validate payload, append ONE event,
  regenerate projections, print {ok, event_id} JSON; any failure exits 1
  with the typed-error JSON and appends nothing (added Phase 5, BD30; slug
  resolves like status).
- `sofar serve [--port 4173]` — chokidar watch on .sofar/ → GET /state
  (JSON InitiativeState per initiative), Server-Sent Events on change.
- `sofar mcp [--root <dir>]` — start the stdio MCP server (server name:
  sofar) exposing §MCP tools; --root overrides the repo root (default:
  cwd). Added in Phase 2 (BD13); `sofar init` registers it in .mcp.json.

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
- **Phase 4:** `sofar init` on a fresh repo yields a working end-to-end
  loop (start session → tool events → end session → status shows it);
  init is idempotent (second run changes nothing); serve pushes an SSE on
  append within 500ms.
- **Phase 5:** AGENTS.md dialect drives a manual OpenCode session through
  read→work→write-back; the Jul 7 Fable→Opus handoff is executed and scored
  on the Phase 0 scorecard as an arm-C run.
