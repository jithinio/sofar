perf baseline [r1-fixes with 2.7 single fold (the Phase 3.3 target)] — typescript (/usr/local/bin/node /Users/jins/IO/sofar-r1-fixes/packages/engine/dist/cli.js) · 20 spawns per cell · Apple M4 Pro, node v24.15.0 · commit a45ea21
node spawn floor: p50 21.9 ms · p95 26.0 ms

## i10-1mb — 10 initiatives, bound log 1.0 MB (3595 lines), 1.0 MB total
| command | p50 ms | p95 ms | min ms |
| --- | ---: | ---: | ---: |
| session-start (index warm) | 65.5 | 70.3 | 62.9 |
| session-start (index cold) | 82.5 | 88.8 | 76.9 |
| post-tool Edit | 76.2 | 79.9 | 70.5 |
| user-prompt (nudge) | 57.8 | 59.5 | 56.4 |
| stop (blocked) | 54.2 | 57.5 | 51.7 |
| session-end | 70.7 | 73.0 | 68.7 |
| statusline | 53.9 | 57.6 | 52.6 |
| status <slug> (full CLI, plain) | 78.8 | 80.3 | 73.5 |

## i10-10mb — 10 initiatives, bound log 10.0 MB (35903 lines), 10.0 MB total
| command | p50 ms | p95 ms | min ms |
| --- | ---: | ---: | ---: |
| session-start (index warm) | 295.1 | 303.3 | 289.9 |
| session-start (index cold) | 424.3 | 445.2 | 411.8 |
| post-tool Edit | 408.4 | 426.3 | 388.4 |
| user-prompt (nudge) | 318.8 | 328.6 | 314.2 |
| stop (blocked) | 310.7 | 338.4 | 306.3 |
| session-end | 396.3 | 420.3 | 371.8 |
| statusline | 319.5 | 332.8 | 313.0 |
| status <slug> (full CLI, plain) | 300.7 | 311.4 | 292.4 |

## i100-1mb — 100 initiatives, bound log 1.0 MB (3595 lines), 1.3 MB total
| command | p50 ms | p95 ms | min ms |
| --- | ---: | ---: | ---: |
| session-start (index warm) | 78.1 | 84.3 | 74.3 |
| session-start (index cold) | 99.0 | 102.2 | 94.0 |
| post-tool Edit | 81.7 | 84.0 | 75.3 |
| user-prompt (nudge) | 61.7 | 64.5 | 59.4 |
| stop (blocked) | 54.7 | 56.5 | 53.9 |
| session-end | 71.9 | 75.8 | 69.5 |
| statusline | 55.4 | 60.9 | 54.0 |
| status <slug> (full CLI, plain) | 76.1 | 80.5 | 73.0 |

## i100-10mb — 100 initiatives, bound log 10.0 MB (35903 lines), 10.3 MB total
| command | p50 ms | p95 ms | min ms |
| --- | ---: | ---: | ---: |
| session-start (index warm) | 313.0 | 327.9 | 303.1 |
| session-start (index cold) | 431.3 | 447.4 | 422.7 |
| post-tool Edit | 401.4 | 412.7 | 368.6 |
| user-prompt (nudge) | 322.5 | 330.3 | 315.6 |
| stop (blocked) | 310.6 | 324.4 | 305.2 |
| session-end | 390.4 | 410.4 | 383.4 |
| statusline | 315.7 | 330.8 | 307.6 |
| status <slug> (full CLI, plain) | 304.3 | 320.2 | 295.5 |

## i1000-1mb — 1000 initiatives, bound log 1.0 MB (3595 lines), 3.5 MB total
| command | p50 ms | p95 ms | min ms |
| --- | ---: | ---: | ---: |
| session-start (index warm) | 130.9 | 138.6 | 126.5 |
| session-start (index cold) | 213.2 | 238.2 | 200.2 |
| post-tool Edit | 85.0 | 96.0 | 82.4 |
| user-prompt (nudge) | 77.3 | 86.3 | 75.6 |
| stop (blocked) | 63.2 | 66.9 | 61.0 |
| session-end | 83.3 | 87.7 | 76.4 |
| statusline | 63.1 | 67.9 | 60.6 |
| status <slug> (full CLI, plain) | 77.8 | 81.9 | 73.4 |

## i1000-10mb — 1000 initiatives, bound log 10.0 MB (35903 lines), 12.5 MB total
| command | p50 ms | p95 ms | min ms |
| --- | ---: | ---: | ---: |
| session-start (index warm) | 373.3 | 396.4 | 362.9 |
| session-start (index cold) | 556.7 | 572.8 | 541.1 |
| post-tool Edit | 377.3 | 385.4 | 374.4 |
| user-prompt (nudge) | 331.5 | 345.0 | 308.0 |
| stop (blocked) | 317.0 | 321.9 | 294.2 |
| session-end | 417.9 | 460.9 | 390.7 |
| statusline | 341.1 | 391.0 | 307.9 |
| status <slug> (full CLI, plain) | 313.9 | 335.2 | 303.2 |

## repo — 55 initiatives, bound log 0.6 MB (789 lines), 7.6 MB total
| command | p50 ms | p95 ms | min ms |
| --- | ---: | ---: | ---: |
| session-start (index warm) | 75.1 | 77.6 | 73.3 |
| session-start (index cold) | 140.6 | 143.9 | 137.4 |
| post-tool Edit | 63.1 | 65.5 | 60.6 |
| user-prompt (nudge) | 53.1 | 66.5 | 50.5 |
| stop (blocked) | 39.4 | 43.0 | 36.7 |
| session-end | 56.1 | 60.0 | 53.8 |
| statusline | 42.0 | 43.6 | 39.9 |
| status <slug> (full CLI, plain) | 63.6 | 66.8 | 59.1 |

## floor — a root with no record
| command | p50 ms | p95 ms | min ms |
| --- | ---: | ---: | ---: |
| session-start (no record) | 31.6 | 33.7 | 30.7 |

## in-process (TypeScript reference only; carried over from the 0.32.0 as-shipped record — 2.7 left foldLog and renderStatus unchanged): fold of the bound log, digest render of the folded state
| cell | fold p50 ms | fold p95 ms | render p50 ms | render p95 ms |
| --- | ---: | ---: | ---: | ---: |
| i10-1mb | 13.3 | 17.2 | 0.2 | 0.3 |
| i10-10mb | 211.6 | 222.1 | 0.4 | 0.5 |
| i100-1mb | 12.6 | 13.7 | 0.1 | 0.2 |
| i100-10mb | 220.2 | 233.9 | 0.5 | 0.6 |
| i1000-1mb | 13.1 | 14.2 | 0.2 | 0.3 |
| i1000-10mb | 226.5 | 239.3 | 0.4 | 0.5 |
| repo | 2.3 | 3.2 | 0.2 | 0.8 |

