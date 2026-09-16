perf baseline [r1-fixes RC 179b8fd (engine src identical), merged at daea704] — typescript (node dist/cli.js (built from source as build.mjs ships it)) · 20 spawns per cell · Apple M4 Pro, node v24.15.0 · commit daea704
node spawn floor: p50 20.8 ms · p95 22.6 ms · load avg 3.42 → 4.28

## i10-1mb — 10 initiatives, bound log 1.0 MB (3595 lines), 1.0 MB total
| command | p50 ms | p95 ms | min ms |
| --- | ---: | ---: | ---: |
| session-start (index warm) | 66.5 | 70.9 | 62.5 |
| session-start (index cold) | 81.2 | 86.2 | 76.8 |
| post-tool Edit | 71.6 | 79.3 | 70.0 |
| user-prompt (nudge) | 60.4 | 66.2 | 57.3 |
| stop (blocked) | 54.9 | 58.5 | 52.3 |
| session-end | 70.9 | 71.7 | 69.5 |
| statusline | 53.7 | 55.3 | 52.5 |
| status <slug> (full CLI, plain) | 76.1 | 77.9 | 74.9 |

## i10-10mb — 10 initiatives, bound log 10.0 MB (35903 lines), 10.0 MB total
| command | p50 ms | p95 ms | min ms |
| --- | ---: | ---: | ---: |
| session-start (index warm) | 315.1 | 329.7 | 302.0 |
| session-start (index cold) | 420.1 | 430.9 | 411.1 |
| post-tool Edit | 392.1 | 409.7 | 368.3 |
| user-prompt (nudge) | 327.2 | 342.4 | 296.7 |
| stop (blocked) | 317.1 | 325.5 | 290.6 |
| session-end | 393.8 | 433.2 | 365.6 |
| statusline | 323.7 | 343.2 | 293.5 |
| status <slug> (full CLI, plain) | 302.7 | 308.6 | 297.0 |

## i100-1mb — 100 initiatives, bound log 1.0 MB (3595 lines), 1.3 MB total
| command | p50 ms | p95 ms | min ms |
| --- | ---: | ---: | ---: |
| session-start (index warm) | 84.1 | 87.4 | 76.7 |
| session-start (index cold) | 105.5 | 114.2 | 99.3 |
| post-tool Edit | 78.5 | 84.5 | 73.9 |
| user-prompt (nudge) | 67.5 | 79.1 | 61.8 |
| stop (blocked) | 61.8 | 64.2 | 59.4 |
| session-end | 79.8 | 82.5 | 77.5 |
| statusline | 59.7 | 65.8 | 55.6 |
| status <slug> (full CLI, plain) | 82.3 | 87.7 | 77.9 |

## i100-10mb — 100 initiatives, bound log 10.0 MB (35903 lines), 10.3 MB total
| command | p50 ms | p95 ms | min ms |
| --- | ---: | ---: | ---: |
| session-start (index warm) | 326.5 | 342.4 | 311.9 |
| session-start (index cold) | 460.1 | 480.7 | 437.9 |
| post-tool Edit | 411.1 | 431.4 | 376.6 |
| user-prompt (nudge) | 342.2 | 356.2 | 311.1 |
| stop (blocked) | 325.8 | 341.3 | 296.1 |
| session-end | 407.2 | 425.3 | 374.4 |
| statusline | 335.6 | 346.5 | 312.1 |
| status <slug> (full CLI, plain) | 317.6 | 327.5 | 300.8 |

## i1000-1mb — 1000 initiatives, bound log 1.0 MB (3595 lines), 3.5 MB total
| command | p50 ms | p95 ms | min ms |
| --- | ---: | ---: | ---: |
| session-start (index warm) | 133.9 | 148.3 | 127.8 |
| session-start (index cold) | 208.0 | 214.6 | 204.2 |
| post-tool Edit | 89.8 | 97.8 | 81.2 |
| user-prompt (nudge) | 79.1 | 81.6 | 72.7 |
| stop (blocked) | 63.0 | 68.2 | 59.7 |
| session-end | 79.7 | 88.2 | 76.2 |
| statusline | 64.0 | 67.3 | 59.6 |
| status <slug> (full CLI, plain) | 87.4 | 92.9 | 79.5 |

## i1000-10mb — 1000 initiatives, bound log 10.0 MB (35903 lines), 12.5 MB total
| command | p50 ms | p95 ms | min ms |
| --- | ---: | ---: | ---: |
| session-start (index warm) | 378.8 | 402.8 | 367.6 |
| session-start (index cold) | 559.0 | 581.6 | 545.3 |
| post-tool Edit | 400.8 | 417.1 | 389.3 |
| user-prompt (nudge) | 343.3 | 348.5 | 319.8 |
| stop (blocked) | 335.3 | 344.2 | 307.9 |
| session-end | 403.0 | 409.5 | 381.9 |
| statusline | 355.0 | 435.2 | 324.2 |
| status <slug> (full CLI, plain) | 314.6 | 460.7 | 298.3 |

## repo — 55 initiatives, bound log 0.6 MB (789 lines), 7.6 MB total
| command | p50 ms | p95 ms | min ms |
| --- | ---: | ---: | ---: |
| session-start (index warm) | 69.1 | 73.1 | 67.8 |
| session-start (index cold) | 130.8 | 134.6 | 128.9 |
| post-tool Edit | 57.3 | 59.9 | 55.9 |
| user-prompt (nudge) | 47.6 | 48.6 | 46.5 |
| stop (blocked) | 37.9 | 39.9 | 36.6 |
| session-end | 50.8 | 53.4 | 49.2 |
| statusline | 38.4 | 41.9 | 36.7 |
| status <slug> (full CLI, plain) | 61.7 | 63.7 | 60.6 |

## floor — a root with no record
| command | p50 ms | p95 ms | min ms |
| --- | ---: | ---: | ---: |
| session-start (no record) | 32.2 | 36.9 | 29.8 |

## in-process (TypeScript reference only): fold of the bound log, digest render of the folded state
| cell | fold p50 ms | fold p95 ms | render p50 ms | render p95 ms |
| --- | ---: | ---: | ---: | ---: |
| i10-1mb | 12.9 | 18.9 | 0.1 | 0.3 |
| i10-10mb | 231.4 | 263.9 | 0.3 | 0.8 |
| i100-1mb | 13.2 | 16.1 | 0.2 | 0.3 |
| i100-10mb | 229.6 | 247.4 | 0.3 | 0.4 |
| i1000-1mb | 13.0 | 17.2 | 0.2 | 0.3 |
| i1000-10mb | 228.8 | 244.9 | 0.3 | 0.4 |
| repo | 2.4 | 3.5 | 0.1 | 0.2 |

