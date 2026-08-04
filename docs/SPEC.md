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
files_touched[], task_files, current: {active_phase, next_action,
blocked_on?}, freshness, cursor: <last event id> }
task_files (speed T4) = derived file-locality map, task id → file paths
touched while that task was ACTIVE at replay time: existing file_touched
events only (payload-valid, unvoided, any session/source incl. cli — the
freshness precedent), attributed to EVERY task active at that point in
ulid order; deduped most-recent-first (a re-touch moves the path to the
front), capped at 20 per task (oldest drops, no sentinel). Zero new event
types, zero new capture — read-side and retroactive over every existing
record; derived only from record events, so an identical record folds to
identical task_files (injection byte-stability holds by construction).
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
Git state (record-integrity 4.1) is DERIVED at render time and never
recorded: core/git.ts readGitState(rootDir) resolves branch, local tip
(refs/heads/<branch>), and origin tip (refs/remotes/origin/<branch>) from
loose refs then packed-refs, yielding {branch, head, upstream, synced}.
Commits and pushes leave no trace in the record by design (record-hygiene
D1 exempts git from PostToolUse), which is precisely why a session could
not tell whether work was pushed; git is an authoritative self-describing
ledger, so it is READ rather than copied. Refs only — no subprocess and no
commit-graph walk, because this runs inside the 100ms shim budget (speed
T2) — so the answer is "same or different", not an ahead/behind count. In
a shared checkout every session sees one .git, so a push by any of them
updates the origin ref for all of them at once. Best-effort: null renders
nothing. The status block carries it as one `Git:` line above Goal, and the
UserPromptSubmit shim emits it as its own unconditional line (4.4).
FoldResult also carries unregistered_sessions (record-integrity 2.1): every
session id appearing on an event in THIS log that no session_started here
ever registered, sorted, never including "cli". The fold attaches activity
to registered sessions only (BD21/BD44), so such events were previously
counted by freshness and files_touched while attributable to no session —
invisible mass. A non-empty list is the misroute signature and feeds
doctor's session-routing audit. Additive; InitiativeState unchanged.
Repo-level derivation listInitiatives(rootDir) (initiative-list 1.2):
every directory under .sofar/initiatives/ summarized — slug, bound
branches (bindings.json inverted), tasks done/total, active phase, next
action, last envelope-valid event id — ordered by last-event ulid
DESCENDING (record recency), never-logged initiatives last by slug asc;
tolerant like the fold (unreadable log or corrupt bindings.json → warning
+ thinner entry, never fatal); zero new event types.

## Record graph (repo-wide adjacency derivation — record-graph 1.1)
`buildGraph(rootDir)` (core/graph.ts) is ONE mechanical, read-side adjacency
derivation over every `.sofar/initiatives/*/events.jsonl` in the repo. It
subsumes the bespoke per-edge reducers (task_files, activity) and recovers
the cross-initiative provenance the per-initiative fold structurally drops —
a session, a file path, and a cited decision all outlive the log they were
written to, and the fold sees one log at a time.

**Guarantees (each one load-bearing, not aspirational):**
- **Zero new event types, zero new capture.** Every node and edge is derived
  from envelopes and payloads already present. The write path is untouched;
  nothing is added to any hook or tool.
- **Retroactive over every existing record.** Coverage is whatever logs
  exist, pre-rename history included — no backfill, no migration, no schema
  change. (Contrast the rejected declared-`scope` field, which would have
  been the first non-retroactive derivation in this engine.)
- **Zero model API calls** (§Architectural invariants, felt-cost D3).
  Citation extraction is a CLOSED LEXICAL GRAMMAR with literal matching
  only — no inference, no embeddings, no entity resolution.
- **Deterministic.** Replay order is ulid order, as in the fold (D-sync-1);
  node and edge order is a pure function of the event set. The same records
  build a deep-equal graph with identical warnings.
- **Tolerant.** Corrupt or unknown lines skip with a warning, never fatal,
  never rewritten; an unreadable log degrades to a warning and a thinner
  graph (the listInitiatives precedent).
- **Never in the hot path.** buildGraph reads N logs where the fold reads
  one, so it cannot fit the 100ms shim budget (speed T2). Its ONLY consumers
  are explicit CLI surfaces (`sofar why`, `sofar related`) and doctor;
  no hook, statusline, or shim path may import it (pinned by test, 3.4).

