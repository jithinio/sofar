perf baseline — candidate (/Users/jins/IO/sofar-rust-core/target/release/sofar-core) · 20 spawns per cell · Apple M4 Pro, node v24.15.0 · commit 4b5b62b2
node spawn floor: p50 22.8 ms · p95 27.0 ms · load avg 4.93 → 5.05

## team100-w10 — 20 initiatives, bound log 19.3 MB (27841 lines), 69.6 MB total
| command | p50 ms | p95 ms | min ms | vs target p50 | vs target p95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| session-start (index warm) | 12.8 | 14.1 | 11.8 | 0.23× | 0.22× |
| session-start (index cold) | 418.1 | 440.1 | 408.1 | 0.58× | 0.60× |
| post-tool Edit | 48.5 | 56.6 | 45.4 | 0.37× | 0.41× |
| user-prompt (nudge) | 16.9 | 17.9 | 16.1 | 0.24× | 0.25× |
| stop (blocked) | 13.8 | 14.8 | 12.3 | 0.22× | 0.20× |
| session-end | 47.9 | 49.8 | 43.8 | 0.40× | 0.40× |
| statusline | 3.6 | 4.4 | 3.2 | 0.10× | 0.11× |
| status <slug> (full CLI, plain) | 235.7 | 243.8 | 223.5 | 0.77× | 0.78× |
| find <slug> (graph + index build, TypeScript) | 661.4 | 704.7 | 627.5 | 1.02× | 1.04× |

## team100-w25 — 20 initiatives, bound log 19.2 MB (27766 lines), 69.5 MB total
| command | p50 ms | p95 ms | min ms | vs target p50 | vs target p95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| session-start (index warm) | 13.6 | 19.6 | 11.5 | 0.27× | 0.37× |
| session-start (index cold) | 419.3 | 432.5 | 400.0 | 0.60× | 0.58× |
| post-tool Edit | 48.1 | 54.2 | 43.2 | 0.40× | 0.40× |
| user-prompt (nudge) | 15.1 | 16.1 | 14.8 | 0.22× | 0.19× |
| stop (blocked) | 12.2 | 12.5 | 12.1 | 0.20× | 0.16× |
| session-end | 46.1 | 51.3 | 42.8 | 0.39× | 0.39× |
| statusline | 3.8 | 4.3 | 3.5 | 0.11× | 0.11× |
| status <slug> (full CLI, plain) | 224.9 | 240.7 | 219.9 | 0.76× | 0.78× |
| find <slug> (graph + index build, TypeScript) | 612.5 | 651.0 | 596.5 | 0.89× | 0.79× |

## team100-w50 — 20 initiatives, bound log 19.1 MB (27716 lines), 69.5 MB total
| command | p50 ms | p95 ms | min ms | vs target p50 | vs target p95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| session-start (index warm) | 11.6 | 12.1 | 11.4 | 0.23× | 0.22× |
| session-start (index cold) | 406.2 | 434.8 | 391.7 | 0.57× | 0.58× |
| post-tool Edit | 46.4 | 50.5 | 42.9 | 0.34× | 0.22× |
| user-prompt (nudge) | 16.4 | 17.8 | 15.4 | 0.25× | 0.26× |
| stop (blocked) | 13.3 | 15.0 | 12.0 | 0.22× | 0.21× |
| session-end | 46.1 | 49.8 | 42.5 | 0.39× | 0.32× |
| statusline | 3.6 | 4.1 | 3.1 | 0.10× | 0.10× |
| status <slug> (full CLI, plain) | 235.4 | 242.5 | 221.9 | 0.82× | 0.80× |
| find <slug> (graph + index build, TypeScript) | 671.6 | 690.6 | 632.1 | 1.09× | 1.03× |

## team100-w100 — 20 initiatives, bound log 19.2 MB (27743 lines), 69.5 MB total
| command | p50 ms | p95 ms | min ms | vs target p50 | vs target p95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| session-start (index warm) | 11.9 | 13.1 | 11.7 | 0.21× | 0.22× |
| session-start (index cold) | 419.6 | 441.6 | 400.6 | 0.59× | 0.58× |
| post-tool Edit | 44.8 | 48.6 | 42.2 | 0.36× | 0.36× |
| user-prompt (nudge) | 15.7 | 18.7 | 15.1 | 0.25× | 0.29× |
| stop (blocked) | 12.6 | 14.1 | 12.4 | 0.23× | 0.25× |
| session-end | 48.9 | 51.8 | 42.1 | 0.43× | 0.40× |
| statusline | 3.9 | 4.7 | 3.6 | 0.12× | 0.14× |
| status <slug> (full CLI, plain) | 233.5 | 242.7 | 221.3 | 0.77× | 0.76× |
| find <slug> (graph + index build, TypeScript) | 660.0 | 687.2 | 626.3 | 1.01× | 0.99× |

