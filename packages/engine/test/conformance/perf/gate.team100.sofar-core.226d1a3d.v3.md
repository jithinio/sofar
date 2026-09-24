perf baseline — candidate (/Users/jins/IO/sofar-rust-core/target/release/sofar-core) · 20 spawns per cell · Apple M4 Pro, node v24.15.0 · commit 0a7638a2
node spawn floor: p50 21.9 ms · p95 22.8 ms · load avg 3.17 → 4.51

## team100-w10 — 20 initiatives, bound log 19.3 MB (27841 lines), 69.6 MB total
| command | p50 ms | p95 ms | min ms | vs target p50 | vs target p95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| session-start (index warm) | 7.8 | 9.3 | 7.3 | 0.16× | 0.16× |
| session-start (index cold) | 403.5 | 414.3 | 394.8 | 0.59× | 0.59× |
| post-tool Edit | 47.7 | 56.1 | 43.1 | 0.41× | 0.46× |
| user-prompt (nudge) | 15.1 | 16.1 | 14.5 | 0.25× | 0.24× |
| stop (blocked) | 11.6 | 12.0 | 11.4 | 0.21× | 0.16× |
| session-end | 43.9 | 46.0 | 42.1 | 0.39× | 0.36× |
| statusline | 2.3 | 2.6 | 2.1 | 0.07× | 0.06× |
| status <slug> (full CLI, plain) | 220.2 | 240.7 | 214.6 | 0.74× | 0.74× |
| find <slug> (graph + index build, TypeScript) | 668.5 | 699.2 | 619.9 | 1.06× | 1.05× |

## team100-w25 — 20 initiatives, bound log 19.2 MB (27766 lines), 69.5 MB total
| command | p50 ms | p95 ms | min ms | vs target p50 | vs target p95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| session-start (index warm) | 7.3 | 8.0 | 7.1 | 0.16× | 0.16× |
| session-start (index cold) | 392.4 | 407.6 | 387.4 | 0.55× | 0.54× |
| post-tool Edit | 44.5 | 49.6 | 42.8 | 0.37× | 0.37× |
| user-prompt (nudge) | 15.0 | 15.8 | 14.3 | 0.23× | 0.23× |
| stop (blocked) | 11.4 | 12.2 | 11.2 | 0.19× | 0.19× |
| session-end | 42.8 | 43.6 | 40.9 | 0.35× | 0.33× |
| statusline | 2.3 | 2.8 | 2.2 | 0.06× | 0.07× |
| status <slug> (full CLI, plain) | 219.2 | 232.7 | 213.3 | 0.73× | 0.75× |
| find <slug> (graph + index build, TypeScript) | 610.9 | 640.4 | 599.0 | 0.95× | 0.91× |

## team100-w50 — 20 initiatives, bound log 19.1 MB (27716 lines), 69.5 MB total
| command | p50 ms | p95 ms | min ms | vs target p50 | vs target p95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| session-start (index warm) | 7.8 | 9.0 | 7.3 | 0.15× | 0.17× |
| session-start (index cold) | 397.8 | 408.0 | 389.8 | 0.57× | 0.56× |
| post-tool Edit | 44.3 | 53.5 | 42.8 | 0.36× | 0.39× |
| user-prompt (nudge) | 14.6 | 14.8 | 14.2 | 0.22× | 0.21× |
| stop (blocked) | 11.6 | 12.1 | 11.2 | 0.21× | 0.19× |
| session-end | 42.9 | 44.4 | 42.0 | 0.37× | 0.35× |
| statusline | 2.3 | 3.0 | 2.1 | 0.07× | 0.08× |
| status <slug> (full CLI, plain) | 217.3 | 223.4 | 212.9 | 0.75× | 0.73× |
| find <slug> (graph + index build, TypeScript) | 632.4 | 686.0 | 606.8 | 1.01× | 1.04× |

## team100-w100 — 20 initiatives, bound log 19.2 MB (27743 lines), 69.5 MB total
| command | p50 ms | p95 ms | min ms | vs target p50 | vs target p95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| session-start (index warm) | 8.1 | 8.6 | 7.7 | 0.17× | 0.18× |
| session-start (index cold) | 423.0 | 433.3 | 394.6 | 0.61× | 0.59× |
| post-tool Edit | 44.4 | 48.6 | 42.9 | 0.37× | 0.38× |
| user-prompt (nudge) | 15.2 | 15.8 | 14.7 | 0.23× | 0.21× |
| stop (blocked) | 11.9 | 12.7 | 11.6 | 0.21× | 0.22× |
| session-end | 44.5 | 48.2 | 41.1 | 0.39× | 0.41× |
| statusline | 2.2 | 2.7 | 2.2 | 0.06× | 0.07× |
| status <slug> (full CLI, plain) | 224.4 | 242.5 | 215.2 | 0.75× | 0.79× |
| find <slug> (graph + index build, TypeScript) | 663.0 | 700.8 | 618.5 | 1.04× | 1.02× |

