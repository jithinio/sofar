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
      src/cli/ui/        #   terminal rendering kernel (caps/style/symbols/
                         #   frames/spinner/layout) — §CLI UI; human
                         #   surfaces ONLY, agent surfaces never import it
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
freshness, cursor: <last event id> }
activity (Phase 7, BD44) = derived per-session aggregation of mechanical
events attributed by envelope.session (session "cli" excluded; unregistered
session ids stay unattached): { files[] deduped in first-touch order,
commands count, task_changes[] as "<id> → <status>" in log order } — lists
capped at 20 entries + "+N more" sentinel; present only when ≥1 such event
exists. closed_reason = the session_closed reason when that close set ended.
freshness (staleness-detection 1.1) = fold-time drift derivation from
MECHANICAL signals only — content-semantic staleness inference is banned
(D3/D12): { events_since_writeback: {files, commands, tasks, notes,
decisions} counting payload-valid, unvoided file_touched / command_run /
task_status_changed / note_added / decision_logged events appended after
the last session_ended (ANY session/source incl. cli), notes: [{ts, text}]
— the CONTENT of the counted note_added events (notes-in-digest 1.2: the
counters say THAT the record drifted, the notes say WHAT), log order,
uncapped at fold, notes.length === counts.notes by construction; when
nothing ever wrote back the window is the whole log — every note is
un-absorbed, last_writeback_ts: ts of that session_ended, or null when
nothing ever wrote back }.
session_ended is the ONLY reset (session_closed resets nothing); zero new
event types — the derivation is read-side and retroactively covers every
existing record. Companion derivation staleActivePhases(state) (the D-P11
stale-phase check extracted from doctor — one detector, two surfaces) lists
phases whose tasks are all done but whose status was never set to done.
Repo-level derivation listInitiatives(rootDir) (initiative-list 1.2):
every directory under .sofar/initiatives/ summarized — slug, bound
branches (bindings.json inverted), tasks done/total, active phase, next
action, last envelope-valid event id — ordered by last-event ulid
DESCENDING (record recency), never-logged initiatives last by slug asc;
tolerant like the fold (unreadable log or corrupt bindings.json → warning
+ thinner entry, never fatal); zero new event types.

## Cursor primitive (sync-ready contract)
`export(sinceId?) → NDJSON stream of events` ; `import(stream)` appends
events not already present (dedupe by id — idempotent). Per-initiative
streams; ordering by ulid. This is the entire future sync interface.
Fold replay order is NORMATIVELY ulid id order, not file order (convergent
fold: same event set → identical state on every replica; D-sync-1, Jul 11).
Riders: (a) writers MUST mint monotonic ulids within a process; (b) fold is
total under cross-machine clock skew — causally-misordered events resolve
by id order via the normal skip-with-warning tolerance; accepted-in-v1,
vector/hybrid-clock upgrade reserved for a future envelope version.
[Engine currently folds in file order — change queued as task 13.1;
identical behavior for never-merged logs.]

## MCP tools (server name: sofar)
- sofar_get_state({initiative?, view?}) → progressive disclosure (token-opt):
  view "digest" (DEFAULT) returns the summary-dense orientation projection as
  text (goal, active/next task, next action, phase summary, last-session
  resume, recent decisions WITH rationale — the compaction-proof orient, ~1k
  tok, rationale kept first-class); view "full" returns the complete folded
  InitiativeState (re-injectable in full, architecture Open-Q#5). Resolves
  initiative from bindings.json + current branch when omitted; neither view
  appends. The digest shares renderStatus with the SessionStart block, so it
  carries the same staleness signals (staleness-detection 2.1/2.2/2.4): the
  budgeted `⚠ next action may be stale: N events since write-back
  (breakdown)` line when mechanical drift exists, stale-phase markers on
  phase lines, and the clipped-summary pointer — plus the budgeted
  notes-since-write-back section (notes-in-digest 2.1) directly under the
  staleness line: newest-last window of ≤5 notes, one date-prefixed line
  each clipped to 200 chars, overflow labeled "(last K of N)"; header is
  "Notes:" when nothing ever wrote back; absent when no notes selected.
  view "initiatives" (initiative-list 3.1) returns the budgeted portfolio
  listing over §State's listInitiatives — one clipped line per initiative
  (slug, bound branch(es) or "unbound", done/total tasks with %, active
  phase, next action), count-capped at 20 with an "+N more (run sofar
  list)" overflow line — and is the ONLY view that skips initiative
  resolution entirely (`initiative` ignored): it must work from an
  unbound branch, which is exactly when a session needs it.
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
unknown_initiative errors — from any tool or CLI command that resolves a
slug (explicit or branch-bound) — carry a count-capped (10) `available
initiatives:` suffix, or a `sofar new` hint when none exist
(initiative-list 2.2): the dead-end orients instead of blocking.

