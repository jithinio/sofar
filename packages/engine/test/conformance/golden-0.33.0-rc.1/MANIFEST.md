# Golden manifest (rust-core D11)

Recorded from the TypeScript reference at **r1-fixes 179b8fd** (sofar.sh
0.33.0-rc.1, @sofar/schema 0.10.0), merged into rust-core at daea704 with
the engine sources byte-identical to 179b8fd. Fixtures unchanged (this
repository's record at 7535e75, four cells, seven synthetic builders).

Previous set: `../golden-0.32.0-as-shipped/` — the same cases from the
0.32.0 engine (rust-core at 7535e75). 8 of 25 goldens are byte-identical
between the two sets: open.O4-styled-status, open.O5-commit-trailer,
repo.drive-nudge, repo.hook-lifecycle, repo.peers, repo.status,
repo.statusline, syn.no-record.

## Changed goldens (17) and why

Every change below is one of the intentional projection/digest changes
r1-fixes 4.2 lists (its task note names the task per change); no golden
changed for any other reason. Task ids are r1-fixes tasks.

| golden | reason |
| --- | --- |
| argv.fast-path | 1.3: commander help gains `types [options] [type]`; status block re-ordered (2.3), decision index (2.2), `Next ids:` (2.1) |
| cell.calib-1 | 2.3 section order; 2.2 `[D<n>] <date> <chose> — over <over>` index with `(rule above)` and the older-only rejected ledger; 2.1 `Next ids:` |
| cell.round-1-sofar | 2.3; 2.2 (28 rejected approaches become the older-only ledger); 2.1 |
| cell.smoke-4-drive | 2.3; 2.2; 2.1 |
| cell.smoke-4-sofar | 2.3; 2.2; 2.1 |
| open.O2-update-segment | version string in the update line: `you have 0.33.0-rc.1` (package version, not a behaviour change) |
| repo.append | 1.3: `--source nope` is accepted (exit 0, `{"ok":true}`) and recorded as source `cli`; the extra event shifts the later fold warning from line 53 to 54, the notes count and the record delta; status block 2.3/2.2/2.1 |
| repo.branch-elsewhere | 2.3 (the recent-work notice and adjacency block move to the volatile tail); 2.2; 2.1 |
| repo.session-start | 2.3; 2.2; 2.1 |
| syn.baseline | 2.3; 2.2; 2.1 |
| syn.budget | 2.3; 2.2 (index lines clipped with `…`, `— over` suffix); 2.1 |
| syn.corrupt | 2.3 only (Session/Git lines move to the tail); every fold warning byte-identical |
| syn.guards | 2.3; 2.2; 2.1 |
| syn.lifecycle | 2.3: the closed banner and the recent-work notice move from the head to the tail (both still present, 4 occurrences as before) |
| syn.many | 1.1: unbound notice reworded (`Nothing resolves for this session…`, `with the session_id above`); 2.6: the quick-work lane paragraph; 2.3 |
| syn.no-git | 1.1: unbound notice reworded and carries the `Session:` line; 2.3; 2.2; 2.1 |
| syn.unicode | 2.3; 2.2 (the UTF-16 clip now applies to the index line); 2.1 |

Not exercised by any fixture: 1.6 handoff `detail`, 3.1 plan.md
`verify:`/`verified pass @<head7>` suffixes and `, P/N verifications
passed` (no fixture record carries a verification), 2.4 review packet.
