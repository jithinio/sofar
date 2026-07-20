import { readFileSync } from 'node:fs'
import { defineConfig, type Plugin } from 'vitest/config'

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
          sequence: { groupOrder: 0 },
          exclude: ['**/node_modules/**', 'packages/engine/test/shim-latency.test.ts'],
        },
      },
      {
        plugins: [shAsText()],
        test: {
          name: 'latency',
          sequence: { groupOrder: 1 },
          include: ['packages/engine/test/shim-latency.test.ts'],
          fileParallelism: false,
        },
      },
    ],
  },
})
