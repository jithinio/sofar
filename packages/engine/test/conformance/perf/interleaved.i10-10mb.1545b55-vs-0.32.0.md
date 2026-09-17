perf baseline [interleaved: r1-fixes 1545b55 vs 0.32.0 pinned install, i10-10mb, n=25] — typescript (/usr/local/bin/node /Users/jins/IO/sofar-r1-fixes/packages/engine/dist/cli.js) · 25 spawns per cell · Apple M4 Pro, node v24.15.0 · commit 1545b55
node spawn floor: p50 22.1 ms · p95 24.1 ms · load avg 5.97 → 6.92 · interleaved with /usr/local/bin/node /Users/jins/.bench/sofar-0.32.0/node_modules/sofar.sh/dist/cli.js

## i10-10mb — 10 initiatives, bound log 10.0 MB (35903 lines), 10.0 MB total
| command | p50 ms | p95 ms | min ms | comparator p50 | comparator p95 | vs comparator p50 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| session-start (index warm) | 318.3 | 341.6 | 304.4 | 318.9 | 352.6 | 1.00× |
| session-start (index cold) | 439.0 | 507.9 | 423.2 | 436.1 | 495.8 | 1.01× |
| post-tool Edit | 413.2 | 465.2 | 393.1 | 622.4 | 719.3 | 0.66× |
| user-prompt (nudge) | 331.5 | 376.2 | 323.8 | 329.3 | 345.7 | 1.01× |
| stop (blocked) | 329.0 | 348.4 | 318.8 | 325.3 | 348.7 | 1.01× |
| session-end | 403.8 | 448.1 | 390.6 | 617.5 | 658.6 | 0.65× |
| statusline | 327.7 | 338.9 | 313.7 | 322.7 | 332.9 | 1.02× |
| status <slug> (full CLI, plain) | 316.9 | 451.3 | 304.1 | 313.6 | 372.1 | 1.01× |

