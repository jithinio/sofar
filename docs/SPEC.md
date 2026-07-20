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
      src/client/        # v2 sync client: config/http/device/repos/push/
                         # pull/doorbell — §Sync client
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

## Architectural invariants

- **Zero model API calls.** sofar never calls a model: no API keys, no
  inference costs, no user content fed to any model. Everything the engine
  produces is a read-side derivation computed locally; record write-backs
  are the agent's own tool-call args, which keeps their output tokens
  minimal by construction. Any change that would add a model call to sofar
  (e.g. cheap-model or Batch-API bookkeeping) is rejected until a Decision
  explicitly revisits this invariant (felt-cost D3, Jul 2026). The ONLY
  egress in the product is the v2 sync client (§Sync client, sync-client
  D4, Jul 2026): record events pushed to the user's OWN authenticated
  sofar-cloud repo, opt-in via `sofar login` + `sofar link`, revocable
  server-side — nothing else ever leaves the machine.
- **Injection byte-stability.** For an unchanged record, the SessionStart
  status block renders byte-identically — no timestamps, counters, or other
  volatile bytes are introduced at render time (all dates in the block come
  from event data). Pinned by regression test (felt-cost 1.2). Any
  cache-cost play built on this must cite token-optimization's rejected
  "leading with prompt caching" as an informed re-test (felt-cost D2).

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
 "actor":"agent|human","user":"<git user.email — OPTIONAL>",
 "type":"<event_type>","payload":{}}
```
Rules: ulid ids (sortable); appends are atomic single-line writes with
O_APPEND; a reader must tolerate a torn final line (skip + warn); events are
immutable — corrections are new events of type `correction` referencing the
target id.
Canonical serialization (0.9.1): serializeEvent is the ONLY envelope
serializer, and its byte form is a pure function of the envelope value —
envelope fields in the fixed schema order above (`user` omitted when
absent; unknown additive fields preserved after `payload`, sorted);
payload and every nested object with keys sorted lexicographically by
code point, arrays in order; no whitespace; `ts` is carried verbatim,
never reformatted. Writer and puller therefore emit identical bytes for
the same event even when a store reorders keys (Postgres jsonb does) —
events.jsonl is git-committed, so byte divergence on identical events
would mean spurious diffs/merge conflicts. Canonicalization is
forward-only: existing log lines are never rewritten (append-only
stands); a historical line whose payload keys were inserted unsorted
keeps its bytes in place and only fresh serializations (push wire,
export, pull appends) carry the sorted form. Pull writes the canonical
form of the PARSED event, never raw wire bytes — a non-canonical server
can never poison a local log.
`user` (team-readiness T1, Jul 12) is OPTIONAL author identity: stamped when
the event is minted, from `git config user.email`, and omitted whenever that
is unavailable — the identity lookup must NEVER fail an append. Strictly
additive: the envelope stays v1, events without `user` remain valid forever,
and every reader (fold included) tolerates absence; when present it must be
a non-empty string (a malformed value fails envelope validation like any
other corruption — skip + warn, never fatal). `sofar import` never restamps:
imported events keep their original `user` (or its absence) — authorship is
minting-machine truth.

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
Companion derivation overlappingWritebacks(state) (task 12.4, BD58 family):
current.next_action is last-writer-wins (BD9), so when concurrent sessions
each write back, the losers' next actions vanish from the scalar — this
lists ended, next_action-bearing sessions whose [started, ended] interval
overlaps the winner's (winner = max ended, tie → later session order),
excluding duplicates of the winner's text; newest-ended first. Rendered in
renderStatus (SessionStart block + get_state digest, ≤3 lines, 260-char
clip) and `sofar status` (uncapped), directly under the next action.
FoldResult additionally carries orphan_task_events (task 12.2, BD58):
task_status_changed events that were skipped at replay AND whose task id
is absent from the FINAL plan — replay-time skips later legitimized by a
task_added/plan_updated (clock-skew ordering, D-sync-1 rider b) are NOT
orphans. Additive; InitiativeState itself is unchanged.
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
Implemented task 13.1: foldLines sorts envelope-valid events by id (stable
— a duplicated id keeps file order) before pass-2 replay; pass-1 decode
warnings keep file order (they describe lines, not events); cursor is
therefore the MAX event id, identical on every replica.

## Sync client (v2 — api.sofar.sh, the D14 seam; sync-client, Jul 2026)
The client half of sofar-cloud sync. The server (private repo) is
authoritative for the wire; the client implements it exactly and stays
useful with the API completely gone — local work is NEVER blocked by sync.

Base URL resolution: `--api` flag > `SOFAR_API_URL` env > `.sofar/
remote.json` api_url > `https://api.sofar.sh`. Errors on /v1 are
`{"error":{"code":"snake_case","message":"…"}}`; the device endpoints
speak OAuth flat-string errors (`{"error":"code"}`) — the client
normalizes both. Cross-org/unknown resources return 404, never 403;
client copy never pretends to distinguish "doesn't exist" from "not a
member".

