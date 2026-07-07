# Initiative: harness-build (v1 engine)

## Goal
Build the Harness v1 engine during the Fable 5 window (Jul 3–7): event log
core, MCP server, Claude Code hooks, projections, CLI, watcher/state server,
and the AGENTS.md dialect. Engine only — schema lives in one swappable
module; UI/sync/team are explicitly out of scope. Full contracts in SPEC.md.
Conventions and protocol in CLAUDE.md. Strategy context in harness-docs/
(00-spine, 01-roadmap, 02-action-plan, 03-architecture).

## Current state
- Active phase: 6 COMPLETE (hardening + distribution readiness, all five
  tasks done Jul 7: 6.3 atomic projection writes BD38, 6.4 version
  single-sourced BD39, 6.5 repo.md in the SessionStart context BD40,
  6.2 zero-dep installable tarball + packaging E2E BD41, 6.1 root README +
  pack-time tarball README BD42; 245 tests green, 23 files). The engine
  is distribution-ready: `npm pack` in packages/engine yields an
  installable zero-dependency tarball; publishing (flipping the engine's
  "private") remains a user decision. Ceremony items 5.2/5.3 remain open
  and user-driven in parallel. Phase 5 status: 5.1 done: `harness event
  append` dialect surface + AGENTS.md protocol block with the three BD19
  clauses, Stop-hook write-back parity proven. 5.2 docs + checklist
  simulation done — the manual OpenCode verification run is still pending,
  so its box stays open.
- Next action: Task 5.3 remainder, both legs USER-DRIVEN and both now
  reduced to scoring/authorization only: (a) the arm-C Opus 4.8 resume has
  been EXECUTED (session log 2026-07-07 "THE ARM-C RESUME" — fresh Opus
  4.8 [1m] session, "resume this initiative" only, oriented from the record
  alone, re-verified 245/245 green at HEAD 2da65f5 after a concurrent
  Fable 5 session landed Phase 6 mid-run, asked nothing); it now
  needs the user to SCORE it as arm-C on the (user-held) Phase 0 scorecard —
  that closes 5.3's handoff leg. (b) the manual OpenCode run per
  docs/opencode-adapter.md §3 (steps 1–3 scripted there; agent prompt in
  §3's intro) then flip 5.2. The final Fable write-back is DONE (session
  log 2026-07-07); the record is the handoff artifact and it just carried a
  zero-context Opus 4.8 session end-to-end.
- Blocked on: nothing (both remainders are user-side actions, not blockers)

## Plan

### Phase 1 — Event log core [done]  (completed Jul 3)
- [x] 1.1 Scaffold: TS strict, vitest, esbuild bundling, npm bin entry
- [x] 1.2 Event envelope types + runtime validation (SPEC §Envelope)
- [x] 1.3 Append: atomic single-line O_APPEND writes, concurrent-safe
- [x] 1.4 Fold/replay: events.jsonl → InitiativeState (SPEC §State)
- [x] 1.5 Cursor primitive: export/import "events since N" (sync-ready)
- [x] 1.6 Tests: concurrent appends, corrupt-line tolerance (skip+warn),
      replay determinism, cursor round-trip

### Phase 2 — MCP server [done]  (completed Jul 3)
- [x] 2.1 stdio MCP server exposing typed tools (SPEC §MCP tools)
- [x] 2.2 Tools: get_state, start_session, end_session, update_task,
      log_decision, update_plan, add_note
- [x] 2.3 Payload schemas isolated in packages/schema/ (the ONLY schema
      home) — satisfied by construction: tool arg schemas/validators were
      built in packages/schema/src/tool-inputs.ts from the start (2.1);
      verified engine src contains no JSON-Schema/validator shapes outside
      projections/templates and imports all schema from @harness/schema
- [x] 2.4 .mcp.json registration snippet emitted by init (Phase 4 wires it)
- [x] 2.5 Tests: every tool appends correct event; state reflects it

### Phase 3 — Hooks + projections [done]  (completed Jul 6)
- [x] 3.1 Hook shims in .claude/hooks/ as standalone scripts calling the CLI
      (portability rule — no inline command logic)
- [x] 3.2 SessionStart shim: emit projection as context, ≤10,000 chars
- [x] 3.3 PostToolUse shim (matcher Edit|Write|MultiEdit|Bash): append
      file_touched / command_run mechanical events
- [x] 3.4 Stop shim: if no session_ended event for this session → exit 2
      with "write back to the record"; MUST check stop_hook_active guard
- [x] 3.5 SessionEnd shim: mechanical close event (fallback logging only)
- [x] 3.6 Projection generator: templates → plan.md, decisions.md, status
      block; regenerated on every append; never hand-edited

### Phase 4 — CLI + watcher [done]  (completed Jul 6)
- [x] 4.1 `harness init`: scaffold .harness/, install hook shims + settings,
      emit .mcp.json entry, append protocol block to CLAUDE.md — block MUST
      assert total jurisdiction (SPEC §CLI field finding Jul 4, BD19)
- [x] 4.2 `harness new <slug>` / `harness switch <slug>`: initiative dirs +
      bindings.json (branch ↔ initiative)
- [x] 4.3 `harness status`: fold + print tree (phase/task/status/next)
- [x] 4.4 `harness export --since <cursor>` / `harness import`
- [x] 4.5 Watcher + localhost JSON state server (no UI — endpoint only)

### Phase 5 — Dialect + forced handoff [pending]  (target: Jul 7)
- [x] 5.1 AGENTS.md protocol block (convention dialect for MCP-less tools)
- [ ] 5.2 OpenCode adapter notes: plugin equivalents (tool.execute.before/
      after) documented; convention fallback verified manually
      *2026-07-06: docs/opencode-adapter.md + automated simulation of its
      verification checklist (test/acceptance.phase5.test.ts) are done;
      the manual OpenCode verification run is still pending — part of the
      5.3 ceremony prep, so this box stays open (BD32).*
- [ ] 5.3 THE CEREMONY: final Fable session writes back via protocol;
      Opus 4.8 resumes this initiative from the record alone; score the
      handoff as a real arm-C run on the Phase 0 scorecard