## team100 — 20 initiatives, bound log 95.6 MB (138950 lines), 345.4 MB total
| command | p50 ms | p95 ms | min ms | vs target p50 | vs target p95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| session-start (index warm) | 42.6 | 47.8 | 41.0 | 0.46× | 0.50× |
| session-start (index cold) | 2007.0 | 2142.5 | 1937.6 | 0.60× | 0.63× |
| post-tool Edit | 168.2 | 191.6 | 164.8 | 0.45× | 0.44× |
| user-prompt (nudge) | 68.3 | 71.3 | 65.9 | 0.42× | 0.39× |
| stop (blocked) | 56.2 | 60.3 | 53.3 | 0.40× | 0.40× |
| session-end | 175.7 | 184.0 | 169.5 | 0.46× | 0.40× |
| statusline | 7.6 | 8.2 | 7.1 | 0.19× | 0.19× |
| status <slug> (full CLI, plain) | 1176.3 | 1248.5 | 1138.7 | 0.78× | 0.82× |
| find <slug> (graph + index build, TypeScript) | 3155.8 | 3500.3 | 2976.4 | 1.01× | 1.09× |

## team100-w10 — team100 corpus (rust-core 1.5)
20 initiatives, 10 writers, 69.6 MB / 100344 events in all; bound record 19.3 MB / 27841 events, 1735 sessions of which 10 open (one per writer); largest log 19.3 MB

| measure | max RSS MB |
| --- | ---: |
| session-start (index warm) | 173.4 |
| post-tool Edit | 29.1 |
| user-prompt (nudge) | 158.0 |
| stop (blocked) | 30.3 |
| session-end | 27.5 |
| statusline | 27.2 |
| status <slug> (full CLI, plain) | 251.3 |
| find <slug> (graph + index build, TypeScript) | 402.1 |

| bound-log prefix (events) | bytes | fold ms (process, min of 3) |
| ---: | ---: | ---: |
| 559 | 0.40 MB | 6.8 |
| 1396 | 0.99 MB | 13.6 |
| 2793 | 1.89 MB | 25.5 |
| 5586 | 3.84 MB | 48.2 |
| 9775 | 6.72 MB | 76.7 |
| 13964 | 9.59 MB | 112.4 |
| 19550 | 13.48 MB | 156.3 |
| 27928 | 19.28 MB | 219.6 |

fold crosses 100 ms at ~12511 events / 8.6 MB; a full refold reaches 250 ms at never within this log

growth budget from the profiles (0.3 human / 0.7 agent, 10 sessions per user per week): 163 events and 0.11 MB per user per week — 100 users add 11 MB / 16300 events a week

## team100-w25 — team100 corpus (rust-core 1.5)
20 initiatives, 25 writers, 69.5 MB / 100269 events in all; bound record 19.2 MB / 27766 events, 1734 sessions of which 25 open (one per writer); largest log 19.2 MB

| measure | max RSS MB |
| --- | ---: |
| session-start (index warm) | 169.6 |
| post-tool Edit | 29.0 |
| user-prompt (nudge) | 152.8 |
| stop (blocked) | 29.5 |
| session-end | 27.0 |
| statusline | 27.2 |
| status <slug> (full CLI, plain) | 250.3 |
| find <slug> (graph + index build, TypeScript) | 400.9 |

| bound-log prefix (events) | bytes | fold ms (process, min of 3) |
| ---: | ---: | ---: |
| 557 | 0.39 MB | 6.3 |
| 1393 | 0.99 MB | 12.7 |
| 2785 | 1.88 MB | 23.3 |
| 5571 | 3.83 MB | 43.7 |
| 9749 | 6.69 MB | 73.0 |
| 13927 | 9.56 MB | 105.6 |
| 19497 | 13.44 MB | 154.8 |
| 27853 | 19.23 MB | 212.9 |

fold crosses 100 ms at ~13207 events / 9.1 MB; a full refold reaches 250 ms at never within this log

growth budget from the profiles (0.3 human / 0.7 agent, 10 sessions per user per week): 163 events and 0.11 MB per user per week — 100 users add 11 MB / 16300 events a week