**Nodes** — id is stable and unique repo-wide; `kind` discriminates:
```
initiative:<slug>            slug, goal
phase:<slug>#<name>          initiative, name, status
task:<slug>#<task id>        initiative, task_id, title, status
session:<session id>         tool?, model?, started?, ended?
file:<repo-relative path>    path
command:<event ulid>         initiative, session, ts, cmd
decision:<event ulid>        initiative, session, ts, ordinal, chose/over/because, dangling[]
note:<event ulid>            initiative, session, ts, text
```
Three families, and the difference is the point. STRUCTURAL nodes
(initiative, phase, task) come from each initiative's FINAL folded state, so
a plan_updated that drops a task drops its node — they describe the plan as
it now stands. OCCURRENCE nodes (command, decision, note) are one per
sourcing event, keyed by its ulid: an occurrence has no identity apart from
the event that recorded it. JOIN nodes (session, file) are deliberately NOT
slug-scoped — the session id and the repo-relative path are the same
identity in every log that mentions them, and that shared identity is the
entire cross-initiative edge. Task ids are NOT repo-unique (`1.1` exists in
most initiatives), so every structural id carries its slug.

**Edges** — `{kind, from, to, initiative, event_id?, ts?, attrs?}`:
```
structural (final folded plan; no event_id)
  has_phase   initiative -> phase
  has_task    phase      -> task
occurrence (exactly ONE edge per sourcing event; carries event_id + ts)
  touched     session    -> file       file_touched            attrs.op
  ran         session    -> command    command_run
  changed     session    -> task       task_status_changed     attrs.status
  decided     session    -> decision   decision_logged
  noted       session    -> note       note_added
  worked      task       -> file       file_touched x every task ACTIVE then
derived from decision prose (closed lexical grammar; no event_id)
  cites       decision   -> decision | task
```
Occurrence edges are multi-edges by design: they are NOT deduped into
pairs. Losing the per-event grain would make the consolidation in Phase 4
impossible — activity's `task_changes` renders every status change in log
order, including repeats on one task, and its `files` list is
first-touch-ordered. Deduping is a READ-side choice each query makes.
`edge.initiative` is the envelope.initiative of the sourcing event (the home
slug for structural edges), which is what makes cross-initiative provenance
a filter rather than a join.

Session-anchored edges form only for events whose `envelope.session` is a
real session id: `cli` is not a session identity and gets no node (the
activity rule, BD44). A cli-sourced file_touched still mints its file node
and still forms `worked` edges — task_files and freshness both count cli
events, and this derivation subsumes task_files, so it must match. The
`worked` edge is exactly the task_files rule generalized repo-wide: a
file_touched attributes to EVERY task active at that point in ulid order.

**Citation grammar (the `cites` edge, record-graph 1.3).** Matched over the
concatenated decision text (chose + over + because):
- QUALIFIED `<slug> <handle>` — `<slug>` must be an initiative directory
  that EXISTS; `<handle>` is `D<n>`, `T<n>`, or `<n>.<n>`. Binding is
  case-insensitive: slugs are lowercase by construction (`sofar new`
  validates `[a-z0-9-]+`), so `Felt-cost D3` at a sentence start is
  orthography, not a different name — and an exact-match rule would not
  leave it unbound, it would silently degrade the handle to an UNQUALIFIED
  one bound to the WRONG (home) initiative. A word that case-folds to no
  known slug qualifies nothing; the handle stays home-bound, since every
  unqualified citation follows some prose word.
- UNQUALIFIED `D<n>` or `T<n>` alone — resolved against the CITING
  decision's own initiative.
- Bare `<n>.<n>` is NOT a handle. Measured on the live record it matches
  version strings (`0.1`, `0.7`, `0.8`) and an IP octet (`127.0`) — 20 false
  positives, zero true ones. A dotted task id needs its slug.
- `BD<n>` and `D-<label>` (`D-P11`, `D-sync-1`) are NOT handles: they name
  the archived pre-migration prose record and hand-coined labels, neither of
  which has a node here. They are outside the grammar entirely — never
  matched, so they neither resolve nor land in `dangling[]`. The archived
  record is cited pervasively (BD22/BD16 7x each on the live record);
  recording those tokens would flood `dangling[]`, which is reserved for
  grammar-matched handles precisely so it stays a finding, not noise.

Resolution is literal and refuses to guess:
- `D<n>` → the nth decision_logged in that initiative's log in ulid order,
  1-based (`decision.ordinal`). This numbering is not invented for the
  graph — it is the convention the record already uses, and it round-trips:
  felt-cost D3 resolves to the zero-model-API-calls decision that
  §Architectural invariants cites by that handle.
- `T<n>` / `<n>.<n>` → the task with that EXACT id in that initiative's
  final plan.
- A decision target resolves only when its event id sorts BEFORE the citing
  decision's: a decision cannot cite the future.
