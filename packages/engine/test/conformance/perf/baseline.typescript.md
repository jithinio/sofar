perf baseline [rust-core 4.4 team100 reference (before-baseline for decision 01M39ED9), same sitting as the candidate (D12), tree 3f9fe5c] — typescript (node dist/cli.js (built from source as build.mjs ships it)) · 20 spawns per cell · Apple M4 Pro, node v24.15.0 · commit 3f9fe5cf
node spawn floor: p50 21.0 ms · p95 23.3 ms · load avg 3.24 → 1.99

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
| session-start (index warm) | 59.8 | 67.4 | 57.5 |
| session-start (index cold) | 934.0 | 1012.9 | 901.3 |
| post-tool Edit | 377.3 | 472.2 | 342.0 |
| user-prompt (nudge) | 267.1 | 314.2 | 255.2 |
| stop (blocked) | 248.6 | 255.0 | 244.9 |
| session-end | 340.6 | 368.6 | 331.2 |
| statusline | 35.6 | 39.0 | 32.0 |
| status <slug> (full CLI, plain) | 303.8 | 327.4 | 295.0 |
| find <slug> (graph + index build, TypeScript) | 637.6 | 660.4 | 616.6 |

## team100-w25 — 20 initiatives, bound log 19.2 MB (27766 lines), 69.5 MB total
| command | p50 ms | p95 ms | min ms |
| --- | ---: | ---: | ---: |
| session-start (index warm) | 60.4 | 75.9 | 57.0 |
| session-start (index cold) | 896.7 | 915.8 | 884.9 |
| post-tool Edit | 338.5 | 362.5 | 332.9 |
| user-prompt (nudge) | 265.8 | 288.8 | 261.6 |
| stop (blocked) | 254.7 | 258.6 | 250.9 |
| session-end | 337.4 | 352.1 | 329.2 |
| statusline | 32.4 | 34.3 | 31.1 |
| status <slug> (full CLI, plain) | 287.2 | 291.5 | 282.1 |
| find <slug> (graph + index build, TypeScript) | 629.0 | 650.8 | 611.8 |

## team100-w50 — 20 initiatives, bound log 19.1 MB (27716 lines), 69.5 MB total
| command | p50 ms | p95 ms | min ms |
| --- | ---: | ---: | ---: |
| session-start (index warm) | 58.6 | 65.3 | 56.2 |
| session-start (index cold) | 896.1 | 928.1 | 880.0 |
| post-tool Edit | 342.4 | 359.0 | 336.9 |
| user-prompt (nudge) | 260.4 | 270.3 | 257.5 |
| stop (blocked) | 254.0 | 266.8 | 250.9 |
| session-end | 336.5 | 344.2 | 331.9 |
| statusline | 32.9 | 34.6 | 31.2 |
| status <slug> (full CLI, plain) | 289.7 | 310.0 | 285.7 |
| find <slug> (graph + index build, TypeScript) | 609.2 | 624.6 | 603.0 |

## team100-w100 — 20 initiatives, bound log 19.2 MB (27743 lines), 69.5 MB total
| command | p50 ms | p95 ms | min ms |
| --- | ---: | ---: | ---: |
| session-start (index warm) | 60.7 | 66.0 | 59.4 |
| session-start (index cold) | 899.4 | 920.1 | 887.3 |
| post-tool Edit | 336.3 | 351.6 | 331.2 |
| user-prompt (nudge) | 258.6 | 283.1 | 253.2 |
| stop (blocked) | 250.6 | 255.4 | 247.6 |
| session-end | 335.7 | 350.7 | 329.8 |
| statusline | 33.3 | 35.2 | 31.8 |
| status <slug> (full CLI, plain) | 292.1 | 305.9 | 286.3 |
| find <slug> (graph + index build, TypeScript) | 618.6 | 643.0 | 603.3 |

