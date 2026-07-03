# Initiative: harness-build (v1 engine)

## Goal
Build the Harness v1 engine during the Fable 5 window (Jul 3–7): event log
core, MCP server, Claude Code hooks, projections, CLI, watcher/state server,
and the AGENTS.md dialect. Engine only — schema lives in one swappable
module; UI/sync/team are explicitly out of scope. Full contracts in SPEC.md.
Conventions and protocol in CLAUDE.md. Strategy context in harness-docs/
(00-spine, 01-roadmap, 02-action-plan, 03-architecture).

## Current state
- Active phase: 1
- Next action: Task 1.6 — Phase 1 acceptance test suite
- Blocked on: nothing

## Plan

### Phase 1 — Event log core [active]  (target: Jul 3)
- [x] 1.1 Scaffold: TS strict, vitest, esbuild bundling, npm bin entry
- [x] 1.2 Event envelope types + runtime validation (SPEC §Envelope)
- [x] 1.3 Append: atomic single-line O_APPEND writes, concurrent-safe
- [x] 1.4 Fold/replay: events.jsonl → InitiativeState (SPEC §State)
- [x] 1.5 Cursor primitive: export/import "events since N" (sync-ready)
- [ ] 1.6 Tests: concurrent appends, corrupt-line tolerance (skip+warn),
      replay determinism, cursor round-trip

### Phase 2 — MCP server [pending]  (target: Jul 4)
- [ ] 2.1 stdio MCP server exposing typed tools (SPEC §MCP tools)
- [ ] 2.2 Tools: get_state, start_session, end_session, update_task,
      log_decision, update_plan, add_note
- [ ] 2.3 Payload schemas isolated in src/schema/ (the ONLY schema home)
- [ ] 2.4 .mcp.json registration snippet emitted by init (Phase 4 wires it)
- [ ] 2.5 Tests: every tool appends correct event; state reflects it

### Phase 3 — Hooks + projections [pending]  (target: Jul 5)
- [ ] 3.1 Hook shims in .claude/hooks/ as standalone scripts calling the CLI
      (portability rule — no inline command logic)
- [ ] 3.2 SessionStart shim: emit projection as context, ≤10,000 chars
- [ ] 3.3 PostToolUse shim (matcher Edit|Write|MultiEdit|Bash): append
      file_touched / command_run mechanical events
- [ ] 3.4 Stop shim: if no session_ended event for this session → exit 2
      with "write back to the record"; MUST check stop_hook_active guard
- [ ] 3.5 SessionEnd shim: mechanical close event (fallback logging only)
- [ ] 3.6 Projection generator: templates → plan.md, decisions.md, status
      block; regenerated on every append; never hand-edited

### Phase 4 — CLI + watcher [pending]  (target: Jul 6)
- [ ] 4.1 `harness init`: scaffold .harness/, install hook shims + settings,
      emit .mcp.json entry, append protocol block to CLAUDE.md
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

## Repo knowledge
- Contracts: SPEC.md is authoritative for envelope, tools, layout,
  acceptance criteria. If code and SPEC disagree, SPEC wins; log a decision
  if SPEC must change.
- Test command: `npm test` (vitest). Build: `npm run build` (esbuild).
- Definition of done per task: acceptance criteria in SPEC.md §Acceptance.

## Session log
- (empty — first build session appends here)
