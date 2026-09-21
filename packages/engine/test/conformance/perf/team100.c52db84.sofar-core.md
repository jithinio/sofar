perf baseline [rust-core 1.5 team cells: sofar-core direct (2baf63e, SessionIndex), interleaved ABAB with node dist/cli.js at rc.2 (D12)] — candidate (/Users/jins/IO/sofar-rust-core/target/release/sofar-core) · 25 spawns per cell · Apple M4 Pro, node v24.15.0 · commit c52db84
node spawn floor: p50 20.9 ms · p95 23.0 ms · load avg 5.18 → 4.37 · interleaved with node /Users/jins/IO/sofar-rust-core/packages/engine/dist/cli.js

## team100-w10 — 20 initiatives, bound log 19.3 MB (27841 lines), 69.6 MB total
| command | p50 ms | p95 ms | min ms | comparator p50 | comparator p95 | vs comparator p50 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| session-start (index warm) | 382.0 | 396.3 | 375.6 | 470.8 | 483.0 | 0.81× |
| session-start (index cold) | 747.9 | 758.9 | 738.6 | 966.2 | 988.4 | 0.77× |
| post-tool Edit | 327.5 | 342.6 | 323.0 | 475.6 | 488.4 | 0.69× |
| user-prompt (nudge) | 258.3 | 267.2 | 254.1 | 398.2 | 404.4 | 0.65× |
| stop (blocked) | 245.1 | 254.5 | 238.3 | 391.7 | 402.0 | 0.63× |
| session-end | 329.2 | 343.1 | 322.6 | 473.2 | 490.6 | 0.70× |
| statusline | 241.8 | 249.9 | 238.8 | 389.7 | 394.1 | 0.62× |
| status <slug> (full CLI, plain) | 294.7 | 305.8 | 289.1 | 374.7 | 389.3 | 0.79× |
| find <slug> (graph + index build, TypeScript) | 614.9 | 630.1 | 609.5 | 613.7 | 634.9 | 1.00× |

## team100-w25 — 20 initiatives, bound log 19.2 MB (27766 lines), 69.5 MB total
| command | p50 ms | p95 ms | min ms | comparator p50 | comparator p95 | vs comparator p50 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| session-start (index warm) | 389.0 | 398.6 | 382.6 | 474.3 | 490.3 | 0.82× |
| session-start (index cold) | 756.6 | 1061.0 | 746.4 | 967.9 | 1211.7 | 0.78× |
| post-tool Edit | 335.1 | 367.1 | 328.0 | 493.4 | 564.5 | 0.68× |
| user-prompt (nudge) | 261.4 | 271.1 | 256.6 | 405.1 | 419.6 | 0.65× |
| stop (blocked) | 243.5 | 250.3 | 239.8 | 393.1 | 402.3 | 0.62× |
| session-end | 329.8 | 343.3 | 325.0 | 473.6 | 483.4 | 0.70× |
| statusline | 243.4 | 258.2 | 240.4 | 392.4 | 409.5 | 0.62× |
| status <slug> (full CLI, plain) | 306.9 | 363.2 | 293.2 | 397.7 | 437.7 | 0.77× |
| find <slug> (graph + index build, TypeScript) | 645.8 | 735.0 | 613.9 | 656.3 | 760.7 | 0.98× |

## team100-w50 — 20 initiatives, bound log 19.1 MB (27716 lines), 69.5 MB total
| command | p50 ms | p95 ms | min ms | comparator p50 | comparator p95 | vs comparator p50 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| session-start (index warm) | 401.2 | 419.4 | 382.9 | 500.5 | 551.1 | 0.80× |
| session-start (index cold) | 764.3 | 803.9 | 737.5 | 976.0 | 1031.4 | 0.78× |
| post-tool Edit | 340.4 | 366.3 | 327.1 | 495.4 | 526.5 | 0.69× |
| user-prompt (nudge) | 266.1 | 279.3 | 256.2 | 408.2 | 428.1 | 0.65× |
| stop (blocked) | 244.4 | 263.7 | 239.5 | 400.9 | 412.9 | 0.61× |
| session-end | 333.1 | 346.9 | 320.5 | 479.3 | 502.9 | 0.69× |
| statusline | 251.4 | 265.4 | 242.9 | 412.4 | 425.1 | 0.61× |
| status <slug> (full CLI, plain) | 311.0 | 323.2 | 293.6 | 394.8 | 408.4 | 0.79× |
| find <slug> (graph + index build, TypeScript) | 657.5 | 688.1 | 622.2 | 659.5 | 690.2 | 1.00× |

