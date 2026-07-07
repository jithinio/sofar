# Repo memory — harness-build

- Contracts: docs/SPEC.md is authoritative for envelope, tools, layout,
  acceptance criteria. If code and SPEC disagree, SPEC wins; log a decision
  if SPEC must change.
- Test command: `npm test` (vitest). Build: `npm run build` (esbuild).
  Both run at the workspace root; typecheck: `npm run typecheck`.
- Monorepo (BD11): npm workspaces. packages/schema → @harness/schema
  (source-shipped, no build); packages/engine → harness bin
  (packages/engine/dist/cli.js after build).
- Definition of done per task: acceptance criteria in docs/SPEC.md
  §Acceptance.
- Boundary: harness-docs/ (00-spine, 01-roadmap, 02-action-plan,
  03-architecture) and the Phase 0 scorecard live OUTSIDE this repo in the
  user's strategy vault. Engine sessions never need them; 5.3 scoring is
  performed by the user against that scorecard. Do not go looking for them;
  do not block on them.
- Push policy: push origin main at each verified wrap-up (user-established
  Jul 3). Pushing is part of ending a work batch, not per-commit.
- Dogfooding semantics: this repo SELF-HOSTS — it tracks itself via its own
  installed harness record (.harness/initiatives/harness-build/, migrated
  2026-07-07, BD47). docs/harness.md is the archived pre-migration prose
  record (superseded banner at its top); it stays readable for the ceremony
  history but is never written again. Write-back means the harness record:
  MCP tools or `harness event append`, per the installed protocol blocks.
