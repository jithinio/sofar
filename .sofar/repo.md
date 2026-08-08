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
- Committing the record needs a BARE git call (repo-memory-capture M2): the
  D1 exemption (cli/event.ts shellSegments) splits on every shell separator
  INCLUDING newlines and exempts only if EVERY segment leads with git or
  sofar. `git add -A && git commit -F msg.txt` is exempt; a heredoc
  (`git commit -F - <<'EOF'`) is NOT — the message body's lines scan as
  segments leading with prose. Mixing in echo/printf defeats it identically.
  Symptom: write back, commit, and the tree is dirty again with command_run
  events about the commit itself. Put the message in a file, use
  `git commit -F <path>`, and keep status/diff checks bare.
- Release command (repo-memory-capture M1): `npm publish -w sofar.sh` from the repo root (or bare
  `npm publish` from inside packages/engine) — always run by the USER (OTP
  + permission classifier), agent stages everything up to it. Bare
  `npm publish` at the root targets the PRIVATE monorepo package and would
  tarball the entire repo including .sofar/ records; the root
  package.json's `"private": true` is the guard that blocks it (EPRIVATE,
  hit 2026-08-04) — never remove that field. An expired npm token surfaces
  as E404 on the publish PUT (npm masks auth errors); `npm whoami`
  returning E401 confirms it, `npm login` fixes it.
- Misrouted sessions are silent (repo-memory-capture M3): a session rooted in
  this repo fires the hooks on EVERY tool call, and with no explicit pin the
  branch binding decides where they land. A session working on a DIFFERENT
  initiative here must call sofar_start_session with an explicit `initiative`
  as its first act. Doctor cannot catch the failure: its Session routing axis
  only detects sessions SPANNING 2+ initiatives; events landing uniformly in
  one WRONG initiative are byte-identical to correct work and it reports "no
  problems found". Symptom: a closed initiative's tree goes dirty seconds
  after a clean commit, its banner shows "N other session(s) did work without
  writing back", and its next action reads stale — all from a concurrent
  session unrelated to it. Observed 2026-08-05 (session a18d80d0's
  session-strategy-bench harvest filed under repo-memory-capture).
- Dogfooding semantics: this repo SELF-HOSTS — it tracks itself via its own
  installed sofar record (.sofar/initiatives/harness-build/, migrated
  2026-07-07, BD47; initiative slug keeps the original name as history).
  docs/harness.md is the archived pre-migration prose record (superseded
  banner at its top); it stays readable for the ceremony history but is
  never written again. Write-back means the sofar record: MCP tools or
  `sofar event append`, per the installed protocol blocks.
- Hooks (.claude/hooks/*.sh) and .mcp.json both exec the GLOBAL `sofar`
  from PATH (installed under ~/.local, npm prefix override needed:
  `npm install -g --prefix ~/.local sofar.sh@latest`). After each
  npm publish, upgrade the global install — otherwise this repo dogfoods
  a stale engine (found 2026-07-10: hooks ran the Jul-7 0.1.0 build for
  three days; injected status was missing the rejected-approaches ledger).
  A running Claude Code session keeps its already-launched MCP server;
  new binary takes effect on the next session (or /mcp reconnect).
  Corollary: to WRITE events using a feature not yet in the global install
  (a new status, a new event type), the in-session MCP tools will reject it
  — go through the freshly built local engine instead:
  `node packages/engine/dist/cli.js event append <slug> --type … --payload …`.
- Commit messages: NO "Co-Authored-By" trailers — user ruling
  2026-07-11; end the message after the descriptive body.
- Zero model API calls (felt-cost D3): sofar itself never calls a model — no
  API keys, no inference costs, no user content sent anywhere. Write-backs
  cost nothing extra because they are the agent's own tool-call args.
  Cheap-model or Batch-API bookkeeping is rejected; revisiting requires a new
  Decision citing that one. Binds every surface, including the statusline.
- CLI output law (cli-ui D1): styled static output + stderr spinners at the
  emit()/renderer boundary; semantic ANSI-16 only (green=success, red=error,
  cyan=identifiers, dim=secondary) — no hex for text, no background
  detection; degradation ladder NO_COLOR > --no-color > FORCE_COLOR > TTY;
  animation only when isTTY && !CI. Agent-facing surfaces — renderStatus
  digest, hook stdout, NDJSON, MCP stdio — are guaranteed BYTE-PLAIN. Every
  new CLI surface inherits this; no TUI framework, no truecolor themes.
- Emitted-directive version gating (scanner-version-gate M1): any Tailwind
  directive sofar writes into a host stylesheet is gated on the host's
  INSTALLED tailwindcss version — `@source not` needs >=4.1; on 4.0.x it
  fails the host build ("`@source` paths must be quoted"). Establish such
  boundaries from the artifact, never a changelog: `npm pack tailwindcss@X`,
  untar, grep dist/ for the parse site. Second rule from the same bug:
  Tailwind resolves every path relative to the STYLESHEET, so suggested
  directives are computed per stylesheet (like sofarExclusionDirective) and
  live-fired with `npx @tailwindcss/cli -i <entry> -o /dev/null` first.
- Searching fold.ts (record-index M1): packages/engine/src/core/fold.ts holds
  literal NUL bytes (a map key built as `${index}\0${session}\0${subject}`), so
  grep and ripgrep call it binary and print NOTHING — silently, exit 0. A
  symbol that lives there reads as nonexistent. Use `rg -a`/`grep -a` on that
  file, or follow the import from a module that uses the symbol.
- Deliberately NOT promoted: felt-cost D4 (the `sofar statusline`
  subcommand) is a feature contract, not repo-wide law — docs/SPEC.md and the
  code already describe it, and the parts that generalize are covered by
  felt-cost D3 (zero model calls) and BD22 (best-effort, never break the
  session). Named here so doctor's repo-memory axis reads as judged rather
  than unnoticed (2026-08-03).