- A decision naming its OWN ordinal is a self-label, not a citation, and is
  dropped (no self-edges).
- Anything else is DANGLING: carried on the citing decision node as
  `dangling[]`, never silently discarded. Dangling citations are a finding,
  not noise — `record-integrity 4.4` and `4.5` dangle because that
  initiative's plan never held tasks by those ids.

Measured over the live record (2026-08-03; 140 decisions, 15 logged
initiatives): 62 handle tokens → 22 decision edges, 11 task edges, 5
self-labels, 5 future refs, 19 dangling; 8 of the 33 resolved edges cross an
initiative boundary. That cross-boundary set is the whole basis of
`repoGeneral` (2.3): repo-generality is OBSERVED from citation behaviour
rather than declared at log time, and its top result on this repo is
felt-cost D3 — cited from record-graph and sync-client — the decision
CLAUDE.md and §Architectural invariants already treat as repo-wide law.

**Queries (record-graph 2.1-2.4)** — read-only over a built graph:
- `whyFile(graph, path)` → every session, task and decision behind a path,
  across ALL initiatives, newest-first. Sessions (`touched`) and tasks
  (`worked`) are DIRECT edges. Decisions are a documented TWO-HOP join
  (decision ← session → file) and a weaker claim: the record knows which
  session logged a decision and which files that session touched, never that
  the decision was ABOUT the file — surfaces must not present it as direct.
- `relatedTasks(graph, taskNodeId)` → co-touched-file neighbours ranked by
  shared-path count, cross-initiative included. Joins on file-node identity
  as recorded.
- `repoGeneral(graph)` → decisions cited from initiatives other than their
  own, ranked by DISTINCT citing initiatives, then citation volume, then
  oldest. Uncapped at derivation (the overlappingWritebacks precedent) — it
  feeds doctor (3.3) as well as renders.

Ordering and dedupe follow the task_files precedent: dedupe most-recent
first, newest-first out. Lists cap at GRAPH_RESULT_CAP (20) and report
overflow as a NUMERIC `omitted` count — never as a `+N more` element inside
a typed list, because query results feed doctor as well as renderers and the
in-band sentinel in `activity.files` is already why openSessionFileConflicts
must defend with `startsWith('+')`. Rendering `+N more` is a surface concern.

**Path identity.** file_touched records the path the agent actually edited —
an ABSOLUTE path — so one logical file accumulates a node per checkout it
was ever edited from. Measured here: 229 file nodes, 89 outside the current
root, 38 under `.claude/worktrees/`, and 21 paths split across checkouts;
`packages/engine/src/cli/doctor.ts` exists under four, including
`/Users/jins/IO/harness/...`, this repo's PRE-RENAME root. Recorded paths
are never rewritten and no prefix rule recovers a directory rename, so node
identity stays verbatim and `resolveFileNodes` joins at READ time: an exact
hit wins outright, otherwise every recorded path ending at a segment
boundary with the query matches, and callers report `matched_paths`. Literal
matching, no inference; the caller controls specificity.

**Surfaces (record-graph 3.1-3.4).** buildGraph has exactly THREE consumers —
`sofar why <path>`, `sofar related <task-id>` (both in §CLI) and doctor's
repo-memory axis — and the exclusion is as normative as the derivation. The
shims fire on the user's critical path against a 100ms end-to-end budget
(speed T2) and the CLI is built as separate bundles for exactly that reason
(`dist/fast.js` for the shims and statusline, `dist/full.js` for everything
else), so a graph import inside the hot path would be paid on every tool use.
Two static locks hold it: no module under `mcp/` or `projections/`, and
neither `cli/fast.ts`, `cli/boot.ts`, `cli/event.ts` nor `cli/statusline.ts`,
may reach `core/graph.ts` by any import chain; and the rebuilt hot-path bundle
must not contain a byte of graph code (which also catches a dynamic import or
a barrel re-export the walk would miss). The `mcp/`+`projections/` half of
that set doubles as the pin on a rejected approach — feeding graph results
into the SessionStart block or the `sofar_get_state` digest, which would put
an N-log read behind every session start and spend the digest budget on
adjacency.

Rendering follows the §CLI UI ladder: capability-gated styling over a shared
section model, so the styled path paints the plain one rather than re-deriving
it. Plain output is WIDTH-INDEPENDENT — prose clipped at a fixed budget, never
wrapped to `$COLUMNS` — so piped output is byte-stable across terminals.

