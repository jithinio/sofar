/**
 * The `sofar` bin entry (speed-2 T1/T3) — a stub, deliberately tiny.
 *
 * Two jobs, both of which only work from a module that loads BEFORE the bulk
 * of the code:
 *
 * 1. Enable the on-disk V8 compile cache. `module.enableCompileCache()` caches
 *    modules compiled AFTER the call, so calling it from inside the big bundle
 *    would cache nothing that matters — it has to be its own module, imported
 *    first. Node ≥22.8 only; older runtimes (package engines allow 18) simply
 *    skip it, and a read-only or full cache dir is not an error worth failing a
 *    hook over. Measured ~17% off every spawn.
 *
 * 2. Route to the hot path. `sofar event <hook>` and `sofar statusline` run on
 *    every matched tool use and every status-bar render; everything else runs
 *    at human frequency. The dynamic imports below are marked external at build
 *    time so they stay two separate bundles — the hook path never parses the
 *    MCP SDK, chokidar, commander, cloud, doctor or upgrade.
 *
 * The stub must stay dependency-free: anything imported here is paid for by
 * BOTH paths.
 */

// Top-level await requires this file to be a module; it has no static imports
// by design (anything imported here is paid for by BOTH paths).
export {}

// Marked external in build.mjs so esbuild emits these as runtime imports of
// the sibling bundles instead of inlining them back into one file.
const FAST = './fast.js'
const FULL = './full.js'

try {
  const { enableCompileCache } = (await import('node:module')) as {
    enableCompileCache?: () => unknown
  }
  enableCompileCache?.()
} catch {
  // No compile cache on this runtime, or the cache dir is not writable.
  // Purely an optimization — never let it break a command.
}

const command = process.argv[2]
if (command === 'event' || command === 'statusline') {
  const { runFast } = (await import(FAST)) as { runFast: (argv: readonly string[]) => Promise<boolean> }
  // runFast returns false for shapes it does not own (e.g. `event append`,
  // an unknown flag) — those fall through to the full CLI unchanged.
  if (await runFast(process.argv)) {
    // Handled. Nothing else to load.
  } else {
    await import(FULL)
  }
} else {
  await import(FULL)
}
