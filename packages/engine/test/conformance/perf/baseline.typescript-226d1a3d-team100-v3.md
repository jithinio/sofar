perf baseline [team100 AFTER at rust-core 226d1a3d (4.4 digest v3), AC check waived by the operator for this gate only (M16), same sitting as the candidate (D12)] — typescript (node dist/cli.js (built from source as build.mjs ships it)) · 20 spawns per cell · Apple M4 Pro, node v24.15.0 · commit 0a7638a2
node spawn floor: p50 22.4 ms · p95 24.5 ms · load avg 3.03 → 3.17

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
| session-start (index warm) | 49.1 | 57.0 | 45.3 |
| session-start (index cold) | 679.4 | 701.0 | 650.9 |
| post-tool Edit | 115.7 | 121.3 | 112.1 |
| user-prompt (nudge) | 60.8 | 67.3 | 58.8 |
| stop (blocked) | 54.9 | 75.4 | 52.9 |
| session-end | 113.3 | 128.7 | 109.3 |
| statusline | 33.4 | 40.8 | 31.9 |
| status <slug> (full CLI, plain) | 297.0 | 323.6 | 284.1 |
| find <slug> (graph + index build, TypeScript) | 630.9 | 663.6 | 611.2 |

## team100-w25 — 20 initiatives, bound log 19.2 MB (27766 lines), 69.5 MB total
| command | p50 ms | p95 ms | min ms |
| --- | ---: | ---: | ---: |
| session-start (index warm) | 46.3 | 49.5 | 44.9 |
| session-start (index cold) | 709.2 | 750.6 | 676.8 |
| post-tool Edit | 120.4 | 134.1 | 112.6 |
| user-prompt (nudge) | 64.9 | 69.6 | 61.2 |
| stop (blocked) | 60.9 | 63.1 | 56.6 |
| session-end | 123.4 | 131.6 | 112.5 |
| statusline | 37.0 | 38.9 | 34.3 |
| status <slug> (full CLI, plain) | 301.1 | 311.9 | 286.0 |
| find <slug> (graph + index build, TypeScript) | 644.2 | 701.2 | 619.6 |

## team100-w50 — 20 initiatives, bound log 19.1 MB (27716 lines), 69.5 MB total
| command | p50 ms | p95 ms | min ms |
| --- | ---: | ---: | ---: |
| session-start (index warm) | 50.3 | 54.5 | 47.0 |
| session-start (index cold) | 698.8 | 726.0 | 667.5 |
| post-tool Edit | 124.1 | 137.5 | 115.4 |
| user-prompt (nudge) | 67.5 | 70.4 | 61.4 |
| stop (blocked) | 55.9 | 63.5 | 53.7 |
| session-end | 116.7 | 128.3 | 109.8 |
| statusline | 33.5 | 36.7 | 32.2 |
| status <slug> (full CLI, plain) | 291.6 | 307.5 | 282.4 |
| find <slug> (graph + index build, TypeScript) | 626.8 | 661.8 | 607.5 |

## team100-w100 — 20 initiatives, bound log 19.2 MB (27743 lines), 69.5 MB total
| command | p50 ms | p95 ms | min ms |
| --- | ---: | ---: | ---: |
| session-start (index warm) | 47.6 | 48.7 | 46.4 |
| session-start (index cold) | 694.2 | 728.4 | 668.6 |
| post-tool Edit | 120.0 | 127.5 | 114.5 |
| user-prompt (nudge) | 65.2 | 73.8 | 61.3 |
| stop (blocked) | 55.6 | 58.2 | 53.6 |
| session-end | 114.9 | 117.6 | 111.2 |
| statusline | 36.0 | 39.8 | 32.7 |
| status <slug> (full CLI, plain) | 298.3 | 307.1 | 287.2 |
| find <slug> (graph + index build, TypeScript) | 640.2 | 690.0 | 626.4 |