Storage triad (sync-client D2 — three homes, three lifetimes):
- `.sofar/remote.json` — COMMITTABLE `{version, api_url, org, name,
  repo_id}` written by `sofar link`; repo_id is not a secret, teammates
  share the binding.
- `~/.config/sofar/credentials.json` (XDG_CONFIG_HOME-aware) — sfr_
  tokens keyed by normalized api_url, file mode 0600, dir 0700.
  Credentials never touch the repo and are NEVER printed after mint.
- `~/.local/state/sofar/sync/<sha256(clone-path)>.json`
  (XDG_STATE_HOME-aware) — per-CLONE cursors `{streams: {<slug>:
  {pushed, pulled}}}`, invalidated when api_url/repo_id change. Never
  committed: cursors mutate per sync; a lost cursor file is safe because
  push/pull are idempotent by event id.

Commands (styled-capable confirmation surfaces; wording identical plain):
- `sofar login [--api <url>] [--scopes sync|read]` — RFC-8628 device
  flow (client_id `sofar-cli`): POST /api/auth/device/code → print
  user_code + verification_uri_complete, attempt a browser open → poll
  /api/auth/device/token every `interval`s (`authorization_pending`
  continues, `slow_down` adds 5s, `access_denied`/`expired_token` abort
  with clear copy, the `expires_in` deadline aborts as expired) → the
  short-lived access_token immediately mints the real credential at
  POST /v1/tokens `{name: <hostname>, scopes}` → store, discard the
  access_token. `--scopes read` mints a read-only token.
- `sofar link --org <slug> [--name <repo>]` — POST /v1/repos (idempotent
  on org+name, 201/200 → {repo_id}), writes `.sofar/remote.json`.
- `sofar push [slug|--all] [--full]` — per initiative stream, wire lines
  are the engine's canonical envelope JSONL (exactly what `sofar export`
  emits — never re-serialized), ulid order, FROM EVENT ZERO on first
  push (the server refolds the whole stream; a stream missing genesis
  folds to an empty slug/goal). Batches ≤1000 lines AND ≤5MB (server
  413s; a stricter 413 halves the batch), uncompressed. Response
  `{accepted, duplicates, invalid[], head}`: partial acceptance is
  normal; `invalid` lines are a client bug surfaced loudly, never fatal,
  and never wedge the queue. Idempotent by event id: 429 (Retry-After
  honored)/5xx/network re-send the SAME batch with capped exponential
  backoff; the ack cursor advances only on 2xx and persists per batch.
  The offline queue IS the log after the ack cursor — an unreachable API
  fails the command politely, local work is untouched, the next push
  drains with zero loss and no duplicate state effects.
- `sofar pull [slug|--all] [--full] [--watch]` — GET …/events?since=
  <cursor>&limit=<n> pages in ulid order; every response carries
  X-Sofar-Cursor; empty body = caught up. Pages import with `sofar
  import` semantics (dedupe by id — pulling your own pushed events back
  is safe by construction), projections regenerate when anything landed,
  and the inbound cursor persists AFTER each imported page (crash
  between the two re-pulls a page; the reverse order could lose one).
  Inbound cursor is independent of the push ack cursor. `--full` drops
  the stream cursor (re-pull/re-push from genesis — recovery, cheap
  under dedupe).
