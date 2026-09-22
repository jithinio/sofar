perf baseline [SessionIndex A/B: sofar-core 2baf63e vs da1ae8b (pre-SessionIndex), interleaved ABAB (D12)] — candidate (/Users/jins/IO/sofar-rust-core/target/release/sofar-core) · 25 spawns per cell · Apple M4 Pro, node v24.15.0 · commit c52db84
node spawn floor: p50 22.3 ms · p95 24.3 ms · load avg 4.37 → 3.22 · interleaved with /private/tmp/claude-501/-Users-jins-IO-sofar/869ee7f9-ebcc-4395-8a98-6d23564960fd/scratchpad/pre-target/release/sofar-core

## i10-10mb — 10 initiatives, bound log 10.0 MB (35903 lines), 10.0 MB total
| command | p50 ms | p95 ms | min ms | comparator p50 | comparator p95 | vs comparator p50 | vs target p50 | vs target p95 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| session-start (index warm) | 158.8 | 167.1 | 153.7 | 192.4 | 201.8 | 0.83× | 0.52× | 0.53× |
| session-start (index cold) | 246.2 | 257.4 | 237.0 | 275.9 | 284.1 | 0.89× | 0.58× | 0.60× |
| post-tool Edit | 205.0 | 212.3 | 192.5 | 234.3 | 245.1 | 0.87× | 0.51× | 0.51× |
| user-prompt (nudge) | 174.6 | 230.9 | 146.6 | 198.6 | 272.8 | 0.88× | 0.54× | 0.61× |
| stop (blocked) | 229.7 | 619.1 | 156.4 | 313.9 | 609.3 | 0.73× | 0.68× | 1.65× |
| session-end | 197.1 | 336.8 | 190.3 | 230.9 | 331.8 | 0.85× | 0.47× | 0.74× |
| statusline | 141.9 | 150.0 | 136.1 | 174.8 | 183.5 | 0.81× | 0.42× | 0.34× |
| status <slug> (full CLI, plain) | 169.5 | 180.1 | 162.5 | 197.9 | 210.0 | 0.86× | 0.50× | 0.32× |

## i100-10mb — 100 initiatives, bound log 10.0 MB (35903 lines), 10.3 MB total
| command | p50 ms | p95 ms | min ms | comparator p50 | comparator p95 | vs comparator p50 | vs target p50 | vs target p95 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| session-start (index warm) | 163.4 | 172.7 | 157.1 | 192.2 | 203.7 | 0.85× | 0.48× | 0.39× |
| session-start (index cold) | 252.1 | 266.2 | 246.6 | 284.0 | 304.7 | 0.89× | 0.54× | 0.48× |
| post-tool Edit | 202.0 | 213.1 | 191.2 | 228.8 | 242.5 | 0.88× | 0.47× | 0.43× |
| user-prompt (nudge) | 145.2 | 151.8 | 138.5 | 173.9 | 183.5 | 0.84× | 0.42× | 0.36× |
| stop (blocked) | 144.5 | 149.2 | 136.2 | 176.9 | 182.5 | 0.82× | 0.41× | 0.32× |
| session-end | 202.3 | 211.4 | 191.6 | 233.6 | 244.9 | 0.87× | 0.43× | 0.29× |
| statusline | 144.6 | 150.5 | 135.0 | 173.7 | 183.0 | 0.83× | 0.42× | 0.34× |
| status <slug> (full CLI, plain) | 173.0 | 180.6 | 164.4 | 201.1 | 213.2 | 0.86× | 0.51× | 0.42× |

## i1000-10mb — 1000 initiatives, bound log 10.0 MB (35903 lines), 12.5 MB total
| command | p50 ms | p95 ms | min ms | comparator p50 | comparator p95 | vs comparator p50 | vs target p50 | vs target p95 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| session-start (index warm) | 226.1 | 235.1 | 219.9 | 256.4 | 264.4 | 0.88× | 0.53× | 0.50× |
| session-start (index cold) | 357.4 | 389.9 | 345.3 | 389.0 | 413.8 | 0.92× | 0.56× | 0.55× |
| post-tool Edit | 208.9 | 220.9 | 202.3 | 243.5 | 251.6 | 0.86× | 0.50× | 0.49× |
| user-prompt (nudge) | 152.4 | 170.0 | 147.5 | 183.3 | 191.1 | 0.83× | 0.44× | 0.47× |
| stop (blocked) | 144.7 | 149.1 | 139.0 | 175.5 | 181.9 | 0.82× | 0.43× | 0.44× |
| session-end | 201.9 | 211.4 | 194.2 | 232.8 | 242.8 | 0.87× | 0.49× | 0.50× |
| statusline | 145.7 | 153.8 | 139.8 | 175.8 | 184.9 | 0.83× | 0.43× | 0.45× |
| status <slug> (full CLI, plain) | 168.7 | 172.8 | 164.3 | 200.4 | 209.4 | 0.84× | 0.54× | 0.53× |