## team100 — 20 initiatives, bound log 95.6 MB (138950 lines), 345.4 MB total
| command | p50 ms | p95 ms | min ms |
| --- | ---: | ---: | ---: |
| session-start (index warm) | 77.1 | 88.2 | 75.1 |
| session-start (index cold) | 3354.8 | 3480.2 | 3245.8 |
| post-tool Edit | 387.3 | 454.6 | 371.5 |
| user-prompt (nudge) | 161.3 | 166.6 | 157.8 |
| stop (blocked) | 136.5 | 142.5 | 130.2 |
| session-end | 368.2 | 418.5 | 361.6 |
| statusline | 38.5 | 41.0 | 37.0 |
| status <slug> (full CLI, plain) | 1464.8 | 1529.3 | 1443.2 |
| find <slug> (graph + index build, TypeScript) | 3133.6 | 3302.3 | 3024.8 |

## team100-w10 — team100 corpus (rust-core 1.5)
20 initiatives, 10 writers, 69.6 MB / 100344 events in all; bound record 19.3 MB / 27841 events, 1735 sessions of which 10 open (one per writer); largest log 19.3 MB

| measure | max RSS MB |
| --- | ---: |
| session-start (index warm) | 444.2 |
| post-tool Edit | 144.8 |
| user-prompt (nudge) | 465.2 |
| stop (blocked) | 116.4 |
| session-end | 115.0 |
| statusline | 116.6 |
| status <slug> (full CLI, plain) | 402.1 |
| find <slug> (graph + index build, TypeScript) | 401.4 |

| bound-log prefix (events) | bytes | fold ms (in-process, min of 3) |
| ---: | ---: | ---: |
| 559 | 0.40 MB | 4.2 |
| 1396 | 0.99 MB | 8.6 |
| 2793 | 1.89 MB | 15.3 |
| 5586 | 3.84 MB | 31.6 |
| 9775 | 6.72 MB | 55.7 |
| 13964 | 9.59 MB | 78.5 |
| 19550 | 13.48 MB | 114.8 |
| 27928 | 19.28 MB | 169.3 |

fold crosses 100 ms at ~17273 events / 11.9 MB; a full refold reaches 250 ms at never within this log

growth budget from the profiles (0.3 human / 0.7 agent, 10 sessions per user per week): 163 events and 0.11 MB per user per week — 100 users add 11 MB / 16300 events a week

## team100-w25 — team100 corpus (rust-core 1.5)
20 initiatives, 25 writers, 69.5 MB / 100269 events in all; bound record 19.2 MB / 27766 events, 1734 sessions of which 25 open (one per writer); largest log 19.2 MB

| measure | max RSS MB |
| --- | ---: |
| session-start (index warm) | 474.0 |
| post-tool Edit | 142.7 |
| user-prompt (nudge) | 466.2 |
| stop (blocked) | 116.1 |
| session-end | 114.9 |
| statusline | 117.8 |
| status <slug> (full CLI, plain) | 402.0 |
| find <slug> (graph + index build, TypeScript) | 401.4 |

| bound-log prefix (events) | bytes | fold ms (in-process, min of 3) |
| ---: | ---: | ---: |
| 557 | 0.39 MB | 3.8 |
| 1393 | 0.99 MB | 8.5 |
| 2785 | 1.88 MB | 15.1 |
| 5571 | 3.83 MB | 32.3 |
| 9749 | 6.69 MB | 54.2 |
| 13927 | 9.56 MB | 82.1 |
| 19497 | 13.44 MB | 116.1 |
| 27853 | 19.23 MB | 163.8 |

fold crosses 100 ms at ~16854 events / 11.6 MB; a full refold reaches 250 ms at never within this log

growth budget from the profiles (0.3 human / 0.7 agent, 10 sessions per user per week): 163 events and 0.11 MB per user per week — 100 users add 11 MB / 16300 events a week

## team100-w50 — team100 corpus (rust-core 1.5)
20 initiatives, 50 writers, 69.5 MB / 100219 events in all; bound record 19.1 MB / 27716 events, 1734 sessions of which 50 open (one per writer); largest log 19.1 MB

| measure | max RSS MB |
| --- | ---: |
| session-start (index warm) | 455.6 |
| post-tool Edit | 142.7 |
| user-prompt (nudge) | 468.3 |
| stop (blocked) | 116.9 |
| session-end | 114.8 |
| statusline | 117.1 |
| status <slug> (full CLI, plain) | 402.7 |
| find <slug> (graph + index build, TypeScript) | 401.3 |

