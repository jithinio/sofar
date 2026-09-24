perf baseline [team100 AFTER at rust-core 4b5b62b2 (4.4 L2+L1), battery waiver (operator, M16), same sitting as the candidate (D12)] — typescript (node dist/cli.js (built from source as build.mjs ships it)) · 20 spawns per cell · Apple M4 Pro, node v24.15.0 · commit 4b5b62b2
node spawn floor: p50 20.9 ms · p95 23.9 ms · load avg 3.46 → 4.93

## i10-1mb — 10 initiatives, bound log 1.0 MB (3595 lines), 1.0 MB total
| command | p50 ms | p95 ms | min ms |
| --- | ---: | ---: | ---: |
| session-start (index warm) | 45.8 | 49.3 | 44.2 |
| session-start (index cold) | 87.8 | 97.9 | 84.2 |
| post-tool Edit | 74.0 | 83.6 | 70.6 |
| user-prompt (nudge) | 54.6 | 58.8 | 51.4 |
| stop (blocked) | 61.1 | 78.8 | 54.5 |
| session-end | 72.6 | 77.6 | 68.9 |
| statusline | 34.5 | 36.0 | 33.0 |
| status <slug> (full CLI, plain) | 98.6 | 120.0 | 93.6 |

## i10-10mb — 10 initiatives, bound log 10.0 MB (35903 lines), 10.0 MB total
| command | p50 ms | p95 ms | min ms |
| --- | ---: | ---: | ---: |
| session-start (index warm) | 53.7 | 60.1 | 49.2 |
| session-start (index cold) | 343.4 | 350.4 | 316.5 |
| post-tool Edit | 260.8 | 274.3 | 249.7 |
| user-prompt (nudge) | 193.1 | 214.3 | 186.5 |
| stop (blocked) | 190.7 | 193.8 | 172.1 |
| session-end | 276.1 | 285.3 | 257.4 |
| statusline | 34.4 | 41.7 | 32.5 |
| status <slug> (full CLI, plain) | 230.0 | 235.2 | 221.6 |

## i100-1mb — 100 initiatives, bound log 1.0 MB (3595 lines), 1.3 MB total
| command | p50 ms | p95 ms | min ms |
| --- | ---: | ---: | ---: |
| session-start (index warm) | 58.6 | 60.3 | 56.8 |
| session-start (index cold) | 120.7 | 127.5 | 115.7 |
| post-tool Edit | 76.1 | 80.3 | 73.6 |
| user-prompt (nudge) | 59.1 | 62.0 | 55.0 |
| stop (blocked) | 57.2 | 61.6 | 53.0 |
| session-end | 75.2 | 83.6 | 72.3 |
| statusline | 33.2 | 34.9 | 31.5 |
| status <slug> (full CLI, plain) | 91.7 | 96.7 | 88.7 |

## i100-10mb — 100 initiatives, bound log 10.0 MB (35903 lines), 10.3 MB total
| command | p50 ms | p95 ms | min ms |
| --- | ---: | ---: | ---: |
| session-start (index warm) | 63.9 | 66.3 | 60.5 |
| session-start (index cold) | 377.3 | 392.9 | 368.9 |
| post-tool Edit | 279.4 | 295.8 | 271.9 |
| user-prompt (nudge) | 188.3 | 222.2 | 183.5 |
| stop (blocked) | 181.5 | 190.3 | 177.4 |
| session-end | 254.3 | 273.7 | 249.4 |
| statusline | 34.2 | 37.1 | 32.6 |
| status <slug> (full CLI, plain) | 210.5 | 215.3 | 207.7 |

## i1000-1mb — 1000 initiatives, bound log 1.0 MB (3595 lines), 3.5 MB total
| command | p50 ms | p95 ms | min ms |
| --- | ---: | ---: | ---: |
| session-start (index warm) | 110.5 | 118.3 | 107.0 |
| session-start (index cold) | 367.9 | 379.2 | 361.5 |
| post-tool Edit | 83.5 | 86.8 | 81.8 |
| user-prompt (nudge) | 69.8 | 76.2 | 68.1 |
| stop (blocked) | 61.9 | 64.0 | 60.8 |
| session-end | 76.3 | 78.0 | 74.6 |
| statusline | 37.5 | 40.2 | 36.1 |
| status <slug> (full CLI, plain) | 92.2 | 97.1 | 88.8 |

## i1000-10mb — 1000 initiatives, bound log 10.0 MB (35903 lines), 12.5 MB total
| command | p50 ms | p95 ms | min ms |
| --- | ---: | ---: | ---: |
| session-start (index warm) | 110.5 | 114.7 | 107.7 |
| session-start (index cold) | 603.1 | 634.4 | 591.0 |
| post-tool Edit | 279.1 | 297.3 | 264.3 |
| user-prompt (nudge) | 192.5 | 197.3 | 188.5 |
| stop (blocked) | 185.3 | 193.6 | 180.3 |
| session-end | 272.9 | 285.4 | 258.4 |
| statusline | 41.3 | 46.3 | 38.6 |
| status <slug> (full CLI, plain) | 222.8 | 246.7 | 215.4 |

