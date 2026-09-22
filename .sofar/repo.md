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
  A fresh worktree needs `npm ci` then `npm run build` first (r1-fixes M1):
  dist/ is gitignored and spawn-based suites execute dist/cli.js.
  Load-flaky under a busy full run (branch-visibility M1): reach-index's
  "3.5 lexical seeds" case and shim-latency's 100 ms SessionStart budget.
  Rerun the file alone (`npx vitest run <file>`); a pass alone means load.
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
- Version label after an RC tag (r1-fixes M7): main's engine version carries
  semver build metadata (`0.33.0-rc.2+trunk`), so a main build is never
  mistaken for the tagged RC. Only the tag's commit has the bare RC string,
  and benches run the ~/.bench copy built from the tag.
- Boopada bench runners (bench-refresh M1, M2) run as launchd agents
  (com.sofar.bench.round1.*), never nohup from a Claude Code Bash call. The
  host must stay on AC power with the lid open: caffeinate cannot stop
  clamshell or battery sleep. Simultaneous timedOut rows mean sleep; check
  `pmset -g log`. A lone Cursor failed row with null usage whose transcript
  ends in `turn_ended` success is a hang behind a stray background server (L23).
- Round-1 rescores use round 1's FROZEN tests (bench-refresh M3): the round-1
  runner copy's hidden-tests/ (= 9f1e1cb), never handoff-bench's own, which is
  round 2's tree since 6999515. The analysis scripts default to the copy and
  patch with -N; "Reversed (or previously applied) patch" means the wrong tree.
- Committing the record needs a BARE git call (repo-memory-capture M2): the
  D1 exemption (cli/event.ts shellSegments) splits on every shell separator
  INCLUDING newlines and exempts only if EVERY segment leads with git or
  sofar. `git add -A && git commit -F msg.txt` is exempt; a heredoc
  (`git commit -F - <<'EOF'`) is NOT — the message body's lines scan as
  segments leading with prose. Mixing in echo/printf defeats it identically.
  Symptom: write back, commit, and the tree is dirty again with command_run
  events about the commit itself. Put the message in a file, use
  `git commit -F <path>`, and keep status/diff checks bare.
- Commit WITH A PATHSPEC in the shared checkout (typed-judge M1): every live
  session on main shares ONE git index, so a peer's plain `git commit` takes
  whatever anyone has staged. Staging by explicit path is not enough.
  Use `git commit -F <msgfile> -- <paths>`. Observed 2026-09-22: typed-judge's
  4.2/4.3 code landed in drive-visibility's record commit d0ebec9.
- Version bumps touch FOUR places (drive-visibility M5, corrected by M6):
  (1) packages/engine/package.json — `version` plus five sofar-core optional
  deps (darwin-arm64, darwin-x64, linux-x64, linux-arm64, win32-x64);
  (2) package-lock.json — the same six; (3) packaging/npm/sofar-core-*/
  package.json — each platform package's own `version`, which packaging.test
  asserts equals the engine's; (4) two conformance goldens that embed it,
  re-recorded with SOFAR_CONFORMANCE_RECORD=1 (append to golden/MANIFEST.md,
  never rewrite its older entries). Replace globally, then self-check before
  committing — parses as JSON, zero occurrences of the old string, engine
  version equal to the new one, exactly five sofar-core deps pinned to it —
  and run the packaging and conformance suites, which catch (3) and (4).
  Never `npm install --package-lock-only`: it can reach the network.
- A vitest file that fails to LOAD reads as "not run", never as a failure
  (drive-visibility M7): the suite still says PASSED while covering less.
  Compare test COUNTS against the base whenever the environment differs —
  a release gated on a suite that quietly skipped a file is not gated.
- A release branch in a git WORKTREE needs its own node_modules (M6): a
  symlink to the main checkout's carries npm's workspace links, which point
  at the MAIN tree, so the packaging test reads main's version and fails.
  Link `sofar.sh` and `@sofar/schema` into the worktree itself.
- Tags: an UNPUSHED tag may be deleted and re-cut (drive-visibility M8) —
  nobody has seen it, and shipping notes known to be wrong is the real
  damage. Once PUSHED, a correction is a NEW tag, never a move: no
  `git tag -f`, no delete-and-repush. The rule is "never rewrite what
  someone else has seen", not "never move a tag".
- Release command (repo-memory-capture M1): `npm publish -w sofar.sh` from the repo root (or bare
  `npm publish` from inside packages/engine) — always run by the USER (OTP
  + permission classifier), agent stages everything up to it. Bare
  `npm publish` at the root targets the PRIVATE monorepo package and would
  tarball the entire repo including .sofar/ records; the root
  package.json's `"private": true` is the guard that blocks it (EPRIVATE,
  hit 2026-08-04) — never remove that field. An expired npm token surfaces
  as E404 on the publish PUT (npm masks auth errors); `npm whoami`
  returning E401 confirms it, `npm login` fixes it.
