perf baseline [rust-core 1.5 reference at rc.2 (2baf63e): team cells, in-process fold curve and RSS] — typescript (node dist/cli.js (built from source as build.mjs ships it)) · 5 spawns per cell · Apple M4 Pro, node v24.15.0 · commit c52db84
node spawn floor: p50 22.4 ms · p95 23.4 ms · load avg 2.88 → 5.18

## team100-w10 — 20 initiatives, bound log 19.3 MB (27841 lines), 69.6 MB total
| command | p50 ms | p95 ms | min ms |
| --- | ---: | ---: | ---: |
| session-start (index warm) | 470.6 | 475.3 | 465.5 |
| session-start (index cold) | 956.1 | 974.0 | 949.5 |
| post-tool Edit | 481.9 | 482.8 | 474.0 |
| user-prompt (nudge) | 397.7 | 647.3 | 393.8 |
| stop (blocked) | 385.9 | 393.5 | 385.2 |
| session-end | 467.3 | 474.5 | 462.3 |
| statusline | 386.5 | 417.0 | 385.3 |
| status <slug> (full CLI, plain) | 383.8 | 398.9 | 375.4 |
| find <slug> (graph + index build, TypeScript) | 621.0 | 628.9 | 615.6 |

## team100-w25 — 20 initiatives, bound log 19.2 MB (27766 lines), 69.5 MB total
| command | p50 ms | p95 ms | min ms |
| --- | ---: | ---: | ---: |
| session-start (index warm) | 467.9 | 469.6 | 466.7 |
| session-start (index cold) | 961.9 | 1060.7 | 952.9 |
| post-tool Edit | 503.5 | 510.2 | 478.0 |
| user-prompt (nudge) | 404.9 | 641.6 | 396.1 |
| stop (blocked) | 385.6 | 388.8 | 382.9 |
| session-end | 481.9 | 489.5 | 469.7 |
| statusline | 401.2 | 408.7 | 397.1 |
| status <slug> (full CLI, plain) | 393.0 | 402.5 | 376.6 |
| find <slug> (graph + index build, TypeScript) | 616.8 | 622.1 | 610.5 |

## team100-w50 — 20 initiatives, bound log 19.1 MB (27716 lines), 69.5 MB total
| command | p50 ms | p95 ms | min ms |
| --- | ---: | ---: | ---: |
| session-start (index warm) | 473.6 | 483.3 | 464.4 |
| session-start (index cold) | 959.3 | 962.6 | 946.6 |
| post-tool Edit | 489.7 | 501.9 | 482.2 |
| user-prompt (nudge) | 396.6 | 641.3 | 385.4 |
| stop (blocked) | 386.7 | 388.9 | 385.7 |
| session-end | 471.8 | 475.3 | 465.6 |
| statusline | 384.1 | 385.7 | 381.0 |
| status <slug> (full CLI, plain) | 391.1 | 395.3 | 388.8 |
| find <slug> (graph + index build, TypeScript) | 612.1 | 635.4 | 606.5 |

## team100-w100 — 20 initiatives, bound log 19.2 MB (27743 lines), 69.5 MB total
| command | p50 ms | p95 ms | min ms |
| --- | ---: | ---: | ---: |
| session-start (index warm) | 503.0 | 550.9 | 479.9 |
| session-start (index cold) | 1263.5 | 1647.7 | 1142.3 |
| post-tool Edit | 1260.6 | 2709.2 | 751.1 |
| user-prompt (nudge) | 539.8 | 1189.3 | 487.5 |
| stop (blocked) | 520.8 | 814.5 | 435.6 |
| session-end | 492.8 | 524.1 | 469.0 |
| statusline | 463.1 | 537.8 | 389.9 |
| status <slug> (full CLI, plain) | 500.5 | 613.5 | 490.6 |
| find <slug> (graph + index build, TypeScript) | 1030.3 | 1467.0 | 813.1 |