## repo — 55 initiatives, bound log 0.6 MB (789 lines), 7.6 MB total
| command | p50 ms | p95 ms | min ms |
| --- | ---: | ---: | ---: |
| session-start (index warm) | 65.7 | 69.8 | 60.9 |
| session-start (index cold) | 169.2 | 190.0 | 158.8 |
| post-tool Edit | 58.0 | 62.1 | 54.3 |
| user-prompt (nudge) | 46.7 | 53.0 | 42.3 |
| stop (blocked) | 45.4 | 47.5 | 40.4 |
| session-end | 57.3 | 60.2 | 51.8 |
| statusline | 36.9 | 40.8 | 35.4 |
| status <slug> (full CLI, plain) | 79.9 | 87.0 | 74.4 |

## floor — a root with no record
| command | p50 ms | p95 ms | min ms |
| --- | ---: | ---: | ---: |
| session-start (no record) | 31.4 | 33.9 | 30.9 |

## team100-w10 — 20 initiatives, bound log 19.3 MB (27841 lines), 69.6 MB total
| command | p50 ms | p95 ms | min ms |
| --- | ---: | ---: | ---: |
| session-start (index warm) | 54.9 | 63.0 | 49.3 |
| session-start (index cold) | 715.6 | 737.3 | 677.2 |
| post-tool Edit | 129.8 | 136.4 | 115.7 |
| user-prompt (nudge) | 69.6 | 73.1 | 61.6 |
| stop (blocked) | 61.5 | 74.4 | 56.5 |
| session-end | 120.6 | 125.0 | 115.5 |
| statusline | 36.2 | 39.8 | 32.7 |
| status <slug> (full CLI, plain) | 304.8 | 313.0 | 295.8 |
| find <slug> (graph + index build, TypeScript) | 646.1 | 676.7 | 608.9 |

## team100-w25 — 20 initiatives, bound log 19.2 MB (27766 lines), 69.5 MB total
| command | p50 ms | p95 ms | min ms |
| --- | ---: | ---: | ---: |
| session-start (index warm) | 49.4 | 53.3 | 47.8 |
| session-start (index cold) | 702.9 | 744.6 | 686.1 |
| post-tool Edit | 118.9 | 135.1 | 113.9 |
| user-prompt (nudge) | 68.8 | 86.9 | 62.3 |
| stop (blocked) | 62.2 | 78.3 | 58.5 |
| session-end | 118.1 | 130.8 | 112.8 |
| statusline | 34.5 | 37.4 | 32.5 |
| status <slug> (full CLI, plain) | 295.7 | 310.3 | 288.9 |
| find <slug> (graph + index build, TypeScript) | 687.4 | 823.9 | 621.7 |

## team100-w50 — 20 initiatives, bound log 19.1 MB (27716 lines), 69.5 MB total
| command | p50 ms | p95 ms | min ms |
| --- | ---: | ---: | ---: |
| session-start (index warm) | 50.3 | 53.8 | 49.3 |
| session-start (index cold) | 712.0 | 754.3 | 684.4 |
| post-tool Edit | 134.5 | 233.0 | 124.8 |
| user-prompt (nudge) | 64.5 | 68.4 | 61.8 |
| stop (blocked) | 60.1 | 70.7 | 55.6 |
| session-end | 119.6 | 155.5 | 115.3 |
| statusline | 36.4 | 39.6 | 34.3 |
| status <slug> (full CLI, plain) | 287.5 | 302.0 | 283.6 |
| find <slug> (graph + index build, TypeScript) | 615.0 | 669.5 | 606.3 |

## team100-w100 — 20 initiatives, bound log 19.2 MB (27743 lines), 69.5 MB total
| command | p50 ms | p95 ms | min ms |
| --- | ---: | ---: | ---: |
| session-start (index warm) | 56.8 | 59.5 | 50.5 |
| session-start (index cold) | 716.9 | 764.9 | 684.4 |
| post-tool Edit | 122.9 | 136.5 | 115.9 |
| user-prompt (nudge) | 63.1 | 65.5 | 61.5 |
| stop (blocked) | 54.3 | 56.2 | 53.1 |
| session-end | 113.3 | 128.3 | 111.0 |
| statusline | 33.1 | 34.8 | 32.0 |
| status <slug> (full CLI, plain) | 301.6 | 317.5 | 296.3 |
| find <slug> (graph + index build, TypeScript) | 655.9 | 691.9 | 609.4 |

