import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { chmodSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'

// CJS deps bundled into ESM output need a require shim (esbuild emits
// "Dynamic require of ... is not supported" without it).
const requireShim = [
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
  banner: { js: `#!/usr/bin/env node\n${requireShim}` },
  // Hook shim sources ship INSIDE the bundle as text — only dist/ is
  // published, so `sofar init` can never read src/hooks/ at runtime.
  loader: { '.sh': 'text' },
})

chmodSync('dist/cli.js', 0o755)

// ---------------------------------------------------------------------------
// Library surface (library-surface 1.2, L1/L2): "@alignlabs/sofar/schema" and
// "@alignlabs/sofar/engine" — self-contained ESM bundles, no shebang, never
// executable. Side-effect-free entry modules; the CLI bundle is untouched.
// ---------------------------------------------------------------------------

await build({
  entryPoints: ['src/lib/schema.ts', 'src/lib/engine.ts', 'src/lib/client.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  outdir: 'dist',
  banner: { js: requireShim },
})

// Declaration emit (L2): tsc writes d.ts for the lib entry closure — engine
// sources under dist/types/engine/, the @sofar/schema sources under
// dist/types/schema/ (rootDir spans packages/). The workspace package is
// PRIVATE by design (D13), so emitted `from '@sofar/schema'` specifiers
// would dangle for consumers — rewrite them to the emitted relative paths,
// making the published d.ts tree self-contained.
rmSync('dist/types', { recursive: true, force: true })
execFileSync(join('..', '..', 'node_modules', '.bin', 'tsc'), ['-p', 'tsconfig.declarations.json'], {
  stdio: 'inherit',
})

const SCHEMA_TARGETS = {
  '@sofar/schema/tool-inputs': join('dist', 'types', 'schema', 'src', 'tool-inputs'),
  '@sofar/schema': join('dist', 'types', 'schema', 'src', 'events'),
}

function dtsFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return dtsFiles(path)
    return entry.name.endsWith('.d.ts') ? [path] : []
  })
}

for (const file of dtsFiles(join('dist', 'types'))) {
  const source = readFileSync(file, 'utf8')
  let next = source
  for (const [specifier, emitted] of Object.entries(SCHEMA_TARGETS)) {
    // relative() may return a bare sibling name — d.ts specifiers must be ./-prefixed.
    let rel = relative(dirname(file), emitted).replaceAll('\\', '/')
    if (!rel.startsWith('.')) rel = `./${rel}`
    next = next.replaceAll(`'${specifier}'`, `'${rel}.js'`).replaceAll(`"${specifier}"`, `"${rel}.js"`)
  }
  if (next !== source) writeFileSync(file, next)
}