## team100 — 20 initiatives, bound log 95.6 MB (138950 lines), 345.4 MB total
| command | p50 ms | p95 ms | min ms |
| --- | ---: | ---: | ---: |
| session-start (index warm) | 4617.7 | 4629.1 | 4583.2 |
| session-start (index cold) | 7932.6 | 8009.0 | 7899.0 |
| post-tool Edit | 4788.5 | 4863.2 | 4658.5 |
| user-prompt (nudge) | 4296.3 | 6146.1 | 4231.2 |
| stop (blocked) | 4192.9 | 4242.2 | 4169.2 |
| session-end | 4577.0 | 4664.3 | 4516.6 |
| statusline | 4313.8 | 4425.6 | 4259.0 |
| status <slug> (full CLI, plain) | 4080.7 | 4119.6 | 4028.6 |
| find <slug> (graph + index build, TypeScript) | 3061.4 | 3127.8 | 3007.5 |

## team100-w10 — team100 corpus (rust-core 1.5)
20 initiatives, 10 writers, 69.6 MB / 100344 events in all; bound record 19.3 MB / 27841 events, 1735 sessions of which 10 open (one per writer); largest log 19.3 MB

| measure | max RSS MB |
| --- | ---: |
| session-start (index warm) | 540.5 |
| post-tool Edit | 397.0 |
| user-prompt (nudge) | 484.0 |
| stop (blocked) | 377.1 |
| session-end | 376.8 |
| statusline | 377.2 |
| status <slug> (full CLI, plain) | 400.6 |
| find <slug> (graph + index build, TypeScript) | 400.9 |

| bound-log prefix (events) | bytes | fold ms (in-process, min of 3) |
| ---: | ---: | ---: |
| 557 | 0.39 MB | 3.5 |
| 1393 | 0.99 MB | 8.0 |
| 2787 | 1.89 MB | 15.6 |
| 5574 | 3.83 MB | 36.9 |
| 9754 | 6.70 MB | 68.4 |
| 13934 | 9.57 MB | 106.3 |
| 19508 | 13.46 MB | 170.2 |
| 27868 | 19.26 MB | 276.1 |

fold crosses 100 ms at ~13244 events / 9.1 MB; a full refold reaches 250 ms at ~25804 events / 17.8 MB

growth budget from the profiles (0.3 human / 0.7 agent, 10 sessions per user per week): 163 events and 0.11 MB per user per week — 100 users add 11 MB / 16300 events a week

## team100-w25 — team100 corpus (rust-core 1.5)
20 initiatives, 25 writers, 69.5 MB / 100269 events in all; bound record 19.2 MB / 27766 events, 1734 sessions of which 25 open (one per writer); largest log 19.2 MB

| measure | max RSS MB |
| --- | ---: |
| session-start (index warm) | 543.9 |
| post-tool Edit | 397.8 |
| user-prompt (nudge) | 467.5 |
| stop (blocked) | 377.1 |
| session-end | 376.5 |
| statusline | 377.5 |
| status <slug> (full CLI, plain) | 400.0 |
| find <slug> (graph + index build, TypeScript) | 399.2 |

| bound-log prefix (events) | bytes | fold ms (in-process, min of 3) |
| ---: | ---: | ---: |
| 556 | 0.39 MB | 2.9 |
| 1390 | 0.98 MB | 7.5 |
| 2779 | 1.88 MB | 14.8 |
| 5559 | 3.82 MB | 34.6 |
| 9728 | 6.68 MB | 67.2 |
| 13897 | 9.55 MB | 105.8 |
| 19455 | 13.42 MB | 168.2 |
| 27793 | 19.21 MB | 270.1 |

fold crosses 100 ms at ~13273 events / 9.1 MB; a full refold reaches 250 ms at ~26150 events / 18.1 MB

growth budget from the profiles (0.3 human / 0.7 agent, 10 sessions per user per week): 163 events and 0.11 MB per user per week — 100 users add 11 MB / 16300 events a week

## team100-w50 — team100 corpus (rust-core 1.5)
20 initiatives, 50 writers, 69.5 MB / 100219 events in all; bound record 19.1 MB / 27716 events, 1734 sessions of which 50 open (one per writer); largest log 19.1 MB

| measure | max RSS MB |
| --- | ---: |
| session-start (index warm) | 542.1 |
| post-tool Edit | 402.6 |
| user-prompt (nudge) | 458.9 |
| stop (blocked) | 375.7 |
| session-end | 375.0 |
| statusline | 375.6 |
| status <slug> (full CLI, plain) | 398.9 |
| find <slug> (graph + index build, TypeScript) | 399.9 |

