import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { userConfigPath, type Env } from '../client/config'

/**
 * ~/.config/sofar/config.json — user-level CLI preference (auto-update 3.1).
 *
 * Its own module, not a section of update-check.ts, because BOTH update-check
 * (which acts on the flag) and upgrade (which pitches it) need to read it, and
 * putting it in either one makes the pair circular.
 *
 * Separate FILE from client/config.ts's credentials.json on purpose: a
 * credential rewrite must never be able to lose a preference, or vice versa.
 * Preference, not state — nothing here is required for sofar to work.
 */

export { userConfigPath, type Env }

/** Default false: auto-install is opt-in, and an unreadable config is not consent. */
export function readAutoUpgrade(env: Env = process.env): boolean {
  const path = userConfigPath(env)
  if (!existsSync(path)) return false
  try {
    const decoded = JSON.parse(readFileSync(path, 'utf8')) as { auto_upgrade?: unknown } | null
    return typeof decoded === 'object' && decoded !== null && decoded.auto_upgrade === true
  } catch {
    return false
  }
}

/** Merge-write the flag, preserving any other keys the file already carries. */
export function writeAutoUpgrade(enabled: boolean, env: Env = process.env): void {
  const path = userConfigPath(env)
  let existing: Record<string, unknown> = {}
  if (existsSync(path)) {
    try {
      const decoded = JSON.parse(readFileSync(path, 'utf8')) as unknown
      if (typeof decoded === 'object' && decoded !== null) existing = decoded as Record<string, unknown>
    } catch {
      // Unreadable config is rewritten rather than blocking an explicit opt-in.
    }
  }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(
    path,
    `${JSON.stringify({ ...existing, version: 1, auto_upgrade: enabled }, null, 2)}\n`,
    'utf8',
  )
}