### Phase 6 — Hardening + distribution readiness [active]  (added Jul 7, BD37)
- [x] 6.1 README.md: what/why, install, quickstart (init/new/status),
      MCP server, hooks, AGENTS.md dialect — the front door for npm users
- [x] 6.2 Packaging: bundled-bin distribution — the engine tarball must
      install with zero runtime deps (bin is fully esbuild-bundled);
      npm pack → install into temp prefix → `harness init` E2E test
- [x] 6.3 Atomic projection writes (temp file + rename) — serve and
      SessionStart must never see a half-written plan.md/status
- [x] 6.4 CLI version single-sourced from package.json (currently
      hardcoded '0.1.0' in src/cli/index.ts — drift waiting to happen)
- [x] 6.5 repo.md surfaces in the SessionStart context block with its own
      budget (record layout defines it; nothing reads it today) — the
      ≤10,000-char cap guarantee must hold

## Decisions
- BD1: Stack = TypeScript/Node ≥18. MCP SDK is TS-first; users have Node
  (Claude Code requires it); npm is the distribution channel; one language
  across CLI/MCP/shims. Rejected Rust/Go: slower to build in window, MCP
  SDK maturity. Rejected Python: weak global-CLI distribution story.
- BD2: Write-back enforcement = Stop hook (exit 2 blocks stop, forces
  continue), NOT SessionEnd (cleanup-only, cannot feed back). Guard against
  infinite loop via stop_hook_active check.
- BD3: Projection injected at SessionStart must fit 10,000-char context cap
  → status projection is summary-dense; detail lives in per-session files.
- BD4: Hooks are thin standalone scripts calling `harness event append` —
  logic lives in the CLI; shims stay portable across Claude Code/Codex.
- BD5: Events are truth; md files are generated projections (per
  03-architecture storage decision). Hand-edits to projections are a bug.
- BD6: Schema (event payloads + projection templates) confined to
  src/schema/ and src/projections/templates/ — Phase 0/1 iteration touches
  only these.
- BD7: devDependencies typescript, esbuild, vitest, @types/node are
  toolchain, not runtime deps — allowed under the CLAUDE.md dependency rule
  (which names vitest/esbuild as the test/build tools). Runtime dependency
  set stays exactly: @modelcontextprotocol/sdk, commander, chokidar, ulid.
- BD8: Correction fold semantics — a correction event VOIDS the event its
  ref points at (target skipped during replay); replacement content is
  appended as a fresh event. Rejected in-place patching: violates event
  immutability and complicates replay. SPEC only says "referencing the
  target id", so this is the minimal meaningful interpretation.
- BD9: current.* fields are DERIVED at fold end, not stored: active_phase =
  first phase with status active; next_action = latest session_ended's
  next_action; blocked_on = list of blocked phases/tasks (using the blocking
  task_status_changed note when present, cleared on unblock). SPEC leaves
  the computation unspecified; deriving keeps the log free of redundant
  state-sync events. Envelope-valid events with unknown types still advance
  the cursor (sync moves events by envelope, not payload).
- BD10: ulid generation uses monotonicFactory(), not the default ulid() —
  default ulids are randomly ordered within the same millisecond, which
  breaks the cursor contract (creation order must match sort order for
  "events since id"). Cross-process same-ms ordering stays unspecified
  (inherent to ulid); acceptable because fold replays in file order.
- BD11: Monorepo now (user-directed, Jul 3), not post-v1 — npm workspaces,
  zero new tooling. packages/schema = @harness/schema, source-shipped
  internal package (main/types point at src/events.ts; no build step until
  it publishes); packages/engine = harness bin (core/mcp/cli/projections/
  hooks). Rejected deferring to v2 (prior recommendation): user prefers
  paying structure cost early so ui/sync/adapters slot in later. Rejected
  pnpm/turborepo: npm workspaces add no dependencies. SPEC §Repo layout and
  CLAUDE.md guard-rail paths updated; BD6's path references superseded —
  schema home is packages/schema/src/, templates
  packages/engine/src/projections/templates/.
- BD12: MCP server uses the SDK's LOW-LEVEL API (Server +
  setRequestHandler(ListTools/CallTool)) with hand-written plain-JSON-Schema
  tool definitions and @harness/schema validators
  (packages/schema/src/tool-inputs.ts, exported as
  @harness/schema/tool-inputs). Rejected the high-level McpServer
  .registerTool API: it wants zod shapes, and zod is not in our locked
  runtime dependency set (BD7); hand-rolled validators also keep every
  validation shape in the one schema home (guard-rail).
- BD13: MCP server launches via a `harness mcp [--root <dir>]` subcommand on
  the existing commander CLI; SPEC §CLI did not list it, so SPEC was
  extended (one line) rather than improvising an undocumented surface. The
  .mcp.json registration snippet is { mcpServers: { harness: { command:
  "harness", args: ["mcp"] } } }, emitted by src/mcp/register.ts (task 2.4)
  and wired into `harness init` in Phase 4. Rejected a separate bin entry
  (harness-mcp): one bin keeps install/registration surface minimal.
- BD14: Projections sequencing — SPEC §MCP tools says every tool regenerates
  projections, but full templates are Phase 3 (task 3.6). Built the seam in
  Phase 2: src/projections/generator.ts regenerateProjections(initiativeDir,
  state) renders minimal v0 plan.md + decisions.md via template functions in
  src/projections/templates/ (plan.ts, decisions.ts); every tool append
  calls it; generated files carry a "do not hand-edit" header. Rejected
  deferring projections entirely to Phase 3 (would violate the SPEC tool
  contract and Phase 2 acceptance) and building full templates now (Phase 3
  scope creep). Phase 3 extends these templates in place.
- BD15: Session semantics — the stdio server process holds ONE in-memory
  active session. start_session generates a ulid session_id, appends
  session_started, sets it active (remembering id, tool, initiative);
  subsequent appends use envelope.session = active id (else "cli") and
  envelope.source = the session's tool if it names an envelope SOURCES
  member, else "cli"; actor is always "agent" for MCP appends. end_session's
  session_id arg wins over the active session; if it names the active one,
  that session's initiative is used (SPEC's end_session signature has no
  initiative arg) and the active slot is cleared after the append. Rejected
  a multi-session registry: one agent process per stdio server, YAGNI.
