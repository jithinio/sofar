#!/usr/bin/env node
/**
 * rust-core 2.1 — step 1 of the schema codegen pipeline (rust-core D1, D9).
 *
 *   packages/schema/src/events.ts  ──(this)──▶  crates/sofar-schema/schema/events.schema.json
 *                                  ──(cargo xtask schema)──▶  crates/sofar-schema/src/generated.rs
 *
 * Emits a JSON Schema (draft-07) for `KnownEventPayloads` and every type it
 * reaches: the twenty payload interfaces, their nested objects (PlanStructure,
 * TaskRoute, RunSurface) and the string-literal enums. Rooting at the
 * registry means a payload added to KnownEventPayloads flows into Rust with
 * no list to maintain here.
 *
 * ts-json-schema-generator is pinned to 2.9.0 and brings its own TypeScript
 * 5.9 (TypeScript 7 has no stable programmatic API — D9), so this never
 * touches the workspace's compiler.
 *
 *   node tools/schema-codegen/emit.mjs            # write the schema
 *   node tools/schema-codegen/emit.mjs --check    # exit 1 if the committed file is stale
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createGenerator } from 'ts-json-schema-generator'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
export const OUT = join(root, 'crates', 'sofar-schema', 'schema', 'events.schema.json')

export function emit() {
  const config = {
    path: join(root, 'packages', 'schema', 'src', 'events.ts'),
    tsconfig: join(root, 'packages', 'schema', 'tsconfig.json'),
    type: 'KnownEventPayloads',
    expose: 'export',
    jsDoc: 'extended',
    topRef: true,
    // The TypeScript validators never reject unknown keys, and the fold must
    // read logs written by newer engines — so neither may the Rust types.
    additionalProperties: true,
    sortProps: true,
    skipTypeCheck: true,
  }
  const schema = createGenerator(config).createSchema(config.type)
  return `${JSON.stringify(schema, null, 2)}\n`
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const text = emit()
  if (process.argv.includes('--check')) {
    let current = null
    try {
      current = readFileSync(OUT, 'utf8')
    } catch {}
    if (current !== text) {
      console.error(`stale: ${OUT} does not match packages/schema/src — run \`npm run schema:emit\``)
      process.exit(1)
    }
    console.log(`fresh: ${OUT}`)
  } else {
    mkdirSync(dirname(OUT), { recursive: true })
    writeFileSync(OUT, text)
    console.log(`wrote ${OUT}`)
  }
}