| bound-log prefix (events) | bytes | fold ms (in-process, min of 3) |
| ---: | ---: | ---: |
| 556 | 0.39 MB | 3.7 |
| 1390 | 0.98 MB | 8.6 |
| 2780 | 1.88 MB | 15.7 |
| 5561 | 3.82 MB | 32.9 |
| 9731 | 6.68 MB | 54.7 |
| 13902 | 9.55 MB | 83.0 |
| 19462 | 13.43 MB | 115.1 |
| 27803 | 19.17 MB | 163.7 |

fold crosses 100 ms at ~16845 events / 11.6 MB; a full refold reaches 250 ms at never within this log

growth budget from the profiles (0.3 human / 0.7 agent, 10 sessions per user per week): 163 events and 0.11 MB per user per week — 100 users add 11 MB / 16300 events a week

## team100-w100 — team100 corpus (rust-core 1.5)
20 initiatives, 100 writers, 69.5 MB / 100246 events in all; bound record 19.2 MB / 27743 events, 1745 sessions of which 100 open (one per writer); largest log 19.2 MB

| measure | max RSS MB |
| --- | ---: |
| session-start (index warm) | 455.0 |
| post-tool Edit | 143.7 |
| user-prompt (nudge) | 477.4 |
| stop (blocked) | 118.5 |
| session-end | 115.4 |
| statusline | 117.2 |
| status <slug> (full CLI, plain) | 402.7 |
| find <slug> (graph + index build, TypeScript) | 405.8 |

| bound-log prefix (events) | bytes | fold ms (in-process, min of 3) |
| ---: | ---: | ---: |
| 557 | 0.39 MB | 3.3 |
| 1392 | 0.99 MB | 8.6 |
| 2783 | 1.88 MB | 16.1 |
| 5566 | 3.82 MB | 33.8 |
| 9741 | 6.68 MB | 58.1 |
| 13915 | 9.55 MB | 83.7 |
| 19481 | 13.43 MB | 120.8 |
| 27830 | 19.19 MB | 171.7 |

fold crosses 100 ms at ~16360 events / 11.3 MB; a full refold reaches 250 ms at never within this log

growth budget from the profiles (0.3 human / 0.7 agent, 10 sessions per user per week): 163 events and 0.11 MB per user per week — 100 users add 11 MB / 16300 events a week

## team100 — team100 corpus (rust-core 1.5)
20 initiatives, 100 writers, 345.4 MB / 500188 events in all; bound record 95.6 MB / 138950 events, 8576 sessions of which 100 open (one per writer); largest log 95.6 MB

| measure | max RSS MB |
| --- | ---: |
| session-start (index warm) | 1197.1 |
| post-tool Edit | 379.9 |
| user-prompt (nudge) | 1125.2 |
| stop (blocked) | 308.6 |
| session-end | 308.2 |
| statusline | 311.9 |
| status <slug> (full CLI, plain) | 1172.5 |
| find <slug> (graph + index build, TypeScript) | 1175.7 |

| bound-log prefix (events) | bytes | fold ms (in-process, min of 3) |
| ---: | ---: | ---: |
| 2781 | 1.88 MB | 17.9 |
| 6952 | 4.84 MB | 41.5 |
| 13904 | 9.54 MB | 81.2 |
| 27807 | 19.20 MB | 165.8 |
| 48663 | 33.64 MB | 296.9 |
| 69519 | 47.95 MB | 429.7 |
| 97326 | 67.25 MB | 637.4 |
| 139037 | 95.67 MB | 952.5 |

fold crosses 100 ms at ~16990 events / 11.7 MB; a full refold reaches 250 ms at ~41203 events / 28.5 MB

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
| team100-w10 | 174.9 | 195.6 | 1.3 | 1.8 |
| team100-w25 | 173.3 | 188.4 | 1.2 | 1.4 |
| team100-w50 | 171.9 | 184.7 | 1.2 | 1.5 |
| team100-w100 | 179.6 | 191.4 | 1.2 | 1.6 |
| team100 | 991.3 | 1066.4 | 5.6 | 8.4 |

