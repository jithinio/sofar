perf baseline [team100 re-run at 3f9fe5c with the pinned-row gate fix (01M39H05), same sitting as the candidate (D12)] — typescript (node dist/cli.js (built from source as build.mjs ships it)) · 20 spawns per cell · Apple M4 Pro, node v24.15.0 · commit 3f9fe5cf
node spawn floor: p50 19.9 ms · p95 21.3 ms · load avg 2.9 → 4.42

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
| session-start (index warm) | 57.8 | 59.6 | 56.3 |
| session-start (index cold) | 920.5 | 951.6 | 883.3 |
| post-tool Edit | 341.1 | 362.5 | 333.9 |
| user-prompt (nudge) | 262.2 | 274.5 | 256.9 |
| stop (blocked) | 262.8 | 281.9 | 250.8 |
| session-end | 354.6 | 383.0 | 339.6 |
| statusline | 33.5 | 35.6 | 31.8 |
| status <slug> (full CLI, plain) | 302.2 | 325.4 | 289.4 |
| find <slug> (graph + index build, TypeScript) | 603.8 | 637.3 | 599.9 |

## team100-w25 — 20 initiatives, bound log 19.2 MB (27766 lines), 69.5 MB total
| command | p50 ms | p95 ms | min ms |
| --- | ---: | ---: | ---: |
| session-start (index warm) | 59.5 | 62.3 | 56.9 |
| session-start (index cold) | 899.4 | 923.7 | 887.5 |
| post-tool Edit | 338.0 | 353.8 | 333.8 |
| user-prompt (nudge) | 261.4 | 284.7 | 257.8 |
| stop (blocked) | 253.0 | 255.5 | 249.6 |
| session-end | 341.8 | 430.9 | 335.7 |
| statusline | 33.1 | 35.6 | 31.6 |
| status <slug> (full CLI, plain) | 291.4 | 303.1 | 285.8 |
| find <slug> (graph + index build, TypeScript) | 614.4 | 638.5 | 605.3 |

## team100-w50 — 20 initiatives, bound log 19.1 MB (27716 lines), 69.5 MB total
| command | p50 ms | p95 ms | min ms |
| --- | ---: | ---: | ---: |
| session-start (index warm) | 71.4 | 113.6 | 65.8 |
| session-start (index cold) | 996.8 | 1079.5 | 966.3 |
| post-tool Edit | 356.1 | 384.1 | 347.5 |
| user-prompt (nudge) | 269.5 | 276.8 | 263.2 |
| stop (blocked) | 264.4 | 271.4 | 260.0 |
| session-end | 356.9 | 373.8 | 345.0 |
| statusline | 37.1 | 40.8 | 34.1 |
| status <slug> (full CLI, plain) | 321.8 | 356.0 | 303.2 |
| find <slug> (graph + index build, TypeScript) | 695.3 | 736.8 | 664.7 |

## team100-w100 — 20 initiatives, bound log 19.2 MB (27743 lines), 69.5 MB total
| command | p50 ms | p95 ms | min ms |
| --- | ---: | ---: | ---: |
| session-start (index warm) | 69.2 | 72.5 | 66.2 |
| session-start (index cold) | 976.8 | 1005.8 | 935.2 |
| post-tool Edit | 372.2 | 396.6 | 356.2 |
| user-prompt (nudge) | 278.7 | 299.6 | 271.9 |
| stop (blocked) | 275.6 | 299.4 | 267.8 |
| session-end | 359.5 | 386.3 | 354.7 |
| statusline | 37.2 | 41.4 | 35.5 |
| status <slug> (full CLI, plain) | 331.1 | 360.7 | 314.6 |
| find <slug> (graph + index build, TypeScript) | 683.2 | 718.5 | 667.4 |

