session-start arms (rust-core 1.5 turn 3), recorded 2026-09-22 at 157dc88 on an Apple M4 Pro, AC power, under `caffeinate -ims`, load 4.3 to 6.5.

Three builds of the core are interleaved, and the arm order rotates every iteration (D12). n = 25 per arm, spawned as the harness spawns them. The cells are the harness's corpus cells built by `corpus.ts`, primed with 5 drift edits and one session-start. Warm reuses the index. Cold deletes `.sofar/.index/` before every spawn.

- `pre`: 8bad310, the core after turn 1 (FileIndex plus the guard borrow)
- `parse`: 1a95096, where JSON objects parse in linear time
- `index`: 157dc88, where the tier-1 index builds in linear time (the reducer's path index, and no duplicate scan on write)

## team100 (bound log 95.6 MB, 345 MB in all)

| arm | warm p50 ms | warm p95 | cold p50 ms | cold p95 |
| --- | ---: | ---: | ---: | ---: |
| pre | 3,242 | 3,394 | 6,907 | 7,461 |
| parse | 1,270 (0.39×) | 1,388 | 6,799 (0.98×) | 8,524 |
| index | 1,269 (0.39×) | 1,400 | 2,768 (0.40×) | 2,942 |

## team100-w100 (bound log 19.2 MB, 69.5 MB in all)

| arm | warm p50 ms | warm p95 | cold p50 ms | cold p95 |
| --- | ---: | ---: | ---: | ---: |
| pre | 334 | 347 | 715 | 763 |
| parse | 246 (0.74×) | 251 | 715 (1.00×) | 755 |
| index | 248 (0.74×) | 257 | 554 (0.77×) | 584 |

Each prediction was written before its build (rust-core notes 01M3427S and 01M342G2):

- parse, warm at team100: ~3.3 s to ~1.3 s. Measured 3.24 to 1.27 s.
- parse, cold: unchanged, because a cold start has no prior index to parse. Measured 0.98× and 1.00×.
- index, cold at team100: ~7.0 s to ~4.0 s. Measured 6.9 to 2.8 s, better than predicted.
- index, warm: unchanged. Measured 1.00× of parse.
- At 19 MB: warm ~0.85× and cold ~0.9× were predicted. Measured 0.74× and 0.77×.

Against the TypeScript engine with r1-fixes 4.5 (`hasfile.6ee2782-vs-5027480.typescript.md`, same cells, earlier the same day), team100's warm session-start is 2,201 ms and cold 5,766 ms. The core at 8bad310 trailed on warm (3,242 ms). At 157dc88 it leads on both: 1,269 ms warm and 2,768 ms cold. Those two numbers come from separate sittings, not one interleaved run.
