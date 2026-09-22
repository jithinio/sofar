import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineConfig, type Plugin } from 'vitest/config'

// Per-clone state (diagnostics store, sync cursors, update check) resolves
// from XDG_STATE_HOME, and every temp clone a test creates hashes to a NEW
// dir there. Without this, hook and CLI tests leave one dir per fixture clone
// in the developer's real ~/.local/state/sofar (1,100 found 2026-09-15). A
// test that needs a specific state dir still stubs its own.
//
// XDG_CONFIG_HOME for the same reason, the other way round: a driver reads
// the developer's real ~/.config/sofar/config.json (drive.keep_awake, D5),
// so a test run would start caffeinate or not depending on whose Mac ran it.
const testState = {
  XDG_STATE_HOME: mkdtempSync(join(tmpdir(), 'sofar-vitest-state-')),
  XDG_CONFIG_HOME: mkdtempSync(join(tmpdir(), 'sofar-vitest-config-')),
}

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
          exclude: ['**/node_modules/**', 'packages/engine/test/shim-latency.test.ts'],
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
    ],
  },
})