## Hooks (installed by `sofar init` as standalone scripts in .claude/hooks/)
- SessionStart shim → `sofar event session-start` then prints the status
  projection to stdout (context injection). The block opens with a
  `Session: <id> — when calling sofar_start_session, pass this as
  session_id.` line carrying the hook-registered session id (adopt-by-id,
  Phase 7, BD43). Includes a "Repo memory" section
  sourced from .sofar/repo.md when it exists and is not the untouched init
  stub, budget-clipped to ~1,500 chars (added Phase 6, BD40). Staleness
  surfacing (staleness-detection, mechanical signals only): when counted
  events postdate the last write-back the block renders ONE budgeted line
  `⚠ next action may be stale: N events since write-back (breakdown)`
  under the next action (absent on a fresh record); a stale phase renders
  as `[<status> — all tasks done; mark phase done?]` on its phase line; a
  last-session summary cut by its budget carries `(clipped — full text in
  sessions/<id>.md)` INSIDE the budget. Un-absorbed notes (notes-in-digest
  2.1) render as a budgeted section under the staleness line — see §MCP
  get_state digest for the exact rule; both surfaces share renderStatus.
  HARD LIMIT:
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
  As its FINAL output, init prints a scanner-defense hint when a tree-wide
  class scanner is detected (Tailwind v4: `tailwindcss>=4` in package.json) —
  the scanner would ingest committed `.sofar/` records; the hint points at
  `sofar doctor --fix` (added Phase 10, D-P10).