## team100-w100 — 20 initiatives, bound log 19.2 MB (27743 lines), 69.5 MB total
| command | p50 ms | p95 ms | min ms | comparator p50 | comparator p95 | vs comparator p50 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| session-start (index warm) | 391.1 | 406.8 | 379.9 | 483.0 | 501.1 | 0.81× |
| session-start (index cold) | 773.1 | 809.1 | 741.4 | 985.9 | 1032.2 | 0.78× |
| post-tool Edit | 331.3 | 355.5 | 321.2 | 482.6 | 498.9 | 0.69× |
| user-prompt (nudge) | 264.7 | 282.9 | 251.3 | 406.7 | 427.5 | 0.65× |
| stop (blocked) | 246.2 | 262.3 | 236.1 | 398.6 | 416.1 | 0.62× |
| session-end | 330.3 | 348.6 | 322.2 | 484.2 | 500.8 | 0.68× |
| statusline | 251.9 | 265.2 | 239.0 | 399.9 | 419.9 | 0.63× |
| status <slug> (full CLI, plain) | 302.4 | 312.5 | 289.6 | 386.2 | 400.2 | 0.78× |
| find <slug> (graph + index build, TypeScript) | 636.4 | 675.8 | 602.4 | 631.6 | 667.1 | 1.01× |

## team100 — 20 initiatives, bound log 95.6 MB (138950 lines), 345.4 MB total
| command | p50 ms | p95 ms | min ms | comparator p50 | comparator p95 | vs comparator p50 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| session-start (index warm) | 4669.9 | 5030.8 | 4611.9 | 4555.4 | 4830.4 | 1.03× |
| session-start (index cold) | 8438.3 | 8580.0 | 8258.9 | 8265.3 | 8488.9 | 1.02× |
| post-tool Edit | 3123.2 | 3234.4 | 3030.7 | 4810.6 | 4897.2 | 0.65× |
| user-prompt (nudge) | 2796.2 | 2981.6 | 2627.2 | 4441.4 | 4555.8 | 0.63× |
| stop (blocked) | 2695.7 | 2821.4 | 2481.3 | 4416.9 | 4616.4 | 0.61× |
| session-end | 3056.3 | 3293.2 | 2957.0 | 4746.0 | 5052.1 | 0.64× |
| statusline | 2642.2 | 2761.2 | 2490.4 | 4401.3 | 4606.8 | 0.60× |
| status <slug> (full CLI, plain) | 2947.5 | 4060.3 | 2806.1 | 4264.3 | 6051.0 | 0.69× |
| find <slug> (graph + index build, TypeScript) | 3135.0 | 3287.3 | 3036.0 | 3165.3 | 3307.7 | 0.99× |

## team100-w10 — team100 corpus (rust-core 1.5)
20 initiatives, 10 writers, 69.6 MB / 100344 events in all; bound record 19.3 MB / 27841 events, 1735 sessions of which 10 open (one per writer); largest log 19.3 MB

| measure | max RSS MB |
| --- | ---: |
| session-start (index warm) | 334.4 |
| post-tool Edit | 247.5 |
| user-prompt (nudge) | 308.2 |
| stop (blocked) | 251.0 |
| session-end | 251.5 |
| statusline | 250.2 |
| status <slug> (full CLI, plain) | 251.0 |
| find <slug> (graph + index build, TypeScript) | 399.7 |

| bound-log prefix (events) | bytes | fold ms (process, min of 3) |
| ---: | ---: | ---: |
| 561 | 0.40 MB | 7.7 |
| 1402 | 0.99 MB | 15.4 |
| 2805 | 1.90 MB | 26.6 |
| 5610 | 3.86 MB | 52.6 |
| 9817 | 6.75 MB | 92.9 |
| 14024 | 9.64 MB | 135.7 |
| 19634 | 13.54 MB | 199.4 |
| 28048 | 19.32 MB | 302.1 |

fold crosses 100 ms at ~10511 events / 7.2 MB; a full refold reaches 250 ms at ~23778 events / 16.4 MB

growth budget from the profiles (0.3 human / 0.7 agent, 10 sessions per user per week): 163 events and 0.11 MB per user per week — 100 users add 11 MB / 16300 events a week

## team100-w25 — team100 corpus (rust-core 1.5)
20 initiatives, 25 writers, 69.5 MB / 100269 events in all; bound record 19.2 MB / 27766 events, 1734 sessions of which 25 open (one per writer); largest log 19.2 MB

| measure | max RSS MB |
| --- | ---: |
| session-start (index warm) | 330.4 |
| post-tool Edit | 249.9 |
| user-prompt (nudge) | 313.2 |
| stop (blocked) | 249.5 |
| session-end | 249.7 |
| statusline | 250.2 |
| status <slug> (full CLI, plain) | 250.2 |
| find <slug> (graph + index build, TypeScript) | 400.8 |

| bound-log prefix (events) | bytes | fold ms (process, min of 3) |
| ---: | ---: | ---: |
| 559 | 0.40 MB | 7.1 |
| 1399 | 0.99 MB | 14.4 |
| 2797 | 1.89 MB | 27.6 |
| 5595 | 3.84 MB | 53.1 |
| 9791 | 6.73 MB | 91.4 |
| 13987 | 9.60 MB | 134.7 |
| 19581 | 13.49 MB | 200.5 |
| 27973 | 19.27 MB | 300.0 |

