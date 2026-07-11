# Repo memory — sofar

- Product renamed harness → sofar on 2026-07-07 (BD49-revised, BD50):
  CLI/bin `sofar`, packages sofar-monorepo + @sofar/schema + sofar, MCP
  server "sofar" with sofar_* tools, record dir `.sofar/`. No back-compat
  aliases (pre-publish). Historical event/projection text and the archived
  docs still say harness — that is history, never rewritten.
- Contracts: docs/SPEC.md is authoritative for envelope, tools, layout,
  acceptance criteria. If code and SPEC disagree, SPEC wins; log a decision
  if SPEC must change.
- Test command: `npm test` (vitest). Build: `npm run build` (esbuild).
  Both run at the workspace root; typecheck: `npm run typecheck`.
- Monorepo (BD11): npm workspaces. packages/schema → @sofar/schema
  (source-shipped, no build); packages/engine → sofar bin
  (packages/engine/dist/cli.js after build).
- Definition of done per task: acceptance criteria in docs/SPEC.md
  §Acceptance.
- Boundary: harness-docs/ (00-spine, 01-roadmap, 02-action-plan,
  03-architecture — pre-rename dir name, kept) and the Phase 0 scorecard
  live OUTSIDE this repo in the user's strategy vault. Engine sessions
  never need them; 5.3 scoring is performed by the user against that
  scorecard. Do not go looking for them; do not block on them.
- Push policy: push origin main at each verified wrap-up (user-established
  Jul 3). Pushing is part of ending a work batch, not per-commit.
- Dogfooding semantics: this repo SELF-HOSTS — it tracks itself via its own
  installed sofar record (.sofar/initiatives/harness-build/, migrated
  2026-07-07, BD47; initiative slug keeps the original name as history).
  docs/harness.md is the archived pre-migration prose record (superseded
  banner at its top); it stays readable for the ceremony history but is
  never written again. Write-back means the sofar record: MCP tools or
  `sofar event append`, per the installed protocol blocks.
- Hooks (.claude/hooks/*.sh) and .mcp.json both exec the GLOBAL `sofar`
  from PATH (installed under ~/.local, npm prefix override needed:
  `npm install -g --prefix ~/.local @alignlabs/sofar@latest`). After each
  npm publish, upgrade the global install — otherwise this repo dogfoods
  a stale engine (found 2026-07-10: hooks ran the Jul-7 0.1.0 build for
  three days; injected status was missing the rejected-approaches ledger).
  A running Claude Code session keeps its already-launched MCP server;
  new binary takes effect on the next session (or /mcp reconnect).
- Commit messages: NO "Co-Authored-By" trailers — user ruling
  2026-07-11; end the message after the descriptive body.