## team100 — 20 initiatives, bound log 95.6 MB (138950 lines), 345.4 MB total
| command | p50 ms | p95 ms | min ms |
| --- | ---: | ---: | ---: |
| session-start (index warm) | 91.9 | 95.4 | 88.4 |
| session-start (index cold) | 3353.2 | 3400.9 | 3256.5 |
| post-tool Edit | 377.8 | 437.6 | 371.3 |
| user-prompt (nudge) | 164.6 | 182.7 | 158.9 |
| stop (blocked) | 141.9 | 149.7 | 132.6 |
| session-end | 380.4 | 463.8 | 366.3 |
| statusline | 39.9 | 43.7 | 38.8 |
| status <slug> (full CLI, plain) | 1511.1 | 1531.5 | 1477.8 |
| find <slug> (graph + index build, TypeScript) | 3135.7 | 3199.7 | 3037.3 |

## team100-w10 — team100 corpus (rust-core 1.5)
20 initiatives, 10 writers, 69.6 MB / 100344 events in all; bound record 19.3 MB / 27841 events, 1735 sessions of which 10 open (one per writer); largest log 19.3 MB

| measure | max RSS MB |
| --- | ---: |
| session-start (index warm) | 461.9 |
| post-tool Edit | 143.9 |
| user-prompt (nudge) | 467.4 |
| stop (blocked) | 116.5 |
| session-end | 116.5 |
| statusline | 116.7 |
| status <slug> (full CLI, plain) | 402.5 |
| find <slug> (graph + index build, TypeScript) | 402.1 |

| bound-log prefix (events) | bytes | fold ms (in-process, min of 3) |
| ---: | ---: | ---: |
| 559 | 0.40 MB | 4.3 |
| 1396 | 0.99 MB | 8.7 |
| 2793 | 1.89 MB | 15.4 |
| 5586 | 3.84 MB | 32.4 |
| 9775 | 6.72 MB | 56.2 |
| 13964 | 9.59 MB | 80.3 |
| 19550 | 13.48 MB | 116.8 |
| 27928 | 19.28 MB | 168.9 |

fold crosses 100 ms at ~16979 events / 11.7 MB; a full refold reaches 250 ms at never within this log

growth budget from the profiles (0.3 human / 0.7 agent, 10 sessions per user per week): 163 events and 0.11 MB per user per week — 100 users add 11 MB / 16300 events a week

## team100-w25 — team100 corpus (rust-core 1.5)
20 initiatives, 25 writers, 69.5 MB / 100269 events in all; bound record 19.2 MB / 27766 events, 1734 sessions of which 25 open (one per writer); largest log 19.2 MB

| measure | max RSS MB |
| --- | ---: |
| session-start (index warm) | 461.5 |
| post-tool Edit | 142.5 |
| user-prompt (nudge) | 467.0 |
| stop (blocked) | 116.2 |
| session-end | 116.3 |
| statusline | 117.9 |
| status <slug> (full CLI, plain) | 402.6 |
| find <slug> (graph + index build, TypeScript) | 402.7 |

| bound-log prefix (events) | bytes | fold ms (in-process, min of 3) |
| ---: | ---: | ---: |
| 557 | 0.39 MB | 4.2 |
| 1393 | 0.99 MB | 9.6 |
| 2785 | 1.88 MB | 17.2 |
| 5571 | 3.83 MB | 34.6 |
| 9749 | 6.69 MB | 59.1 |
| 13927 | 9.56 MB | 83.2 |
| 19497 | 13.44 MB | 119.1 |
| 27853 | 19.23 MB | 169.2 |

fold crosses 100 ms at ~16537 events / 11.4 MB; a full refold reaches 250 ms at never within this log

growth budget from the profiles (0.3 human / 0.7 agent, 10 sessions per user per week): 163 events and 0.11 MB per user per week — 100 users add 11 MB / 16300 events a week

## team100-w50 — team100 corpus (rust-core 1.5)
20 initiatives, 50 writers, 69.5 MB / 100219 events in all; bound record 19.1 MB / 27716 events, 1734 sessions of which 50 open (one per writer); largest log 19.1 MB

| measure | max RSS MB |
| --- | ---: |
| session-start (index warm) | 452.5 |
| post-tool Edit | 145.0 |
| user-prompt (nudge) | 467.9 |
| stop (blocked) | 117.3 |
| session-end | 114.7 |
| statusline | 116.4 |
| status <slug> (full CLI, plain) | 399.6 |
| find <slug> (graph + index build, TypeScript) | 401.3 |

