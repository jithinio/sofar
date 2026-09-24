perf baseline — candidate (/Users/jins/IO/sofar-rust-core/target/release/sofar-core) · 20 spawns per cell · Apple M4 Pro, node v24.15.0 · commit 3f9fe5cf
node spawn floor: p50 20.1 ms · p95 21.5 ms · load avg 2.21 → 6.48

## team100-w10 — 20 initiatives, bound log 19.3 MB (27841 lines), 69.6 MB total
| command | p50 ms | p95 ms | min ms | vs target p50 | vs target p95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| session-start (index warm) | 24.9 | 53.6 | 22.2 | 0.42× | 0.79× |
| session-start (index cold) | 513.5 | 561.3 | 502.0 | 0.55× | 0.55× |
| post-tool Edit | 169.5 | 175.1 | 164.9 | 0.45× | 0.37× |
| user-prompt (nudge) | 129.5 | 135.7 | 124.9 | 0.48× | 0.43× |
| stop (blocked) | 128.4 | 135.4 | 121.4 | 0.52× | 0.53× |
| session-end | 189.9 | 207.2 | 185.7 | 0.56× | 0.56× |
| statusline | 2.9 | 3.4 | 2.7 | 0.08× | 0.09× |
| status <slug> (full CLI, plain) | 219.2 | 224.4 | 214.5 | 0.72× | 0.69× |
| find <slug> (graph + index build, TypeScript) | 635.5 | 689.7 | 610.8 | 1.00× | 1.04× |

## team100-w25 — 20 initiatives, bound log 19.2 MB (27766 lines), 69.5 MB total
| command | p50 ms | p95 ms | min ms | vs target p50 | vs target p95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| session-start (index warm) | 22.6 | 29.5 | 19.8 | 0.37× | 0.39× |
| session-start (index cold) | 508.6 | 527.1 | 501.5 | 0.57× | 0.58× |
| post-tool Edit | 169.6 | 174.2 | 166.7 | 0.50× | 0.48× |
| user-prompt (nudge) | 132.4 | 149.1 | 128.1 | 0.50× | 0.52× |
| stop (blocked) | 124.8 | 127.6 | 122.3 | 0.49× | 0.49× |
| session-end | 188.5 | 193.2 | 185.3 | 0.56× | 0.55× |
| statusline | 2.8 | 3.3 | 2.7 | 0.09× | 0.10× |
| status <slug> (full CLI, plain) | 215.9 | 224.6 | 212.7 | 0.75× | 0.77× |
| find <slug> (graph + index build, TypeScript) | 631.6 | 683.1 | 600.8 | 1.00× | 1.05× |

## team100-w50 — 20 initiatives, bound log 19.1 MB (27716 lines), 69.5 MB total
| command | p50 ms | p95 ms | min ms | vs target p50 | vs target p95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| session-start (index warm) | 22.4 | 25.7 | 21.1 | 0.38× | 0.39× |
| session-start (index cold) | 502.9 | 550.6 | 493.9 | 0.56× | 0.59× |
| post-tool Edit | 170.5 | 179.3 | 166.9 | 0.50× | 0.50× |
| user-prompt (nudge) | 128.2 | 131.7 | 125.1 | 0.49× | 0.49× |
| stop (blocked) | 125.4 | 130.3 | 121.9 | 0.49× | 0.49× |
| session-end | 191.4 | 198.1 | 188.2 | 0.57× | 0.58× |
| statusline | 2.8 | 3.4 | 2.7 | 0.08× | 0.10× |
| status <slug> (full CLI, plain) | 219.8 | 225.1 | 215.3 | 0.76× | 0.73× |
| find <slug> (graph + index build, TypeScript) | 619.7 | 655.1 | 602.5 | 1.02× | 1.05× |

## team100-w100 — 20 initiatives, bound log 19.2 MB (27743 lines), 69.5 MB total
| command | p50 ms | p95 ms | min ms | vs target p50 | vs target p95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| session-start (index warm) | 23.3 | 29.3 | 22.5 | 0.38× | 0.44× |
| session-start (index cold) | 513.4 | 534.5 | 497.9 | 0.57× | 0.58× |
| post-tool Edit | 171.1 | 186.7 | 166.6 | 0.51× | 0.53× |
| user-prompt (nudge) | 132.3 | 147.6 | 127.7 | 0.51× | 0.52× |
| stop (blocked) | 131.1 | 143.0 | 123.7 | 0.52× | 0.56× |
| session-end | 193.2 | 207.3 | 189.5 | 0.58× | 0.59× |
| statusline | 3.0 | 3.4 | 2.7 | 0.09× | 0.10× |
| status <slug> (full CLI, plain) | 240.8 | 269.0 | 226.0 | 0.82× | 0.88× |
| find <slug> (graph + index build, TypeScript) | 633.9 | 678.5 | 608.3 | 1.02× | 1.06× |