- BD16: Initiative resolution — explicit `initiative` arg wins; else current
  git branch → slug via .harness/bindings.json. Branch is read by parsing
  .git/HEAD ("ref: refs/heads/<branch>"), following a worktree-style .git
  FILE ("gitdir: <path>") to its HEAD; detached HEAD/no repo/no binding →
  typed unknown_initiative error telling the caller to pass `initiative`
  explicitly. Resolved slugs must exist under .harness/initiatives/ (typos
  must not create logs). Repo root = server cwd; `harness mcp --root`
  overrides. Rejected spawning `git rev-parse`: subprocess per call, needs
  git on PATH, and HEAD parsing is sufficient for v1.
- BD17: Typed tool errors — failures return an MCP result with isError:true
  and content[0].text = JSON {code, message, errors?}; code union lives in
  ONE place (@harness/schema/tool-inputs): invalid_input |
  unknown_initiative | unknown_tool | unknown_event | io_error
  (unknown_tool added to the planned set for unlisted tool names).
  Validation failures carry field-level errors; tests assert no event is
  appended on failure. Rejected MCP protocol errors (McpError): agents see
  tool-result text, not protocol faults — in-band typed errors are
  actionable and parseable.
- BD18: Tool arg → payload mapping — update_task {task_id, status, note?} →
  task_status_changed {id, status, note?} (SPEC tool signature says task_id,
  Phase 1 payload schema says id; mapped at the tool boundary rather than
  changing either frozen contract); update_plan {plan} must satisfy the
  existing PlanStructure validator (reused via validatePayload so tool input
  and event payload cannot drift); log_decision → decision_logged;
  add_note → note_added.
- BD19: Total-jurisdiction protocol block (user field finding, Jul 4) —
  SPEC §CLI `harness init` contract expanded: the installed protocol block
  MUST state (a) all work state lives in harness records, never in tool
  memory or scratch files; (b) work matching no existing initiative
  requires `harness new` before proceeding; (c) bindings resolve which
  record a session serves. Cause: dogfooding showed a second initiative's
  state leaking into Claude Code native memory + a scratch dir — per-file
  jurisdiction is not enough. Affects task 4.1 (init protocol block) and
  task 5.1 (AGENTS.md dialect must carry the same three clauses). The same
  hand-edit accidentally reverted SPEC §Repo layout/§Event types to the
  pre-monorepo text (BD11) and dropped the `harness mcp` CLI line (BD13);
  those sections were restored — code and record remain monorepo + mcp.
- BD20: Session identity correlation through the log, no side channel —
  hooks know Claude Code's session_id, the MCP server minted ulids; they
  unify via events: `harness event session-start` appends session_started
  with envelope.session = Claude's session_id; harness_start_session ADOPTS
  the newest open session (session_started with no close) for the
  initiative and returns its id (no duplicate append), minting a fresh ulid
  only when none is open; harness_end_session then closes the adopted
  session, so the Stop shim verifies write-back by folding the log for
  Claude's session_id. Semantics shift: two start_sessions without an end
  now adopt the same open session instead of minting parallel identities.
  Rejected a side-channel correlation file (second source of truth beside
  the log) and passing session ids through env vars (not available to the
  MCP server process).
- BD21: New event type session_closed {reason} — the SessionEnd hook must
  not fabricate a session_ended (its required summary/next_action would
  clobber the fold-derived current.next_action); session_closed is the
  mechanical close: fold sets session.ended only (never summary/
  next_action, never overrides an earlier end), warns + skips for
  unregistered sessions (no stubs — a close marker for an unknown session
  carries no information). SPEC §Event types updated; SPEC §State sessions
  shape gained model? and next_action? (retained by fold since Phase 3 —
  sessions/<id>.md projections need them). Rejected reusing session_ended
  with placeholder summary: poisons next_action and defeats the Stop
  shim's write-back check.