## team100 — 20 initiatives, bound log 95.6 MB (138950 lines), 345.4 MB total
| command | p50 ms | p95 ms | min ms |
| --- | ---: | ---: | ---: |
| session-start (index warm) | 107.2 | 125.7 | 104.5 |
| session-start (index cold) | 5941.7 | 6239.0 | 5557.0 |
| post-tool Edit | 1975.6 | 2207.3 | 1889.2 |
| user-prompt (nudge) | 1560.8 | 1603.3 | 1505.7 |
| stop (blocked) | 1522.5 | 1576.1 | 1468.8 |
| session-end | 1894.1 | 1991.8 | 1782.9 |
| statusline | 40.8 | 43.5 | 39.2 |
| status <slug> (full CLI, plain) | 1528.2 | 1613.7 | 1501.5 |
| find <slug> (graph + index build, TypeScript) | 3074.9 | 3220.1 | 2966.4 |

## team100-w10 — team100 corpus (rust-core 1.5)
20 initiatives, 10 writers, 69.6 MB / 100344 events in all; bound record 19.3 MB / 27841 events, 1735 sessions of which 10 open (one per writer); largest log 19.3 MB

| measure | max RSS MB |
| --- | ---: |
| session-start (index warm) | 516.8 |
| post-tool Edit | 401.8 |
| user-prompt (nudge) | 556.4 |
| stop (blocked) | 377.4 |
| session-end | 378.2 |
| statusline | 376.8 |
| status <slug> (full CLI, plain) | 404.2 |
| find <slug> (graph + index build, TypeScript) | 402.0 |

| bound-log prefix (events) | bytes | fold ms (in-process, min of 3) |
| ---: | ---: | ---: |
| 559 | 0.40 MB | 4.4 |
| 1396 | 0.99 MB | 8.7 |
| 2793 | 1.89 MB | 15.6 |
| 5586 | 3.84 MB | 31.9 |
| 9775 | 6.72 MB | 57.4 |
| 13964 | 9.59 MB | 79.9 |
| 19550 | 13.48 MB | 115.0 |
| 27928 | 19.28 MB | 164.7 |

fold crosses 100 ms at ~17164 events / 11.8 MB; a full refold reaches 250 ms at never within this log

growth budget from the profiles (0.3 human / 0.7 agent, 10 sessions per user per week): 163 events and 0.11 MB per user per week — 100 users add 11 MB / 16300 events a week

## team100-w25 — team100 corpus (rust-core 1.5)
20 initiatives, 25 writers, 69.5 MB / 100269 events in all; bound record 19.2 MB / 27766 events, 1734 sessions of which 25 open (one per writer); largest log 19.2 MB

| measure | max RSS MB |
| --- | ---: |
| session-start (index warm) | 518.9 |
| post-tool Edit | 401.6 |
| user-prompt (nudge) | 534.3 |
| stop (blocked) | 376.9 |
| session-end | 378.2 |
| statusline | 378.3 |
| status <slug> (full CLI, plain) | 402.5 |
| find <slug> (graph + index build, TypeScript) | 400.9 |

| bound-log prefix (events) | bytes | fold ms (in-process, min of 3) |
| ---: | ---: | ---: |
| 557 | 0.39 MB | 3.1 |
| 1393 | 0.99 MB | 8.1 |
| 2785 | 1.88 MB | 14.9 |
| 5571 | 3.83 MB | 31.6 |
| 9749 | 6.69 MB | 54.6 |
| 13927 | 9.56 MB | 79.9 |
| 19497 | 13.44 MB | 118.5 |
| 27853 | 19.23 MB | 166.6 |

fold crosses 100 ms at ~16830 events / 11.6 MB; a full refold reaches 250 ms at never within this log

growth budget from the profiles (0.3 human / 0.7 agent, 10 sessions per user per week): 163 events and 0.11 MB per user per week — 100 users add 11 MB / 16300 events a week

## team100-w50 — team100 corpus (rust-core 1.5)
20 initiatives, 50 writers, 69.5 MB / 100219 events in all; bound record 19.1 MB / 27716 events, 1734 sessions of which 50 open (one per writer); largest log 19.1 MB

| measure | max RSS MB |
| --- | ---: |
| session-start (index warm) | 518.7 |
| post-tool Edit | 400.6 |
| user-prompt (nudge) | 542.6 |
| stop (blocked) | 377.9 |
| session-end | 376.4 |
| statusline | 376.3 |
| status <slug> (full CLI, plain) | 403.0 |
| find <slug> (graph + index build, TypeScript) | 402.8 |