## team100 — 20 initiatives, bound log 95.6 MB (138950 lines), 345.4 MB total
| command | p50 ms | p95 ms | min ms | vs target p50 | vs target p95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| session-start (index warm) | 19.6 | 25.2 | 18.3 | 0.25× | 0.29× |
| session-start (index cold) | 2003.5 | 2060.0 | 1952.6 | 0.60× | 0.59× |
| post-tool Edit | 170.7 | 204.0 | 163.3 | 0.44× | 0.45× |
| user-prompt (nudge) | 69.1 | 74.8 | 66.6 | 0.43× | 0.45× |
| stop (blocked) | 56.1 | 59.0 | 50.7 | 0.41× | 0.41× |
| session-end | 178.9 | 186.1 | 167.2 | 0.49× | 0.44× |
| statusline | 4.0 | 4.7 | 3.9 | 0.10× | 0.11× |
| status <slug> (full CLI, plain) | 1177.5 | 1209.0 | 1152.4 | 0.80× | 0.79× |
| find <slug> (graph + index build, TypeScript) | 3146.9 | 3260.8 | 3017.2 | 1.00× | 0.99× |

## team100-w10 — team100 corpus (rust-core 1.5)
20 initiatives, 10 writers, 69.6 MB / 100344 events in all; bound record 19.3 MB / 27841 events, 1735 sessions of which 10 open (one per writer); largest log 19.3 MB

| measure | max RSS MB |
| --- | ---: |
| session-start (index warm) | 169.6 |
| post-tool Edit | 28.7 |
| user-prompt (nudge) | 158.4 |
| stop (blocked) | 29.3 |
| session-end | 26.6 |
| statusline | 26.9 |
| status <slug> (full CLI, plain) | 286.5 |
| find <slug> (graph + index build, TypeScript) | 401.7 |

| bound-log prefix (events) | bytes | fold ms (process, min of 3) |
| ---: | ---: | ---: |
| 559 | 0.40 MB | 6.4 |
| 1396 | 0.99 MB | 13.1 |
| 2793 | 1.89 MB | 23.2 |
| 5586 | 3.84 MB | 44.7 |
| 9775 | 6.72 MB | 75.8 |
| 13964 | 9.59 MB | 105.9 |
| 19550 | 13.48 MB | 148.9 |
| 27928 | 19.28 MB | 214.4 |

fold crosses 100 ms at ~13146 events / 9.0 MB; a full refold reaches 250 ms at never within this log

growth budget from the profiles (0.3 human / 0.7 agent, 10 sessions per user per week): 163 events and 0.11 MB per user per week — 100 users add 11 MB / 16300 events a week

## team100-w25 — team100 corpus (rust-core 1.5)
20 initiatives, 25 writers, 69.5 MB / 100269 events in all; bound record 19.2 MB / 27766 events, 1734 sessions of which 25 open (one per writer); largest log 19.2 MB

| measure | max RSS MB |
| --- | ---: |
| session-start (index warm) | 167.1 |
| post-tool Edit | 28.5 |
| user-prompt (nudge) | 157.2 |
| stop (blocked) | 29.0 |
| session-end | 26.3 |
| statusline | 26.9 |
| status <slug> (full CLI, plain) | 223.0 |
| find <slug> (graph + index build, TypeScript) | 401.0 |

| bound-log prefix (events) | bytes | fold ms (process, min of 3) |
| ---: | ---: | ---: |
| 557 | 0.39 MB | 6.2 |
| 1393 | 0.99 MB | 12.8 |
| 2785 | 1.88 MB | 22.9 |
| 5571 | 3.83 MB | 44.1 |
| 9749 | 6.69 MB | 74.3 |
| 13927 | 9.56 MB | 112.1 |
| 19497 | 13.44 MB | 146.5 |
| 27853 | 19.23 MB | 213.3 |

fold crosses 100 ms at ~12592 events / 8.6 MB; a full refold reaches 250 ms at never within this log

growth budget from the profiles (0.3 human / 0.7 agent, 10 sessions per user per week): 163 events and 0.11 MB per user per week — 100 users add 11 MB / 16300 events a week