| bound-log prefix (events) | bytes | fold ms (in-process, min of 3) |
| ---: | ---: | ---: |
| 556 | 0.39 MB | 3.2 |
| 1390 | 0.98 MB | 8.1 |
| 2780 | 1.88 MB | 15.1 |
| 5561 | 3.82 MB | 31.0 |
| 9731 | 6.68 MB | 56.9 |
| 13902 | 9.55 MB | 84.5 |
| 19462 | 13.43 MB | 117.7 |
| 27803 | 19.17 MB | 167.1 |

fold crosses 100 ms at ~16503 events / 11.4 MB; a full refold reaches 250 ms at never within this log

growth budget from the profiles (0.3 human / 0.7 agent, 10 sessions per user per week): 163 events and 0.11 MB per user per week — 100 users add 11 MB / 16300 events a week

## team100-w100 — team100 corpus (rust-core 1.5)
20 initiatives, 100 writers, 69.5 MB / 100246 events in all; bound record 19.2 MB / 27743 events, 1745 sessions of which 100 open (one per writer); largest log 19.2 MB

| measure | max RSS MB |
| --- | ---: |
| session-start (index warm) | 454.0 |
| post-tool Edit | 142.5 |
| user-prompt (nudge) | 470.0 |
| stop (blocked) | 117.5 |
| session-end | 115.3 |
| statusline | 116.5 |
| status <slug> (full CLI, plain) | 403.4 |
| find <slug> (graph + index build, TypeScript) | 402.0 |

| bound-log prefix (events) | bytes | fold ms (in-process, min of 3) |
| ---: | ---: | ---: |
| 557 | 0.39 MB | 3.9 |
| 1392 | 0.99 MB | 9.1 |
| 2783 | 1.88 MB | 16.0 |
| 5566 | 3.82 MB | 32.1 |
| 9741 | 6.68 MB | 58.2 |
| 13915 | 9.55 MB | 81.5 |
| 19481 | 13.43 MB | 112.8 |
| 27830 | 19.19 MB | 167.6 |

fold crosses 100 ms at ~17210 events / 11.8 MB; a full refold reaches 250 ms at never within this log

growth budget from the profiles (0.3 human / 0.7 agent, 10 sessions per user per week): 163 events and 0.11 MB per user per week — 100 users add 11 MB / 16300 events a week

## team100 — team100 corpus (rust-core 1.5)
20 initiatives, 100 writers, 345.4 MB / 500188 events in all; bound record 95.6 MB / 138950 events, 8576 sessions of which 100 open (one per writer); largest log 95.6 MB

| measure | max RSS MB |
| --- | ---: |
| session-start (index warm) | 1198.9 |
| post-tool Edit | 379.7 |
| user-prompt (nudge) | 1055.0 |
| stop (blocked) | 309.2 |
| session-end | 308.6 |
| statusline | 308.3 |
| status <slug> (full CLI, plain) | 1171.2 |
| find <slug> (graph + index build, TypeScript) | 1175.3 |

| bound-log prefix (events) | bytes | fold ms (in-process, min of 3) |
| ---: | ---: | ---: |
| 2781 | 1.88 MB | 17.8 |
| 6952 | 4.84 MB | 40.7 |
| 13904 | 9.54 MB | 86.7 |
| 27807 | 19.20 MB | 176.6 |
| 48663 | 33.64 MB | 303.4 |
| 69519 | 47.95 MB | 442.7 |
| 97326 | 67.25 MB | 644.1 |
| 139037 | 95.67 MB | 967.4 |

fold crosses 100 ms at ~15960 events / 11.0 MB; a full refold reaches 250 ms at ~39885 events / 27.6 MB

growth budget from the profiles (0.3 human / 0.7 agent, 10 sessions per user per week): 163 events and 0.11 MB per user per week — 100 users add 11 MB / 16300 events a week

## in-process (TypeScript reference only): fold of the bound log, digest render of the folded state
| cell | fold p50 ms | fold p95 ms | render p50 ms | render p95 ms |
| --- | ---: | ---: | ---: | ---: |
| i10-1mb | 12.8 | 15.8 | 0.3 | 0.6 |
| i10-10mb | 118.3 | 136.8 | 0.5 | 0.9 |
| i100-1mb | 10.7 | 13.1 | 0.2 | 0.3 |
| i100-10mb | 113.2 | 126.7 | 0.4 | 0.5 |
| i1000-1mb | 10.3 | 12.6 | 0.1 | 0.3 |
| i1000-10mb | 117.1 | 130.2 | 0.5 | 0.6 |
| repo | 2.4 | 3.4 | 0.6 | 1.0 |
| team100-w10 | 171.7 | 188.1 | 1.3 | 1.8 |
| team100-w25 | 172.4 | 190.3 | 1.2 | 1.7 |
| team100-w50 | 172.5 | 184.1 | 1.1 | 1.5 |
| team100-w100 | 170.6 | 193.6 | 1.1 | 2.9 |
| team100 | 1032.7 | 1101.8 | 6.2 | 9.8 |

