import { readFileSync } from 'node:fs'

/**
 * The Codex contract fixtures (agents-parity 1.1) and the validator that holds
 * a payload or an output to the hook schemas codex 0.154.0 embeds. Shared by
 * codex-contract.test.ts, which pins the fixtures, and every later suite that
 * builds on them (D4): a shape is tested against these files, never against
 * one written from memory.
 */

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
export type Obj = { [key: string]: Json }

export function codexFixture<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(`../fixtures/codex/${name}`, import.meta.url), 'utf8')) as T
}

export const SCHEMAS = codexFixture<Record<string, Obj>>('hook-schemas.codex-0.154.0.json')
export const PAYLOADS = codexFixture<Record<string, { schema: string; payload: Obj }>>(
  'hook-payloads.codex-0.154.0.json',
)
export const CONTRACT = codexFixture<Obj>('contract.codex-0.154.0.json')

export const isObj = (v: Json | undefined): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

function typeOf(value: Json): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value === 'number' ? 'number' : typeof value
}

/**
 * The draft-07 subset Codex's generated hook schemas use: type, const, enum,
 * required, additionalProperties false, $ref into definitions, allOf, and the
 * boolean `true` schema. Anything else in a schema is a new construct, and
 * failing on it beats silently accepting a payload.
 */
function validate(schema: Json, value: Json, root: Obj, path = '$'): string[] {
  if (schema === true) return []
  if (!isObj(schema)) return [`${path}: unsupported schema ${JSON.stringify(schema)}`]
  const errors: string[] = []
  for (const key of Object.keys(schema)) {
    const known = ['$schema', 'title', 'description', 'default', 'definitions', 'type', 'const', 'enum', 'required', 'additionalProperties', 'properties', '$ref', 'allOf']
    if (!known.includes(key)) errors.push(`${path}: unsupported keyword ${key}`)
  }
  if (typeof schema.$ref === 'string') {
    const name = schema.$ref.replace('#/definitions/', '')
    const definitions = root.definitions
    const target = isObj(definitions) ? definitions[name] : undefined
    if (target === undefined) return [`${path}: unresolved ${schema.$ref}`]
    errors.push(...validate(target, value, root, path))
  }
  if (Array.isArray(schema.allOf)) {
    // Every allOf in these schemas wraps a nullable $ref next to `default: null`.
    if (value !== null) for (const part of schema.allOf) errors.push(...validate(part, value, root, path))
  }
  if (schema.type !== undefined) {
    const allowed = Array.isArray(schema.type) ? schema.type : [schema.type]
    const actual = typeOf(value)
    const ok = allowed.some((t) => t === actual || (t === 'integer' && Number.isInteger(value)))
    if (!ok) errors.push(`${path}: ${actual} is not ${allowed.join('|')}`)
  }
  if (schema.const !== undefined && value !== schema.const) errors.push(`${path}: not ${JSON.stringify(schema.const)}`)
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) errors.push(`${path}: ${JSON.stringify(value)} not in enum`)
  if (isObj(value)) {
    const properties = isObj(schema.properties) ? schema.properties : {}
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (typeof key === 'string' && !(key in value)) errors.push(`${path}: missing ${key}`)
      }
    }
    for (const [key, child] of Object.entries(value)) {
      const sub = properties[key]
      if (sub === undefined) {
        if (schema.additionalProperties === false) errors.push(`${path}: unexpected ${key}`)
        continue
      }
      errors.push(...validate(sub, child, root, `${path}.${key}`))
    }
  }
  return errors
}

/** Errors holding `value` to the embedded schema titled `title`; empty when it conforms. */
export function checkSchema(title: string, value: Json): string[] {
  const schema = SCHEMAS[title]
  if (schema === undefined) return [`no schema ${title}`]
  return validate(schema, value, schema)
}