## team100 — 20 initiatives, bound log 95.6 MB (138950 lines), 345.4 MB total
| command | p50 ms | p95 ms | min ms |
| --- | ---: | ---: | ---: |
| session-start (index warm) | 99.5 | 104.1 | 97.5 |
| session-start (index cold) | 5605.1 | 5893.7 | 5422.8 |
| post-tool Edit | 1932.7 | 2037.9 | 1839.1 |
| user-prompt (nudge) | 1489.6 | 1536.0 | 1455.1 |
| stop (blocked) | 1429.9 | 1484.0 | 1409.9 |
| session-end | 1828.0 | 2088.8 | 1770.4 |
| statusline | 38.8 | 39.5 | 37.5 |
| status <slug> (full CLI, plain) | 1470.4 | 1500.0 | 1463.9 |
| find <slug> (graph + index build, TypeScript) | 2984.7 | 3040.8 | 2936.9 |

## team100-w10 — team100 corpus (rust-core 1.5)
20 initiatives, 10 writers, 69.6 MB / 100344 events in all; bound record 19.3 MB / 27841 events, 1735 sessions of which 10 open (one per writer); largest log 19.3 MB

| measure | max RSS MB |
| --- | ---: |
| session-start (index warm) | 522.4 |
| post-tool Edit | 400.7 |
| user-prompt (nudge) | 560.1 |
| stop (blocked) | 377.8 |
| session-end | 376.0 |
| statusline | 379.0 |
| status <slug> (full CLI, plain) | 402.4 |
| find <slug> (graph + index build, TypeScript) | 403.7 |

| bound-log prefix (events) | bytes | fold ms (in-process, min of 3) |
| ---: | ---: | ---: |
| 559 | 0.40 MB | 4.6 |
| 1396 | 0.99 MB | 9.5 |
| 2793 | 1.89 MB | 17.1 |
| 5586 | 3.84 MB | 35.2 |
| 9775 | 6.72 MB | 58.4 |
| 13964 | 9.59 MB | 82.7 |
| 19550 | 13.48 MB | 117.8 |
| 27928 | 19.28 MB | 166.6 |

fold crosses 100 ms at ~16720 events / 11.5 MB; a full refold reaches 250 ms at never within this log

growth budget from the profiles (0.3 human / 0.7 agent, 10 sessions per user per week): 163 events and 0.11 MB per user per week — 100 users add 11 MB / 16300 events a week

## team100-w25 — team100 corpus (rust-core 1.5)
20 initiatives, 25 writers, 69.5 MB / 100269 events in all; bound record 19.2 MB / 27766 events, 1734 sessions of which 25 open (one per writer); largest log 19.2 MB

| measure | max RSS MB |
| --- | ---: |
| session-start (index warm) | 527.5 |
| post-tool Edit | 401.8 |
| user-prompt (nudge) | 554.5 |
| stop (blocked) | 377.4 |
| session-end | 375.9 |
| statusline | 378.6 |
| status <slug> (full CLI, plain) | 402.3 |
| find <slug> (graph + index build, TypeScript) | 402.0 |

| bound-log prefix (events) | bytes | fold ms (in-process, min of 3) |
| ---: | ---: | ---: |
| 557 | 0.39 MB | 2.9 |
| 1393 | 0.99 MB | 7.7 |
| 2785 | 1.88 MB | 14.8 |
| 5571 | 3.83 MB | 30.7 |
| 9749 | 6.69 MB | 54.6 |
| 13927 | 9.56 MB | 80.1 |
| 19497 | 13.44 MB | 114.7 |
| 27853 | 19.23 MB | 163.1 |

fold crosses 100 ms at ~17133 events / 11.8 MB; a full refold reaches 250 ms at never within this log

growth budget from the profiles (0.3 human / 0.7 agent, 10 sessions per user per week): 163 events and 0.11 MB per user per week — 100 users add 11 MB / 16300 events a week

## team100-w50 — team100 corpus (rust-core 1.5)
20 initiatives, 50 writers, 69.5 MB / 100219 events in all; bound record 19.1 MB / 27716 events, 1734 sessions of which 50 open (one per writer); largest log 19.1 MB

| measure | max RSS MB |
| --- | ---: |
| session-start (index warm) | 517.8 |
| post-tool Edit | 401.2 |
| user-prompt (nudge) | 546.5 |
| stop (blocked) | 378.2 |
| session-end | 376.9 |
| statusline | 379.4 |
| status <slug> (full CLI, plain) | 401.3 |
| find <slug> (graph + index build, TypeScript) | 401.1 |