fold crosses 100 ms at ~10623 events / 7.3 MB; a full refold reaches 250 ms at ~23754 events / 16.4 MB

growth budget from the profiles (0.3 human / 0.7 agent, 10 sessions per user per week): 163 events and 0.11 MB per user per week — 100 users add 11 MB / 16300 events a week

## team100-w50 — team100 corpus (rust-core 1.5)
20 initiatives, 50 writers, 69.5 MB / 100219 events in all; bound record 19.1 MB / 27716 events, 1734 sessions of which 50 open (one per writer); largest log 19.1 MB

| measure | max RSS MB |
| --- | ---: |
| session-start (index warm) | 331.4 |
| post-tool Edit | 248.1 |
| user-prompt (nudge) | 303.4 |
| stop (blocked) | 249.5 |
| session-end | 247.3 |
| statusline | 247.2 |
| status <slug> (full CLI, plain) | 247.4 |
| find <slug> (graph + index build, TypeScript) | 400.9 |

| bound-log prefix (events) | bytes | fold ms (process, min of 3) |
| ---: | ---: | ---: |
| 558 | 0.39 MB | 8.2 |
| 1396 | 0.99 MB | 15.7 |
| 2792 | 1.89 MB | 28.4 |
| 5585 | 3.83 MB | 53.3 |
| 9773 | 6.71 MB | 94.6 |
| 13962 | 9.58 MB | 137.6 |
| 19546 | 13.47 MB | 200.8 |
| 27923 | 19.21 MB | 301.1 |

fold crosses 100 ms at ~10294 events / 7.1 MB; a full refold reaches 250 ms at ~23655 events / 16.3 MB

growth budget from the profiles (0.3 human / 0.7 agent, 10 sessions per user per week): 163 events and 0.11 MB per user per week — 100 users add 11 MB / 16300 events a week

## team100-w100 — team100 corpus (rust-core 1.5)
20 initiatives, 100 writers, 69.5 MB / 100246 events in all; bound record 19.2 MB / 27743 events, 1745 sessions of which 100 open (one per writer); largest log 19.2 MB

| measure | max RSS MB |
| --- | ---: |
| session-start (index warm) | 335.1 |
| post-tool Edit | 250.3 |
| user-prompt (nudge) | 306.2 |
| stop (blocked) | 249.3 |
| session-end | 249.8 |
| statusline | 249.6 |
| status <slug> (full CLI, plain) | 250.1 |
| find <slug> (graph + index build, TypeScript) | 401.5 |

| bound-log prefix (events) | bytes | fold ms (process, min of 3) |
| ---: | ---: | ---: |
| 559 | 0.40 MB | 6.9 |
| 1398 | 0.99 MB | 14.0 |
| 2795 | 1.89 MB | 25.3 |
| 5590 | 3.83 MB | 51.4 |
| 9783 | 6.71 MB | 99.3 |
| 13975 | 9.58 MB | 144.1 |
| 19565 | 13.47 MB | 208.9 |
| 27950 | 19.23 MB | 307.6 |

fold crosses 100 ms at ~9853 events / 6.8 MB; a full refold reaches 250 ms at ~23058 events / 15.9 MB

growth budget from the profiles (0.3 human / 0.7 agent, 10 sessions per user per week): 163 events and 0.11 MB per user per week — 100 users add 11 MB / 16300 events a week

## team100 — team100 corpus (rust-core 1.5)
20 initiatives, 100 writers, 345.4 MB / 500188 events in all; bound record 95.6 MB / 138950 events, 8576 sessions of which 100 open (one per writer); largest log 95.6 MB

| measure | max RSS MB |
| --- | ---: |
| session-start (index warm) | 1754.6 |
| post-tool Edit | 1255.0 |
| user-prompt (nudge) | 1561.0 |
| stop (blocked) | 1251.9 |
| session-end | 1253.0 |
| statusline | 1258.2 |
| status <slug> (full CLI, plain) | 1249.8 |
| find <slug> (graph + index build, TypeScript) | 1174.4 |

| bound-log prefix (events) | bytes | fold ms (process, min of 3) |
| ---: | ---: | ---: |
| 2783 | 1.88 MB | 26.4 |
| 6958 | 4.85 MB | 65.1 |
| 13916 | 9.55 MB | 135.9 |
| 27831 | 19.22 MB | 305.8 |
| 48705 | 33.67 MB | 625.4 |
| 69579 | 47.99 MB | 1051.7 |
| 97410 | 67.32 MB | 1670.7 |
| 139157 | 95.71 MB | 2916.9 |

fold crosses 100 ms at ~10388 events / 7.2 MB; a full refold reaches 250 ms at ~23261 events / 16.0 MB

growth budget from the profiles (0.3 human / 0.7 agent, 10 sessions per user per week): 163 events and 0.11 MB per user per week — 100 users add 11 MB / 16300 events a week