- BD22: Best-effort hooks — every `harness event` handler exits 0 silently
  on any failure (unreadable stdin, missing session_id, no .harness/, no
  binding, unknown tool_name); only Stop deliberately exits 2, and only for
  a registered-but-unwritten session (stop_hook_active → 0 loop guard;
  unregistered session_id → 0 so foreign repos are never blocked;
  write-back check = fold-derived session.summary present, since only
  session_ended sets summary and voided corrections don't count).
  SessionStart re-fires (resume/clear/compact) with the same session_id
  skip the duplicate append but still print the status block. Handlers are
  pure functions returning {exitCode, stdout, stderr}; commander wiring
  stays thin so tests never wrestle process.exit. Rejected erroring loudly:
  a memory layer that can break sessions in unbound repos is worse than no
  memory layer.
- BD23: PostToolUse mapping — Edit|MultiEdit → file_touched {path:
  tool_input.file_path, op:'edit'}, Write → op:'write', Bash → command_run
  {cmd: tool_input.command}; envelope source 'hook', actor 'agent', session
  = stdin session_id (fallback 'cli' so a touch without correlation still
  lands). Unknown tool_name or missing file_path/command → exit 0, append
  nothing. Rejected recording tool_response (verbose, no state value) and
  an op per hook tool name (op is edit|write — the record cares about
  mutation kind, not which editor variant did it).
- BD24: Status projection ≤10k strategy — renderStatus enforces the BD3 cap
  twice: per-section char budgets (goal 600, next_action/blocked 500,
  session summary 1200, 5 decisions × 280, phase list capped at 12 lines)
  whose worst-case sum is ~6.5k, plus a final enforceStatusLimit guard that
  slices to 10,000 and appends "…truncated — run harness status for full
  detail". The status block is stdout-only (SessionStart context), not a
  projection file — SPEC §Record layout lists no status.md. sessions/<id>.md
  are regenerated for every known session on every append (idempotent,
  O(sessions)); session ids come from outside, so filenames are sanitized
  ([^A-Za-z0-9._-] → _) to keep hostile ids inside sessions/. Rejected
  proportional (single-pool) budgeting: harder to reason about worst cases
  than fixed per-section caps.

- BD25: `harness init` mechanics — shim sources ship INSIDE the bundled CLI
  (esbuild `loader: {'.sh': 'text'}` + `declare module '*.sh'` in
  packages/engine/src/types.d.ts; root vitest.config.ts mirrors the loader
  with a sh-as-text plugin since tests import src directly); only dist/
  ships, so init never reads src/hooks/ at runtime. Idempotency is
  byte-level via write-if-changed. Ownership rules: shims are harness-owned
  (content kept current, chmod 0755); repo.md is hand-written (create-only,
  never overwritten); the CLAUDE.md protocol block installs once between
  `<!-- harness:protocol -->` markers and is never touched again (hand
  edits inside markers survive); settings.json/.mcp.json are merged —
  entries matched by command path / server name are skipped, an existing
  customized mcpServers.harness wins, and unparseable user JSON aborts
  init with exit 1 rather than risking a clobber. Rejected reading shims
  from the package dir (breaks packaging) and JSON-format-preserving
  edits (idempotency only needs OUR formatting to be stable).

- BD26: `harness new`/`switch` semantics — CLI-created events carry
  actor 'human', source 'cli', session 'cli' (AppendOptions gained an
  `actor?` override; MCP/hook appends stay 'agent'). new resolves the
  branch BEFORE creating anything so a bind failure leaves the repo
  untouched; --no-bind is the detached-HEAD/no-repo escape hatch; --goal
  omitted → non-empty placeholder goal (initiative_created requires goal,
  and an empty-string sentinel would fail schema validation). bindings.json
  writes are read-modify-write merges (other branches survive); switch
  refuses unknown slugs (typos must not create logs — BD16 rule extended
  to the CLI). Rejected binding "worktree name" instead of branch: SPEC
  §Record layout keys bindings by branch-or-worktree, and currentBranch()
  already resolves worktree HEADs to their branch.

- BD27: `harness status` render lives in src/projections/templates/status.ts
  as renderFullStatus (guard-rail: templates are the only template home),
  next to the capped renderStatus — same fold, different budget: the CLI
  print is uncapped with a per-task tree ([x]/[~]/[!]/[ ] markers) because
  the 10k cap is a SessionStart context budget (BD3), not a terminal
  constraint. Fold warnings go to stderr with exit 0 (a corrupt line must
  not hide status — CLAUDE.md tolerance rule); resolution failures exit 1
  with the BD16 typed message plus a CLI usage hint. Rejected reusing
  renderStatus for the CLI (caps would silently hide tasks) and putting the
  render in src/cli/ (template outside the template home).

- BD28: export/import CLI surface — both commands take an optional [slug]
  positional resolving like status (explicit wins, else branch binding,
  BD16); SPEC §CLI line extended to match (an export command that can only
  serve the bound initiative can't move a second initiative's log, which
  the BD19 field finding showed is a real workflow). Import summary is one
  parseable JSON line {"appended":N,"skipped":M}; stream warnings go to
  stderr; projections regenerate only when appended > 0 (an idempotent
  re-import rewrites nothing). Handlers take the already-read stream —
  commander wiring owns file/stdin IO so tests stay process-free.

- BD29: `harness serve` design — node:http only, bound 127.0.0.1 ONLY
  (localhost law), three routes and nothing else (/state, /state/<slug>,
  /events SSE; non-GET → 405, everything else → 404, slug path segments
  validated against [a-z0-9-]+ so a URL never walks the fs). chokidar
  watches .harness/initiatives/ recursively with basename filtering to
  events.jsonl (chokidar ≥4 dropped globs; projection writes are ignored
  by the filter), re-folds just the changed initiative, and pushes
  `event: state` + {slug, state} JSON — measured 51ms append→client,
  contract ≤500ms. startServer({root, port}) → {port, url, close} factory
  (port 0 = ephemeral for tests) awaits watcher-ready before resolving so
  appends right after startup are never missed; close() ends SSE clients,
  closes the watcher, and closeAllConnections() so no handle dangles.
  Heartbeat comment every 15s keeps proxies from reaping idle streams.
  A fold error on one initiative degrades to an empty state for that slug
  rather than a 500 (an endpoint that dies on one torn log is useless).
  renderFullStatus also gained a "Files touched" section during Phase 4
  acceptance (status must show the loop's file_touched; SPEC's status list
  is a floor, not a ceiling). Rejected express (dependency law), any
  static/UI route (scope law), and debouncing appends (latency budget is
  generous; consumers coalesce).

- BD30: `harness event append` — the convention-dialect surface (task 5.1).
  BD4 already named the command; SPEC §CLI's `harness event <subcommand>`
  umbrella covered it, and the SPEC line was extended to name append
  explicitly rather than leave the dialect surface undocumented. Flags:
  --type/--payload required, --session (default cli), --source (default
  cli), --actor (default agent), optional [slug] positional resolving like
  status (BD16). Unlike the hook subcommands it is NOT best-effort (BD22
  exemption): an explicit caller deserves real errors, so any failure —
  malformed/non-object payload JSON, unknown type, invalid payload, bad
  source/actor, unresolved initiative — exits 1 with the BD17 typed-error
  JSON on stderr and appends NOTHING; success prints {ok, event_id} JSON.
  All writes route through ToolContext.appendAndProject, keeping
  validate → append → regenerate the single mutation path. A session_ended
  appended via the dialect satisfies the Stop hook's fold-based write-back
  check identically to the MCP path (asserted in test/append.test.ts).
  Rejected a top-level `harness append`: BD4 fixed the name and grouping
  under `event` keeps the machine surface in one place. Rejected stdin
  payloads: one-line flag invocations are what convention-following agents
  compose reliably.
- BD31: AGENTS.md protocol block — `harness init` now installs
  AGENTS_PROTOCOL_BLOCK (src/cli/init.ts, beside PROTOCOL_BLOCK) into
  AGENTS.md with the SAME marker discipline as CLAUDE.md (same
  `<!-- harness:protocol -->` markers, create-if-missing,
  append-if-unmarked, never touched once markers exist); byte-level init
  idempotency still holds (hash-tree test covers AGENTS.md). SPEC §CLI init
  line extended (+ AGENTS.md). The block carries the same three BD19
  total-jurisdiction clauses but a CLI-only loop — orient via `harness
  status` (detail in plan.md/decisions.md), start/log/write-back via
  `harness event append`, write-back marked MANDATORY — because AGENTS.md
  readers (OpenCode, Codex, plain shells) cannot be assumed to have MCP or
  a blocking Stop hook; the MANDATORY clause is the compensating control.
  Plus explicit prohibitions: never hand-edit projections, never edit
  events.jsonl, corrections are new correction events. Rejected reusing
  PROTOCOL_BLOCK verbatim: its loop names harness_* MCP tools an MCP-less
  tool cannot call. Rejected different marker names per file: one
  discipline, hand-edits inside markers survive in both.
- BD32: OpenCode adapter = docs + simulated checklist, no plugin code
  (task 5.2). docs/opencode-adapter.md maps the hook surface to OpenCode
  plugin hooks (tool.execute.after ≈ PostToolUse via a shell-out to
  `harness event post-tool` with Claude-Code-shaped JSON; session
  lifecycle events ≈ SessionStart/SessionEnd shims) and states the gap
  explicitly: OpenCode has NO exit-2-blocking Stop equivalent — its idle
  signal is a notification, not a gate — so write-back there rests on the
  AGENTS.md dialect's MANDATORY clause as the compensating control. A
  future plugin is specified as thin shell-outs only (BD4): behavior,
  validation, and session correlation stay in the CLI. The doc's §3 manual
  verification checklist (12 steps, exact commands, expected events.jsonl
  lines and status output per step, including Stop-gate parity probes
  before/after the dialect session_ended and a negative probe proving
  invalid input appends nothing) is simulated 1:1 against the BUILT CLI in
  test/acceptance.phase5.test.ts, so the checklist cannot drift from real
  CLI behavior. The simulation proves checklist ACCURACY, not agent
  compliance — the manual OpenCode run stays pending as 5.3 ceremony prep
  and 5.2's checkbox stays open until it happens (the honest record beats
  the checkmark). Rejected building the plugin now: OpenCode's plugin API
  is outside the locked dependency window and the convention dialect is
  the contracted v1 fallback (SPEC §Acceptance Phase 5).
