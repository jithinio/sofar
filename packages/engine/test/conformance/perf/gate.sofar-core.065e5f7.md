perf baseline [sofar-core direct, fold cache (D17 mirrored), same sitting as the 065e5f7 reference] — candidate (/Users/jins/IO/sofar-rust-core/target/release/sofar-core) · 20 spawns per cell · Apple M4 Pro, node v24.15.0 · commit 065e5f7
node spawn floor: p50 22.4 ms · p95 24.8 ms · load avg 3.93 → 7.18

## i10-1mb — 10 initiatives, bound log 1.0 MB (3595 lines), 1.0 MB total
| command | p50 ms | p95 ms | min ms | vs target p50 | vs target p95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| session-start (index warm) | 30.7 | 36.8 | 29.6 | 0.45× | 0.51× |
| session-start (index cold) | 43.0 | 45.1 | 39.5 | 0.51× | 0.52× |
| post-tool Edit | 33.7 | 34.9 | 32.1 | 0.44× | 0.44× |
| user-prompt (nudge) | 18.8 | 20.1 | 18.1 | 0.32× | 0.32× |
| stop (blocked) | 17.0 | 17.6 | 16.4 | 0.30× | 0.30× |
| session-end | 32.3 | 34.5 | 30.8 | 0.43× | 0.44× |
| statusline | 17.4 | 18.4 | 16.7 | 0.31× | 0.31× |
| status <slug> (full CLI, plain) | 20.8 | 21.6 | 19.9 | 0.26× | 0.26× |

## i10-10mb — 10 initiatives, bound log 10.0 MB (35903 lines), 10.0 MB total
| command | p50 ms | p95 ms | min ms | vs target p50 | vs target p95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| session-start (index warm) | 181.1 | 184.6 | 179.3 | 0.59× | 0.59× |
| session-start (index cold) | 268.6 | 278.1 | 263.3 | 0.63× | 0.64× |
| post-tool Edit | 222.5 | 231.3 | 216.8 | 0.55× | 0.55× |
| user-prompt (nudge) | 168.6 | 178.6 | 166.2 | 0.52× | 0.47× |
| stop (blocked) | 167.5 | 175.3 | 164.6 | 0.50× | 0.47× |
| session-end | 220.2 | 226.7 | 215.1 | 0.53× | 0.50× |
| statusline | 166.4 | 169.4 | 163.9 | 0.49× | 0.39× |
| status <slug> (full CLI, plain) | 195.0 | 201.0 | 191.3 | 0.57× | 0.36× |

## i100-1mb — 100 initiatives, bound log 1.0 MB (3595 lines), 1.3 MB total
| command | p50 ms | p95 ms | min ms | vs target p50 | vs target p95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| session-start (index warm) | 32.6 | 33.7 | 32.2 | 0.39× | 0.22× |
| session-start (index cold) | 46.5 | 47.5 | 45.8 | 0.44× | 0.30× |
| post-tool Edit | 32.4 | 34.1 | 31.9 | 0.37× | 0.31× |
| user-prompt (nudge) | 17.9 | 18.7 | 17.6 | 0.28× | 0.28× |
| stop (blocked) | 17.0 | 17.1 | 16.7 | 0.28× | 0.27× |
| session-end | 31.7 | 34.3 | 29.9 | 0.38× | 0.37× |
| statusline | 17.3 | 17.7 | 16.9 | 0.28× | 0.22× |
| status <slug> (full CLI, plain) | 19.4 | 19.6 | 18.9 | 0.22× | 0.16× |

## i100-10mb — 100 initiatives, bound log 10.0 MB (35903 lines), 10.3 MB total
| command | p50 ms | p95 ms | min ms | vs target p50 | vs target p95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| session-start (index warm) | 187.1 | 193.8 | 182.9 | 0.55× | 0.44× |
| session-start (index cold) | 278.3 | 281.2 | 273.8 | 0.59× | 0.50× |
| post-tool Edit | 223.3 | 229.9 | 220.1 | 0.52× | 0.46× |
| user-prompt (nudge) | 171.7 | 177.9 | 167.6 | 0.49× | 0.43× |
| stop (blocked) | 165.9 | 167.9 | 163.9 | 0.47× | 0.36× |
| session-end | 224.2 | 240.7 | 217.9 | 0.47× | 0.33× |
| statusline | 172.2 | 187.1 | 165.6 | 0.50× | 0.42× |
| status <slug> (full CLI, plain) | 199.6 | 209.1 | 190.0 | 0.58× | 0.49× |

## i1000-1mb — 1000 initiatives, bound log 1.0 MB (3595 lines), 3.5 MB total
| command | p50 ms | p95 ms | min ms | vs target p50 | vs target p95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| session-start (index warm) | 81.7 | 87.9 | 78.9 | 0.23× | 0.16× |
| session-start (index cold) | 140.1 | 143.7 | 136.5 | 0.34× | 0.15× |
| post-tool Edit | 45.5 | 49.0 | 42.8 | 0.43× | 0.40× |
| user-prompt (nudge) | 30.0 | 31.5 | 29.0 | 0.36× | 0.21× |
| stop (blocked) | 20.8 | 21.6 | 19.7 | 0.29× | 0.18× |
| session-end | 36.3 | 44.0 | 34.6 | 0.35× | 0.21× |
| statusline | 20.8 | 21.6 | 19.3 | 0.29× | 0.19× |
| status <slug> (full CLI, plain) | 19.6 | 20.9 | 19.1 | 0.22× | 0.15× |

## i1000-10mb — 1000 initiatives, bound log 10.0 MB (35903 lines), 12.5 MB total
| command | p50 ms | p95 ms | min ms | vs target p50 | vs target p95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| session-start (index warm) | 240.8 | 245.1 | 233.0 | 0.56× | 0.52× |
| session-start (index cold) | 371.7 | 384.1 | 367.5 | 0.58× | 0.54× |
| post-tool Edit | 232.9 | 236.4 | 229.1 | 0.55× | 0.53× |
| user-prompt (nudge) | 189.4 | 247.5 | 176.6 | 0.55× | 0.68× |
| stop (blocked) | 214.4 | 256.8 | 186.1 | 0.64× | 0.76× |
| session-end | 233.6 | 370.8 | 221.7 | 0.57× | 0.88× |
| statusline | 170.7 | 173.9 | 167.2 | 0.51× | 0.51× |
| status <slug> (full CLI, plain) | 192.7 | 196.8 | 191.6 | 0.62× | 0.60× |

## repo — 55 initiatives, bound log 0.6 MB (789 lines), 7.6 MB total
| command | p50 ms | p95 ms | min ms | vs target p50 | vs target p95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| session-start (index warm) | 23.1 | 23.9 | 22.9 | 0.33× | 0.33× |
| session-start (index cold) | 64.7 | 67.0 | 63.5 | 0.50× | 0.49× |
| post-tool Edit | 16.5 | 18.1 | 15.2 | 0.30× | 0.32× |
| user-prompt (nudge) | 9.8 | 10.9 | 9.4 | 0.22× | 0.24× |
| stop (blocked) | 4.8 | 5.5 | 4.6 | 0.12× | 0.14× |
| session-end | 16.4 | 18.0 | 15.8 | 0.32× | 0.34× |
| statusline | 5.4 | 5.8 | 5.1 | 0.14× | 0.14× |
| status <slug> (full CLI, plain) | 6.4 | 7.0 | 6.1 | 0.10× | 0.11× |

## floor — a root with no record
| command | p50 ms | p95 ms | min ms | vs target p50 | vs target p95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| session-start (no record) | 1.7 | 2.1 | 1.5 | 0.06× | 0.06× |