**Consolidation (record-graph 4.1-4.3) — where the ONE rule lives.** The
adjacency vocabulary and the single emission rule live in `core/adjacency.ts`,
BELOW both the fold and the graph:
```
core/adjacency.ts   node ids, edge vocabulary, edgesForEvent(),
                    taskFilesFromEdges(), activityFromEdges()
core/fold.ts        state replay — EMITS this log's edges as it goes,
                    derives task_files + each session's activity from them
core/graph.ts       repo-wide union of those per-log edge lists,
                    + occurrence-node minting, citations, queries
```
That direction is forced, not stylistic: `graph.ts` imports `fold.ts`, so
`fold → graph` would be a cycle, and it would hand the hot path the N-log read
this section forbids. Below-both gives one rule with neither problem — the
fold already tracks the live plan, so "which tasks were active when this file
was touched" (speed T4) is decided exactly once, and `FoldResult.edges` is
slug-qualified and directly unionable.

The gate was byte-identity and it was MEASURED, pre- vs post-consolidation
over the live record: the whole repo-wide graph (3205 nodes, 4300 edges, in
order) plus every initiative's `task_files`, per-session `activity`,
`files_touched`, `freshness`, `phases`, warnings, orphans and unregistered
sessions came out identical. Cost: `foldLines` on the largest log 0.90ms →
1.04ms against speed T2's 100ms shim budget (pin still green); `buildGraph`
stays ~17ms and off the hot path. Deleted by it: the graph's own plan tracker
and event switch, the fold's `recordTaskFiles` and `recordActivity`.

`unregistered_sessions`, `overlappingWritebacks` and
`openSessionFileConflicts` deliberately STAY in the fold. They are read-only
queries over the folded session table rather than per-edge reducers, and each
needs a fact the graph deliberately drops: `unregistered_sessions` is PER-LOG
registration (the misroute signature) where the graph makes a session id one
identity across every log — the very property the cross-initiative join rests
on — and `overlappingWritebacks` needs write-back prose for a `next_action`
that is per-initiative by construction (BD9).

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

Library subpath "sofar.sh/client" (sync-client D1): the whole
client core — config/credential/cursor stores, device flow, createRepo,
pushStream/pullStream/splitBatches, runDoorbell — importable by the
Tauri shell and iOS app. Same laws as /schema and /engine: side-effect-
free import (env/fs resolved at call time), self-contained d.ts, zero
runtime deps (native fetch; the SSE reader is hand-rolled), bin and
manifest law unchanged.