- BD33: serve also pushes on `addDir` of a new initiative directory, with
  a bounded wait (20×50ms) for its events.jsonl before folding (then
  pushes whatever exists). Cause: a dir created and populated in one burst
  (`harness new` while serve runs) can lose the file's `add` event to a
  chokidar/fsevents race — reproduced as a ~1-in-5 flake in serve.test.ts
  where the push never arrived. The SPEC 500ms SLA covers appends to
  existing logs (unchanged, still asserted at 500ms); the new-dir test
  asserts the push happens, not its speed. Rejected usePolling: constant
  cost to fix a first-push-only race. Rejected widening test timeouts
  alone: the miss was real product behavior, not test tightness.
- BD34: Protocol CLAUDE.md moved docs/ → repo root (ceremony prep, Jul 7).
  Claude Code auto-loads only a root CLAUDE.md; the 5.3 cold resume "from
  the record alone" needs that routing — a zero-context session must reach
  docs/harness.md without being told where to look. Internal references
  path-fixed (docs/harness.md, docs/SPEC.md); SPEC §Repo layout updated.
  Rejected a thin root pointer file to docs/CLAUDE.md: two protocol files
  drift; one file, one home.
- BD35: Root AGENTS.md added as a THIN ROUTER (Jul 7, after the Codex cold
  start failed). Codex/OpenCode-family tools auto-read AGENTS.md, not
  CLAUDE.md — BD34 fixed routing for Claude Code only, so the record's
  tool-agnostic resumability claim had a hole. The router points at
  docs/harness.md + docs/SPEC.md and defers all rules to CLAUDE.md (single
  source). Rejected a full protocol copy (one appeared untracked and was
  reshaped): duplicated rules drift — the exact reason BD34 rejected
  pointer+copy pairs. Both cold-resume dry runs proved agents follow
  multi-hop routing reliably. Also field-noted: a session must LAUNCH
  inside the repo — no root file can route a blank workspace (the failed
  Codex attempt started in ~/Documents/Codex/<date>, not the repo).
- BD37: Phase 6 (hardening + distribution readiness) added post-plan on
  user direction ("continue the development", Jul 7). Contents chosen as
  the gap between "SPEC-complete" and "shippable": README, installable
  tarball, atomic projection writes, version single-sourcing, repo.md
  surfacing. Scope law intact — no UI/sync/team/telemetry. Rejected
  starting post-v1 roadmap items (ui, sync): guard-rail violation inside
  the window; those need the user to reopen scope explicitly.
- BD36: serve now has a bounded reconciliation safety net for connected SSE
  clients (Jul 7 Codex resume). A full-suite run reproduced a remaining
  new-initiative miss: even the BD33 `addDir` fallback can fail to observe
  a create+populate burst on fsevents, leaving the client with no state
  event. The watcher remains the fast path, but while SSE clients are
  connected the server scans initiative log size/mtime every 250ms and
  broadcasts any changed log the watcher missed; versions are seeded after
  watcher ready, and no scan broadcasts when no clients are attached. This
  keeps the JSON-only localhost scope and preserves the SPEC 500ms existing
  append SLA (watcher path still asserts it). Rejected unbounded polling
  or static/UI work; rejected treating the failure as test-only because it
  reproduced the exact product path the test protects.
