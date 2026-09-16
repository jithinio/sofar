import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { OUT, emit } from '../../../tools/schema-codegen/emit.mjs'

/**
 * rust-core 2.1 — the regen-diff half of the codegen pipeline that runs
 * under `npm test` (rust-core D1: Rust payload types are generated from this
 * package, never hand-written). Step 1 is checked in-process; step 2
 * (`cargo xtask schema --check`) runs when a cargo toolchain is present and
 * is skipped otherwise, so a JavaScript-only checkout still passes.
 */

const root = join(import.meta.dirname, '..', '..', '..')

describe('rust schema codegen (rust-core 2.1)', () => {
  it('crates/sofar-schema/schema/events.schema.json is what packages/schema/src emits', () => {
    expect(readFileSync(OUT, 'utf8')).toBe(emit())
  })

  it('every KnownEventPayloads member reaches the schema as a definition', () => {
    const schema = JSON.parse(emit()) as { definitions: Record<string, { properties?: Record<string, { $ref?: string }> }> }
    const registry = schema.definitions.KnownEventPayloads?.properties ?? {}
    expect(Object.keys(registry).length).toBe(20)
    for (const [type, ref] of Object.entries(registry)) {
      const name = ref.$ref?.replace('#/definitions/', '')
      expect(name, `${type} should reference a named payload type`).toMatch(/Payload$/)
      expect(schema.definitions[name!], `${name} missing`).toBeDefined()
    }
  })

  const cargo = spawnSync('cargo', ['--version'], { encoding: 'utf8' })
  it.skipIf(cargo.error !== undefined || cargo.status !== 0)(
    'crates/sofar-schema/src/generated.rs is what the schema generates (cargo xtask schema --check)',
    () => {
      const r = spawnSync('cargo', ['xtask', 'schema', '--check'], { cwd: root, encoding: 'utf8', timeout: 600_000 })
      expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0)
    },
  )
})
