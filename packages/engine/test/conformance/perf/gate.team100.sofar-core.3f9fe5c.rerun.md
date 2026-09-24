perf baseline — candidate (/private/tmp/claude-501/-Users-jins-IO-sofar/4bfa3819-8e11-461b-b306-fea1a0b9c3c9/scratchpad/gate-3f9fe5c/target/release/sofar-core) · 20 spawns per cell · Apple M4 Pro, node v24.15.0 · commit 3f9fe5cf
node spawn floor: p50 22.6 ms · p95 23.6 ms · load avg 4.42 → 3.31

## team100-w10 — 20 initiatives, bound log 19.3 MB (27841 lines), 69.6 MB total
| command | p50 ms | p95 ms | min ms | vs target p50 | vs target p95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| session-start (index warm) | 23.0 | 33.6 | 22.6 | 0.40× | 0.56× |
| session-start (index cold) | 508.5 | 527.5 | 499.8 | 0.55× | 0.55× |
| post-tool Edit | 171.0 | 181.6 | 167.7 | 0.50× | 0.50× |
| user-prompt (nudge) | 128.0 | 130.8 | 126.1 | 0.49× | 0.48× |
| stop (blocked) | 125.0 | 129.6 | 122.5 | 0.48× | 0.46× |
| session-end | 190.3 | 193.3 | 188.3 | 0.54× | 0.50× |
| statusline | 2.9 | 3.5 | 2.8 | 0.09× | 0.10× |
| status <slug> (full CLI, plain) | 216.2 | 218.0 | 213.6 | 0.72× | 0.67× |
| find <slug> (graph + index build, TypeScript) | 609.1 | 633.6 | 601.9 | 1.01× | 0.99× |

## team100-w25 — 20 initiatives, bound log 19.2 MB (27766 lines), 69.5 MB total
| command | p50 ms | p95 ms | min ms | vs target p50 | vs target p95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| session-start (index warm) | 22.5 | 23.9 | 22.4 | 0.38× | 0.38× |
| session-start (index cold) | 504.4 | 520.7 | 496.9 | 0.56× | 0.56× |
| post-tool Edit | 170.5 | 174.0 | 168.1 | 0.50× | 0.49× |
| user-prompt (nudge) | 128.4 | 131.1 | 126.5 | 0.49× | 0.46× |
| stop (blocked) | 127.0 | 131.8 | 122.1 | 0.50× | 0.52× |
| session-end | 191.3 | 194.0 | 188.1 | 0.56× | 0.45× |
| statusline | 3.0 | 4.2 | 2.9 | 0.09× | 0.12× |
| status <slug> (full CLI, plain) | 217.7 | 227.4 | 215.2 | 0.75× | 0.75× |
| find <slug> (graph + index build, TypeScript) | 648.3 | 680.3 | 609.1 | 1.06× | 1.07× |

## team100-w50 — 20 initiatives, bound log 19.1 MB (27716 lines), 69.5 MB total
| command | p50 ms | p95 ms | min ms | vs target p50 | vs target p95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| session-start (index warm) | 22.6 | 23.7 | 19.9 | 0.32× | 0.21× |
| session-start (index cold) | 505.6 | 518.2 | 497.2 | 0.51× | 0.48× |
| post-tool Edit | 168.7 | 179.7 | 166.5 | 0.47× | 0.47× |
| user-prompt (nudge) | 126.3 | 134.4 | 125.0 | 0.47× | 0.49× |
| stop (blocked) | 123.7 | 126.2 | 122.4 | 0.47× | 0.46× |
| session-end | 188.6 | 191.2 | 186.3 | 0.53× | 0.51× |
| statusline | 2.9 | 3.4 | 2.8 | 0.08× | 0.08× |
| status <slug> (full CLI, plain) | 215.1 | 222.1 | 211.3 | 0.67× | 0.62× |
| find <slug> (graph + index build, TypeScript) | 629.6 | 668.0 | 609.8 | 0.91× | 0.91× |

## team100-w100 — 20 initiatives, bound log 19.2 MB (27743 lines), 69.5 MB total
| command | p50 ms | p95 ms | min ms | vs target p50 | vs target p95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| session-start (index warm) | 22.7 | 23.1 | 20.0 | 0.33× | 0.32× |
| session-start (index cold) | 514.0 | 568.0 | 494.5 | 0.53× | 0.56× |
| post-tool Edit | 173.9 | 201.6 | 169.1 | 0.47× | 0.51× |
| user-prompt (nudge) | 130.1 | 146.2 | 126.8 | 0.47× | 0.49× |
| stop (blocked) | 130.3 | 135.4 | 125.5 | 0.47× | 0.45× |
| session-end | 194.6 | 206.6 | 188.4 | 0.54× | 0.53× |
| statusline | 2.9 | 3.5 | 2.8 | 0.08× | 0.08× |
| status <slug> (full CLI, plain) | 219.2 | 230.1 | 213.3 | 0.66× | 0.64× |
| find <slug> (graph + index build, TypeScript) | 647.2 | 686.8 | 609.5 | 0.95× | 0.96× |