- BD38: Projection writes are atomic (task 6.3) — generator.ts writes every
  generated file (plan.md, decisions.md, sessions/*.md) to a uniquely-named
  `.<target>.<pid>.<random>.tmp` in the SAME directory, then renameSync over
  the target (atomic on POSIX same-fs), so serve's /state fold, a
  SessionStart fold, or a human tailing plan.md never observes a half-written
  projection; any write failure removes the temp file, and a unit test
  asserts no *.tmp lingers after repeated regeneration. Temp names are
  dot-prefixed and pid+random-suffixed so concurrent regenerations never
  collide, and serve's watcher (basename-filtered to events.jsonl) never
  fires on them. Generator keeps plain-overwrite semantics — checked: init's
  byte-level idempotency never depended on generator write-if-changed (init
  renders no projections), and the init hash-tree tests stay green. Rejected
  write-if-changed in the generator (a read per file per append to optimize
  nothing measured) and fsync ceremony (events.jsonl is truth; projections
  are regenerable).
- BD39: CLI version single-sourced (task 6.4) — src/cli/index.ts imports
  `version` from ../../package.json (tsconfig already had resolveJsonModule;
  esbuild inlines the named JSON import into the bundle) and passes it to
  program.version(); the hardcoded '0.1.0' literal is gone. Asserted in the
  existing built-CLI smoke (acceptance.phase4): `<bundle> --version` output
  equals the version field read from packages/engine/package.json at test
  time, so a bump can never drift. Rejected reading package.json at runtime
  with readFileSync(relative-to-bin): only dist/ ships inside a tarball
  whose package.json location differs between npm layouts — inlining at
  build time has no runtime path to get wrong.
- BD40: Repo memory in the SessionStart context (task 6.5) — .harness/repo.md
  (hand-written, SPEC §Record layout; nothing read it before) now surfaces as
  a "Repo memory (.harness/repo.md)" section in the session-start status
  block, placed after the goal/current sections and before the phase tree,
  with its OWN 1,500-char budget clipped by a dedicated marker ("…truncated —
  read .harness/repo.md for the rest") that preserves the author's line
  structure (clipBlock — unlike clip(), repo.md prose keeps its formatting).
  Missing, unreadable, empty, or still the byte-identical (trimmed) init stub
  → section omitted entirely. Split of responsibilities keeps the
  schema/templates law: the handler (src/cli/event.ts readRepoMemory) does IO
  + the stub check; budget/placement/rendering live in
  templates/status.ts (renderStatus gained an optional StatusOptions arg).
  The global ≤10k enforceStatusLimit guard is unchanged and re-proven with a
  ~50k repo.md at handler and built-CLI level (worst-case section sum rises
  ~6.5k → ~8k, still under the cap before the guard). SPEC §Hooks
  SessionStart line extended to name the repo-memory inclusion. Rejected
  folding repo.md into the goal budget (repo-scoped memory must not compete
  with initiative state) and rendering it in `harness status` too (the
  uncapped CLI print is initiative-scoped; repo.md is a context-injection
  concern — revisit on demand).
- BD41: Engine manifest reclassified for bundled-bin distribution (task 6.2)
  — ALL packages/engine "dependencies" (including "@harness/schema": "*",
  which is private/unpublished and made the old tarball uninstallable) moved
  to devDependencies, because dist/cli.js is fully esbuild-bundled and a
  consumer needs ZERO runtime deps; the BD7 dependency LAW is about the USED
  set, which is byte-identical (@modelcontextprotocol/sdk, commander,
  chokidar, ulid — still imported, still bundled; package-lock only gained
  "dev": true flags). Added "prepack": "node build.mjs" so any tarball
  carries a fresh build. VERIFIED: `npm pack` works fine with
  "private": true (private only blocks publish), so the engine STAYS private
  until the user green-lights publishing — flipping that flag is the only
  packaging step left. Tarball contents today: dist/cli.js + package.json
  (162 kB packed); npm auto-includes README* only from the PACKAGE dir and
  packages/engine has none yet — README handling lands with task 6.1.
  Guarded by test/packaging.test.ts, a real-channel E2E kept in the suite
  (BD1: npm IS the distribution channel): npm pack → npm install -g
  --prefix <tmp> → installed bin answers --version, installs zero deps
  (node_modules absent), and drives init → new → status in a fixture repo
  (npm_config_* env stripped so the child npm behaves like a user shell).
  Measured ~1s wall on a warm cache — no test-runner special-casing needed.
  Rejected publishing @harness/schema to make the old manifest installable
  (publishes an internal package nobody imports at runtime) and rejected
  removing "private" now (publish is a user decision, not a build gate).
- BD42: README.md at repo root (task 6.1) — terse/factual npm front door in
  the docs' register (no marketing voice, badges, or emoji): what harness is
  (truth in events.jsonl, everything else generated projections), honest
  pre-publish install (pack a tarball from a checkout; `npm install -g
  harness` only "once published"), quickstart (init → new → work loop →
  status), the three integration surfaces (MCP tools; hook shims incl. the
  Stop write-back gate; AGENTS.md CLI dialect with mandatory write-back),
  the SPEC §Record layout diagram verbatim, a one-line-per-command CLI
  table, and links to docs/SPEC.md + docs/harness.md. Tarball README: ONE
  source at repo root — engine "prepack" copies it into packages/engine
  (npm auto-includes README.md even with files:["dist"] — verified in the
  tarball listing), "postpack" deletes the copy, and .gitignore excludes it
  so it can never be committed and drift (the BD34/BD35 no-pointer+copy
  rule, kept by generating the copy at pack time only); packaging E2E now
  asserts the installed package carries the README and the engine dir is
  clean after pack. Rejected a hand-maintained packages/engine/README.md
  (two front doors drift) and rejected symlinking (npm pack follows
  symlinks inconsistently across platforms).

## Repo knowledge
- Contracts: SPEC.md is authoritative for envelope, tools, layout,
  acceptance criteria. If code and SPEC disagree, SPEC wins; log a decision
  if SPEC must change.
- Test command: `npm test` (vitest). Build: `npm run build` (esbuild).
  Both run at the workspace root; typecheck: `npm run typecheck`.
- Monorepo (BD11): npm workspaces. packages/schema → @harness/schema
  (source-shipped, no build); packages/engine → harness bin
  (packages/engine/dist/cli.js after build).
- Definition of done per task: acceptance criteria in SPEC.md §Acceptance.
- Boundary (cold-resume dry run, Jul 7): harness-docs/ (00-spine, 01-roadmap,
  02-action-plan, 03-architecture) and the Phase 0 scorecard live OUTSIDE
  this repo in the user's strategy vault. Engine sessions never need them;
  5.3 scoring is performed by the user against that scorecard. Do not go
  looking for them; do not block on them.
- Push policy: push origin main at each verified wrap-up (user-established
  Jul 3). Pushing is part of ending a work batch, not per-commit.
- Dogfooding semantics: this repo tracks itself via the PROTOCOL (prose
  record in docs/harness.md), not via an installed .harness/ record — the
  built tooling is exercised in tests and fixtures. "Write back via
  protocol" in 5.3 means: session log + current state in docs/harness.md.

## Session log
- 2026-07-03 (claude-code / Fable 5): Phase 1 complete, tasks 1.1–1.6, one
  commit per task. Repo git-initialized at repo root (docs/ untouched).
  Built: scaffold (TS strict/vitest/esbuild/bin entry), envelope +
  validation in src/core/envelope.ts, atomic O_APPEND append in
  src/core/log.ts, fold/replay in src/core/fold.ts with payload schemas
  isolated in src/schema/events.ts, cursor export/import in
  src/core/cursor.ts, consolidated acceptance suite in
  test/acceptance.phase1.test.ts. 86 tests green; all four SPEC Phase 1
  acceptance bullets verified (4-process×250 appends zero loss; corrupt
  line skip+warn; deterministic replay; idempotent import). New decisions
  BD7–BD10 (toolchain devDeps; correction voids target; derived current.*;
  monotonic ulids — default ulid() is NOT sortable within one ms).
  Left off: nothing in flight. Next action: Task 2.1 — stdio MCP server
  (src/mcp/server.ts + one file per tool, per SPEC §MCP tools).
- 2026-07-03, same session, later (claude-code / Fable 5): Restructured to
  npm workspaces monorepo on user direction (BD11) — packages/schema
  (@harness/schema) + packages/engine (harness bin). git mv preserved
  history; fold now imports @harness/schema across the boundary. SPEC
  §Repo layout, CLAUDE.md schema guard-rail, task 2.3 text updated. All 86
  tests green post-move; build + bin verified at
  packages/engine/dist/cli.js. Next action unchanged: Task 2.1 — stdio MCP
  server in packages/engine/src/mcp/.
- 2026-07-03, same session, later (claude-code / Fable 5, Phase 2 executed
  by a delegated subagent, verified by the main session): Phase 2 complete,
  tasks 2.1–2.5, commits c110cb0/7a07e35/79eec16/0b4b896. Built: stdio MCP
  server on the SDK low-level API (no zod — BD12), seven harness_* tools
  (validate → append → regenerate projections), tool arg schemas in
  packages/schema/src/tool-inputs.ts, v0 projection seam
  (generator.ts + templates/{shared,plan,decisions}.ts — BD14), `harness
  mcp [--root]` subcommand (BD13, SPEC §CLI updated), .mcp.json snippet
  emitter. Decisions BD12–BD18. Tests 86 → 135, all green; verification
  independently re-run by main session (typecheck/test/build + raw
  JSON-RPC stdio smoke test: session lifecycle, typed invalid_input error
  with zero appends, projections regenerated). All three SPEC Phase 2
  acceptance bullets pass. Left off: nothing in flight. Next action: Task
  3.1 — hook shims (needs `harness event append` CLI surface first).
- 2026-07-06 (claude-code / Fable 5, Phases 3+4 executed by two sequential
  delegated subagents, each verified by the main session): Phase 3 complete
  (3.1–3.6, commits 1936009..047f324): `harness event` CLI surface, four
  POSIX shims, session correlation by log adoption (BD20), session_closed
  event (BD21), best-effort hook philosophy (BD22), PostToolUse mapping
  (BD23), full projections with hard ≤10k status cap (BD24). Phase 4
  complete (4.1–4.5, commits 4793d32..d0d4905): idempotent `harness init`
  with bundled shim text + BD19 total-jurisdiction protocol block (BD25),
  new/switch with branch binding (BD26), uncapped status (BD27),
  export/import CLI (BD28, SPEC [slug] positional), 127.0.0.1-only serve
  with SSE (BD29, measured 51ms push). Tests 185 → 222 after Phase 3+4
  (135 → 185 → 222). Main-session verification: full gate re-run; live
  hook-flow smoke (session-start context, Stop exit 2 with byte-exact
  stderr, loop guard, MCP adoption returning the hook session id, Stop
  passing after end_session); built-CLI init/new/status smoke; byte-level
  double-init idempotency (zero changes). Left off: nothing in flight.
  Next action: Phase 5 — 5.1 AGENTS.md dialect (carry the three BD19
  clauses; reuse PROTOCOL_BLOCK in src/cli/init.ts), 5.2 OpenCode adapter
  notes, 5.3 the Jul 7 Fable→Opus handoff ceremony (user-driven).
- 2026-07-06, later (claude-code / Fable 5, Phase 5 prep by delegated
  subagent, verified by main session): 5.1 done (commit b47dd00):
  `harness event append` dialect surface (BD30), AGENTS.md protocol block
  installed by init with BD19 clauses + mandatory write-back (BD31); Stop
  gate parity between dialect append and MCP end_session proven at handler
  and built-CLI level. 5.2 documented + simulated (commit 9831a04, BD32):
  docs/opencode-adapter.md with plugin mapping, the no-blocking-Stop gap
  called out, 12-step manual checklist simulated 1:1 in
  acceptance.phase5.test.ts — checkbox stays OPEN pending the manual
  OpenCode run. Main-session verification caught a real ~1-in-5 flake the
  agent's single green run missed: chokidar/fsevents drops the file add
  event when a new initiative dir is created+populated in one burst →
  serve never pushed. Fixed in serve.ts via addDir + bounded log wait
  (BD33, commit follows); serve suite then 12/12 clean, full suite 235
  green. Tests 222 → 235. Left off: nothing in flight. Next actions:
  (1) manual OpenCode checklist run (docs/opencode-adapter.md §3) → flip
  5.2; (2) 5.3 ceremony Jul 7 — Fable writes back via protocol, Opus 4.8
  cold-resumes from the record, scored as arm-C.
- 2026-07-07 (claude-code / Fable 5) — CEREMONY PREP + FINAL FABLE
  WRITE-BACK: (1) BD34 — protocol CLAUDE.md moved to repo root with paths
  fixed so a zero-context session auto-loads the routing chain. (2) Cold
  resume DRY RUN passed: a zero-context subagent oriented via
  CLAUDE.md → docs/harness.md → docs/SPEC.md alone, reconstructed all
  phases/constraints/decisions, verified 235/235 tests, asked nothing.
  Its four gaps are fixed as Repo knowledge notes: harness-docs/ +
  Phase 0 scorecard are OUTSIDE this repo (user-held, never block on
  them); push policy (push at verified wrap-ups); dogfooding semantics
  ("write back via protocol" = session log + current state in
  docs/harness.md — no installed .harness/ here). (3) OpenCode manual
  checklist (docs/opencode-adapter.md §3): steps 1–3 executed in a
  fixture — every expected outcome matched (AGENTS.md markers, 2-line
  log, pending v1 in plan.md). The agent run itself (steps 4–12) was
  blocked by the session permission gate (external autonomous agent needs
  explicit user authorization) — it remains the operator's run; 5.2 stays
  open. THIS ENTRY IS THE FABLE WRITE-BACK FOR 5.3. Left off: nothing in
  flight; suite 235 green at HEAD. Next action (user): (a) run checklist
  steps 1–3 + the `opencode run` prompt from docs/opencode-adapter.md §3,
  verify outcomes 4–12, flip 5.2; (b) start a FRESH Claude Code session
  on Opus 4.8 in this repo with only "resume this initiative" as the
  prompt, let it orient from the record alone, and score the handoff as
  an arm-C run on the Phase 0 scorecard. The record is ready.
- 2026-07-07, later (claude-code / Fable 5) — COLD RESUME PROBE (not the
  arm-C run): fresh session, prompt "resume this initiative" only; oriented
  via root CLAUDE.md → docs/harness.md → docs/SPEC.md, asked nothing.
  Verified the record's claimed state holds at HEAD 2d9f9bc: clean tree,
  235/235 tests green. NOTE: this session ran on Fable 5 — the /model
  default was switched to Fable 5 immediately before launch — but arm-C
  requires Opus 4.8, so this run does not satisfy 5.3's scoring leg; it
  counts only as a second successful cold-resume dry run. No code changes.
  Left off: nothing in flight. Next action (user, unchanged): (a) OpenCode
  checklist run per docs/opencode-adapter.md §3, then flip 5.2; (b) fresh
  session on OPUS 4.8 (switch via /model first) with only "resume this
  initiative", scored as arm-C on the user-held Phase 0 scorecard.
- 2026-07-07, later (codex / GPT-5) — COLD RESUME + WATCHER HARDENING
  (not the arm-C run): oriented via root AGENTS.md → docs/harness.md →
  docs/SPEC.md → CLAUDE.md, asked nothing, and confirmed the remaining
  initiative work is user-driven. Verification initially caught a real
  serve regression in the already-known new-initiative SSE path: full
  `npm test` failed 234/235 because `serve.test.ts` timed out waiting for
  the fresh-log push. Fixed packages/engine/src/cli/serve.ts with BD36:
  watcher remains the fast path, plus a 250ms connected-client
  reconciliation of events.jsonl size/mtime for missed filesystem events.
  Verification after the fix: focused serve suite 5/5, `npm run
  typecheck`, full `npm test` 235/235, and `npm run build` all green.
  Left off: no implementation work in flight. Next action (user,
  unchanged): (a) OpenCode checklist run per docs/opencode-adapter.md §3,
  then flip 5.2; (b) fresh Claude Code session on OPUS 4.8 with only
  "resume this initiative", scored as arm-C on the user-held Phase 0
  scorecard.
- 2026-07-07, later (claude-code / Opus 4.8 [1m]) — THE ARM-C RESUME
  (5.3 handoff execution leg — the run the two prior probes could not be):
  fresh session, prompt "resume this initiative" only. Oriented from the
  record alone — root CLAUDE.md (auto-loaded) → docs/harness.md →
  docs/SPEC.md — reconstructed the full phase/decision/guard-rail state,
  confirmed the remaining work is user-side, and asked the user nothing.
  This session runs on Opus 4.8 (1M-context variant, model id
  claude-opus-4-8[1m]) — the model arm-C requires — so unlike the Fable 5
  and Codex/GPT-5 cold-resume probes it satisfies 5.3's model condition;
  only the SCORING against the user-held Phase 0 scorecard remains.
  RACE (field finding): at session start the record showed Phase 5 as the
  frontier and HEAD 7e9aff2; I verified that snapshot (clean tree, 235/235,
  22 files, typecheck + build green) and wrote back. Between my verify and
  my commit, a CONCURRENT Fable 5 session working in the SAME working tree
  built and committed all of Phase 6 (BD37–BD42, commits 50aaf4b..2da65f5)
  and swept my still-uncommitted record edit into its 2da65f5 commit. I
  re-based on the new HEAD and re-verified: clean tree, 245/245 (23 files)
  at HEAD 2da65f5 == origin/main. The arm-C demonstration still holds —
  Opus 4.8 resumed from the record alone and asked nothing — but the hazard
  surfaced is operational: two Claude sessions sharing one working tree
  interleave record edits, so ceremony/parallel runs should use separate
  clones or git worktrees, not one checkout. No code changes by this
  session. Left off: nothing in flight; suite 245/245 green at HEAD
  2da65f5. Next action (user): (a) SCORE this resume as the arm-C run on
  the Phase 0 scorecard — that closes 5.3's handoff leg; (b) OpenCode
  checklist run per docs/opencode-adapter.md §3, then flip 5.2. 5.3's
  checkbox stays open until the arm-C scoring is recorded (honest record
  over checkmark, per BD32's principle).
- 2026-07-07, later (claude-code / Fable 5, Phase 6 by delegated subagent,
  verified by main session): Phase 6 complete, tasks 6.1–6.5, commits
  50aaf4b..3b118b6, decisions BD38–BD42. Atomic projection writes
  (temp+rename), CLI version single-sourced from package.json, repo.md now
  surfaces in the SessionStart context with a 1,500-char budget (10k cap
  holds against a 50k repo.md), engine tarball installs with ZERO runtime
  deps (bundled-bin pattern; deps reclassified to devDependencies — used
  set unchanged, BD7 law intact), root README as the npm front door.
  Tests 235 → 245. Main-session verification: full gate green; independent
  pack → global-install into temp prefix → installed binary ran init/new/
  session-start (Repo memory section rendered)/status. Publishing remains
  a user decision (flip engine "private", npm publish — schema does NOT
  need publishing; it is bundled). Left off: nothing in flight. Next
  action (user, unchanged): 5.2 manual OpenCode run, 5.3 arm-C scoring on
  Opus 4.8. Engine is feature-complete AND shippable.