- `--watch` — doorbell: GET /v1/doorbell?streams=<repo_id>/<slug>,…
  (SSE, authed). `data:` events are `{"stream","head"}`; `: heartbeat`
  comments ~25s; NOTIFICATION ONLY — every ring and every (re)connect
  after a drop triggers a since-cursor pull, so a missed doorbell can
  never lose data. Reconnect uses capped backoff + an idle watchdog;
  401/404 stop the loop (they need a human, not a retry). Every failed
  or dropped cycle ALSO fires the catch-up pull (onGap), so against an
  SSE-hostile path (idle-killed connections, buffering proxies, a down
  doorbell) watch mode degrades to capped-backoff polling instead of
  going deaf — data always flows through pull.

Library subpath "@alignlabs/sofar/client" (sync-client D1): the whole
client core — config/credential/cursor stores, device flow, createRepo,
pushStream/pullStream/splitBatches, runDoorbell — importable by the
Tauri shell and iOS app. Same laws as /schema and /engine: side-effect-
free import (env/fs resolved at call time), self-contained d.ts, zero
runtime deps (native fetch; the SSE reader is hand-rolled), bin and
manifest law unchanged.

## Library surface (library-surface, L1/L2 — added for sofar-cloud + D11)
@alignlabs/sofar additionally publishes typed ESM subpath exports so other
services consume the engine programmatically (fold parity: cloud state must
come from the engine's OWN fold, never a reimplementation):
- "@alignlabs/sofar/schema" — the v1 envelope type + validateEnvelope (the
  tolerant guard: validates, never throws or repairs — skip-and-warn stays
  the caller's decision) + makeEvent, and every event payload type/validator
  from @sofar/schema (events module).
- "@alignlabs/sofar/engine" — foldLines/foldLog (deterministic, total,
  ulid-normative — EXACTLY the CLI's fold), InitiativeState + component
  types + the cross-session derivations, the cursor primitive (readEvents /
  exportEvents / exportNDJSON / importNDJSON), and serializeEvent.
- "@alignlabs/sofar/client" — the v2 sync client core (§Sync client;
  sync-client D1, Jul 2026).
Laws: importing a subpath executes no CLI code and has no side effects; the
bin and the zero-runtime-deps manifest are unchanged; the d.ts tree under
dist/types is SELF-CONTAINED — the private @sofar/schema name never appears
in published declarations (build-time specifier rewrite, L2); consumers use
bundler-style module resolution. The @sofar/schema workspace package itself
stays private and unpublished (D13: one stewarded npm name; the bare name
also collides with a sofar-cloud-internal package).

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
Transports (speed T3): stdio (`sofar mcp`) is the DEFAULT and the only
transport `sofar init` registers — zero-config users lose nothing. The
SAME frozen 7-tool surface is additionally served over streamable HTTP at
`/mcp` on the `sofar serve` daemon (127.0.0.1 only), opt-in via a
documented .mcp.json entry `{"type": "http", "url":
"http://127.0.0.1:4173/mcp"}` — sessions connect to the running daemon
instead of spawning a per-session process. One MCP session = one fresh
server handle with its OWN ToolContext and active-session pin (BD58: the
pin is never shared between concurrent agent sessions on the daemon).
Transport only — tool definitions, results, and typed errors are
parity-locked stdio vs HTTP by test. Daemon absent → the HTTP connection
is refused immediately (never a hang); the documented fallback is to
start `sofar serve` or keep the stdio registration.
Write tools (update_task, log_decision, add_note, update_plan) with
`initiative` omitted resolve to the ACTIVE session's pinned initiative when
one exists (task 12.1, BD58) — the pin is set by start_session, so a
concurrent branch switch on the shared checkout cannot misroute an
already-started session's writes (the Phase 11 incident's root cause);
branch → bindings resolution is the fallback when no session is active,
and an explicit `initiative` always wins. end_session already resolves via
the active session (BD15). start_session and get_state keep branch
resolution: start_session is what establishes the pin, and get_state is a
read (explicit `initiative` scopes cross-initiative reads).
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
  Cold-resume advisory (felt-cost 2.1/2.2): on source=resume ONLY, when the
  record's last event predates the longest cache TTL (1h — heuristic, the
  TTL is server-controlled) AND the transcript file is ≥80KB (~20k tokens
  at bytes/4), ONE advisory line precedes the block naming the estimated
  re-warm cost and the fresh-start alternative. Best-effort: any failure
  (missing transcript, empty log, unparseable ts) renders no advisory,
  never an error. The advisory composes AROUND the status block — never
  inside renderStatus (byte-stability, §Architectural invariants) — and the
  composed output is re-capped to the same hard limit.
  HARD LIMIT:
  output ≤10,000 chars — projection generator must guarantee this.
- UserPromptSubmit shim (felt-cost 4.1/4.2, D5) → the batch-complete nudge:
  when the prompt's session_id is registered AND initiative drift since the
  last write-back is ≥5 mechanical events, stdout (exit 0 =
  additionalContext for this hook; lands after the cached prefix, so it is
  cache-safe) carries ONE line nudging an in-flow sofar_end_session — a
  write-back while context is warm makes the Stop gate a fallback instead
  of a forced extra turn. Stateless: re-fires on every prompt until a
  write-back resets drift (staleness-line precedent). Repeat session_ended
  events for one session are LEGAL and last-wins in the fold (ended/
  summary/next_action overwritten, freshness reset, Stop passes once any
  exists). Best-effort (BD22): every failure path is silence, never a
  blocked prompt.
- PostToolUse shim (matcher: Edit|Write|MultiEdit|Bash) → appends
  file_touched / command_run from stdin JSON (tool_name, tool_input).
- Stop shim → reads stdin JSON; if stop_hook_active is true → exit 0
  (loop guard). Else if no session_ended event exists for this session_id
  AND gate-relevant drift is nonzero → exit 2 with stderr: "Write back to
  the sofar record before finishing: call sofar_end_session (or append
  session_ended via `sofar event append`)." Else exit 0.
  Gate-relevant drift (drift-gated Stop, speed T1): nonzero when EITHER
  the staleness/nudge counter total — freshness.events_since_writeback
  (file_touched + command_run + task_status_changed + note_added +
  decision_logged), initiative-scoped, any session/source — is nonzero,
  OR the stopping session itself carries derived mechanical activity
  (BD44 session.activity): its own un-written-back work keeps concurrent
  gates independent — another session's write-back resetting the shared
  counter never exempts this one (the Phase 7 independent-gates law).
  Read-side, zero new event types. Mutation-class only: pure reads emit
  no events and never gate; session lifecycle and plan-structure events
  are uncounted (matching the staleness line — speed T1 decision). Zero
  on both → exit 0 silently even without a write-back (nothing moved,
  nothing to write back). ANY error in the drift computation enforces
  the block (fail closed — never a silent skip); every other resolution
  failure keeps exiting 0 (BD22). The gate only ever converts an exit-2
  into an exit-0 — no today-exit-0 path becomes blocking.
- SessionEnd shim → appends mechanical session-close marker (fallback only;
  cannot feed back to the agent).
Shims contain no logic — they invoke the sofar CLI.

## CLI
- `sofar init` — create .sofar/, write repo.md stub, install hook shims
  + .claude/settings.json hooks block, emit .mcp.json registration, append
  protocol blocks to CLAUDE.md and AGENTS.md (idempotent; the AGENTS.md
  block is the CLI convention dialect for MCP-less tools — added Phase 5,
  BD31). Writes the union-merge rule for committed event logs to
  .gitattributes — the exact line `.sofar/**/events.jsonl merge=union`
  (team-readiness T2): file created when missing, otherwise MERGED (rule
  appended, user content byte-preserved — never clobbered); idempotent,
  and any existing line already targeting `.sofar/**/events.jsonl` wins
  over ours (the customized-entry precedent). Union merge is safe for the
  record and ONLY for it: the log is append-only and the fold replays in
  ulid id order (D-sync-1), so a merge that keeps both sides' lines in
  arbitrary order folds to the same state on every clone. Each installed protocol block
  MUST include: (a) all work state lives in sofar records — never in tool
  memory or scratch files; (b) work matching no existing initiative requires
  creating one (sofar new) before proceeding; (c) bindings resolve which
  record a session serves. [Field finding, Jul 4: singular-record protocol
  caused a second initiative's state to leak into Claude Code native memory
  + a scratch dir — jurisdiction must be total, not per-file.]
  With `--statusline`, init also merges the rent-meter wiring
  `"statusLine": { "type": "command", "command": "sofar statusline" }` into
  .claude/settings.json — ONLY when the key is absent: an existing
  statusLine, whatever its value, is the user's and wins (felt-cost D4's
  clobber concern, honored under explicit opt-in — D4 informed re-test,
  init-statusline D1). Without the flag, when the project settings carry
  no statusLine, init prints a plain opt-in hint (points at
  `sofar init --statusline`, notes a project statusLine shadows a personal
  ~/.claude/settings.json one).
  As its FINAL output, init prints a scanner-defense hint when a tree-wide
  class scanner is detected (Tailwind v4: `tailwindcss>=4` in package.json) —
  the scanner would ingest committed `.sofar/` records; the hint points at
  `sofar doctor --fix` (added Phase 10, D-P10). The statusline hint, when
  both fire, prints before it — the scanner hint keeps the final slot.
