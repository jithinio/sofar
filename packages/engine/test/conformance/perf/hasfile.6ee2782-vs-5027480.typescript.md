perf baseline [r1-fixes 4.5 A/B: TypeScript 6ee2782 (hasFile) vs 5027480 (its parent), interleaved ABAB (D12)] — typescript (node /private/tmp/claude-501/-Users-jins-IO-sofar/6394af10-d979-4454-a347-5e22178c5a5c/scratchpad/ts-6ee2782/packages/engine/dist/cli.js) · 25 spawns per cell · Apple M4 Pro, node v24.15.0 · commit 6ee2782
node spawn floor: p50 24.3 ms · p95 26.4 ms · load avg 5.02 → 4.66 · interleaved with node /private/tmp/claude-501/-Users-jins-IO-sofar/6394af10-d979-4454-a347-5e22178c5a5c/scratchpad/ts-5027480/packages/engine/dist/cli.js

## team100-w100 — 20 initiatives, bound log 19.2 MB (27743 lines), 69.5 MB total
| command | p50 ms | p95 ms | min ms | comparator p50 | comparator p95 | vs comparator p50 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| session-start (index warm) | 414.1 | 469.5 | 398.6 | 515.7 | 562.4 | 0.80× |
| session-start (index cold) | 949.7 | 973.0 | 932.7 | 1052.0 | 1075.6 | 0.90× |
| post-tool Edit | 416.4 | 433.8 | 407.6 | 518.2 | 542.9 | 0.80× |
| user-prompt (nudge) | 326.9 | 355.5 | 321.2 | 431.8 | 452.9 | 0.76× |
| stop (blocked) | 319.0 | 325.4 | 312.8 | 422.1 | 431.1 | 0.76× |
| session-end | 406.4 | 434.4 | 399.6 | 512.6 | 536.4 | 0.79× |
| statusline | 323.2 | 337.3 | 314.5 | 425.1 | 441.5 | 0.76× |
| status <slug> (full CLI, plain) | 335.9 | 380.4 | 323.0 | 448.1 | 611.1 | 0.75× |
| find <slug> (graph + index build, TypeScript) | 689.4 | 744.1 | 677.5 | | | |

## team100 — 20 initiatives, bound log 95.6 MB (138950 lines), 345.4 MB total
| command | p50 ms | p95 ms | min ms | comparator p50 | comparator p95 | vs comparator p50 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| session-start (index warm) | 2200.8 | 3621.3 | 2133.2 | 5164.7 | 7499.4 | 0.43× |
| session-start (index cold) | 5765.9 | 6003.7 | 5476.8 | 8462.5 | 8977.3 | 0.68× |
| post-tool Edit | 2090.3 | 2252.5 | 2017.2 | 4764.9 | 4980.8 | 0.44× |
| user-prompt (nudge) | 1665.6 | 2615.0 | 1629.2 | 4325.8 | 4783.2 | 0.39× |
| stop (blocked) | 1681.5 | 1731.5 | 1632.3 | 4386.2 | 4608.4 | 0.38× |
| session-end | 2077.0 | 2241.3 | 1981.1 | 4852.9 | 5320.0 | 0.43× |
| statusline | 1678.7 | 2451.2 | 1634.5 | 4375.1 | 6384.8 | 0.38× |
| status <slug> (full CLI, plain) | 1550.5 | 1663.9 | 1486.0 | 4197.7 | 4902.0 | 0.37× |
| find <slug> (graph + index build, TypeScript) | 3087.5 | 3188.6 | 3009.5 | | | |

## team100-w100 — team100 corpus (rust-core 1.5)
20 initiatives, 100 writers, 69.5 MB / 100246 events in all; bound record 19.2 MB / 27743 events, 1745 sessions of which 100 open (one per writer); largest log 19.2 MB

| measure | max RSS MB |
| --- | ---: |
| session-start (index warm) | 544.7 |
| post-tool Edit | 401.3 |
| user-prompt (nudge) | 488.5 |
| stop (blocked) | 381.4 |
| session-end | 380.5 |
| statusline | 380.7 |
| status <slug> (full CLI, plain) | 399.0 |
| find <slug> (graph + index build, TypeScript) | 401.6 |

| bound-log prefix (events) | bytes | fold ms (process, min of 3) |
| ---: | ---: | ---: |
| 559 | 0.40 MB | 74.7 |
| 1398 | 0.99 MB | 84.9 |
| 2795 | 1.89 MB | 99.1 |
| 5590 | 3.83 MB | 128.9 |
| 9783 | 6.71 MB | 172.2 |
| 13975 | 9.58 MB | 227.0 |
| 19565 | 13.47 MB | 286.2 |
| 27950 | 19.24 MB | 381.8 |

fold crosses 100 ms at ~2878 events / 1.9 MB; a full refold reaches 250 ms at ~16149 events / 11.1 MB

growth budget from the profiles (0.3 human / 0.7 agent, 10 sessions per user per week): 163 events and 0.11 MB per user per week — 100 users add 11 MB / 16300 events a week

## team100 — team100 corpus (rust-core 1.5)
20 initiatives, 100 writers, 345.4 MB / 500188 events in all; bound record 95.6 MB / 138950 events, 8576 sessions of which 100 open (one per writer); largest log 95.6 MB

| measure | max RSS MB |
| --- | ---: |
| session-start (index warm) | 1457.2 |
| post-tool Edit | 1212.7 |
| user-prompt (nudge) | 1378.2 |
| stop (blocked) | 1140.5 |
| session-end | 1139.9 |
| statusline | 1139.6 |
| status <slug> (full CLI, plain) | 1175.6 |
| find <slug> (graph + index build, TypeScript) | 1175.1 |

| bound-log prefix (events) | bytes | fold ms (process, min of 3) |
| ---: | ---: | ---: |
| 2783 | 1.88 MB | 88.6 |
| 6958 | 4.85 MB | 131.7 |
| 13916 | 9.55 MB | 210.4 |
| 27831 | 19.22 MB | 345.9 |
| 48705 | 33.67 MB | 570.6 |
| 69579 | 47.99 MB | 828.8 |
| 97410 | 67.32 MB | 1169.8 |
| 139157 | 95.71 MB | 1729.0 |

fold crosses 100 ms at ~3885 events / 2.7 MB; a full refold reaches 250 ms at ~17983 events / 12.4 MB

growth budget from the profiles (0.3 human / 0.7 agent, 10 sessions per user per week): 163 events and 0.11 MB per user per week — 100 users add 11 MB / 16300 events a week