## team100-w50 — team100 corpus (rust-core 1.5)
20 initiatives, 50 writers, 69.5 MB / 100219 events in all; bound record 19.1 MB / 27716 events, 1734 sessions of which 50 open (one per writer); largest log 19.1 MB

| measure | max RSS MB |
| --- | ---: |
| session-start (index warm) | 167.2 |
| post-tool Edit | 29.0 |
| user-prompt (nudge) | 156.6 |
| stop (blocked) | 29.2 |
| session-end | 26.5 |
| statusline | 26.5 |
| status <slug> (full CLI, plain) | 249.9 |
| find <slug> (graph + index build, TypeScript) | 402.8 |

| bound-log prefix (events) | bytes | fold ms (process, min of 3) |
| ---: | ---: | ---: |
| 556 | 0.39 MB | 6.5 |
| 1390 | 0.98 MB | 12.7 |
| 2780 | 1.88 MB | 23.5 |
| 5561 | 3.82 MB | 44.7 |
| 9731 | 6.68 MB | 74.7 |
| 13902 | 9.55 MB | 106.0 |
| 19462 | 13.43 MB | 157.2 |
| 27803 | 19.17 MB | 220.3 |

fold crosses 100 ms at ~13101 events / 9.0 MB; a full refold reaches 250 ms at never within this log

growth budget from the profiles (0.3 human / 0.7 agent, 10 sessions per user per week): 163 events and 0.11 MB per user per week — 100 users add 11 MB / 16300 events a week

## team100-w100 — team100 corpus (rust-core 1.5)
20 initiatives, 100 writers, 69.5 MB / 100246 events in all; bound record 19.2 MB / 27743 events, 1745 sessions of which 100 open (one per writer); largest log 19.2 MB

| measure | max RSS MB |
| --- | ---: |
| session-start (index warm) | 170.0 |
| post-tool Edit | 29.0 |
| user-prompt (nudge) | 156.8 |
| stop (blocked) | 29.0 |
| session-end | 26.5 |
| statusline | 26.6 |
| status <slug> (full CLI, plain) | 285.7 |
| find <slug> (graph + index build, TypeScript) | 401.4 |

| bound-log prefix (events) | bytes | fold ms (process, min of 3) |
| ---: | ---: | ---: |
| 557 | 0.39 MB | 6.7 |
| 1392 | 0.99 MB | 13.8 |
| 2783 | 1.88 MB | 24.0 |
| 5566 | 3.82 MB | 45.7 |
| 9741 | 6.68 MB | 79.6 |
| 13915 | 9.55 MB | 109.5 |
| 19481 | 13.43 MB | 160.9 |
| 27830 | 19.19 MB | 223.3 |

fold crosses 100 ms at ~12588 events / 8.6 MB; a full refold reaches 250 ms at never within this log

growth budget from the profiles (0.3 human / 0.7 agent, 10 sessions per user per week): 163 events and 0.11 MB per user per week — 100 users add 11 MB / 16300 events a week

## team100 — team100 corpus (rust-core 1.5)
20 initiatives, 100 writers, 345.4 MB / 500188 events in all; bound record 95.6 MB / 138950 events, 8576 sessions of which 100 open (one per writer); largest log 95.6 MB

| measure | max RSS MB |
| --- | ---: |
| session-start (index warm) | 908.4 |
| post-tool Edit | 125.2 |
| user-prompt (nudge) | 844.1 |
| stop (blocked) | 125.5 |
| session-end | 118.1 |
| statusline | 115.3 |
| status <slug> (full CLI, plain) | 1130.2 |
| find <slug> (graph + index build, TypeScript) | 1176.0 |

| bound-log prefix (events) | bytes | fold ms (process, min of 3) |
| ---: | ---: | ---: |
| 2781 | 1.88 MB | 23.3 |
| 6952 | 4.84 MB | 56.1 |
| 13904 | 9.54 MB | 107.0 |
| 27807 | 19.20 MB | 223.9 |
| 48663 | 33.64 MB | 376.8 |
| 69519 | 47.95 MB | 574.0 |
| 97326 | 67.25 MB | 777.6 |
| 139037 | 95.67 MB | 1177.8 |

fold crosses 100 ms at ~12947 events / 8.9 MB; a full refold reaches 250 ms at ~31363 events / 21.7 MB

growth budget from the profiles (0.3 human / 0.7 agent, 10 sessions per user per week): 163 events and 0.11 MB per user per week — 100 users add 11 MB / 16300 events a week

