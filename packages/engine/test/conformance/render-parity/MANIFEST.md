# render-parity manifest (rust-core D11)

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