| bound-log prefix (events) | bytes | fold ms (in-process, min of 3) |
| ---: | ---: | ---: |
| 555 | 0.39 MB | 2.8 |
| 1387 | 0.98 MB | 7.2 |
| 2774 | 1.88 MB | 14.9 |
| 5549 | 3.81 MB | 33.9 |
| 9710 | 6.67 MB | 66.2 |
| 13872 | 9.53 MB | 104.8 |
| 19420 | 13.40 MB | 163.4 |
| 27743 | 19.15 MB | 266.6 |

fold crosses 100 ms at ~13355 events / 9.2 MB; a full refold reaches 250 ms at ~26404 events / 18.2 MB

growth budget from the profiles (0.3 human / 0.7 agent, 10 sessions per user per week): 163 events and 0.11 MB per user per week — 100 users add 11 MB / 16300 events a week

## team100-w100 — team100 corpus (rust-core 1.5)
20 initiatives, 100 writers, 69.5 MB / 100246 events in all; bound record 19.2 MB / 27743 events, 1745 sessions of which 100 open (one per writer); largest log 19.2 MB

| measure | max RSS MB |
| --- | ---: |
| session-start (index warm) | 547.6 |
| post-tool Edit | 404.0 |
| user-prompt (nudge) | 462.7 |
| stop (blocked) | 376.1 |
| session-end | 377.5 |
| statusline | 377.4 |
| status <slug> (full CLI, plain) | 399.8 |
| find <slug> (graph + index build, TypeScript) | 399.6 |

| bound-log prefix (events) | bytes | fold ms (in-process, min of 3) |
| ---: | ---: | ---: |
| 555 | 0.39 MB | 3.0 |
| 1389 | 0.98 MB | 7.7 |
| 2777 | 1.88 MB | 15.2 |
| 5554 | 3.82 MB | 34.2 |
| 9720 | 6.67 MB | 67.3 |
| 13885 | 9.53 MB | 107.1 |
| 19439 | 13.41 MB | 163.5 |
| 27770 | 19.17 MB | 275.8 |

fold crosses 100 ms at ~13143 events / 9.0 MB; a full refold reaches 250 ms at ~25856 events / 17.8 MB

growth budget from the profiles (0.3 human / 0.7 agent, 10 sessions per user per week): 163 events and 0.11 MB per user per week — 100 users add 11 MB / 16300 events a week

## team100 — team100 corpus (rust-core 1.5)
20 initiatives, 100 writers, 345.4 MB / 500188 events in all; bound record 95.6 MB / 138950 events, 8576 sessions of which 100 open (one per writer); largest log 95.6 MB

| measure | max RSS MB |
| --- | ---: |
| session-start (index warm) | 1457.7 |
| post-tool Edit | 1209.6 |
| user-prompt (nudge) | 1373.6 |
| stop (blocked) | 1135.3 |
| session-end | 1134.8 |
| statusline | 1135.1 |
| status <slug> (full CLI, plain) | 1177.5 |
| find <slug> (graph + index build, TypeScript) | 1175.7 |

| bound-log prefix (events) | bytes | fold ms (in-process, min of 3) |
| ---: | ---: | ---: |
| 2780 | 1.88 MB | 16.3 |
| 6949 | 4.84 MB | 45.7 |
| 13898 | 9.54 MB | 105.5 |
| 27795 | 19.19 MB | 275.5 |
| 48642 | 33.62 MB | 698.7 |
| 69489 | 47.93 MB | 1224.9 |
| 97284 | 67.22 MB | 1894.4 |
| 138977 | 95.65 MB | 3613.4 |

fold crosses 100 ms at ~13256 events / 9.1 MB; a full refold reaches 250 ms at ~25710 events / 17.7 MB

growth budget from the profiles (0.3 human / 0.7 agent, 10 sessions per user per week): 163 events and 0.11 MB per user per week — 100 users add 11 MB / 16300 events a week

## in-process (TypeScript reference only): fold of the bound log, digest render of the folded state
| cell | fold p50 ms | fold p95 ms | render p50 ms | render p95 ms |
| --- | ---: | ---: | ---: | ---: |
| team100-w10 | 283.8 | 297.9 | 1.6 | 4.1 |
| team100-w25 | 282.4 | 307.3 | 1.3 | 1.5 |
| team100-w50 | 284.7 | 292.2 | 1.2 | 1.6 |
| team100-w100 | 279.9 | 297.5 | 1.5 | 1.5 |
| team100 | 3730.4 | 3865.9 | 10.1 | 11.8 |

