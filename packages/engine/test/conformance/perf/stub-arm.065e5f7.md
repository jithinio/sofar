perf baseline [stub arm: node dist/cli.js dispatching to sofar-core (mixed install through node)] — typescript+sofar-core (/usr/local/bin/node /var/folders/0h/2l96vz9973d4p1vcc5p53q480000gn/T/sofar-conformance-U9KHxQ/reference/cli.js) · 20 spawns per cell · Apple M4 Pro, node v24.15.0 · commit 065e5f7
node spawn floor: p50 21.2 ms · p95 22.6 ms · load avg 4.61 → 3.43

## i10-1mb — 10 initiatives, bound log 1.0 MB (3595 lines), 1.0 MB total
| command | p50 ms | p95 ms | min ms | vs target p50 | vs target p95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| session-start (index warm) | 58.2 | 62.2 | 56.5 | 0.85× | 0.86× |
| session-start (index cold) | 68.4 | 73.4 | 66.4 | 0.82× | 0.85× |
| post-tool Edit | 75.1 | 83.2 | 71.5 | 0.98× | 1.06× |
| user-prompt (nudge) | 47.3 | 49.0 | 46.6 | 0.82× | 0.79× |
| stop (blocked) | 45.7 | 46.6 | 44.7 | 0.81× | 0.79× |
| session-end | 74.3 | 75.6 | 73.0 | 1.00× | 0.97× |
| statusline | 46.3 | 48.7 | 44.7 | 0.82× | 0.82× |
| status <slug> (full CLI, plain) | 44.9 | 46.7 | 44.2 | 0.57× | 0.56× |

## i10-10mb — 10 initiatives, bound log 10.0 MB (35903 lines), 10.0 MB total
| command | p50 ms | p95 ms | min ms | vs target p50 | vs target p95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| session-start (index warm) | 239.5 | 248.4 | 236.6 | 0.78× | 0.79× |
| session-start (index cold) | 399.9 | 477.8 | 330.7 | 0.94× | 1.11× |
| post-tool Edit | 446.6 | 470.1 | 440.6 | 1.11× | 1.13× |
| user-prompt (nudge) | 222.5 | 226.5 | 220.7 | 0.69× | 0.60× |
| stop (blocked) | 220.8 | 223.5 | 216.8 | 0.66× | 0.59× |
| session-end | 441.9 | 452.4 | 433.3 | 1.06× | 0.99× |
| statusline | 221.8 | 224.0 | 218.4 | 0.66× | 0.51× |
| status <slug> (full CLI, plain) | 218.2 | 222.7 | 213.4 | 0.64× | 0.40× |

## i100-1mb — 100 initiatives, bound log 1.0 MB (3595 lines), 1.3 MB total
| command | p50 ms | p95 ms | min ms | vs target p50 | vs target p95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| session-start (index warm) | 61.5 | 62.6 | 59.9 | 0.74× | 0.41× |
| session-start (index cold) | 75.8 | 77.8 | 74.5 | 0.72× | 0.49× |
| post-tool Edit | 74.9 | 80.8 | 73.7 | 0.86× | 0.74× |
| user-prompt (nudge) | 47.1 | 48.5 | 46.0 | 0.75× | 0.72× |
| stop (blocked) | 46.0 | 47.3 | 44.6 | 0.76× | 0.76× |
| session-end | 74.6 | 76.8 | 73.2 | 0.89× | 0.82× |
| statusline | 46.2 | 47.7 | 44.9 | 0.74× | 0.61× |
| status <slug> (full CLI, plain) | 45.0 | 46.0 | 43.7 | 0.51× | 0.37× |