- `sofar doctor [--fix]` — audit a host repo across four axes: (1) wiring
  integrity (init's shims/settings/.mcp.json/protocol blocks intact); (2)
  record health — initiative logs fold without stub sessions or corrupt lines,
  no STALE PHASE (all tasks done but the phase still active/pending, missing a
  phase_status_changed — D-P11), no UNTRACKED WORK (a wrapped session with real
  file activity but zero task changes — work missing from the plan, or
  fragmented onto a sibling session because the hook session was not adopted);
  (3) concurrency — no file under concurrent edit by ≥2 OPEN sessions (a live
  clobber risk); (4) scanner hazards (Tailwind v4 entry stylesheet lacking a
  `@source not` exclusion for `.sofar`). Record-health and concurrency findings
  are WARN (surfaced, non-fatal); exit 1 only when a FAIL-level finding remains,
  0 on a clean repo. `--fix` performs the one deterministic, safe repair:
  inserting `@source not "<path-relative-to-stylesheet>/.sofar";` after the
  `@import "tailwindcss"` line in each unprotected entry (idempotent); it never
  touches wiring (re-run init) or record prose (added Phase 10, D-P10; deepened
  Phase 11, D-P11). The concurrent-edit signal also surfaces in the SessionStart
  context and `sofar status` (rendered only when open sessions overlap, D-P11).
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
  with statuses (stale phases marked, staleness-detection 2.2), next action,
  blocked, last session; plus an UNCAPPED `⚠ Staleness:` section (terminal
  surface, no 10k cap) when any mechanical signal fires: drift breakdown
  since the last write-back, stale phases with the phase_status_changed fix,
  and a pointer when the capped surfaces clip the last write-back summary
  (staleness-detection 2.3). Un-absorbed notes render UNCAPPED after the
  staleness section (notes-in-digest 2.2): every selected note, full
  timestamp, no count cap or length clip, whitespace collapsed to keep each
  entry one list line; absent when none.
- `sofar list` — every initiative under .sofar/initiatives/, one line each
  (slug, bound branch(es) or "unbound", done/total tasks with %, active
  phase, next action), most recently active first per §State's
  listInitiatives; UNCAPPED entry count (terminal surface, the
  sofar-status precedent), lines whitespace-collapsed so each initiative
  stays one line; derivation warnings to stderr without failing — an
  uninitialized repo prints the empty listing with a `sofar new` hint
  (initiative-list 2.1).
- `sofar next` — the portfolio next-actions surface: one line per
  initiative (slug, bound branch(es) or "unbound", the next action the
  last write-back recorded or "(no next action recorded)"), most recently
  active first per §State's listInitiatives; an initiative whose record
  moved since its last write-back (drift_events > 0, the staleness-
  detection freshness signal) carries a `⚠ may be stale (N events since
  write-back)` suffix — an initiative that never wrote back carries none;
  UNCAPPED entry count (terminal surface), lines whitespace-collapsed so
  each initiative stays one line; derivation warnings to stderr without
  failing — an uninitialized repo prints the empty listing with a
  `sofar new` hint (next-command 1.1).
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
- `sofar upgrade [version] [--check|--dry-run|--force]` — self-update the
  globally-installed CLI to `latest` (or a pinned version). Derives the real
  npm prefix from the running binary's own path (…/lib/node_modules/…) rather
  than `npm config get prefix`, so a custom-prefix install is updated in place
  instead of a naive `npm i -g` installing to the wrong root. --check reports
  installed-vs-latest and the resolved prefix; --dry-run prints the exact npm
  command; --force reinstalls at the target. Non-global installs (local dep,
  npx cache) print manual guidance and never run npm.

## CLI UI (terminal rendering — human surfaces only)
Rendering kernel: src/cli/ui/ — caps, style, symbols, text, frames,
spinner, layout. Zero new dependencies (cli-ui D1/D2, Jul 11): color
detection + formatter mechanics vendored from picocolors, the unicode gate
from is-unicode-supported, frame glyph sets from cli-spinners (all MIT); no
TUI framework, no truecolor themes, no background detection. cli/ui may be
imported ONLY by human-facing CLI command modules; src/projections/**,
src/mcp/**, and src/cli/event.ts NEVER import it — the agent-facing bytes
(guaranteed-plain table below) stay plain forever.

Capability model — detectCaps({env, argv, isTTY, platform}) is a PURE
function returning three INDEPENDENT booleans (tests pass inputs, never
fake a TTY):
- color, by precedence class:
  1. veto — NO_COLOR present (ANY value, incl. empty; no-color.org:
     "regardless of its value"), `--no-color`, or FORCE_COLOR=0
     (force-color.org) → off, beats everything below;
  2. force — FORCE_COLOR set to anything but 0, or `--color` → on, even
     when piped;
  3. ambient — (isTTY && TERM ≠ dumb) || CI present → on; else off.
- unicode — non-Windows: TERM ≠ linux (kernel console); Windows: modern
  hosts only (Windows Terminal, VS Code, Cmder — via its ConEmuTask value;
  plain ConEmu is NOT detected and degrades to ASCII — Terminus, JetBrains
  JediTerm, TERM=xterm-256color|alacritty). Off → cp437-safe ASCII glyph
  substitution (✓→√ · ✗→× · ⚠→!! · ℹ→i · ●→* · ○→o · [✓]→[x] · [•]→[*] ·
  └→`- · │→| · ⋮→: · …→... · ▸→>), same layout and wording.
- animate — isTTY && CI absent && TERM ≠ dumb. Independent of color BOTH
  ways: a NO_COLOR TTY still animates (an uncolored spinner is fine); a
  FORCE_COLOR pipe never does (a colored CI log full of frames is not).

Stream scoping: stdoutCaps()/stderrCaps() derive caps from THAT stream's
own isTTY, and STRIP ambient CI when the stream is piped — piped command
output is consumed byte-for-byte by agents and tests, so only an explicit
FORCE_COLOR/--color restyles it (the CI clause stays in detectCaps for
callers that KNOW their bytes feed a CI log renderer). stdout is the
report channel; stderr is the messaging/progress channel (clig.dev).
Text landing on stderr styles under stderrCaps-derived caps: a stdout TTY
never pushes escapes into a redirected stderr, and vice versa.

Flag/env contract:

| Control | Effect |
|---|---|
| NO_COLOR (any value, incl. empty) | color off everywhere; beats TTY, FORCE_COLOR, `--color` |
| `--no-color` | same veto, per-invocation |
| FORCE_COLOR=0 | same veto |
| FORCE_COLOR=anything else | color on, even piped/CI; loses only to the vetoes; never enables animate or unicode |
| `--color` | same force, per-invocation |
| CI present | ambient color for TTY-less CI log renderers (detectCaps only — stream-scoped caps strip it when the stream is piped); animate always off |
| TERM=dumb | no ambient TTY color, no animate (CI's ambient clause or an explicit force still colors) |
| TERM=linux | unicode off → ASCII fallback glyphs |

`--color`/`--no-color` are registered as program-level commander options
(accepted before or after the subcommand); the kernel reads them from
argv directly, so registration is acceptance-only.

Color law (semantic ANSI-16, cli-ui D1): green=success/done ·
red=error/blocked · yellow=warn/active · cyan=info/identifiers ·
magenta=sofar brand accent · dim=secondary/metadata (muted) ·
bold=headers/emphasis. ANSI-16 SGR ONLY — never hex/256-color/truecolor
for text, never black/white foregrounds, no background detection: the
user's terminal theme supplies the palette. Mechanics: a nested style
re-opens its outer style after the inner close (the picocolors fix);
padding/alignment measures VISIBLE width (escapes stripped); truncation
happens on plain text BEFORE styling; record prose is sanitized before
styled rendering — the FULL ANSI grammar (SGR in any palette, 256-color/
truecolor included, OSC, cursor controls) is stripped and leftover control
bytes (a lone ESC, a stray BEL) dropped — so a hostile or accidental
escape sequence inside a log degrades to plain characters on the styled
layouts and the color law holds for arbitrary record content; the plain
renderers are agent contract bytes and pass record content through
untouched. Corrupt content is never fatal (repo error law). Style
disabled → every formatter is the identity function.

Degradation ladder — each capability degrades independently; the floor is
the pre-cli-ui renderer:
- color off → the styled layouts (inherently color-coded, D1) are skipped
  entirely: status/list/doctor print their pre-styling plain renders
  BYTE-IDENTICALLY (renderFullStatus, renderFullInitiativeList, the
  marker-column doctor report); confirmations keep identical wording,
  minus marks/rails.
- unicode off → glyph substitution only (table above); layout, wording,
  and color unchanged.
- animate off → shipped spinners are skipped entirely (silent stderr).
  The spinner kernel itself degrades animate → in-place redraw (\r +
  erase-line at the frame set's interval, cursor hidden while running and
  restored on stop and on SIGINT — where the handler re-raises the signal
  after restoring, so the default terminate-on-^C disposition survives the
  spinner (installing any SIGINT listener would otherwise suppress it) —
  unref'd timer) and non-animate → one static
  `⋯ text` line at start plus one per text change; but every shipped call
  site (doctor tree scan, upgrade install) constructs the spinner ONLY
  when stderr animates, so a piped/CI stderr carries zero spinner bytes —
  not even the static line.
Spinners and progress write to stderr ONLY, never stdout. Frame sets are
keyed by use case: scan=braille sweep, write=filling bar, network=packet
in flight, brand=eased ✳ pulse; ASCII fallbacks line spinner (all) /
bouncing bar (write).

Surfaces. Styled-capable (render under stream-scoped caps; with color off
the stdout bytes equal the plain renderer):

| Command | stdout (report) | stderr (messaging) |
|---|---|---|
| status | full-zoom layout grammar / renderFullStatus | fold warnings + resolution failures — always plain |
| list | portfolio-zoom blocks / renderFullInitiativeList | derivation warnings — always plain |
| next | styled action lines (bold slug, dim branch, warn stale suffix, pointer on current branch) / renderNextActions | derivation warnings — always plain |
| doctor | ✓/⚠/✗ findings report / marker-column report | scan spinner (animate-gated) |
| new, switch | ✓ confirmation + dim └ details | ✗ failure, styled under stderrCaps |
| init | dim └ detail rails + ✓ result; scanner hint always plain (copy-paste material) | ✗ failure, styled under stderrCaps |
| uninit | dim └ details + notices + ✓ result | warnings + ✗ failures, styled under stderrCaps |
| adopt | MIGRATION BRIEF always plain (agent-executed); --mark result line ✓-styled | typed-error JSON (BD17) — always plain |
| upgrade | --check/--dry-run/result reports — plain text | network spinner (animate-gated) + npm's inherited output |
| serve | (HTTP JSON only — no terminal report) | one-line banner, accent+dim; identical wording plain |

Note: status, list, and next NEVER style stderr — their warnings AND their
failure text (e.g. a resolution error) print plain under every caps
combination. The ✗-styled failure register in the table is deliberately
scoped to the confirmation commands (new, switch, init, uninit); do not
"complete" it on status/list — the plain bytes there are locked by the
acceptance tests.

Guaranteed-plain (agent-facing — zero ESC bytes under EVERY env/flag/TTY
combination, FORCE_COLOR and `--color` included):
- sofar_get_state (all views) and every MCP tool response — mcp stdio
  (src/mcp/**)
- SessionStart hook stdout (renderStatus context block), Stop hook stderr
  block message, PostToolUse/SessionEnd — src/cli/event.ts
- `sofar event append` {ok, event_id} / typed-error JSON output
- `sofar export` NDJSON stdout and `sofar import` report (§Cursor
  primitive)
- generated projections on disk (plan.md, decisions.md, sessions/*.md) —
  src/projections/**
- `sofar serve` HTTP response bodies

Handler purity: styled command handlers keep the pure {exitCode, stdout,
stderr} shape (BD22) — caps and columns are OPTIONAL trailing parameters
defaulting to detection (stdoutCaps(), stderrCaps(),
columnsOf(process.stdout)); process/env access lives only in those
defaults, so tests inject caps and never fake a TTY. Styling is
presentation only: which initiatives/phases/tasks render and their order
stay the underlying derivation's, and exit codes are styling-independent.

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
- **Phase 10:** the init scanner hint fires on `tailwindcss>=4` and stays
  silent for v3 or no-tailwind; `sofar doctor` flags a Tailwind v4 entry
  lacking the `.sofar` exclusion (exit 1) and passes a clean, wired repo
  (exit 0); `sofar doctor --fix` inserts the correct stylesheet-relative
  `@source not` path after the import and is idempotent (a second run changes
  no bytes).
- **Phase 11:** `sofar doctor` flags a phase whose tasks are all done but is
  still active (stale-phase) and does not flag one marked done; flags a wrapped
  session with ≥3 files touched and zero task changes (untracked work) and not
  one that changed a task; flags a file touched by ≥2 open sessions (concurrent
  edit) and clears once one writes back; all three are WARN (exit stays 0). The
  concurrent-edit signal renders in both `sofar status` and the SessionStart
  context when open sessions overlap, and is absent otherwise.
- **Staleness (staleness-detection):** a log carrying counted mechanical
  events (file_touched / command_run / task_status_changed / note_added /
  decision_logged, any source incl. cli) after its last session_ended
  renders the `⚠ next action may be stale` line in renderStatus
  (SessionStart block + get_state digest) and the `⚠ Staleness:` section in
  `sofar status`; a log whose last event is the write-back renders neither,
  and a log that never wrote back renders no staleness line. Freshness
  counters reset on a new session_ended; replay stays deterministic (same
  log → deep-equal state incl. freshness). The SessionStart block holds ≤10k
  chars with every section at worst case, staleness line included. `sofar
  doctor` stale-phase WARN text is byte-identical after the detector's
  extraction to core (Phase 11 criteria unchanged). The clipped-summary
  pointer renders only when the last write-back summary actually exceeds
  its budget, and lands inside that budget.
- **Notes surfacing (notes-in-digest):** a log with note_added events after
  its last session_ended renders their content on all three resume surfaces
  — renderStatus (SessionStart block + get_state digest, budgeted: ≤5
  newest-last lines, 200 chars each) and `sofar status` (uncapped) — and a
  log whose write-back postdates every note renders no notes section on any
  surface; a never-written-back log renders all its notes (header "Notes:").
  Overflow past the digest cap is labeled "(last K of N)"; a voided
  (corrected) note never renders. freshness.notes carries {ts, text} in log
  order with notes.length === counts.notes; replay stays deterministic. The
  SessionStart block holds ≤10k chars with every section at worst case,
  notes section included.
- **Listing (initiative-list):** on a repo with several initiatives —
  including one with an empty/absent log and a corrupt bindings.json —
  `sofar list` renders one line per initiative, most recently active
  first, never-logged entries last by slug, warnings on stderr, exit 0;
  get_state view:"initiatives" succeeds from an UNBOUND branch (no
  unknown_initiative), count-caps at 20 lines with the overflow pointer,
  and each line holds its clip budget; unknown_initiative errors carry
  the available-initiatives suffix (≤10 named) or the `sofar new` hint on
  an initiative-less repo; the derivation is deterministic (same records
  → deep-equal listing, same warnings).
- **CLI UI (cli-ui):** with stdout and stderr both piped and no explicit
  opt-in, every command emits ZERO ESC (\x1b) bytes — ambient CI included;
  FORCE_COLOR=1 on the same piped invocation carries ANSI-16 SGR on the
  styled-capable surfaces ONLY, while every guaranteed-plain surface
  (get_state digest, hook stdout, `sofar event` JSON, export/import
  NDJSON, mcp stdio, on-disk projections) stays byte-identical under EVERY
  env/flag/TTY combination; NO_COLOR (any value, incl. empty) renders
  plain even on a TTY and beats FORCE_COLOR. With color off, status/list/
  doctor stdout is byte-identical to the pre-cli-ui plain renderers.
  Spinners never write to stdout: frames appear only on an animating
  stderr TTY, and a piped/CI stderr carries no spinner bytes at all (not
  even the static line). src/projections/**, src/mcp/**, and
  src/cli/event.ts import nothing from cli/ui (locked statically by
  test; the lock resolves bundler-style `.js`/`.mjs`/`.cjs`-suffixed
  relative specifiers, so importing '../cli/ui/index.js' from a protected
  file fails it). Exit codes are styling-independent: styled and plain
  runs over the same repo state exit identically (doctor's fail→1 law
  included). Hostile record content: with record prose (goal, phase/task
  names, next action, blocked_on, notes, write-back summary, file paths)
  carrying raw ANSI bytes — 256-color/truecolor SGR, reset-all,
  background/reverse codes, OSC sequences, lone ESC — styled status/list
  output still satisfies the semantic-ANSI-16 law with the escapes
  degraded to plain characters, while the plain renderers keep passing
  record bytes through untouched (agent contract). An animated spinner's
  SIGINT handler restores the cursor and re-raises the signal, so ^C
  still terminates the process.
- **Next actions (next-command):** on a repo with several initiatives,
  `sofar next` renders one line per initiative — slug, branch(es) or
  "unbound", next action or "(no next action recorded)" — in the same
  recency order as `sofar list`, warnings on stderr, exit 0; an
  initiative with counted mechanical events after its last session_ended
  renders the `⚠ may be stale (N events since write-back)` suffix, one
  whose last event is the write-back renders no suffix, and one that
  never wrote back renders no suffix; drift_events is additive on
  InitiativeListEntry (same records → deep-equal listing, listing
  renders byte-identical); an uninitialized repo prints the empty
  listing with the `sofar new` hint.
