import { build } from 'esbuild'
import { chmodSync } from 'node:fs'

// CJS deps bundled into ESM output need a require shim (esbuild emits
// "Dynamic require of ... is not supported" without it).
const banner = [
  '#!/usr/bin/env node',
  'import { createRequire as __createRequire } from "node:module";',
  'const require = __createRequire(import.meta.url);',
].join('\n')

await build({
  entryPoints: ['src/cli/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  outfile: 'dist/cli.js',
  banner: { js: banner },
})

chmodSync('dist/cli.js', 0o755)