- RELEASE GATE, user ruling 2026-08-13 (commit-attribution M7): do NOT
  publish while commit-attribution is unfinished — let the whole thing
  land, then publish once. Attribution is a CHAIN (hook writes the
  trailer → core/attribution.ts reads it → doctor reports whether it
  works → the shipping notice and review packet consume it), so a
  partial release puts users in the worst state available: a hook
  writing trailers nothing consumes, or a doctor reporting "attribution
  off" in a version with no way to switch it on. Two consequences: do
  not install .git/hooks/prepare-commit-msg in THIS repo before the
  release (trailers stay hand-written, and the accurate "attribution
  off" beats a misleading "installed but nothing attributed"), and
  session-orientation's protocol-block change rides the same release,
  since a half-shipped versioned block leaves repos matching no known
  version.
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
- A literal NUL byte makes a file invisible to grep (record-index M1,
  record-index M3, peer-messaging M1):
  grep and ripgrep classify the file as binary and print NOTHING — silently,
  exit 0 — so a symbol that lives there reads as nonexistent. Diagnose with
  `file <path>` (it says "data") and confirm with `grep -a`. core/fold.ts
  carried two, as separators in a composite map key; FIXED 2026-08-09 by
  spelling the separator as a backslash-u-0000 escape, which yields an
  identical string from an ASCII source. Write separators that way, and keep
  NULs out of event prose too — one there makes events.jsonl binary to grep.
- Deliberately NOT promoted: felt-cost D4 (the `sofar statusline`
  subcommand) is a feature contract, not repo-wide law — docs/SPEC.md and the
  code already describe it, and the parts that generalize are covered by
  felt-cost D3 (zero model calls) and BD22 (best-effort, never break the
  session). Named here so doctor's repo-memory axis reads as judged rather
  than unnoticed (2026-08-03).
- Cursor runs whatever `sofar` the user's LOGIN SHELL finds (r1-fixes M6):
  it rebuilds PATH for hooks, and very likely for the MCP server, ignoring
  the PATH it was launched with. So a local build put first on PATH is NOT
  what a Cursor session runs. Pin the shims and MCP command by absolute path
  (or through the login shell's startup files) when testing a build in
  Cursor, and confirm with a `command -v sofar` trace in a scratch shim.
  Symptom: a Cursor session with no digest (an older sofar's plain text is
  dropped). Found in the 6.3/6.5 live proof, 2026-09-17.
- A re-homed session's write-back moves main's binding (r1-fixes M8):
  sofar_end_session rebinds the branch to the session's home initiative
  (the result carries `rebound`). On this shared main checkout, every peer
  whose hooks follow the binding then logs into that record. When a
  write-back shows `rebound` for main, run `sofar switch <previous slug>` at
  once (main = drive-visibility as of 2026-09-21), and never commit the
  moved bindings.json. Seen twice on 2026-09-21.
- Writing a record whose truth is on another worktree's branch (rust-core M2).
  rust-core lives in ~/IO/sofar-rust-core, and main's copy of it is stale.
  Event-only writes (notes, decisions, memories, session events) may go
  through main. Carry them over with `sofar export <slug>` and
  `sofar import - <slug> --root <worktree>`, which dedupes by id. A plan
  replacement must be made on the branch, by spawning `sofar mcp` with that
  worktree as cwd. From main's stale copy it clobbers the branch plan when
  the copies union. After ANY sofar_update_plan, re-issue sofar_update_phase
  for every phase that had a note, because plan_updated drops notes silently.
- Hangs in CI and in the perf harness (rust-core M1, rust-core M3). A vitest
  job that runs to the 6 h CI limit is a file that never finished: diff the
  files the log reported against `git ls-files '*.test.ts'`. Never put an
  "unwritable" test path under /proc, because on Linux a recursive mkdirSync
  there loops forever. Use a path under a regular file instead. Run long perf
  cells on this laptop under `caffeinate -ims`, on AC power with the lid open,
  because caffeinate cannot stop clamshell or battery sleep (bench-refresh
  M1). An idle sleep counts against the 120 s spawn timeout, and the cell
  fails with ETIMEDOUT at a random measure. `pmset -g log` shows the sleep.
- Torn sessions from branch bindings in a shared checkout (roadmap-h2 M1).
  end_session rehomes the branch binding, so with several sessions on one
  branch it is last-writer-wins — main moved three times in two hours on
  2026-09-22. A session's OPENING events land in whatever the binding said at
  start and stay there when it re-homes, so `sofar doctor` later FAILs with
  "session spans 2 initiatives (torn, live)". Close it by appending a
  session_ended for that id to the record holding the strays — an append of a
  true fact, and the hygiene of the record that HOLDS them, not of the one
  that owns the session. Avoid it by passing `--initiative` explicitly on
  every write and doing the write-back with `sofar event append` from a
  per-initiative worktree.
