perf baseline [FileIndex + guard borrow A/B: sofar-core 8bad310 vs c0c0e9f (pre), interleaved ABAB (D12)] — candidate (/Users/jins/IO/sofar-rust-core/target/release/sofar-core) · 25 spawns per cell · Apple M4 Pro, node v24.15.0 · commit 8bad310
node spawn floor: p50 22.7 ms · p95 25.0 ms · load avg 3.71 → 8 · interleaved with /private/tmp/claude-501/-Users-jins-IO-sofar/6394af10-d979-4454-a347-5e22178c5a5c/scratchpad/pre-target/release/sofar-core

## team100-w100 — 20 initiatives, bound log 19.2 MB (27743 lines), 69.5 MB total
| command | p50 ms | p95 ms | min ms | comparator p50 | comparator p95 | vs comparator p50 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| session-start (index warm) | 336.4 | 344.4 | 331.0 | 406.1 | 413.3 | 0.83× |
| session-start (index cold) | 738.8 | 761.8 | 720.6 | 816.7 | 834.5 | 0.90× |
| post-tool Edit | 291.8 | 302.7 | 277.0 | 362.9 | 382.5 | 0.80× |
| user-prompt (nudge) | 215.6 | 237.3 | 205.8 | 288.7 | 320.2 | 0.75× |
| stop (blocked) | 193.4 | 214.4 | 186.9 | 266.2 | 286.4 | 0.73× |
| session-end | 282.8 | 552.9 | 277.1 | 354.0 | 617.3 | 0.80× |
| statusline | 187.7 | 196.5 | 183.9 | 260.9 | 273.9 | 0.72× |
| status <slug> (full CLI, plain) | 242.3 | 250.5 | 237.8 | 312.4 | 322.5 | 0.78× |
| find <slug> (graph + index build, TypeScript) | 687.5 | 697.2 | 679.7 | | | |

## team100 — 20 initiatives, bound log 95.6 MB (138950 lines), 345.4 MB total
| command | p50 ms | p95 ms | min ms | comparator p50 | comparator p95 | vs comparator p50 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| session-start (index warm) | 3335.6 | 3445.8 | 3232.7 | 5224.5 | 5697.8 | 0.64× |
| session-start (index cold) | 6994.7 | 7247.0 | 6810.0 | 8904.2 | 9270.5 | 0.79× |
| post-tool Edit | 1534.1 | 1678.6 | 1435.2 | 3453.4 | 3906.0 | 0.44× |
| user-prompt (nudge) | 1198.0 | 2003.0 | 1142.6 | 3275.3 | 5366.4 | 0.37× |
| stop (blocked) | 1068.2 | 1443.4 | 1045.7 | 3038.0 | 3822.6 | 0.35× |
| session-end | 1625.9 | 1882.9 | 1534.1 | 3631.3 | 3841.6 | 0.45× |
| statusline | 1096.0 | 1699.4 | 1059.7 | 3171.4 | 4428.9 | 0.35× |
| status <slug> (full CLI, plain) | 1392.8 | 1456.5 | 1350.4 | 3520.0 | 3653.8 | 0.40× |
| find <slug> (graph + index build, TypeScript) | 3376.6 | 3490.3 | 3067.2 | | | |

## team100-w100 — team100 corpus (rust-core 1.5)
20 initiatives, 100 writers, 69.5 MB / 100246 events in all; bound record 19.2 MB / 27743 events, 1745 sessions of which 100 open (one per writer); largest log 19.2 MB

| measure | max RSS MB |
| --- | ---: |
| session-start (index warm) | 334.8 |
| post-tool Edit | 253.5 |
| user-prompt (nudge) | 309.5 |
| stop (blocked) | 250.8 |
| session-end | 250.7 |
| statusline | 252.3 |
| status <slug> (full CLI, plain) | 252.2 |
| find <slug> (graph + index build, TypeScript) | 400.9 |

| bound-log prefix (events) | bytes | fold ms (process, min of 3) |
| ---: | ---: | ---: |
| 559 | 0.40 MB | 7.7 |
| 1398 | 0.99 MB | 15.3 |
| 2795 | 1.89 MB | 27.8 |
| 5590 | 3.83 MB | 52.1 |
| 9783 | 6.71 MB | 89.5 |
| 13975 | 9.58 MB | 125.7 |
| 19565 | 13.47 MB | 178.3 |
| 27950 | 19.24 MB | 254.1 |

fold crosses 100 ms at ~11003 events / 7.5 MB; a full refold reaches 250 ms at ~27501 events / 18.9 MB

growth budget from the profiles (0.3 human / 0.7 agent, 10 sessions per user per week): 163 events and 0.11 MB per user per week — 100 users add 11 MB / 16300 events a week

## team100 — team100 corpus (rust-core 1.5)
20 initiatives, 100 writers, 345.4 MB / 500188 events in all; bound record 95.6 MB / 138950 events, 8576 sessions of which 100 open (one per writer); largest log 95.6 MB

| measure | max RSS MB |
| --- | ---: |
| session-start (index warm) | 1776.8 |
| post-tool Edit | 1262.2 |
| user-prompt (nudge) | 1578.5 |
| stop (blocked) | 1265.4 |
| session-end | 1259.6 |
| statusline | 1269.6 |
| status <slug> (full CLI, plain) | 1267.5 |
| find <slug> (graph + index build, TypeScript) | 1173.9 |

| bound-log prefix (events) | bytes | fold ms (process, min of 3) |
| ---: | ---: | ---: |
| 2783 | 1.88 MB | 28.0 |
| 6958 | 4.85 MB | 64.9 |
| 13916 | 9.55 MB | 129.2 |
| 27831 | 19.22 MB | 254.7 |
| 48705 | 33.67 MB | 450.5 |
| 69579 | 47.99 MB | 653.4 |
| 97410 | 67.32 MB | 927.1 |
| 139157 | 95.71 MB | 1376.3 |

fold crosses 100 ms at ~10753 events / 7.4 MB; a full refold reaches 250 ms at ~27310 events / 18.9 MB

growth budget from the profiles (0.3 human / 0.7 agent, 10 sessions per user per week): 163 events and 0.11 MB per user per week — 100 users add 11 MB / 16300 events a week