## team100 — 20 initiatives, bound log 95.6 MB (138950 lines), 345.4 MB total
| command | p50 ms | p95 ms | min ms | vs target p50 | vs target p95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| session-start (index warm) | 51.0 | 51.5 | 50.6 | 0.51× | 0.50× |
| session-start (index cold) | 2593.9 | 2712.6 | 2530.4 | 0.46× | 0.46× |
| post-tool Edit | 863.9 | 924.0 | 851.2 | 0.45× | 0.45× |
| user-prompt (nudge) | 667.4 | 696.9 | 662.2 | 0.45× | 0.45× |
| stop (blocked) | 657.0 | 681.9 | 642.6 | 0.46× | 0.46× |
| session-end | 1001.7 | 1091.3 | 962.2 | 0.55× | 0.52× |
| statusline | 7.1 | 7.4 | 6.7 | 0.18× | 0.19× |
| status <slug> (full CLI, plain) | 1143.3 | 1237.8 | 1107.7 | 0.78× | 0.83× |
| find <slug> (graph + index build, TypeScript) | 3126.6 | 3254.3 | 3041.5 | 1.05× | 1.07× |

## team100-w10 — team100 corpus (rust-core 1.5)
20 initiatives, 10 writers, 69.6 MB / 100344 events in all; bound record 19.3 MB / 27841 events, 1735 sessions of which 10 open (one per writer); largest log 19.3 MB

| measure | max RSS MB |
| --- | ---: |
| session-start (index warm) | 262.4 |
| post-tool Edit | 160.1 |
| user-prompt (nudge) | 241.3 |
| stop (blocked) | 161.7 |
| session-end | 159.8 |
| statusline | 159.2 |
| status <slug> (full CLI, plain) | 251.3 |
| find <slug> (graph + index build, TypeScript) | 401.7 |

| bound-log prefix (events) | bytes | fold ms (process, min of 3) |
| ---: | ---: | ---: |
| 559 | 0.40 MB | 6.9 |
| 1396 | 0.99 MB | 13.5 |
| 2793 | 1.89 MB | 23.9 |
| 5586 | 3.84 MB | 44.3 |
| 9775 | 6.72 MB | 76.5 |
| 13964 | 9.59 MB | 109.8 |
| 19550 | 13.48 MB | 150.9 |
| 27928 | 19.28 MB | 212.2 |

fold crosses 100 ms at ~12732 events / 8.7 MB; a full refold reaches 250 ms at never within this log

growth budget from the profiles (0.3 human / 0.7 agent, 10 sessions per user per week): 163 events and 0.11 MB per user per week — 100 users add 11 MB / 16300 events a week

## team100-w25 — team100 corpus (rust-core 1.5)
20 initiatives, 25 writers, 69.5 MB / 100269 events in all; bound record 19.2 MB / 27766 events, 1734 sessions of which 25 open (one per writer); largest log 19.2 MB

| measure | max RSS MB |
| --- | ---: |
| session-start (index warm) | 262.0 |
| post-tool Edit | 158.3 |
| user-prompt (nudge) | 253.0 |
| stop (blocked) | 161.9 |
| session-end | 159.3 |
| statusline | 160.0 |
| status <slug> (full CLI, plain) | 251.9 |
| find <slug> (graph + index build, TypeScript) | 403.2 |

| bound-log prefix (events) | bytes | fold ms (process, min of 3) |
| ---: | ---: | ---: |
| 557 | 0.39 MB | 6.3 |
| 1393 | 0.99 MB | 12.4 |
| 2785 | 1.88 MB | 22.6 |
| 5571 | 3.83 MB | 44.0 |
| 9749 | 6.69 MB | 77.4 |
| 13927 | 9.56 MB | 111.3 |
| 19497 | 13.44 MB | 148.6 |
| 27853 | 19.23 MB | 215.8 |

fold crosses 100 ms at ~12534 events / 8.6 MB; a full refold reaches 250 ms at never within this log

growth budget from the profiles (0.3 human / 0.7 agent, 10 sessions per user per week): 163 events and 0.11 MB per user per week — 100 users add 11 MB / 16300 events a week

