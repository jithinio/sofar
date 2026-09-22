perf baseline [0.32.0 as-shipped (a79c4a7, before r1-fixes 2.7 removed the double fold on appending hooks)] — typescript (node dist/cli.js (built from source as build.mjs ships it)) · 20 spawns per cell · Apple M4 Pro, node v24.15.0
node spawn floor: p50 19.0 ms · p95 20.9 ms

## i10-1mb — 10 initiatives, bound log 1.0 MB (3595 lines), 1.0 MB total
| command | p50 ms | p95 ms | min ms |
| --- | ---: | ---: | ---: |
| session-start (index warm) | 64.3 | 70.2 | 62.8 |
| session-start (index cold) | 82.1 | 86.0 | 76.0 |
| post-tool Edit | 91.6 | 95.9 | 86.6 |
| user-prompt (nudge) | 60.7 | 66.5 | 57.5 |
| stop (blocked) | 54.9 | 59.2 | 52.3 |
| session-end | 93.4 | 113.7 | 89.3 |
| statusline | 58.7 | 60.0 | 56.5 |
| status <slug> (full CLI, plain) | 82.2 | 86.8 | 79.5 |

## i10-10mb — 10 initiatives, bound log 10.0 MB (35903 lines), 10.0 MB total
| command | p50 ms | p95 ms | min ms |
| --- | ---: | ---: | ---: |
| session-start (index warm) | 312.5 | 323.2 | 301.1 |
| session-start (index cold) | 429.8 | 443.0 | 419.9 |
| post-tool Edit | 610.2 | 625.6 | 600.9 |
| user-prompt (nudge) | 334.3 | 346.0 | 315.8 |
| stop (blocked) | 332.4 | 344.6 | 319.4 |
| session-end | 615.3 | 648.3 | 591.2 |
| statusline | 321.5 | 330.9 | 294.3 |
| status <slug> (full CLI, plain) | 309.8 | 322.9 | 296.4 |

## i100-1mb — 100 initiatives, bound log 1.0 MB (3595 lines), 1.3 MB total
| command | p50 ms | p95 ms | min ms |
| --- | ---: | ---: | ---: |
| session-start (index warm) | 79.2 | 83.3 | 76.2 |
| session-start (index cold) | 98.0 | 102.6 | 95.6 |
| post-tool Edit | 94.0 | 99.1 | 88.6 |
| user-prompt (nudge) | 66.3 | 77.5 | 63.4 |
| stop (blocked) | 58.0 | 62.3 | 56.7 |
| session-end | 89.8 | 96.0 | 86.8 |
| statusline | 57.1 | 59.3 | 55.6 |
| status <slug> (full CLI, plain) | 80.4 | 83.0 | 78.8 |

## i100-10mb — 100 initiatives, bound log 10.0 MB (35903 lines), 10.3 MB total
| command | p50 ms | p95 ms | min ms |
| --- | ---: | ---: | ---: |
| session-start (index warm) | 311.6 | 317.7 | 307.8 |
| session-start (index cold) | 454.1 | 488.1 | 436.7 |
| post-tool Edit | 603.8 | 660.8 | 597.1 |
| user-prompt (nudge) | 370.7 | 416.9 | 327.2 |
| stop (blocked) | 328.2 | 364.4 | 322.4 |
| session-end | 609.9 | 624.2 | 597.4 |
| statusline | 324.2 | 333.2 | 297.7 |
| status <slug> (full CLI, plain) | 309.9 | 328.0 | 302.9 |

## i1000-1mb — 1000 initiatives, bound log 1.0 MB (3595 lines), 3.5 MB total
| command | p50 ms | p95 ms | min ms |
| --- | ---: | ---: | ---: |
| session-start (index warm) | 132.1 | 139.3 | 127.8 |
| session-start (index cold) | 207.7 | 212.1 | 206.6 |
| post-tool Edit | 97.5 | 99.3 | 96.1 |
| user-prompt (nudge) | 72.2 | 76.5 | 71.0 |
| stop (blocked) | 61.0 | 62.7 | 58.5 |
| session-end | 98.9 | 112.9 | 90.8 |
| statusline | 64.4 | 69.1 | 63.1 |
| status <slug> (full CLI, plain) | 84.8 | 87.0 | 79.1 |

## i1000-10mb — 1000 initiatives, bound log 10.0 MB (35903 lines), 12.5 MB total
| command | p50 ms | p95 ms | min ms |
| --- | ---: | ---: | ---: |
| session-start (index warm) | 371.6 | 386.2 | 360.6 |
| session-start (index cold) | 564.5 | 589.2 | 552.1 |
| post-tool Edit | 621.0 | 646.3 | 599.0 |
| user-prompt (nudge) | 352.4 | 365.5 | 327.8 |
| stop (blocked) | 329.4 | 336.3 | 323.2 |
| session-end | 616.0 | 639.9 | 592.3 |
| statusline | 332.3 | 344.4 | 312.6 |
| status <slug> (full CLI, plain) | 314.5 | 333.0 | 303.2 |

## repo — 55 initiatives, bound log 0.6 MB (789 lines), 7.6 MB total
| command | p50 ms | p95 ms | min ms |
| --- | ---: | ---: | ---: |
| session-start (index warm) | 63.6 | 68.2 | 62.2 |
| session-start (index cold) | 125.7 | 135.7 | 120.9 |
| post-tool Edit | 56.2 | 59.3 | 54.7 |
| user-prompt (nudge) | 41.1 | 44.2 | 40.0 |
| stop (blocked) | 34.9 | 38.9 | 33.5 |
| session-end | 49.8 | 51.6 | 48.0 |
| statusline | 36.2 | 37.7 | 33.9 |
| status <slug> (full CLI, plain) | 57.4 | 62.1 | 56.3 |

## floor — a root with no record
| command | p50 ms | p95 ms | min ms |
| --- | ---: | ---: | ---: |
| session-start (no record) | 27.1 | 28.0 | 25.8 |

## in-process (TypeScript reference only): fold of the bound log, digest render of the folded state
| cell | fold p50 ms | fold p95 ms | render p50 ms | render p95 ms |
| --- | ---: | ---: | ---: | ---: |
| i10-1mb | 13.3 | 17.2 | 0.2 | 0.3 |
| i10-10mb | 211.6 | 222.1 | 0.4 | 0.5 |
| i100-1mb | 12.6 | 13.7 | 0.1 | 0.2 |
| i100-10mb | 220.2 | 233.9 | 0.5 | 0.6 |
| i1000-1mb | 13.1 | 14.2 | 0.2 | 0.3 |
| i1000-10mb | 226.5 | 239.3 | 0.4 | 0.5 |
| repo | 2.3 | 3.2 | 0.2 | 0.8 |