| bound-log prefix (events) | bytes | fold ms (in-process, min of 3) |
| ---: | ---: | ---: |
| 556 | 0.39 MB | 3.9 |
| 1390 | 0.98 MB | 9.6 |
| 2780 | 1.88 MB | 17.3 |
| 5561 | 3.82 MB | 37.1 |
| 9731 | 6.68 MB | 58.9 |
| 13902 | 9.55 MB | 86.1 |
| 19462 | 13.43 MB | 122.4 |
| 27803 | 19.17 MB | 175.0 |

fold crosses 100 ms at ~16033 events / 11.0 MB; a full refold reaches 250 ms at never within this log

growth budget from the profiles (0.3 human / 0.7 agent, 10 sessions per user per week): 163 events and 0.11 MB per user per week — 100 users add 11 MB / 16300 events a week

## team100-w100 — team100 corpus (rust-core 1.5)
20 initiatives, 100 writers, 69.5 MB / 100246 events in all; bound record 19.2 MB / 27743 events, 1745 sessions of which 100 open (one per writer); largest log 19.2 MB

| measure | max RSS MB |
| --- | ---: |
| session-start (index warm) | 521.2 |
| post-tool Edit | 400.9 |
| user-prompt (nudge) | 532.7 |
| stop (blocked) | 379.1 |
| session-end | 380.7 |
| statusline | 378.8 |
| status <slug> (full CLI, plain) | 401.7 |
| find <slug> (graph + index build, TypeScript) | 401.7 |

| bound-log prefix (events) | bytes | fold ms (in-process, min of 3) |
| ---: | ---: | ---: |
| 557 | 0.39 MB | 3.8 |
| 1392 | 0.99 MB | 9.2 |
| 2783 | 1.88 MB | 16.9 |
| 5566 | 3.82 MB | 34.7 |
| 9741 | 6.68 MB | 61.2 |
| 13915 | 9.55 MB | 84.2 |
| 19481 | 13.43 MB | 116.3 |
| 27830 | 19.19 MB | 166.8 |

fold crosses 100 ms at ~16655 events / 11.5 MB; a full refold reaches 250 ms at never within this log

growth budget from the profiles (0.3 human / 0.7 agent, 10 sessions per user per week): 163 events and 0.11 MB per user per week — 100 users add 11 MB / 16300 events a week

## team100 — team100 corpus (rust-core 1.5)
20 initiatives, 100 writers, 345.4 MB / 500188 events in all; bound record 95.6 MB / 138950 events, 8576 sessions of which 100 open (one per writer); largest log 95.6 MB

| measure | max RSS MB |
| --- | ---: |
| session-start (index warm) | 1466.0 |
| post-tool Edit | 1209.9 |
| user-prompt (nudge) | 1368.4 |
| stop (blocked) | 1148.0 |
| session-end | 1138.8 |
| statusline | 1139.6 |
| status <slug> (full CLI, plain) | 1182.0 |
| find <slug> (graph + index build, TypeScript) | 1174.9 |

| bound-log prefix (events) | bytes | fold ms (in-process, min of 3) |
| ---: | ---: | ---: |
| 2781 | 1.88 MB | 19.1 |
| 6952 | 4.84 MB | 40.7 |
| 13904 | 9.54 MB | 86.1 |
| 27807 | 19.20 MB | 175.4 |
| 48663 | 33.64 MB | 312.2 |
| 69519 | 47.95 MB | 453.7 |
| 97326 | 67.25 MB | 644.5 |
| 139037 | 95.67 MB | 942.0 |

fold crosses 100 ms at ~16067 events / 11.0 MB; a full refold reaches 250 ms at ~39181 events / 27.1 MB

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
| team100-w10 | 167.2 | 174.5 | 1.3 | 3.1 |
| team100-w25 | 166.8 | 180.1 | 1.1 | 1.4 |
| team100-w50 | 175.4 | 187.1 | 1.4 | 1.9 |
| team100-w100 | 172.8 | 195.3 | 1.2 | 1.6 |
| team100 | 994.0 | 1068.8 | 5.9 | 10.3 |

