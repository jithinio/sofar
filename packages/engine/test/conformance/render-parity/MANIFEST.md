# Render-parity manifest (rust-core D11)

Re-recorded from the TypeScript templates at **rust-core 17817db** (the
wave-a merge): every one of the 94 goldens changed, all in `renderStatus` —
memory-lead D4's composition (the next task's spec first; memory, repo memory,
the decision index and the last session yielding to the 6,000-unit cap; the
standing constraints last, ranked by relevance to the focus; minutiae heads
on decision fields) and D3's host-neutral `Session:` line; the `cap` variant
now hits 6,000. `renderFullStatus`, plan.md, decisions.md, memory.md and the
session files are byte-identical to the previous set, kept as
`golden-17817db-pre-wave-a/`. The Rust core (status.rs, memory-lead 1.4)
matched all 94 on its first in-process run.


Recorded from the TypeScript templates at **r1-fixes d9b2878** (3.2 decision
retirement, D25; 5.2 code-unit order, D26), merged into rust-core after 2.4.

- First recording (2.4, engine sources at r1-fixes 4077c9a): 83 goldens over
  the conformance fixtures (this repository's record at 7535e75, four cells,
  seven synthetic builders), 988 surfaces.
- d9b2878: the 83 fixture goldens are byte-unchanged (no fixture carries
  `supersedes`/`until`, and the fixtures hold no mixed-case sort input); 10
  goldens ADDED for the fold-parity cases (`fold-parity.cases.FP-*`), which
  are the only records with retirement fields — FP-10 renders the retired
  window, the `(supersedes D<n>)` marks and decisions.md's retirement marks.

Re-record (`RENDER_PARITY_RECORD=1 npx vitest run render-parity`) only when a
template changes on purpose; add a row per changed golden with the commit and
the reason.