- `sofar doctor [--fix]` — audit a host repo across four axes: (1) wiring
  integrity (init's shims/settings/.mcp.json/protocol blocks intact); (2)
  record health — initiative logs fold without stub sessions or corrupt lines,
  no STALE PHASE (all tasks done but the phase still active/pending, missing a
  phase_status_changed — D-P11), no UNTRACKED WORK (a wrapped session with real
  file activity but zero task changes — work missing from the plan, or
  fragmented onto a sibling session because the hook session was not adopted),
  no ORPHAN TASK EVENTS (task_status_changed whose id the plan never absorbed
  — the misroute symptom of a branch-switched write, task 12.2, BD58; one WARN
  per distinct orphan id, skew-ordered events later legitimized by task_added/
  plan_updated excluded);
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
  five hook shims, our settings.json hook entries (matched on the shim path),
  the settings.json statusLine entry ONLY when it is exactly the one
  `--statusline` installs (a customized statusLine is user config — kept;
  init-statusline D1), .mcp.json's sofar server, our exact .gitattributes
  union-merge line (a customized events.jsonl rule is user content — kept;
  team-readiness T2), and the protocol blocks (markers + one seam
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
- `sofar login` / `sofar link` / `sofar push` / `sofar pull [--watch]`
  — the v2 sync client against api.sofar.sh; full contract in §Sync
  client (sync-client, Jul 2026).
- `sofar event <subcommand>` — append-side surface: session-start,
  post-tool, stop, session-end are internal subcommands for the hook shims;
  `event append --type <event_type> --payload <json-object> [--session <id>]
  [--source <source>] [--actor <actor>] [slug]` is the convention-dialect
  surface for MCP-less tools — validate payload, append ONE event,
  regenerate projections, print {ok, event_id} JSON; any failure exits 1
  with the typed-error JSON and appends nothing (added Phase 5, BD30; slug
  resolves like status).
- `sofar statusline` (felt-cost 3.1/3.2, D4; identity segments D6; styling
  D7/D8) — the rent-meter, wired as Claude Code's statusLine command. Reads
  statusline JSON from stdin, prints ONE line: `<model> · ▸ <dir> ⎇
  <branch> · <pie> <slug> <done>/<total> · $<total_cost_usd> ·
  cache <warm%>[⚠|✓] · <pie> <used%>`. Icons are house-vocabulary text
  GLYPHS, never emoji (D8): ▸ dir, ⎇ branch, kernel progress pie (○◔◑◕●)
  as BOTH gauges — task progress on the record segment (D9, next.ts
  coloring: success done / warn in-progress / dim untouched) and context
  fill. The cache segment keeps its TEXT label in every mode (D10) — the
  word carries the meaning; only the ✓/⚠ band marks accompany it. The leading model (model.display_name) and dir/branch
  segments restore what Claude Code's default status line shows — a custom
  statusLine REPLACES the default, and the rent-meter must not cost the
  user the line they had (D6). Branch comes from .git/HEAD via bounded
  upward walk from workspace.current_dir (worktree `gitdir:` file aware) —
  one file read, no subprocess; detached HEAD drops the branch. STYLED BY
  DEFAULT (D7): the consumer renders ANSI even though stdout is
  piped, so the command forces styled caps (bold model, success-green
  branch, accent slug, band-colored cache — success/error by band, dim
  unjudged — and ctx dim/<70, warn/≥70, error/≥90, dim separators); TTY
  detection is deliberately bypassed. `--no-color` or NO_COLOR falls back
  to the plain line, byte-identical to the 0.8.0 format (`dir:branch`,
  `cache`/`ctx` labels, no ANSI, no glyph icons); runStatusline's library
  default is the plain line. Warm share = cache_read /
  (cache_read + cache_creation + input) from the first usage object found
  (top-level current_usage, context_window.current_usage, or
  cost.current_usage). Health judged only after ≥10k tokens: <30% → ⚠
  (prefix non-determinism), ≥50% → ✓ (healthy stable-prefix band, 50–80%
  per the Jul-12 research). Every segment independent and omitted when its
  inputs are missing; exit 0 always; READ-SIDE ONLY (never appends);
  no model call ever (§Architectural invariants). Root resolution: --root
  or cwd, falling back to the JSON's workspace.current_dir then cwd. NOT
  auto-installed by `sofar init` by default (never clobber an existing
  statusLine config — felt-cost D4); `sofar init --statusline` opts in,
  merging the entry only when the project settings has none (an existing
  statusLine always wins), plain init prints an opt-in hint while unwired,
  and `sofar uninit` removes the entry only when it is exactly ours
  (D4 informed re-test, init-statusline D1) — README documents the flag
  and the one-line settings.json entry.
- `sofar serve [--port 4173]` — chokidar watch on .sofar/ → GET /state
  (JSON InitiativeState per initiative), Server-Sent Events on change;
  plus the opt-in MCP endpoint at /mcp (streamable HTTP, POST/GET/DELETE,
  one isolated server handle per MCP session — §MCP tools transports,
  speed T3). Still 127.0.0.1 only, JSON only.
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

Progress pies (4.2): initiative headers on the styled status/list/next
surfaces carry a pie glyph quantized from tasks done/total — ○ ◔ ◑ ◕ ●
with honest endpoints (● only at 100%, ○ only at 0) — colored on the
checkbox ramp (green complete, yellow in progress, dim untouched). The
ASCII set renders no pie: the numeric fraction already carries the value.
Zero-total initiatives render no pie and no fraction.

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
| status --watch | live full-zoom render: redraw on record changes (chokidar) + active-task marker pulses warn↔dim @600ms; TTY-gated by animate, piped/CI falls back to the one-shot result; ^C restores the cursor and re-raises | (same as status) |
| list | portfolio-zoom blocks / renderFullInitiativeList | derivation warnings — always plain |
| next | two-part entry blocks (header: pointer + pie + bold slug + dim branch tag + dim task fraction; body: hanging-indent word-wrapped action; stale warning on its own line; blank line between entries) / renderNextActions | derivation warnings — always plain |
| doctor | ✓/⚠/✗ findings report / marker-column report | scan spinner (animate-gated) |
| new, switch | ✓ confirmation + dim └ details | ✗ failure, styled under stderrCaps |
| login | code/url prompt (bold code) + ✓ confirmation + dim └ details; the sfr_ token NEVER prints | network spinner while polling (animate-gated); ✗ failure, styled under stderrCaps |
| link | ✓ confirmation + dim └ details | ✗ failure, styled under stderrCaps |
| push, pull | ✓ per-stream result lines | plain warnings (invalid lines, retries); ✗ failure, styled under stderrCaps; `--watch` banner dim |
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
  initiative; Stop shim blocks a session lacking session_ended when
  gate-relevant drift is nonzero (speed T1) and passes one that has written
  back; stop_hook_active loop guard verified; PostToolUse produces
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
- **Phase 12 (misroute hardening, BD58):** a session started on branch A
  keeps writing to A's initiative through every MCP write tool after the
  shared checkout flips to branch B; an explicit `initiative` arg and the
  CLI-slug path (`sofar event append <slug>`) are unaffected, and a server
  with no active session still resolves from the branch. `sofar doctor`
  flags an injected task_status_changed whose id is not in the plan (WARN,
  exit 0) and does not flag applied task events or skew-ordered ones the
  plan later absorbs. overlappingWritebacks surfaces the losing overlapping
  session's next_action (winner excluded, duplicates of the winner's text
  excluded, sequential sessions excluded) and renders in renderStatus and
  `sofar status` only when present.
- **Phase 13 (convergent fold, D-sync-1):** the same event set folds to a
  deep-equal state from shuffled file orders and from merged two-writer
  logs in any concatenation order, cursor included (max id); same-process
  ids from makeEvent are strictly increasing (monotonic writer, rider a); a
  task_status_changed whose id sorts before its task_added resolves totally
  by skip-with-warning from either file order with identical states, and is
  not an orphan (rider b); a duplicated id (pre-dedupe merge artifact)
  keeps file order via the stable sort and folds deterministically.
- **Sync client (sync-client):** round-trip — push a stream from one
  clone, pull since genesis into a fresh clone: byte-identical event
  set, deep-equal fold, zero-diff `sofar status`, projections present.
  Idempotency — a `--full` re-push of an already-pushed stream reports
  accepted=0, duplicates=n, and the server stream is unchanged.
  Downtime drill — with the API down, local appends are unaffected and
  push fails politely with the ack cursor intact; after restart the
  queue drains (exactly the events past the cursor), and a further push
  finds nothing to do. Retries re-send the byte-identical batch on
  5xx/network and honor Retry-After on 429; server-rejected `invalid`
  lines surface on stderr without failing the push or wedging the
  cursor. Batching splits at both 1000 lines and 5MB with every batch
  under both limits and no event dropped or reordered. Pull pages by
  X-Sofar-Cursor persisting the inbound cursor after every imported
  page; the inbound cursor is independent of the push ack. Doorbell
  rings and reconnects each trigger a since-cursor pull; heartbeats
  dispatch nothing; 401 aborts instead of looping. Login stores the
  minted credential 0600 keyed by api_url, honors slow_down (+5s),
  aborts clearly on denial/expiry, and no CLI output ever contains the
  sfr_ token. Live E2E (behind SOFAR_LIVE_API, local api.sofar.sh):
  device login via the claim+approve path, link, and the round-trip.
- **Speed (speed T1 — drift-gated Stop):** a registered session with zero
  gate-relevant drift ends ungated (exit 0, no stderr) even without a
  session_ended — covering the zero-event session and the read-only session
  (no counted events per the T1 decision; uncounted lifecycle/plan-structure
  events since the write-back do not gate); one task_status_changed since
  the last write-back gates (exit 2, exact BD2 message); an error in the
  drift computation gates (fail closed); an in-flow write-back at drift ≥5
  followed by a further eventless turn ends silently; a concurrent
  unwritten session with its own mechanical activity stays gated after
  another session's write-back resets the shared counter (Phase 7
  independent gates). The loop guard and every BD22 exit-0 path are
  byte-identical to Phase 3 behavior.
