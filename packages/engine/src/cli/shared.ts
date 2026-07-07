import { ToolError } from '../mcp/context'

/**
 * Shared CLI command plumbing (Phase 4). Command handlers are pure functions
 * returning {exitCode, stdout, stderr} — the established `sofar event`
 * pattern (BD22) — so tests never wrestle process.exit; commander wiring in
 * index.ts stays thin and just mirrors the result.
 */

export interface CmdResult {
  exitCode: number
  stdout: string
  stderr: string
}

export function ok(stdout = '', stderr = ''): CmdResult {
  return { exitCode: 0, stdout, stderr }
}

export function fail(message: string): CmdResult {
  return { exitCode: 1, stdout: '', stderr: message }
}

/** Human-facing message for a resolution/IO failure inside a handler. */
export function errMessage(err: unknown): string {
  if (err instanceof ToolError) return err.message
  return err instanceof Error ? err.message : String(err)
}

/** Read stdin to a string (for `sofar import -`); empty when run on a TTY. */
export async function readAllStdin(): Promise<string> {
  if (process.stdin.isTTY) return ''
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : (chunk as Buffer))
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** Mirror a handler result onto the process (stdout/stderr/exit code). */
export function emit(result: CmdResult): void {
  if (result.stdout.length > 0) process.stdout.write(result.stdout)
  if (result.stderr.length > 0) {
    process.stderr.write(result.stderr.endsWith('\n') ? result.stderr : `${result.stderr}\n`)
  }
  process.exitCode = result.exitCode
}
