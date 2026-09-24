perf baseline — candidate (/Users/jins/IO/sofar-rust-core/target/release/sofar-core) · 25 spawns per cell · Apple M4 Pro, node v24.15.0 · commit 1745700c
node spawn floor: p50 18.8 ms · p95 20.3 ms · load avg 2.93 → 3.16 · interleaved with node /Users/jins/IO/sofar-rust-core/packages/engine/dist/cli.js

## i1000-1mb — 1000 initiatives, bound log 1.0 MB (3595 lines), 3.5 MB total
| command | p50 ms | p95 ms | min ms | comparator p50 | comparator p95 | vs comparator p50 | vs target p50 | vs target p95 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| session-start (index warm) | 67.0 | 77.6 | 63.6 | 105.9 | 117.1 | 0.63× | 0.61× | 0.66× |
| session-start (index cold) | 281.2 | 302.0 | 277.6 | 356.7 | 394.0 | 0.79× | 0.76× | 0.80× |
| post-tool Edit | 43.3 | 45.3 | 39.3 | 88.5 | 92.9 | 0.49× | 0.52× | 0.52× |
| user-prompt (nudge) | 33.1 | 35.7 | 30.6 | 70.3 | 77.3 | 0.47× | 0.47× | 0.47× |
| stop (blocked) | 25.9 | 29.6 | 23.1 | 65.4 | 70.6 | 0.40× | 0.42× | 0.46× |
| session-end | 33.0 | 34.3 | 31.6 | 76.3 | 80.7 | 0.43× | 0.43× | 0.44× |
| statusline | 5.0 | 6.5 | 4.2 | 36.6 | 39.4 | 0.14× | 0.13× | 0.16× |
| status <slug> (full CLI, plain) | 29.3 | 32.3 | 27.6 | 86.7 | 94.5 | 0.34× | 0.32× | 0.33× |

