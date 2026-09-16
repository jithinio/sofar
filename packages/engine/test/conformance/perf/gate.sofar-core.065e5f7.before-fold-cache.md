# First candidate run, BEFORE the fold cache (rust-core 3.3) — the run that failed the gate

Kept as the measurement behind append.rs's fold cache (D33). Same sitting as the 065e5f7 reference; load avg 8.45 → 4.61 (peer sessions running).

node spawn floor: p50 21.4 ms · p95 22.6 ms · load avg 8.45 → 4.61
## i10-1mb — 10 initiatives, bound log 1.0 MB (3595 lines), 1.0 MB total
| command | p50 ms | p95 ms | min ms | vs target p50 | vs target p95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| session-start (index warm) | 33.4 | 37.7 | 32.5 | 0.49× | 0.52× |
| session-start (index cold) | 42.6 | 45.5 | 41.6 | 0.51× | 0.53× |
| post-tool Edit | 49.9 | 50.9 | 48.3 | 0.65× | 0.65× |
| user-prompt (nudge) | 21.4 | 22.3 | 20.5 | 0.37× | 0.36× |
| stop (blocked) | 20.1 | 20.8 | 19.8 | 0.35× | 0.35× |
| session-end | 49.4 | 54.4 | 47.7 | 0.66× | 0.69× |
| statusline | 21.5 | 23.5 | 20.9 | 0.38× | 0.40× |
| status <slug> (full CLI, plain) | 20.0 | 21.3 | 19.2 | 0.25× | 0.26× |
## i10-10mb — 10 initiatives, bound log 10.0 MB (35903 lines), 10.0 MB total
| command | p50 ms | p95 ms | min ms | vs target p50 | vs target p95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| session-start (index warm) | 219.6 | 239.9 | 213.8 | 0.72× | 0.77× |
| session-start (index cold) | 386.6 | 512.6 | 316.4 | 0.91× | 1.19× |
| post-tool Edit | 469.2 | 628.1 | 418.6 | 1.17× | 1.50× |
| user-prompt (nudge) | 274.2 | 358.3 | 229.4 | 0.84× | 0.94× |
| stop (blocked) | 200.3 | 210.6 | 195.3 | 0.60× | 0.56× |
| session-end | 425.0 | 436.3 | 413.8 | 1.02× | 0.96× |
| statusline | 203.0 | 207.6 | 196.4 | 0.60× | 0.47× |
| status <slug> (full CLI, plain) | 197.0 | 220.0 | 192.2 | 0.58× | 0.39× |
## i100-1mb — 100 initiatives, bound log 1.0 MB (3595 lines), 1.3 MB total
| command | p50 ms | p95 ms | min ms | vs target p50 | vs target p95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| session-start (index warm) | 37.6 | 40.4 | 35.8 | 0.45× | 0.26× |
| session-start (index cold) | 51.6 | 54.9 | 49.8 | 0.49× | 0.34× |
| post-tool Edit | 56.7 | 100.1 | 49.9 | 0.65× | 0.92× |
| user-prompt (nudge) | 27.7 | 41.1 | 24.8 | 0.44× | 0.61× |
| stop (blocked) | 25.3 | 28.8 | 23.0 | 0.42× | 0.46× |
| session-end | 74.9 | 84.8 | 61.7 | 0.90× | 0.91× |
| statusline | 27.0 | 34.8 | 23.1 | 0.44× | 0.44× |
| status <slug> (full CLI, plain) | 23.0 | 24.6 | 21.8 | 0.26× | 0.20× |
## i100-10mb — 100 initiatives, bound log 10.0 MB (35903 lines), 10.3 MB total
| command | p50 ms | p95 ms | min ms | vs target p50 | vs target p95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| session-start (index warm) | 232.1 | 254.4 | 228.0 | 0.68× | 0.58× |
| session-start (index cold) | 440.1 | 622.4 | 323.2 | 0.94× | 1.11× |
| post-tool Edit | 422.6 | 449.4 | 412.2 | 0.99× | 0.90× |
| user-prompt (nudge) | 203.3 | 208.3 | 195.3 | 0.58× | 0.50× |
| stop (blocked) | 201.4 | 206.5 | 193.6 | 0.57× | 0.45× |
| session-end | 416.3 | 435.7 | 404.4 | 0.88× | 0.60× |
| statusline | 201.4 | 208.1 | 196.2 | 0.58× | 0.47× |
| status <slug> (full CLI, plain) | 197.5 | 205.4 | 192.8 | 0.58× | 0.48× |
## i1000-1mb — 1000 initiatives, bound log 1.0 MB (3595 lines), 3.5 MB total
| command | p50 ms | p95 ms | min ms | vs target p50 | vs target p95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| session-start (index warm) | 87.8 | 92.8 | 84.6 | 0.25× | 0.16× |
| session-start (index cold) | 147.1 | 154.1 | 140.4 | 0.36× | 0.16× |
| post-tool Edit | 63.5 | 67.8 | 59.7 | 0.60× | 0.55× |
| user-prompt (nudge) | 32.9 | 34.4 | 31.9 | 0.39× | 0.23× |
| stop (blocked) | 24.2 | 24.6 | 23.7 | 0.34× | 0.20× |
| session-end | 52.1 | 54.4 | 51.0 | 0.50× | 0.26× |
| statusline | 24.5 | 25.1 | 23.7 | 0.34× | 0.22× |
| status <slug> (full CLI, plain) | 20.0 | 20.9 | 19.4 | 0.22× | 0.15× |
## i1000-10mb — 1000 initiatives, bound log 10.0 MB (35903 lines), 12.5 MB total
| command | p50 ms | p95 ms | min ms | vs target p50 | vs target p95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| session-start (index warm) | 279.8 | 312.0 | 266.8 | 0.65× | 0.66× |
| session-start (index cold) | 414.3 | 435.5 | 397.5 | 0.64× | 0.62× |
| post-tool Edit | 439.9 | 453.0 | 429.6 | 1.05× | 1.01× |
| user-prompt (nudge) | 211.3 | 224.3 | 206.1 | 0.61× | 0.62× |
| stop (blocked) | 199.8 | 204.7 | 195.8 | 0.60× | 0.60× |
| session-end | 418.3 | 426.5 | 414.1 | 1.02× | 1.01× |
| statusline | 200.6 | 209.5 | 196.6 | 0.60× | 0.62× |
| status <slug> (full CLI, plain) | 192.3 | 197.1 | 189.1 | 0.61× | 0.60× |
## repo — 55 initiatives, bound log 0.6 MB (789 lines), 7.6 MB total
| command | p50 ms | p95 ms | min ms | vs target p50 | vs target p95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| session-start (index warm) | 25.0 | 27.8 | 24.6 | 0.36× | 0.38× |
| session-start (index cold) | 67.3 | 72.6 | 64.9 | 0.52× | 0.53× |
| post-tool Edit | 20.8 | 21.7 | 19.8 | 0.38× | 0.38× |
| user-prompt (nudge) | 11.1 | 11.4 | 10.8 | 0.25× | 0.25× |
| stop (blocked) | 6.5 | 6.7 | 6.3 | 0.17× | 0.17× |
| session-end | 19.7 | 21.0 | 19.2 | 0.38× | 0.40× |
| statusline | 6.3 | 6.7 | 6.2 | 0.16× | 0.16× |
| status <slug> (full CLI, plain) | 6.0 | 6.6 | 5.8 | 0.10× | 0.10× |
## floor — a root with no record
| command | p50 ms | p95 ms | min ms | vs target p50 | vs target p95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| session-start (no record) | 1.5 | 1.6 | 1.4 | 0.05× | 0.05× |
"i10-10mb / session-start (index cold): p95 512.6 > 432.0",
"i10-10mb / post-tool Edit: p50 469.2 > 401.6",
"i10-10mb / post-tool Edit: p95 628.1 > 417.4",
"i10-10mb / session-end: p50 425.0 > 418.7",
"i100-10mb / session-start (index cold): p95 622.4 > 559.7",
"i1000-10mb / post-tool Edit: p50 439.9 > 420.3",
"i1000-10mb / post-tool Edit: p95 453.0 > 447.4",
"i1000-10mb / session-end: p50 418.3 > 410.0",
"i1000-10mb / session-end: p95 426.5 > 421.4",
