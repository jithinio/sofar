import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineConfig, type Plugin } from 'vitest/config'

// Per-clone state (diagnostics store, sync cursors, update check) resolves
// from XDG_STATE_HOME, and every temp clone a test creates hashes to a NEW
// dir there. Without this, hook and CLI tests leave one dir per fixture clone
// in the developer's real ~/.local/state/sofar (1,100 found 2026-09-15). A
// test that needs a specific state dir still stubs its own.
const testState = { XDG_STATE_HOME: mkdtempSync(join(tmpdir(), 'sofar-vitest-state-')) }

// Mirror of esbuild's `loader: { '.sh': 'text' }` (packages/engine/
// build.mjs): tests import engine src directly, so vitest must resolve
// hook-shim .sh imports to the same default-exported string the
// production bundle inlines.
function shAsText(): Plugin {
  return {
    name: 'sofar:sh-as-text',
    enforce: 'pre',
    load(id: string) {
      if (id.endsWith('.sh')) {
        return `export default ${JSON.stringify(readFileSync(id, 'utf8'))}\n`
      }
      return null
    },
  }
}

export default defineConfig({
  plugins: [shAsText()],
  test: {
    // Two sequential groups (sequence.groupOrder): the latency pin (speed
    // T2) measures wall-clock of spawned shims, so it must run AFTER the
    // parallel suite has released the cores — inside the saturated window
    // the measurements are scheduler noise, not shim behavior.
    projects: [
      {
        plugins: [shAsText()],
        test: {
          name: 'unit',
          env: testState,
          sequence: { groupOrder: 0 },
          exclude: [
            '**/node_modules/**',
            'packages/engine/test/shim-latency.test.ts',
            'packages/engine/test/conformance/perf/**',
          ],
        },
      },
      {
        plugins: [shAsText()],
        test: {
          name: 'latency',
          env: testState,
          sequence: { groupOrder: 1 },
          include: ['packages/engine/test/shim-latency.test.ts'],
          fileParallelism: false,
        },
      },
      // The perf baseline (rust-core 1.3) spawns ~1,200 processes and
      // generates 30 MB of records; it is skipped unless SOFAR_PERF=1
      // (`npm run perf`), and runs alone so no other worker competes for
      // the cores it is timing.
      {
        plugins: [shAsText()],
        test: {
          name: 'perf',
          sequence: { groupOrder: 2 },
          include: ['packages/engine/test/conformance/perf/perf.test.ts'],
          fileParallelism: false,
          // The full team100 cell interleaved at n = 25 (rust-core 1.5) runs
          // ~35 min on its own: ~4.6 s per TypeScript spawn on a 95.6 MB log.
          testTimeout: 3_600_000,
          hookTimeout: 600_000,
        },
      },
    ],
  },
})