- **Speed (speed T2 — shim-latency budget):** every hook shim (SessionStart,
  PostToolUse, UserPromptSubmit nudge, Stop, SessionEnd) completes in
  <100ms END-TO-END — process spawn of the built CLI, boot, fold, and its
  append/render — against a realistic seeded record (hundreds of events in
  the bound initiative, multiple sibling initiatives, repo memory present,
  drift and open sessions arming every render section). Best-of-3 per shim
  after one warmup spawn (the pin asserts capability; scheduler tail noise
  is not a regression). Mutation-checked at introduction: a temporary 150ms
  sleep in one shim fails the pin (byte-stability precedent, felt-cost 1.2).
- **Speed (speed T3 — persistent MCP daemon):** a genuinely spawned stdio
  `sofar mcp` server and the serve daemon's /mcp endpoint return identical
  tool listings (the frozen 7) and identical results for an identical
  call script covering every tool — digest/portfolio text byte-equal,
  typed errors included — and the two records fold to the same state
  (volatile ulids/timestamps redacted); two concurrent HTTP clients on one
  daemon hold isolated MCP sessions (each session's write-backs land
  correctly, neither blocks the other); connecting to a port with no
  daemon fails in <2s (never a hang); /state, /state/<slug>, and /events
  behavior is unchanged.
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
