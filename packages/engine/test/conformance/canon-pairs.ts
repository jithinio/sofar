import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { validateEnvelope } from '../../src/core/envelope'
import { serializeEvent } from '../../src/core/log'

/**
 * rust-core 2.2 — pairs for the Rust envelope cross-check
 * (`crates/sofar-core/tests/canonical_crosscheck.rs`). Walks every
 * `events.jsonl` under a directory and writes one `<line>\t<expected>` per
 * non-blank line, where expected is the TypeScript canonical serialization,
 * `UNPARSEABLE`, or `INVALID <detail>` — exactly what the Rust side must
 * produce for the same bytes.
 *
 *   npx esbuild packages/engine/test/conformance/canon-pairs.ts --bundle --platform=node --format=esm --outfile=/tmp/canon-pairs.mjs
 *   node /tmp/canon-pairs.mjs packages/engine/test/conformance/fixtures /tmp/canon-pairs.tsv
 *   SOFAR_CANON_PAIRS=/tmp/canon-pairs.tsv cargo test -p sofar-core --test canonical_crosscheck -- --ignored
 */
function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (name === 'events.jsonl') out.push(p)
  }
}

const [root, outFile] = process.argv.slice(2)
if (root === undefined || outFile === undefined) {
  console.error('usage: canon-pairs <fixtures-dir> <out.tsv>')
  process.exit(64)
}
const logs: string[] = []
walk(root, logs)
const lines: string[] = []
let valid = 0
let invalid = 0
let unparseable = 0
for (const log of logs) {
  for (const raw of readFileSync(log, 'utf8').split('\n')) {
    const line = raw.trim()
    if (line.length === 0) continue
    let decoded: unknown
    try {
      decoded = JSON.parse(line)
    } catch {
      unparseable++
      lines.push(`${line}\tUNPARSEABLE`)
      continue
    }
    const check = validateEnvelope(decoded)
    if (!check.ok) {
      invalid++
      lines.push(`${line}\tINVALID ${check.errors.map((e) => `${e.field}: ${e.message}`).join('; ')}`)
      continue
    }
    valid++
    lines.push(`${line}\t${serializeEvent(check.event)}`)
  }
}
writeFileSync(outFile, `${lines.join('\n')}\n`)
console.log(JSON.stringify({ logs: logs.length, valid, invalid, unparseable }))
