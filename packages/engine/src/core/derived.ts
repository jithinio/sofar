/**
 * Derived activity (r1-fixes 2.5, D24): the outcome facts the record already
 * holds — command_run `ok`/`exit` (self-improve D2) — folded into what a
 * session and a task can be said to have done, plus the one env switch that
 * removes the derived lines from the injected surfaces for round 3's
 * ablation arm. Nothing here reads the clock, the filesystem or the store:
 * the fold stays a pure function of the log (5.1 purity), and the switch is
 * read only by the CLI and the MCP server, never by a projection.
 */

/** Env switch: `SOFAR_ACTIVITY=off` (also `0`, `false`) — round 3's ablation arm (D24 (5)). */
export const ACTIVITY_ENV = 'SOFAR_ACTIVITY'

export function activityEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env[ACTIVITY_ENV]?.trim().toLowerCase()
  return !(v === 'off' || v === '0' || v === 'false')
}

/**
 * Sentences appended to two tool descriptions while derived activity is on
 * (D24 (4)): the one place the MCP dialect is told what NOT to write. Under
 * the switch they go too, so the ablation arm removes the telling with the
 * showing.
 */
export const ACTIVITY_GUIDANCE: Readonly<Record<string, string>> = {
  sofar_update_task:
    ' The note is WHY — files, commands, test outcomes and commits are captured by hooks and derived; never restate them.',
  sofar_end_session:
    ' The summary is WHY and what it means — files, commands, test outcomes and commits are derived from the record.',
}

export function withActivityGuidance(name: string, description: string, env: NodeJS.ProcessEnv = process.env): string {
  const extra = ACTIVITY_GUIDANCE[name]
  return extra === undefined || !activityEnabled(env) ? description : `${description}${extra}`
}

/** Bound on the command text a test outcome keeps. */
export const TEST_CMD_CLIP = 120

const PKG_TEST = /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|t)(?::[\w-]+)?(?:\s|$)/
const RUNNER =
  /^(?:(?:npx|pnpm|yarn|bun|bunx|poetry\s+run|uv\s+run|bundle\s+exec)\s+)?(?:vitest|jest|mocha|ava|tap|pytest|py\.test|rspec|phpunit|cypress\s+run|playwright\s+test|node\s+--test)(?:\s|$)/
const TOOL_TEST = /^(?:cargo|go|dotnet|swift|mix|gradle|\.\/gradlew|gradlew|mvn|make|deno|zig)\s+test(?:\s|$)/
const ENV_ASSIGN = /^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/

/**
 * The first shell segment of `cmd` that runs a test suite, or null. Pure and
 * total: a CLOSED set of runners matched at the head of each `&&`, `||`, `;`,
 * `|` or newline segment, after leading `VAR=value` assignments are dropped —
 * so `cd pkg && npm test` and `CI=1 vitest run` are test commands, and
 * `git commit -m "npm test"` is not (quoted text is never a segment head).
 * What the command DID is `ok`, never this: an unknown outcome stays unknown.
 */
export function testShapedCommand(cmd: string): string | null {
  for (const raw of splitSegments(cmd)) {
    const seg = raw.replace(ENV_ASSIGN, '').trim()
    if (seg.length === 0) continue
    if (PKG_TEST.test(seg) || RUNNER.test(seg) || TOOL_TEST.test(seg)) return seg.slice(0, TEST_CMD_CLIP)
  }
  return null
}

/** Quote-aware split on the shell's sequencing operators — inside quotes an `&&` is text. */
function splitSegments(cmd: string): string[] {
  const out: string[] = []
  let cur = ''
  let quote: string | null = null
  for (let i = 0; i < cmd.length; i += 1) {
    const ch = cmd[i]!
    if (quote !== null) {
      cur += ch
      if (ch === quote) quote = null
      else if (ch === '\\' && quote === '"') {
        cur += cmd[i + 1] ?? ''
        i += 1
      }
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      cur += ch
    } else if (ch === '\\') {
      cur += ch + (cmd[i + 1] ?? '')
      i += 1
    } else if ((ch === '&' || ch === '|') && cmd[i + 1] === ch) {
      out.push(cur)
      cur = ''
      i += 1
    } else if (ch === ';' || ch === '|' || ch === '\n') {
      out.push(cur)
      cur = ''
    } else cur += ch
  }
  out.push(cur)
  return out
}