## i100-10mb — 100 initiatives, bound log 10.0 MB (35903 lines), 10.3 MB total
| command | p50 ms | p95 ms | min ms | vs target p50 | vs target p95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| session-start (index warm) | 242.2 | 251.2 | 238.0 | 0.71× | 0.57× |
| session-start (index cold) | 330.6 | 336.3 | 327.5 | 0.71× | 0.60× |
| post-tool Edit | 454.6 | 487.2 | 444.7 | 1.06× | 0.98× |
| user-prompt (nudge) | 232.8 | 261.2 | 227.7 | 0.67× | 0.63× |
| stop (blocked) | 229.0 | 235.5 | 225.0 | 0.65× | 0.51× |
| session-end | 449.7 | 461.3 | 442.5 | 0.95× | 0.64× |
| statusline | 229.0 | 233.7 | 221.0 | 0.66× | 0.53× |
| status <slug> (full CLI, plain) | 222.9 | 230.3 | 219.6 | 0.65× | 0.54× |

## i1000-1mb — 1000 initiatives, bound log 1.0 MB (3595 lines), 3.5 MB total
| command | p50 ms | p95 ms | min ms | vs target p50 | vs target p95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| session-start (index warm) | 117.0 | 121.6 | 113.3 | 0.33× | 0.22× |
| session-start (index cold) | 175.2 | 180.5 | 171.9 | 0.43× | 0.19× |
| post-tool Edit | 91.2 | 93.5 | 88.5 | 0.87× | 0.75× |
| user-prompt (nudge) | 60.3 | 64.1 | 58.6 | 0.72× | 0.42× |
| stop (blocked) | 50.4 | 52.0 | 49.0 | 0.71× | 0.43× |
| session-end | 80.1 | 81.3 | 77.3 | 0.77× | 0.39× |
| statusline | 52.4 | 54.3 | 49.6 | 0.73× | 0.47× |
| status <slug> (full CLI, plain) | 48.4 | 51.4 | 46.0 | 0.54× | 0.38× |

## i1000-10mb — 1000 initiatives, bound log 10.0 MB (35903 lines), 12.5 MB total
| command | p50 ms | p95 ms | min ms | vs target p50 | vs target p95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| session-start (index warm) | 298.7 | 315.5 | 292.6 | 0.70× | 0.67× |
| session-start (index cold) | 438.9 | 444.7 | 428.9 | 0.68× | 0.63× |
| post-tool Edit | 464.2 | 494.8 | 452.8 | 1.10× | 1.11× |
| user-prompt (nudge) | 255.2 | 303.6 | 237.5 | 0.73× | 0.84× |
| stop (blocked) | 229.6 | 235.4 | 225.3 | 0.69× | 0.69× |
| session-end | 452.1 | 461.0 | 445.8 | 1.10× | 1.09× |
| statusline | 229.2 | 238.8 | 223.8 | 0.68× | 0.70× |
| status <slug> (full CLI, plain) | 227.3 | 243.7 | 217.3 | 0.73× | 0.74× |

## repo — 55 initiatives, bound log 0.6 MB (789 lines), 7.6 MB total
| command | p50 ms | p95 ms | min ms | vs target p50 | vs target p95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| session-start (index warm) | 52.4 | 56.0 | 50.7 | 0.76× | 0.76× |
| session-start (index cold) | 95.3 | 100.6 | 93.5 | 0.73× | 0.73× |
| post-tool Edit | 47.4 | 49.4 | 46.0 | 0.86× | 0.86× |
| user-prompt (nudge) | 38.4 | 40.8 | 37.0 | 0.88× | 0.90× |
| stop (blocked) | 33.5 | 35.6 | 31.6 | 0.87× | 0.89× |
| session-end | 48.2 | 50.4 | 45.8 | 0.94× | 0.96× |
| statusline | 33.1 | 34.5 | 31.5 | 0.84× | 0.84× |
| status <slug> (full CLI, plain) | 32.5 | 36.8 | 31.3 | 0.52× | 0.57× |

## floor — a root with no record
| command | p50 ms | p95 ms | min ms | vs target p50 | vs target p95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| session-start (no record) | 28.5 | 29.9 | 26.7 | 0.94× | 0.92× |

