#!/usr/bin/env node
// `npm run schema:emit` (r1-fixes 5.1, D22): write the exact string a fold
// snapshot's schema hash is taken over to packages/schema/schema-fingerprint.txt,
// so a second implementation hashes the committed bytes. Reads the built
// schema entry, so run `npm run build` first. A test pins the committed file
// to the live string; this script is how it is refreshed after a schema change.
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const { schemaFingerprint } = await import(join(here, '..', '..', 'engine', 'dist', 'schema.js'))
const out = join(here, '..', 'schema-fingerprint.txt')
writeFileSync(out, schemaFingerprint())
console.log(`wrote ${out}`)
