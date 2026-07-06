import { readFileSync } from 'node:fs'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [
    {
      // Mirror of esbuild's `loader: { '.sh': 'text' }` (packages/engine/
      // build.mjs): tests import engine src directly, so vitest must resolve
      // hook-shim .sh imports to the same default-exported string the
      // production bundle inlines.
      name: 'harness:sh-as-text',
      enforce: 'pre',
      load(id: string) {
        if (id.endsWith('.sh')) {
          return `export default ${JSON.stringify(readFileSync(id, 'utf8'))}\n`
        }
        return null
      },
    },
  ],
})
