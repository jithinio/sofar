perf baseline [rust-core 1.5 reference: team100 in-process fold curve and RSS] — typescript (node dist/cli.js (built from source as build.mjs ships it)) · 5 spawns per cell · Apple M4 Pro, node v24.15.0 · commit 8e9bea2
node spawn floor: p50 25.8 ms · p95 35.4 ms · load avg 2.24 → 7.58

## team100 — 20 initiatives, bound log 95.6 MB (138950 lines), 345.4 MB total
| command | p50 ms | p95 ms | min ms |
| --- | ---: | ---: | ---: |
| session-start (index warm) | 7936.6 | 8108.3 | 7832.7 |
| session-start (index cold) | 12161.7 | 12269.8 | 11764.1 |
| post-tool Edit | 7880.8 | 8075.3 | 7682.1 |
| user-prompt (nudge) | 7839.8 | 9139.8 | 7544.1 |
| stop (blocked) | 7830.0 | 8049.5 | 7388.2 |
| session-end | 8887.7 | 12526.6 | 7893.2 |
| statusline | 7907.1 | 9730.3 | 7540.9 |
| status <slug> (full CLI, plain) | 7282.3 | 7784.3 | 7145.6 |
| find <slug> (graph + index build) | 3138.7 | 3179.6 | 3084.5 |

## team100 — team100 corpus (rust-core 1.5)
20 initiatives, 100 writers, 345.4 MB / 500188 events in all; bound record 95.6 MB / 138950 events, 8576 sessions of which 100 open (one per writer); largest log 95.6 MB

| measure | max RSS MB |
| --- | ---: |
| session-start (index warm) | 1426.3 |
| post-tool Edit | 1207.9 |
| user-prompt (nudge) | 1330.5 |
| stop (blocked) | 838.1 |
| session-end | 909.3 |
| statusline | 919.8 |
| status <slug> (full CLI, plain) | 946.8 |
| find <slug> (graph + index build) | 1177.5 |

| bound-log prefix (events) | bytes | fold ms (in-process, min of 3) |
| ---: | ---: | ---: |
| 2780 | 1.88 MB | 23.4 |
| 6949 | 4.84 MB | 57.8 |
| 13898 | 9.54 MB | 139.3 |
| 27795 | 19.19 MB | 371.9 |
| 48642 | 33.62 MB | 999.5 |
| 69489 | 47.93 MB | 2050.9 |
| 97284 | 67.22 MB | 4217.8 |
| 138977 | 95.65 MB | 8661.8 |

fold crosses 100 ms at ~10546 events / 7.3 MB; a full refold reaches 250 ms at ~20511 events / 14.1 MB

growth budget from the profiles (0.3 human / 0.7 agent, 10 sessions per user per week): 163 events and 0.11 MB per user per week — 100 users add 11 MB / 16300 events a week

## in-process (TypeScript reference only): fold of the bound log, digest render of the folded state
| cell | fold p50 ms | fold p95 ms | render p50 ms | render p95 ms |
| --- | ---: | ---: | ---: | ---: |
| team100 | 7089.7 | 7394.8 | 7.6 | 8.9 |