## team100-w50 — team100 corpus (rust-core 1.5)
20 initiatives, 50 writers, 69.5 MB / 100219 events in all; bound record 19.1 MB / 27716 events, 1734 sessions of which 50 open (one per writer); largest log 19.1 MB

| measure | max RSS MB |
| --- | ---: |
| session-start (index warm) | 171.4 |
| post-tool Edit | 29.7 |
| user-prompt (nudge) | 150.4 |
| stop (blocked) | 29.4 |
| session-end | 27.2 |
| statusline | 27.3 |
| status <slug> (full CLI, plain) | 221.1 |
| find <slug> (graph + index build, TypeScript) | 404.9 |

| bound-log prefix (events) | bytes | fold ms (process, min of 3) |
| ---: | ---: | ---: |
| 556 | 0.39 MB | 6.8 |
| 1390 | 0.98 MB | 13.5 |
| 2780 | 1.88 MB | 23.8 |
| 5561 | 3.82 MB | 48.3 |
| 9731 | 6.68 MB | 80.5 |
| 13902 | 9.55 MB | 110.8 |
| 19462 | 13.43 MB | 163.9 |
| 27803 | 19.17 MB | 224.9 |

fold crosses 100 ms at ~12413 events / 8.5 MB; a full refold reaches 250 ms at never within this log

growth budget from the profiles (0.3 human / 0.7 agent, 10 sessions per user per week): 163 events and 0.11 MB per user per week — 100 users add 11 MB / 16300 events a week

## team100-w100 — team100 corpus (rust-core 1.5)
20 initiatives, 100 writers, 69.5 MB / 100246 events in all; bound record 19.2 MB / 27743 events, 1745 sessions of which 100 open (one per writer); largest log 19.2 MB

| measure | max RSS MB |
| --- | ---: |
| session-start (index warm) | 172.3 |
| post-tool Edit | 29.2 |
| user-prompt (nudge) | 156.0 |
| stop (blocked) | 29.4 |
| session-end | 26.9 |
| statusline | 27.4 |
| status <slug> (full CLI, plain) | 221.7 |
| find <slug> (graph + index build, TypeScript) | 401.8 |

| bound-log prefix (events) | bytes | fold ms (process, min of 3) |
| ---: | ---: | ---: |
| 557 | 0.39 MB | 6.5 |
| 1392 | 0.99 MB | 13.5 |
| 2783 | 1.88 MB | 24.0 |
| 5566 | 3.82 MB | 45.4 |
| 9741 | 6.68 MB | 85.1 |
| 13915 | 9.55 MB | 118.3 |
| 19481 | 13.43 MB | 149.7 |
| 27830 | 19.19 MB | 222.1 |

fold crosses 100 ms at ~11613 events / 8.0 MB; a full refold reaches 250 ms at never within this log

growth budget from the profiles (0.3 human / 0.7 agent, 10 sessions per user per week): 163 events and 0.11 MB per user per week — 100 users add 11 MB / 16300 events a week

## team100 — team100 corpus (rust-core 1.5)
20 initiatives, 100 writers, 345.4 MB / 500188 events in all; bound record 95.6 MB / 138950 events, 8576 sessions of which 100 open (one per writer); largest log 95.6 MB

| measure | max RSS MB |
| --- | ---: |
| session-start (index warm) | 925.0 |
| post-tool Edit | 129.4 |
| user-prompt (nudge) | 846.0 |
| stop (blocked) | 127.5 |
| session-end | 117.5 |
| statusline | 118.3 |
| status <slug> (full CLI, plain) | 1263.4 |
| find <slug> (graph + index build, TypeScript) | 1177.2 |

| bound-log prefix (events) | bytes | fold ms (process, min of 3) |
| ---: | ---: | ---: |
| 2781 | 1.88 MB | 23.3 |
| 6952 | 4.84 MB | 54.5 |
| 13904 | 9.54 MB | 108.1 |
| 27807 | 19.20 MB | 217.8 |
| 48663 | 33.64 MB | 380.2 |
| 69519 | 47.95 MB | 555.5 |
| 97326 | 67.25 MB | 804.8 |
| 139037 | 95.67 MB | 1209.0 |

fold crosses 100 ms at ~12849 events / 8.8 MB; a full refold reaches 250 ms at ~31937 events / 22.1 MB

growth budget from the profiles (0.3 human / 0.7 agent, 10 sessions per user per week): 163 events and 0.11 MB per user per week — 100 users add 11 MB / 16300 events a week