## Library surface (library-surface, L1/L2 — added for sofar-cloud + D11)
sofar.sh additionally publishes typed ESM subpath exports so other
services consume the engine programmatically (fold parity: cloud state must
come from the engine's OWN fold, never a reimplementation):
- "sofar.sh/schema" — the v1 envelope type + validateEnvelope (the
  tolerant guard: validates, never throws or repairs — skip-and-warn stays
  the caller's decision) + makeEvent, and every event payload type/validator
  from @sofar/schema (events module).
- "sofar.sh/engine" — foldLines/foldLog (deterministic, total,
  ulid-normative — EXACTLY the CLI's fold), InitiativeState + component
  types + the cross-session derivations, the cursor primitive (readEvents /
  exportEvents / exportNDJSON / importNDJSON), and serializeEvent.
- "sofar.sh/client" — the v2 sync client core (§Sync client;
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
  NOT called at session start (speed-2 T5a): the digest is
  renderStatus(state) and the SessionStart block is renderStatus(state,
  {repoMemory, sessionId, git}) — the same projection with strictly more, so
  re-reading it after injection can only return less, at the cost of a full
  model round trip. The MCP protocol block directs agents to skip it and
  reach for it only when the injected block is missing or truncated (both
  share STATUS_CHAR_LIMIT) or when reading a DIFFERENT initiative. This does
  NOT extend to sofar_start_session, which must still be called — see its
  entry below. The AGENTS.md dialect keeps its orient-first step: MCP-less
  tools have no hook injection for it to be redundant with.
- sofar_start_session({initiative?, tool, model?, session_id?}) →
  {session_id} — session_id (from the SessionStart context "Session:" line)
  adopts exactly that session, OPEN OR ENDED; an unknown id is registered
  via session_started; omitted → mint a fresh ulid. No open-session
  heuristic (adopt-by-id, Phase 7, BD43).
  Adopting an ended id is pin-only (record-integrity 5.1): no append, and
  `ended`/`summary` are left standing as history. It used to be a typed
  invalid_input on the principle that a finished identity is never resumed
  silently — but adopt-by-id already requires naming the exact session, so
  the guard mostly fired on the legitimate path (write back mid-conversation,
  keep working, re-orient), where it forced ONE agent to mint a SECOND
  identity that the fold cannot distinguish from a genuinely parallel
  session. Reopening at fold level was rejected: clearing `summary` to
  re-arm the Stop gate would erase the prior write-back from
  sessions/<id>.md while its event still stands in the log. Events after a
  session_ended are already routine (hooks emit them) and a repeat
  session_ended is legal and last-wins.
  ALWAYS called, even though get_state at start is not (speed-2 T5a): the
  call's load-bearing effect is ctx.session.set(), not the event. Without an
  active session, resolveWriteInitiative falls back to the branch binding —
  which moves mid-session — so writes land wherever the branch now points,
  and appendAndProject stamps envelope.session "cli", detaching decisions and
  task changes from the session (sessions/<id>.md loses them; the Stop
  write-back linkage breaks). That is the record-integrity misroute class,
  and the side-index workaround for it is already rejected.
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
and an explicit `initiative` always wins. end_session resolves via the
active session (BD15), and the pin SURVIVES the write-back
(record-integrity 4.5): clearing it made every LATER write — a second
write-back, a decision, a task update — fall through to branch resolution,
so a parallel `sofar new` rebinding the branch mid-flight sent a write-back
into a sibling's brand-new initiative while the session's own record showed
no wrap-up at all. A pin is a routing key, not a liveness flag, and a
session's home does not stop being its home when it summarises — the same
premise 0.13.0 settled when start_session learned to adopt an ENDED session
and the parallel-wrap window began handling a session that writes back and
keeps working. A write-back naming a session that is NOT the active one
(no pin, e.g. a restarted server) resolves home → branch, the order
resolveBound has used since 1.2, so it lands in the session's own log
rather than wherever HEAD points. get_state keeps branch resolution — it is a read
(explicit `initiative` scopes cross-initiative reads). start_session
resolves by branch ONLY when `initiative` is named or the session has no
home yet (record-integrity 1.4): lazy registration (D2) means the
PostToolUse hook has usually registered the session already, so resolving
by branch alone registered the same id a SECOND time in another log
whenever the binding moved in between — the dominant tear shape observed
(11 of 14 double-registrations were hook-then-claude-code across two
initiatives). With a home present it adopts there; an explicit `initiative`
still re-homes deliberately.
HOOK writes are pinned too (record-integrity 1.2, D1). A hook runs in a
fresh process where the in-memory pin above is always null, so before this
it resolved by branch alone — and a branch switch during live work sent
file_touched/command_run to whatever branch HEAD named while the same
session's decisions and write-back went to its real initiative. Every hook
subcommand now resolves through the session's HOME initiative: the one
whose log registered it with session_started, derived from the logs rather
than stored in a second place (D1). Branch → bindings is computed first and
passed as the preferred candidate, so the common case (branch and
registration agree) costs one file read; siblings are scanned only on a
miss, and among them the LATEST session_started wins so a deliberate
re-home beats a stale registration. A session registered nowhere falls back
to the branch and registers there (lazy registration, D2 — unchanged). An
UNBOUND branch is a miss rather than an error for a registered session,
which also ends the silent event drop unbound branches used to cause.
unknown_initiative errors — from any tool or CLI command that resolves a
slug (explicit or branch-bound) — carry a count-capped (10) `available
initiatives:` suffix, or a `sofar new` hint when none exist
(initiative-list 2.2): the dead-end orients instead of blocking.

## Hooks (installed by `sofar init` as standalone scripts in .claude/hooks/)
- SessionStart shim → `sofar event session-start` then prints the status
  projection to stdout (context injection). The block opens with a
  `Session: <id> — when calling sofar_start_session, pass this as
  session_id.` line carrying the session id from the hook payload
  (adopt-by-id, Phase 7, BD43). This shim APPENDS NOTHING: registration is
  LAZY (record-hygiene D2) — a session enters the log on its first real
  event, via sofar_start_session's unknown-id branch or the first
  PostToolUse append. A session that only reads and exits is never
  registered, so it mints no session_started, no session_closed, and no
  sessions/<id>.md. Includes a "Repo memory" section
  sourced from .sofar/repo.md when it exists and is not the untouched init
  stub, budget-clipped to ~1,500 chars (added Phase 6, BD40). Staleness
  surfacing (staleness-detection, mechanical signals only): when counted
  events postdate the last write-back the block renders ONE budgeted line
  `⚠ next action may be stale: N events since write-back (breakdown)`
  under the next action (absent on a fresh record); a stale phase renders
  as `[<status> — all tasks done; mark phase done?]` on its phase line. The
  derived resume line names ONE unwritten session (the best resume point);
  every OTHER session that did mechanical work without writing back renders
  as one budgeted `⚠ N other session(s) did work without writing back` line
  listing up to 5 ids (record-integrity 4.3). The derived line stops at the
  newest written-back session by design, which is right for resuming and
  wrong for accounting: with parallel sessions a single write-back used to
  hide every other session's unwritten work from the block entirely. A
  last-session summary cut by its budget carries `(clipped — full text in
  sessions/<id>.md)` INSIDE the budget. Un-absorbed notes (notes-in-digest
  2.1) render as a budgeted section under the staleness line — see §MCP
  get_state digest for the exact rule; both surfaces share renderStatus.
  File-locality hint (speed T4): directly under the "Current task" line,
  ONE budgeted line `files: a.ts, b.ts, …` naming the active task's
  task_files (§State) — at most 8 files, most-recent first, 300-char clip,
  silently absent when the task has no data. Both renderStatus surfaces
  (SessionStart block + get_state digest) carry it; ablation-gated (the
  automated resume ablation re-ran on introduction — result recorded in
  the speed initiative).
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
  The same shim also emits the PARALLEL-WRAP line (record-integrity 4.2),
  independently of the drift nudge — both may appear, newest first. It fires
  when another session in this initiative ENDED with a real write-back
  (summary present, so a mechanical session_closed does not qualify) inside
  THIS session's live span, and carries that session's id, summary and next
  action — clipped to 420 chars.
  The window opens at THIS session's last write-back, falling back to its
  start (0.13.0). Anchoring on `started` alone never closes, so one sibling
  wrap-up was announced for the rest of the session's life; suppressing the
  line whenever `me.ended` was set (0.12.1) went too far the other way and
  silenced a REAL parallel wrap-up, because a session that writes back and
  keeps working still has `ended` set — the hook firing at all is proof it
  is alive. The write-back anchor closes the window when the session
  absorbs the record and re-opens it for new sibling activity, matching the
  frame the drift counter already uses. The phantom sibling that motivated
  0.12.1 was really the identity split (5.1). Budget
  order is next_action FIRST, summary absorbing the
  remainder — the summary is the least actionable part, and rendering it
  first let a long one clip the next action away entirely.
  This is the answer to the cross-session blind spot the initiative opened
  on: before it, a sibling could commit and push and no other live session
  had any way to learn it, so a human had to announce it in every window.
  Stateless and re-firing like the nudge — there is no "already told you"
  bit, and repeating a true fact costs less than storing one.
  The same shim emits the PUSH-STATE line (record-integrity 4.4)
  UNCONDITIONALLY — whenever §Git state is readable, regardless of any
  sibling activity: `sofar: <branch> @ <head>, ` then `pushed (in sync with
  origin/<branch>).` | `NOT pushed (origin/<branch> at <tip>).` | `never
  pushed.` Ordering is news, then state, then nudge: parallel-wrap, push
  state, drift. 4.2 carried push state inside the wrap line, which meant a
  session learned it ONLY when a sibling happened to write back in the
  window — so a long-lived session saw push state once at SessionStart and
  thereafter by luck. That coupling lost the initiative's own motivating
  case a second time: a window committed a README rewrite, a sibling pushed
  that commit with the 0.13.0 release, and the window had to reconstruct the
  answer from git log. Unbinding costs nothing — refs-only state, a line
  bounded by construction, and the same stateless re-fire as the nudge, so
  the 420-char wrap budget bounds the WRAP line only, never the whole
  payload. Repo-level by design: it reports HEAD against origin, never "your
  commits" — per-session commit attribution needs the commit-graph walk
  §Git state rules out, and time-window attribution misreads interleaved
  parallel sessions.
- PostToolUse shim (matcher: Edit|Write|MultiEdit|Bash) → appends
  file_touched / command_run from stdin JSON (tool_name, tool_input),
  preceded by a session_started for an unregistered session (lazy
  registration, record-hygiene D2; envelope session "cli" is never
  registered).
  SELF-RECORDING COMMANDS ARE EXEMPT (record-hygiene D1): a Bash command
  whose every shell segment leads with `git` or `sofar` appends NOTHING.
  Both keep their own ledger — git its history, sofar the record itself —
  and logging them makes the record un-settleable: committing the record is
  a Bash call, so it would append an event about committing the record and
  the tree would be dirty the instant it is clean. The tree can only reach
  clean if some record-committing action appends zero events. Nothing is
  lost: the fold counts command_run and never reads `cmd`. Segments split at
  `&&`, `||`, `;`, `|`, `&` and newline only OUTSIDE quotes
  (record-hygiene-quotes D1): a separator inside a commit message body is not
  a separator, or this repo's own multi-line messages would defeat the
  exemption and the tree could never settle. A command that cannot be scanned
  confidently is LOGGED — unbalanced quotes, or a `$(…)`/backtick
  substitution whose nested command the scan never descends into. Every
  ambiguity resolves toward LOGGING, so the exemption can never swallow real
  work (`cd x && git push`, `git log | head`, `git push & npm test` and
  `git log $(rm -rf x)` are all logged).
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
- `sofar doctor [--fix]` — audit a host repo across six axes: (1) wiring
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
  (3) session routing — no session id spans more than one initiative
  (record-integrity 2.2). Two shapes, both from the pre-pin misroute — TORN
  (registered by session_started in ≥2 initiatives, so MCP writes and hook
  writes went to different logs) and LEAKED (events in an initiative that
  never registered the session, counted by that initiative's freshness and
  files_touched while attributable to no session). Severity grades by
  LIVENESS, not shape (D3): a split with a session still OPEN reports FAIL
  (a pre-fix session actively tearing), one where every session has ENDED
  reports WARN — settled history, unrepairable by construction since no event
  carries a self-evident misplacement marker, and a permanently failing audit
  trains people to ignore it. Derived from FoldResult.unregistered_sessions
  plus each state's registered ids; deterministic, sessions sorted by id and
  footprints by slug;
  (4) concurrency — no file under concurrent edit by ≥2 OPEN sessions (a live
  clobber risk); (5) repo memory — every decision the record TREATS as
  repo-wide (§Record graph `repoGeneral`: cited FROM another initiative) is
  named in the hand-written `.sofar/repo.md`, the one file every SessionStart
  injects. Presence is literal and uses the record's own citation grammar: the
  QUALIFIED handle `<slug> D<n>`. Unqualified `D<n>` cannot count — repo.md has
  no home initiative, so the handle would be ambiguous repo-wide; prose
  matching would be inference (felt-cost D3) and would rot on either side's
  rewording. DETECTION ONLY, always WARN: repo.md is hand-written per §Record
  layout and sofar never generates or rewrites it, so both the curation and the
  SessionStart token budget stay the author's (record-graph 3.3);
  (6) scanner hazards (Tailwind v4 entry stylesheet lacking a
  `@source not` exclusion for `.sofar`). Record-health, concurrency and
  repo-memory findings
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
- `sofar why <path>` — every task, session and decision behind a path,
  across ALL initiatives, newest-first (§Record graph `whyFile`). Prints the
  recorded paths the query resolved to (§Path identity) VERBATIM — those are
  the node ids the answer joined on — then three sections, each headed with
  its TRUE total and listing at most GRAPH_RESULT_CAP entries followed by a
  `+N more` line. The `+N more` string exists only here: the query reports a
  numeric `omitted` (record-graph 2.4). The decisions section carries the
  two-hop caveat inline — logged by a session that also touched this path, not
  necessarily about it — because the record cannot know the stronger claim. An
  untouched path is an empty answer, not an error (exit 0, with the hint that
  paths are recorded per checkout and a shorter query matches more broadly);
  fold warnings go to stderr without failing (record-graph 3.1).
- `sofar related <task-id> [--initiative <slug>]` — tasks that worked on the
  same recorded files, ranked by shared-path count, cross-initiative
  neighbours included (§Record graph `relatedTasks`). Task ids are not
  repo-unique, so the id needs a slug from somewhere: `<slug>#<task-id>`,
  `"<slug> <task-id>"` (the record's own citation form), the `task:` node id,
  `--initiative`, else the branch binding — four literal shapes, never a
  search. A task the plan never held is exit 1 naming the id and initiative
  looked for — including an id only stray status events name: the orphan
  node keeps such edges visible in the graph, but the CLI refuses to anchor
  on a status the plan cannot vouch for. A task with no neighbours is exit 0
  saying so (record-graph 3.2).
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
  file_touched for an Edit and command_run for a Bash call, appends nothing
  for a self-recording command (git/sofar, record-hygiene D1) including one
  whose quoted commit message carries separators and newlines, and registers
  an unregistered session before its first real event (lazy registration,
  record-hygiene D2 — SessionStart alone leaves the log untouched, so a
  session that did nothing leaves no trace).
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
  drift and open sessions arming every render section). Up to 10 attempts
  per shim after one warmup spawn, early-exit on the first run inside the
  budget, assert the minimum (the pin asserts capability; scheduler noise
  from a saturated parallel test run is not a regression, while a genuine
  sleep ≥ budget has a floor no retry ducks). Mutation-checked at
  introduction: a temporary 150ms sleep in one shim fails the pin
  (byte-stability precedent, felt-cost 1.2).
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
- **Speed (speed T4 — file-locality hints):** a file_touched landing while
  a task is active appears in that task's task_files (and in every
  concurrently-active task's); one landing while the task is not active
  does not; a re-touch moves the path to the front (deduped,
  most-recent-first) and the per-task list caps at 20; a voided
  file_touched never attributes; replay stays deterministic (same log →
  deep-equal state, task_files included, from shuffled file orders). The
  renderStatus "files:" line names at most 8 most-recent files inside its
  300-char clip, renders on both renderStatus surfaces, is absent for a
  task with no data, and the SessionStart block holds ≤10k chars with the
  line at worst case. The byte-stability pin passes unmodified.
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
- **Write-back routing (record-integrity 4.5):** a session started under
  initiative A writes back, keeps working, and a parallel `sofar new`
  rebinds the branch to B; the session's SECOND write-back still lands in
  A's log and B's log stays empty. The pin is still held after the first
  write-back (getActiveSession() is non-null), so later decisions and task
  updates route to A as well. With no pin at all — a restarted server
  ending a session registered in A while the branch names B — the write-back
  still lands in A. Both cases fail against the pre-4.5 code.
- **Push awareness (record-integrity 4.4):** a registered session in a repo
  with readable refs and NO sibling session at all still gets the push-state
  line on every UserPromptSubmit — `NOT pushed (origin/<branch> at <tip>)`
  when the local tip is ahead, `pushed (in sync with origin/<branch>)` when
  the refs match, `never pushed.` when no origin ref exists. When a parallel
  window pushes mid-session (refs move, record untouched — git is exempt
  under record-hygiene D1), the session's very next prompt flips from NOT
  pushed to pushed with no sibling write-back involved. The 420-char budget
  bounds the parallel-wrap line alone, not the combined hook payload; a
  sibling that wrapped before this session's last write-back still yields no
  wrap line while the push-state line renders regardless.
- **Record graph (record-graph):** buildGraph over a repo of several
  initiatives is deterministic (same records → deep-equal graph and
  identical warnings, from shuffled file orders) and tolerant (an injected
  corrupt line and an unreadable log each yield a warning and a thinner
  graph, never a throw). A session that wrote to two initiatives yields one
  session node with edges into both — the cross-initiative fact no
  single-log fold can produce. A file path touched from two initiatives is
  ONE file node. Citation extraction resolves `D<n>` to that initiative's
  nth decision in ulid order and `<slug> <task id>` to that task, refuses
  bare `<n>.<n>` (a record carrying `0.14.0` and `127.0.0.1` in decision
  prose yields zero citations from them), binds a miscased qualifier
  (`Felt-cost D3`) to its slug rather than degrading the handle to a
  home-bound one, drops self-labels and future-sorting targets, and records
  every unresolved grammar-matched handle in `dangling[]` rather than
  discarding it. A task the final plan dropped keeps orphan endpoints for
  its `worked` edges as well as its `changed` ones — no edge dangles — and
  an orphan's status follows the log's last word. `sofar why <path>` names
  every task, decision and session that ever touched the path across ALL
  initiatives, newest-first; `sofar related <task-id>` ranks co-touched-file
  neighbours by shared-path count and exits 1 for an orphan-only anchor
  exactly as for an id the record never saw; `repoGeneral` ranks decisions
  by DISTINCT
  citing initiatives other than their own, and doctor WARNs (exit 0) when a
  repo-general decision is absent from `.sofar/repo.md` — detection only,
  repo.md is never generated. No hook shim, statusline, or UserPromptSubmit
  path imports core/graph.ts (locked statically by test, the cli-ui
  import-lock precedent), and the speed T2 shim-latency pin still passes.
  Consolidation was GO/NO-GO and resolved GO: task_files and activity are
  re-expressed as pure functions of one emitted edge list (core/adjacency.ts,
  §Record graph Consolidation), and the graph unions those per-log lists
  instead of walking events itself. BYTE-IDENTICAL was the gate and was
  measured against the pre-consolidation engine over the live record — whole
  graph in order, plus every fold — with the byte-stability and shim-latency
  pins passing unmodified. A golden fixture pins the RULE independently of
  either implementation: two tasks active at once fan one file_touched out to
  both; a re-touch moves the path to the FRONT of task_files while activity
  keeps FIRST-touch order; a cli-sourced touch counts for task_files and never
  for activity; a status change for an id the plan never held is still real
  activity and mints an orphan node; an unregistered session attaches to
  nobody; a voided event contributes nothing.
