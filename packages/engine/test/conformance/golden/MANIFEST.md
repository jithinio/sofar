# Golden manifest (rust-core D11)

Verified byte-unchanged against the TypeScript reference at **r1-fixes
d9b2878** (3.2 decision retirement, D25, and 5.2 code-unit string order, D26,
merged into rust-core after 2.4): every golden below is identical, so the
set stands as recorded. The entries that follow describe the last re-record.

Recorded from the TypeScript reference at **r1-fixes 4077c9a** (sofar.sh
0.33.0-rc.1 sources plus r1-fixes 5.1 and 2.5 — the incremental fold and
automatic outcome capture, D24 — and main's self-improve 1.1–3.3; @sofar/schema
0.10.0 with the optional `ok`/`exit` outcome fields and the four
`suggestion_*` types), merged into rust-core with the engine sources
byte-identical to 4077c9a outside `.sofar/`. Fixtures unchanged (this
repository's record at 7535e75, four cells, seven synthetic builders).

Previous sets: `../golden-0.33.0-rc.1/` — the same cases at r1-fixes
179b8fd (the RC as shipped; its own MANIFEST.md explains the 0.32.0 → RC
changes) — and `../golden-0.32.0-as-shipped/` (rust-core at 7535e75).
9 of 25 goldens are byte-identical between the RC set and this one:
open.O2-update-segment, open.O4-styled-status, open.O5-commit-trailer,
repo.append, repo.session-start, repo.status, repo.statusline, syn.budget,
syn.no-record.

## Changed goldens (16) and why

Every change below is one of two intentional r1-fixes 2.5 / self-improve
1.2 behaviours; no golden changed for any other reason:

- **(a) outcome capture** — PostToolUse now appends `file_touched` /
  `command_run` with `"ok":true` (self-improve D2; `exit` only when the host
  gives a number, which no fixture step does), so every hook-appended
  mechanical event gains 10 bytes and the record delta's byte counts move
  with it. Fixture lines are untouched.
- **(b) derived outcomes in the session projection** (D24) — a session
  whose captured commands include a test-shaped one with a known `ok`
  renders `, tests pass` on its `Derived:` line and a `Last test: pass — <cmd>`
  line in `sessions/<id>.md`.

| golden | reason |
| --- | --- |
| argv.fast-path | commander help gains `post-tool-failure [options]` (PostToolUseFailure hook) and re-wraps every command description to the wider column; (a) on the hook steps |
| cell.calib-1 | (a); (b) `pnpm test -- --run` |
| cell.round-1-sofar | (a); (b) |
| cell.smoke-4-drive | (a); (b) |
| cell.smoke-4-sofar | (a); (b) |
| repo.branch-elsewhere | (a) |
| repo.drive-nudge | (a); (b) `npm test` |
| repo.hook-lifecycle | (a) |
| repo.peers | (a) |
| syn.baseline | (a) |
| syn.corrupt | (a); every fold warning byte-identical |
| syn.guards | (a); every guard line byte-identical |
| syn.lifecycle | (a) |
| syn.many | (a) |
| syn.no-git | (a) |
| syn.unicode | (a) |

Not exercised by any fixture: `post-tool-failure` itself (no step fails a
tool), `ok:false` / `exit` / `failed` / `last_test` on a failure, the
diagnostics store (outside `.sofar/`, never compared), `suggestion_*`
events, the fold-parity cases (their own goldens under `fold-parity/`).