| bound-log prefix (events) | bytes | fold ms (in-process, min of 3) |
| ---: | ---: | ---: |
| 556 | 0.39 MB | 3.1 |
| 1390 | 0.98 MB | 7.6 |
| 2780 | 1.88 MB | 14.6 |
| 5561 | 3.82 MB | 30.8 |
| 9731 | 6.68 MB | 55.5 |
| 13902 | 9.55 MB | 79.2 |
| 19462 | 13.43 MB | 114.3 |
| 27803 | 19.17 MB | 163.4 |

fold crosses 100 ms at ~17198 events / 11.8 MB; a full refold reaches 250 ms at never within this log

growth budget from the profiles (0.3 human / 0.7 agent, 10 sessions per user per week): 163 events and 0.11 MB per user per week — 100 users add 11 MB / 16300 events a week

## team100-w100 — team100 corpus (rust-core 1.5)
20 initiatives, 100 writers, 69.5 MB / 100246 events in all; bound record 19.2 MB / 27743 events, 1745 sessions of which 100 open (one per writer); largest log 19.2 MB

| measure | max RSS MB |
| --- | ---: |
| session-start (index warm) | 528.9 |
| post-tool Edit | 399.1 |
| user-prompt (nudge) | 541.9 |
| stop (blocked) | 377.2 |
| session-end | 378.0 |
| statusline | 376.8 |
| status <slug> (full CLI, plain) | 402.1 |
| find <slug> (graph + index build, TypeScript) | 402.1 |

| bound-log prefix (events) | bytes | fold ms (in-process, min of 3) |
| ---: | ---: | ---: |
| 557 | 0.39 MB | 3.0 |
| 1392 | 0.99 MB | 7.8 |
| 2783 | 1.88 MB | 15.0 |
| 5566 | 3.82 MB | 31.5 |
| 9741 | 6.68 MB | 56.1 |
| 13915 | 9.55 MB | 82.1 |
| 19481 | 13.43 MB | 115.3 |
| 27830 | 19.19 MB | 166.5 |

fold crosses 100 ms at ~16913 events / 11.6 MB; a full refold reaches 250 ms at never within this log

growth budget from the profiles (0.3 human / 0.7 agent, 10 sessions per user per week): 163 events and 0.11 MB per user per week — 100 users add 11 MB / 16300 events a week

## team100 — team100 corpus (rust-core 1.5)
20 initiatives, 100 writers, 345.4 MB / 500188 events in all; bound record 95.6 MB / 138950 events, 8576 sessions of which 100 open (one per writer); largest log 95.6 MB

| measure | max RSS MB |
| --- | ---: |
| session-start (index warm) | 1558.2 |
| post-tool Edit | 1214.9 |
| user-prompt (nudge) | 1409.5 |
| stop (blocked) | 1147.2 |
| session-end | 1138.6 |
| statusline | 1140.3 |
| status <slug> (full CLI, plain) | 1180.8 |
| find <slug> (graph + index build, TypeScript) | 1175.0 |

| bound-log prefix (events) | bytes | fold ms (in-process, min of 3) |
| ---: | ---: | ---: |
| 2781 | 1.88 MB | 17.6 |
| 6952 | 4.84 MB | 38.6 |
| 13904 | 9.54 MB | 84.5 |
| 27807 | 19.20 MB | 170.5 |
| 48663 | 33.64 MB | 291.4 |
| 69519 | 47.95 MB | 422.1 |
| 97326 | 67.25 MB | 627.1 |
| 139037 | 95.67 MB | 917.6 |

fold crosses 100 ms at ~16405 events / 11.3 MB; a full refold reaches 250 ms at ~41523 events / 28.7 MB

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
| team100-w10 | 168.7 | 179.1 | 1.3 | 3.0 |
| team100-w25 | 170.0 | 179.7 | 1.2 | 1.5 |
| team100-w50 | 167.6 | 179.4 | 1.2 | 1.5 |
| team100-w100 | 171.6 | 186.8 | 1.2 | 1.4 |
| team100 | 938.5 | 977.8 | 5.2 | 6.9 |

