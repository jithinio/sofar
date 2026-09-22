perf baseline [rust-core 3.3 gate reference, re-recorded in the same sitting as the candidate (D12) from this tree at 065e5f7 (engine includes r1-fixes 2.5/2.7/5.1/5.2)] — typescript (node dist/cli.js (built from source as build.mjs ships it)) · 20 spawns per cell · Apple M4 Pro, node v24.15.0 · commit 065e5f7
node spawn floor: p50 21.0 ms · p95 22.0 ms · load avg 2.51 → 8.45

## i10-1mb — 10 initiatives, bound log 1.0 MB (3595 lines), 1.0 MB total
| command | p50 ms | p95 ms | min ms |
| --- | ---: | ---: | ---: |
| session-start (index warm) | 68.5 | 72.1 | 66.7 |
| session-start (index cold) | 83.7 | 86.5 | 81.4 |
| post-tool Edit | 76.3 | 78.5 | 73.5 |
| user-prompt (nudge) | 57.8 | 62.3 | 55.0 |
| stop (blocked) | 56.6 | 59.3 | 53.5 |
| session-end | 74.3 | 78.3 | 71.9 |
| statusline | 56.3 | 59.1 | 54.5 |
| status <slug> (full CLI, plain) | 79.3 | 83.2 | 77.4 |

## i10-10mb — 10 initiatives, bound log 10.0 MB (35903 lines), 10.0 MB total
| command | p50 ms | p95 ms | min ms |
| --- | ---: | ---: | ---: |
| session-start (index warm) | 306.3 | 312.6 | 301.7 |
| session-start (index cold) | 424.1 | 432.0 | 418.4 |
| post-tool Edit | 401.6 | 417.4 | 375.2 |
| user-prompt (nudge) | 324.6 | 379.8 | 295.3 |
| stop (blocked) | 335.7 | 375.9 | 301.4 |
| session-end | 418.7 | 456.5 | 394.4 |
| statusline | 336.5 | 438.8 | 301.1 |
| status <slug> (full CLI, plain) | 341.9 | 562.5 | 313.7 |

## i100-1mb — 100 initiatives, bound log 1.0 MB (3595 lines), 1.3 MB total
| command | p50 ms | p95 ms | min ms |
| --- | ---: | ---: | ---: |
| session-start (index warm) | 82.8 | 153.6 | 75.4 |
| session-start (index cold) | 105.3 | 160.1 | 96.1 |
| post-tool Edit | 87.2 | 109.1 | 81.8 |
| user-prompt (nudge) | 62.8 | 67.0 | 60.5 |
| stop (blocked) | 60.2 | 62.4 | 58.8 |
| session-end | 83.5 | 93.4 | 78.8 |
| statusline | 62.0 | 78.7 | 59.9 |
| status <slug> (full CLI, plain) | 87.8 | 123.4 | 83.1 |

## i100-10mb — 100 initiatives, bound log 10.0 MB (35903 lines), 10.3 MB total
| command | p50 ms | p95 ms | min ms |
| --- | ---: | ---: | ---: |
| session-start (index warm) | 340.8 | 437.6 | 324.5 |
| session-start (index cold) | 467.9 | 559.7 | 451.9 |
| post-tool Edit | 428.8 | 497.2 | 400.6 |
| user-prompt (nudge) | 349.0 | 416.4 | 331.5 |
| stop (blocked) | 351.8 | 460.4 | 305.9 |
| session-end | 474.8 | 724.3 | 434.2 |
| statusline | 347.4 | 441.1 | 312.2 |
| status <slug> (full CLI, plain) | 341.9 | 430.2 | 322.4 |

## i1000-1mb — 1000 initiatives, bound log 1.0 MB (3595 lines), 3.5 MB total
| command | p50 ms | p95 ms | min ms |
| --- | ---: | ---: | ---: |
| session-start (index warm) | 351.6 | 563.2 | 184.6 |
| session-start (index cold) | 411.9 | 940.7 | 237.8 |
| post-tool Edit | 105.1 | 123.9 | 97.9 |
| user-prompt (nudge) | 83.8 | 151.2 | 73.1 |
| stop (blocked) | 71.3 | 122.0 | 65.3 |
| session-end | 103.7 | 209.9 | 90.1 |
| statusline | 71.5 | 114.7 | 65.2 |
| status <slug> (full CLI, plain) | 89.5 | 135.0 | 86.2 |

## i1000-10mb — 1000 initiatives, bound log 10.0 MB (35903 lines), 12.5 MB total
| command | p50 ms | p95 ms | min ms |
| --- | ---: | ---: | ---: |
| session-start (index warm) | 428.6 | 473.3 | 398.0 |
| session-start (index cold) | 642.5 | 707.4 | 594.8 |
| post-tool Edit | 420.3 | 447.4 | 398.6 |
| user-prompt (nudge) | 347.3 | 362.8 | 333.1 |
| stop (blocked) | 333.9 | 340.0 | 308.8 |
| session-end | 410.0 | 421.4 | 380.9 |
| statusline | 335.7 | 340.1 | 329.1 |
| status <slug> (full CLI, plain) | 312.8 | 327.6 | 308.4 |

## repo — 55 initiatives, bound log 0.6 MB (789 lines), 7.6 MB total
| command | p50 ms | p95 ms | min ms |
| --- | ---: | ---: | ---: |
| session-start (index warm) | 69.2 | 73.4 | 67.5 |
| session-start (index cold) | 130.7 | 137.7 | 127.5 |
| post-tool Edit | 55.0 | 57.4 | 53.3 |
| user-prompt (nudge) | 43.8 | 45.1 | 42.6 |
| stop (blocked) | 38.5 | 40.1 | 37.2 |
| session-end | 51.1 | 52.6 | 49.4 |
| statusline | 39.7 | 41.3 | 38.1 |
| status <slug> (full CLI, plain) | 62.0 | 64.2 | 61.1 |

## floor — a root with no record
| command | p50 ms | p95 ms | min ms |
| --- | ---: | ---: | ---: |
| session-start (no record) | 30.2 | 32.6 | 29.1 |

## in-process (TypeScript reference only): fold of the bound log, digest render of the folded state
| cell | fold p50 ms | fold p95 ms | render p50 ms | render p95 ms |
| --- | ---: | ---: | ---: | ---: |
| i10-1mb | 13.3 | 18.1 | 0.2 | 0.3 |
| i10-10mb | 260.5 | 359.7 | 0.3 | 0.5 |
| i100-1mb | 12.7 | 17.1 | 0.2 | 0.2 |
| i100-10mb | 249.1 | 278.0 | 0.3 | 0.6 |
| i1000-1mb | 15.7 | 24.1 | 0.2 | 0.3 |
| i1000-10mb | 215.2 | 230.5 | 0.3 | 0.4 |
| repo | 2.4 | 3.0 | 0.1 | 0.2 |

