# Initiative: harness-build (v1 engine)

## Goal
Build the Harness v1 engine during the Fable 5 window (Jul 3–7): event log
core, MCP server, Claude Code hooks, projections, CLI, watcher/state server,
and the AGENTS.md dialect. Engine only — schema lives in one swappable
module; UI/sync/team are explicitly out of scope. Full contracts in SPEC.md.
Conventions and protocol in CLAUDE.md. Strategy context in harness-docs/
(00-spine, 01-roadmap, 02-action-plan, 03-architecture).

## Current state
- Active phase: 3
- Next action: Task 3.3 — PostToolUse handler (`harness event post-tool`):
  Edit|MultiEdit → file_touched op edit, Write → op write, Bash →
  command_run; then 3.4 stop, 3.5 session-end, 3.6 full projections
  (renderStatus ≤10k + sessions/<id>.md), 3.2 session-start printing the
  capped status block
- Blocked on: nothing

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

### Phase 3 — Hooks + projections [active]  (target: Jul 5)
- [x] 3.1 Hook shims in .claude/hooks/ as standalone scripts calling the CLI
      (portability rule — no inline command logic)
- [ ] 3.2 SessionStart shim: emit projection as context, ≤10,000 chars
- [x] 3.3 PostToolUse shim (matcher Edit|Write|MultiEdit|Bash): append
      file_touched / command_run mechanical events
- [x] 3.4 Stop shim: if no session_ended event for this session → exit 2
      with "write back to the record"; MUST check stop_hook_active guard
- [x] 3.5 SessionEnd shim: mechanical close event (fallback logging only)
- [ ] 3.6 Projection generator: templates → plan.md, decisions.md, status
      block; regenerated on every append; never hand-edited

### Phase 4 — CLI + watcher [pending]  (target: Jul 6)
- [ ] 4.1 `harness init`: scaffold .harness/, install hook shims + settings,
      emit .mcp.json entry, append protocol block to CLAUDE.md — block MUST
      assert total jurisdiction (SPEC §CLI field finding Jul 4, BD19)
- [ ] 4.2 `harness new <slug>` / `harness switch <slug>`: initiative dirs +
      bindings.json (branch ↔ initiative)
- [ ] 4.3 `harness status`: fold + print tree (phase/task/status/next)
- [ ] 4.4 `harness export --since <cursor>` / `harness import`
- [ ] 4.5 Watcher + localhost JSON state server (no UI — endpoint only)

### Phase 5 — Dialect + forced handoff [pending]  (target: Jul 7)
- [ ] 5.1 AGENTS.md protocol block (convention dialect for MCP-less tools)
- [ ] 5.2 OpenCode adapter notes: plugin equivalents (tool.execute.before/
      after) documented; convention fallback verified manually
- [ ] 5.3 THE CEREMONY: final Fable session writes back via protocol;
      Opus 4.8 resumes this initiative from the record alone; score the
      handoff as a real arm-C run on the Phase 0 scorecard

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
