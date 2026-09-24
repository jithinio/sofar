perf baseline — candidate (/Users/jins/IO/sofar-rust-core/target/release/sofar-core) · 20 spawns per cell · Apple M4 Pro, node v24.15.0 · commit 1745700c
node spawn floor: p50 21.8 ms · p95 25.1 ms · load avg 2.78 → 6.15

## i10-1mb — 10 initiatives, bound log 1.0 MB (3595 lines), 1.0 MB total
| command | p50 ms | p95 ms | min ms | vs target p50 | vs target p95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| session-start (index warm) | 14.9 | 16.3 | 14.2 | 0.32× | 0.33× |
| session-start (index cold) | 40.5 | 42.9 | 38.5 | 0.46× | 0.44× |
| post-tool Edit | 29.8 | 31.7 | 28.1 | 0.40× | 0.38× |
| user-prompt (nudge) | 15.5 | 16.0 | 15.2 | 0.28× | 0.27× |
| stop (blocked) | 14.8 | 15.7 | 14.0 | 0.24× | 0.20× |
| session-end | 30.4 | 31.8 | 28.2 | 0.42× | 0.41× |
| statusline | 2.5 | 3.1 | 1.9 | 0.07× | 0.09× |
| status <slug> (full CLI, plain) | 30.2 | 31.3 | 28.7 | 0.31× | 0.26× |

## i10-10mb — 10 initiatives, bound log 10.0 MB (35903 lines), 10.0 MB total
| command | p50 ms | p95 ms | min ms | vs target p50 | vs target p95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| session-start (index warm) | 13.4 | 16.4 | 13.1 | 0.25× | 0.27× |
| session-start (index cold) | 216.3 | 223.7 | 211.6 | 0.63× | 0.64× |
| post-tool Edit | 145.0 | 151.3 | 141.1 | 0.56× | 0.55× |
| user-prompt (nudge) | 110.7 | 122.1 | 107.6 | 0.57× | 0.57× |
| stop (blocked) | 109.0 | 112.4 | 106.4 | 0.57× | 0.58× |
| session-end | 157.3 | 166.0 | 152.6 | 0.57× | 0.58× |
| statusline | 3.3 | 3.5 | 2.7 | 0.10× | 0.09× |
| status <slug> (full CLI, plain) | 167.6 | 182.3 | 160.0 | 0.73× | 0.78× |

## i100-1mb — 100 initiatives, bound log 1.0 MB (3595 lines), 1.3 MB total
| command | p50 ms | p95 ms | min ms | vs target p50 | vs target p95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| session-start (index warm) | 19.7 | 22.6 | 18.6 | 0.34× | 0.37× |
| session-start (index cold) | 62.6 | 67.0 | 59.2 | 0.52× | 0.53× |
| post-tool Edit | 28.9 | 32.1 | 27.7 | 0.38× | 0.40× |
| user-prompt (nudge) | 15.8 | 16.6 | 15.5 | 0.27× | 0.27× |
| stop (blocked) | 14.5 | 15.5 | 14.1 | 0.25× | 0.25× |
| session-end | 31.0 | 32.2 | 28.7 | 0.41× | 0.39× |
| statusline | 2.4 | 2.9 | 2.1 | 0.07× | 0.08× |
| status <slug> (full CLI, plain) | 28.9 | 30.6 | 27.9 | 0.32× | 0.32× |

## i100-10mb — 100 initiatives, bound log 10.0 MB (35903 lines), 10.3 MB total
| command | p50 ms | p95 ms | min ms | vs target p50 | vs target p95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| session-start (index warm) | 20.7 | 23.5 | 19.9 | 0.32× | 0.35× |
| session-start (index cold) | 252.0 | 279.5 | 237.3 | 0.67× | 0.71× |
| post-tool Edit | 147.4 | 157.4 | 143.7 | 0.53× | 0.53× |
| user-prompt (nudge) | 110.1 | 118.0 | 107.4 | 0.58× | 0.53× |
| stop (blocked) | 110.5 | 113.2 | 107.7 | 0.61× | 0.59× |
| session-end | 157.7 | 169.6 | 152.6 | 0.62× | 0.62× |
| statusline | 2.8 | 3.6 | 2.7 | 0.08× | 0.10× |
| status <slug> (full CLI, plain) | 169.1 | 177.5 | 159.5 | 0.80× | 0.82× |

## i1000-1mb — 1000 initiatives, bound log 1.0 MB (3595 lines), 3.5 MB total
| command | p50 ms | p95 ms | min ms | vs target p50 | vs target p95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| session-start (index warm) | 71.2 | 85.9 | 64.3 | 0.64× | 0.73× |
| session-start (index cold) | 286.2 | 319.8 | 280.0 | 0.78× | 0.84× |
| post-tool Edit | 43.5 | 50.9 | 37.1 | 0.52× | 0.59× |
| user-prompt (nudge) | 31.7 | 35.1 | 30.5 | 0.45× | 0.46× |
| stop (blocked) | 25.4 | 28.2 | 22.5 | 0.41× | 0.44× |
| session-end | 33.7 | 38.2 | 31.2 | 0.44× | 0.49× |
| statusline | 4.4 | 5.9 | 4.2 | 0.12× | 0.15× |
| status <slug> (full CLI, plain) | 28.3 | 30.5 | 27.2 | 0.31× | 0.31× |

## i1000-10mb — 1000 initiatives, bound log 10.0 MB (35903 lines), 12.5 MB total
| command | p50 ms | p95 ms | min ms | vs target p50 | vs target p95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| session-start (index warm) | 66.3 | 70.5 | 65.3 | 0.60× | 0.61× |
| session-start (index cold) | 462.3 | 481.6 | 454.4 | 0.77× | 0.76× |
| post-tool Edit | 160.6 | 178.4 | 153.6 | 0.58× | 0.60× |
| user-prompt (nudge) | 129.7 | 137.2 | 124.2 | 0.67× | 0.70× |
| stop (blocked) | 120.9 | 167.4 | 117.5 | 0.65× | 0.86× |
| session-end | 173.5 | 186.8 | 161.1 | 0.64× | 0.65× |
| statusline | 6.8 | 7.6 | 5.6 | 0.16× | 0.17× |
| status <slug> (full CLI, plain) | 170.8 | 193.4 | 161.2 | 0.77× | 0.78× |

## repo — 55 initiatives, bound log 0.6 MB (789 lines), 7.6 MB total
| command | p50 ms | p95 ms | min ms | vs target p50 | vs target p95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| session-start (index warm) | 19.8 | 23.1 | 19.0 | 0.30× | 0.33× |
| session-start (index cold) | 80.2 | 88.9 | 77.2 | 0.47× | 0.47× |
| post-tool Edit | 15.3 | 18.3 | 14.8 | 0.26× | 0.29× |
| user-prompt (nudge) | 5.2 | 5.8 | 5.0 | 0.11× | 0.11× |
| stop (blocked) | 4.7 | 5.0 | 4.5 | 0.10× | 0.11× |
| session-end | 13.8 | 15.5 | 12.0 | 0.24× | 0.26× |
| statusline | 1.8 | 1.9 | 1.7 | 0.05× | 0.05× |
| status <slug> (full CLI, plain) | 13.5 | 14.5 | 12.9 | 0.17× | 0.17× |

## floor — a root with no record
| command | p50 ms | p95 ms | min ms | vs target p50 | vs target p95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| session-start (no record) | 1.5 | 1.6 | 1.4 | 0.05× | 0.05× |

