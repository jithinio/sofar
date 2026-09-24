perf baseline [rust-core 4.4 gate reference, re-recorded in the same sitting as the candidate (D12) from this tree at 1745700 (engine includes 4.4 caches and record-index 01M37PM7)] — typescript (node dist/cli.js (built from source as build.mjs ships it)) · 20 spawns per cell · Apple M4 Pro, node v24.15.0 · commit 1745700c
node spawn floor: p50 19.0 ms · p95 21.0 ms · load avg 2.76 → 2.92

## i10-1mb — 10 initiatives, bound log 1.0 MB (3595 lines), 1.0 MB total
| command | p50 ms | p95 ms | min ms |
| --- | ---: | ---: | ---: |
| session-start (index warm) | 45.8 | 49.3 | 44.2 |
| session-start (index cold) | 87.8 | 97.9 | 84.2 |
| post-tool Edit | 74.0 | 83.6 | 70.6 |
| user-prompt (nudge) | 54.6 | 58.8 | 51.4 |
| stop (blocked) | 61.1 | 78.8 | 54.5 |
| session-end | 72.6 | 77.6 | 68.9 |
| statusline | 34.5 | 36.0 | 33.0 |
| status <slug> (full CLI, plain) | 98.6 | 120.0 | 93.6 |

## i10-10mb — 10 initiatives, bound log 10.0 MB (35903 lines), 10.0 MB total
| command | p50 ms | p95 ms | min ms |
| --- | ---: | ---: | ---: |
| session-start (index warm) | 53.7 | 60.1 | 49.2 |
| session-start (index cold) | 343.4 | 350.4 | 316.5 |
| post-tool Edit | 260.8 | 274.3 | 249.7 |
| user-prompt (nudge) | 193.1 | 214.3 | 186.5 |
| stop (blocked) | 190.7 | 193.8 | 172.1 |
| session-end | 276.1 | 285.3 | 257.4 |
| statusline | 34.4 | 41.7 | 32.5 |
| status <slug> (full CLI, plain) | 230.0 | 235.2 | 221.6 |

## i100-1mb — 100 initiatives, bound log 1.0 MB (3595 lines), 1.3 MB total
| command | p50 ms | p95 ms | min ms |
| --- | ---: | ---: | ---: |
| session-start (index warm) | 58.6 | 60.3 | 56.8 |
| session-start (index cold) | 120.7 | 127.5 | 115.7 |
| post-tool Edit | 76.1 | 80.3 | 73.6 |
| user-prompt (nudge) | 59.1 | 62.0 | 55.0 |
| stop (blocked) | 57.2 | 61.6 | 53.0 |
| session-end | 75.2 | 83.6 | 72.3 |
| statusline | 33.2 | 34.9 | 31.5 |
| status <slug> (full CLI, plain) | 91.7 | 96.7 | 88.7 |

## i100-10mb — 100 initiatives, bound log 10.0 MB (35903 lines), 10.3 MB total
| command | p50 ms | p95 ms | min ms |
| --- | ---: | ---: | ---: |
| session-start (index warm) | 63.9 | 66.3 | 60.5 |
| session-start (index cold) | 377.3 | 392.9 | 368.9 |
| post-tool Edit | 279.4 | 295.8 | 271.9 |
| user-prompt (nudge) | 188.3 | 222.2 | 183.5 |
| stop (blocked) | 181.5 | 190.3 | 177.4 |
| session-end | 254.3 | 273.7 | 249.4 |
| statusline | 34.2 | 37.1 | 32.6 |
| status <slug> (full CLI, plain) | 210.5 | 215.3 | 207.7 |

## i1000-1mb — 1000 initiatives, bound log 1.0 MB (3595 lines), 3.5 MB total
| command | p50 ms | p95 ms | min ms |
| --- | ---: | ---: | ---: |
| session-start (index warm) | 110.5 | 118.3 | 107.0 |
| session-start (index cold) | 367.9 | 379.2 | 361.5 |
| post-tool Edit | 83.5 | 86.8 | 81.8 |
| user-prompt (nudge) | 69.8 | 76.2 | 68.1 |
| stop (blocked) | 61.9 | 64.0 | 60.8 |
| session-end | 76.3 | 78.0 | 74.6 |
| statusline | 37.5 | 40.2 | 36.1 |
| status <slug> (full CLI, plain) | 92.2 | 97.1 | 88.8 |

## i1000-10mb — 1000 initiatives, bound log 10.0 MB (35903 lines), 12.5 MB total
| command | p50 ms | p95 ms | min ms |
| --- | ---: | ---: | ---: |
| session-start (index warm) | 110.5 | 114.7 | 107.7 |
| session-start (index cold) | 603.1 | 634.4 | 591.0 |
| post-tool Edit | 279.1 | 297.3 | 264.3 |
| user-prompt (nudge) | 192.5 | 197.3 | 188.5 |
| stop (blocked) | 185.3 | 193.6 | 180.3 |
| session-end | 272.9 | 285.4 | 258.4 |
| statusline | 41.3 | 46.3 | 38.6 |
| status <slug> (full CLI, plain) | 222.8 | 246.7 | 215.4 |

## repo — 55 initiatives, bound log 0.6 MB (789 lines), 7.6 MB total
| command | p50 ms | p95 ms | min ms |
| --- | ---: | ---: | ---: |
| session-start (index warm) | 65.7 | 69.8 | 60.9 |
| session-start (index cold) | 169.2 | 190.0 | 158.8 |
| post-tool Edit | 58.0 | 62.1 | 54.3 |
| user-prompt (nudge) | 46.7 | 53.0 | 42.3 |
| stop (blocked) | 45.4 | 47.5 | 40.4 |
| session-end | 57.3 | 60.2 | 51.8 |
| statusline | 36.9 | 40.8 | 35.4 |
| status <slug> (full CLI, plain) | 79.9 | 87.0 | 74.4 |

## floor — a root with no record
| command | p50 ms | p95 ms | min ms |
| --- | ---: | ---: | ---: |
| session-start (no record) | 31.4 | 33.9 | 30.9 |

## in-process (TypeScript reference only): fold of the bound log, digest render of the folded state
| cell | fold p50 ms | fold p95 ms | render p50 ms | render p95 ms |
| --- | ---: | ---: | ---: | ---: |
| i10-1mb | 12.8 | 15.8 | 0.3 | 0.6 |
| i10-10mb | 118.3 | 136.8 | 0.5 | 0.9 |
| i100-1mb | 10.7 | 13.1 | 0.2 | 0.3 |
| i100-10mb | 113.2 | 126.7 | 0.4 | 0.5 |
| i1000-1mb | 10.3 | 12.6 | 0.1 | 0.3 |
| i1000-10mb | 117.1 | 130.2 | 0.5 | 0.6 |
| repo | 2.4 | 3.4 | 0.6 | 1.0 |