## team100 — 20 initiatives, bound log 95.6 MB (138950 lines), 345.4 MB total
| command | p50 ms | p95 ms | min ms | vs target p50 | vs target p95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| session-start (index warm) | 50.6 | 52.2 | 49.9 | 0.47× | 0.41× |
| session-start (index cold) | 2594.5 | 2700.9 | 2556.1 | 0.44× | 0.43× |
| post-tool Edit | 841.2 | 917.8 | 824.1 | 0.43× | 0.42× |
| user-prompt (nudge) | 697.8 | 774.6 | 664.8 | 0.45× | 0.48× |
| stop (blocked) | 668.5 | 690.2 | 648.9 | 0.44× | 0.44× |
| session-end | 990.1 | 1113.3 | 952.6 | 0.52× | 0.56× |
| statusline | 7.1 | 7.5 | 6.6 | 0.17× | 0.17× |
| status <slug> (full CLI, plain) | 1145.9 | 1244.4 | 1122.5 | 0.75× | 0.77× |
| find <slug> (graph + index build, TypeScript) | 3082.6 | 3203.8 | 2946.2 | 1.00× | 0.99× |

## team100-w10 — team100 corpus (rust-core 1.5)
20 initiatives, 10 writers, 69.6 MB / 100344 events in all; bound record 19.3 MB / 27841 events, 1735 sessions of which 10 open (one per writer); largest log 19.3 MB

| measure | max RSS MB |
| --- | ---: |
| session-start (index warm) | 262.1 |
| post-tool Edit | 163.3 |
| user-prompt (nudge) | 245.0 |
| stop (blocked) | 164.9 |
| session-end | 163.8 |
| statusline | 164.0 |
| status <slug> (full CLI, plain) | 254.5 |
| find <slug> (graph + index build, TypeScript) | 402.0 |

| bound-log prefix (events) | bytes | fold ms (process, min of 3) |
| ---: | ---: | ---: |
| 559 | 0.40 MB | 6.5 |
| 1396 | 0.99 MB | 12.7 |
| 2793 | 1.89 MB | 22.8 |
| 5586 | 3.84 MB | 44.4 |
| 9775 | 6.72 MB | 74.8 |
| 13964 | 9.59 MB | 105.1 |
| 19550 | 13.48 MB | 145.7 |
| 27928 | 19.28 MB | 211.5 |

fold crosses 100 ms at ~13258 events / 9.1 MB; a full refold reaches 250 ms at never within this log

growth budget from the profiles (0.3 human / 0.7 agent, 10 sessions per user per week): 163 events and 0.11 MB per user per week — 100 users add 11 MB / 16300 events a week

## team100-w25 — team100 corpus (rust-core 1.5)
20 initiatives, 25 writers, 69.5 MB / 100269 events in all; bound record 19.2 MB / 27766 events, 1734 sessions of which 25 open (one per writer); largest log 19.2 MB

| measure | max RSS MB |
| --- | ---: |
| session-start (index warm) | 262.1 |
| post-tool Edit | 163.7 |
| user-prompt (nudge) | 240.3 |
| stop (blocked) | 163.1 |
| session-end | 162.1 |
| statusline | 163.5 |
| status <slug> (full CLI, plain) | 249.4 |
| find <slug> (graph + index build, TypeScript) | 402.1 |

| bound-log prefix (events) | bytes | fold ms (process, min of 3) |
| ---: | ---: | ---: |
| 557 | 0.39 MB | 7.0 |
| 1393 | 0.99 MB | 13.6 |
| 2785 | 1.88 MB | 23.4 |
| 5571 | 3.83 MB | 45.6 |
| 9749 | 6.69 MB | 76.8 |
| 13927 | 9.56 MB | 112.4 |
| 19497 | 13.44 MB | 155.7 |
| 27853 | 19.23 MB | 229.0 |

fold crosses 100 ms at ~12469 events / 8.6 MB; a full refold reaches 250 ms at never within this log

growth budget from the profiles (0.3 human / 0.7 agent, 10 sessions per user per week): 163 events and 0.11 MB per user per week — 100 users add 11 MB / 16300 events a week