## team100-w50 — team100 corpus (rust-core 1.5)
20 initiatives, 50 writers, 69.5 MB / 100219 events in all; bound record 19.1 MB / 27716 events, 1734 sessions of which 50 open (one per writer); largest log 19.1 MB

| measure | max RSS MB |
| --- | ---: |
| session-start (index warm) | 255.2 |
| post-tool Edit | 157.8 |
| user-prompt (nudge) | 241.4 |
| stop (blocked) | 160.1 |
| session-end | 157.5 |
| statusline | 157.9 |
| status <slug> (full CLI, plain) | 248.3 |
| find <slug> (graph + index build, TypeScript) | 402.1 |

| bound-log prefix (events) | bytes | fold ms (process, min of 3) |
| ---: | ---: | ---: |
| 556 | 0.39 MB | 6.9 |
| 1390 | 0.98 MB | 13.3 |
| 2780 | 1.88 MB | 23.6 |
| 5561 | 3.82 MB | 45.7 |
| 9731 | 6.68 MB | 77.3 |
| 13902 | 9.55 MB | 105.8 |
| 19462 | 13.43 MB | 152.3 |
| 27803 | 19.17 MB | 210.3 |

fold crosses 100 ms at ~13049 events / 9.0 MB; a full refold reaches 250 ms at never within this log

growth budget from the profiles (0.3 human / 0.7 agent, 10 sessions per user per week): 163 events and 0.11 MB per user per week — 100 users add 11 MB / 16300 events a week

## team100-w100 — team100 corpus (rust-core 1.5)
20 initiatives, 100 writers, 69.5 MB / 100246 events in all; bound record 19.2 MB / 27743 events, 1745 sessions of which 100 open (one per writer); largest log 19.2 MB

| measure | max RSS MB |
| --- | ---: |
| session-start (index warm) | 256.0 |
| post-tool Edit | 161.6 |
| user-prompt (nudge) | 242.0 |
| stop (blocked) | 160.5 |
| session-end | 157.8 |
| statusline | 158.1 |
| status <slug> (full CLI, plain) | 247.8 |
| find <slug> (graph + index build, TypeScript) | 401.3 |

| bound-log prefix (events) | bytes | fold ms (process, min of 3) |
| ---: | ---: | ---: |
| 557 | 0.39 MB | 6.2 |
| 1392 | 0.99 MB | 12.4 |
| 2783 | 1.88 MB | 23.0 |
| 5566 | 3.82 MB | 43.8 |
| 9741 | 6.68 MB | 75.4 |
| 13915 | 9.55 MB | 109.6 |
| 19481 | 13.43 MB | 149.4 |
| 27830 | 19.19 MB | 208.3 |

fold crosses 100 ms at ~12743 events / 8.7 MB; a full refold reaches 250 ms at never within this log

growth budget from the profiles (0.3 human / 0.7 agent, 10 sessions per user per week): 163 events and 0.11 MB per user per week — 100 users add 11 MB / 16300 events a week

## team100 — team100 corpus (rust-core 1.5)
20 initiatives, 100 writers, 345.4 MB / 500188 events in all; bound record 95.6 MB / 138950 events, 8576 sessions of which 100 open (one per writer); largest log 95.6 MB

| measure | max RSS MB |
| --- | ---: |
| session-start (index warm) | 1367.3 |
| post-tool Edit | 790.4 |
| user-prompt (nudge) | 1298.7 |
| stop (blocked) | 800.3 |
| session-end | 795.2 |
| statusline | 794.8 |
| status <slug> (full CLI, plain) | 1258.5 |
| find <slug> (graph + index build, TypeScript) | 1175.8 |

| bound-log prefix (events) | bytes | fold ms (process, min of 3) |
| ---: | ---: | ---: |
| 2781 | 1.88 MB | 23.4 |
| 6952 | 4.84 MB | 54.9 |
| 13904 | 9.54 MB | 116.3 |
| 27807 | 19.20 MB | 219.1 |
| 48663 | 33.64 MB | 386.5 |
| 69519 | 47.95 MB | 562.7 |
| 97326 | 67.25 MB | 775.4 |
| 139037 | 95.67 MB | 1184.9 |

fold crosses 100 ms at ~12055 events / 8.3 MB; a full refold reaches 250 ms at ~31657 events / 21.9 MB

growth budget from the profiles (0.3 human / 0.7 agent, 10 sessions per user per week): 163 events and 0.11 MB per user per week — 100 users add 11 MB / 16300 events a week

