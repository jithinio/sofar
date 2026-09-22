# Real-record fixtures

Frozen copies of real sofar records, used as conformance inputs. Never edit by
hand; re-snapshot deliberately and re-record every golden (see ../../README.md).

- `repo/` — this repository's own `.sofar/` as committed at 7535e75
  (2026-09-15): 55 initiatives, 7.6 MB of event logs with their projections.
  Taken with `git archive HEAD .sofar`, so the blobs are the ones already in
  history. `.index/` (a derived cache) is not part of any fixture.
- `calib-1/`, `smoke-4-sofar/`, `smoke-4-drive/`, `round-1-sofar/` — the
  bench-refresh calibration and smoke cells (Boopada travel-planner task,
  Claude Code arms; `smoke-4-drive` was run under `sofar drive`, so it
  carries driver events).

Each fixture directory holds `dot-sofar/`, which the harness copies to
`<root>/.sofar`; git state is synthesised per case (cases.ts).