## team100-w50 — team100 corpus (rust-core 1.5)
20 initiatives, 50 writers, 69.5 MB / 100219 events in all; bound record 19.1 MB / 27716 events, 1734 sessions of which 50 open (one per writer); largest log 19.1 MB

| measure | max RSS MB |
| --- | ---: |
| session-start (index warm) | 256.1 |
| post-tool Edit | 161.8 |
| user-prompt (nudge) | 244.0 |
| stop (blocked) | 162.1 |
| session-end | 162.3 |
| statusline | 162.3 |
| status <slug> (full CLI, plain) | 248.1 |
| find <slug> (graph + index build, TypeScript) | 405.3 |

| bound-log prefix (events) | bytes | fold ms (process, min of 3) |
| ---: | ---: | ---: |
| 556 | 0.39 MB | 6.6 |
| 1390 | 0.98 MB | 12.9 |
| 2780 | 1.88 MB | 22.9 |
| 5561 | 3.82 MB | 44.2 |
| 9731 | 6.68 MB | 73.4 |
| 13902 | 9.55 MB | 105.7 |
| 19462 | 13.43 MB | 153.5 |
| 27803 | 19.17 MB | 215.6 |

fold crosses 100 ms at ~13167 events / 9.0 MB; a full refold reaches 250 ms at never within this log

growth budget from the profiles (0.3 human / 0.7 agent, 10 sessions per user per week): 163 events and 0.11 MB per user per week — 100 users add 11 MB / 16300 events a week

## team100-w100 — team100 corpus (rust-core 1.5)
20 initiatives, 100 writers, 69.5 MB / 100246 events in all; bound record 19.2 MB / 27743 events, 1745 sessions of which 100 open (one per writer); largest log 19.2 MB

| measure | max RSS MB |
| --- | ---: |
| session-start (index warm) | 256.8 |
| post-tool Edit | 162.1 |
| user-prompt (nudge) | 240.6 |
| stop (blocked) | 164.2 |
| session-end | 162.7 |
| statusline | 162.8 |
| status <slug> (full CLI, plain) | 247.7 |
| find <slug> (graph + index build, TypeScript) | 401.4 |

| bound-log prefix (events) | bytes | fold ms (process, min of 3) |
| ---: | ---: | ---: |
| 557 | 0.39 MB | 6.5 |
| 1392 | 0.99 MB | 13.0 |
| 2783 | 1.88 MB | 22.8 |
| 5566 | 3.82 MB | 43.8 |
| 9741 | 6.68 MB | 73.4 |
| 13915 | 9.55 MB | 102.6 |
| 19481 | 13.43 MB | 145.7 |
| 27830 | 19.19 MB | 211.7 |

fold crosses 100 ms at ~13537 events / 9.3 MB; a full refold reaches 250 ms at never within this log

growth budget from the profiles (0.3 human / 0.7 agent, 10 sessions per user per week): 163 events and 0.11 MB per user per week — 100 users add 11 MB / 16300 events a week

## team100 — team100 corpus (rust-core 1.5)
20 initiatives, 100 writers, 345.4 MB / 500188 events in all; bound record 95.6 MB / 138950 events, 8576 sessions of which 100 open (one per writer); largest log 95.6 MB

| measure | max RSS MB |
| --- | ---: |
| session-start (index warm) | 1376.1 |
| post-tool Edit | 814.2 |
| user-prompt (nudge) | 1307.8 |
| stop (blocked) | 814.9 |
| session-end | 811.4 |
| statusline | 815.5 |
| status <slug> (full CLI, plain) | 1255.7 |
| find <slug> (graph + index build, TypeScript) | 1176.4 |

| bound-log prefix (events) | bytes | fold ms (process, min of 3) |
| ---: | ---: | ---: |
| 2781 | 1.88 MB | 22.9 |
| 6952 | 4.84 MB | 54.9 |
| 13904 | 9.54 MB | 106.6 |
| 27807 | 19.20 MB | 213.2 |
| 48663 | 33.64 MB | 389.4 |
| 69519 | 47.95 MB | 578.7 |
| 97326 | 67.25 MB | 795.3 |
| 139037 | 95.67 MB | 1197.6 |

fold crosses 100 ms at ~13023 events / 8.9 MB; a full refold reaches 250 ms at ~32165 events / 22.2 MB

growth budget from the profiles (0.3 human / 0.7 agent, 10 sessions per user per week): 163 events and 0.11 MB per user per week — 100 users add 11 MB / 16300 events a week

