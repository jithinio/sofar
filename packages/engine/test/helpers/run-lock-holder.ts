import { claimRunLock, type LockPrimitive } from '../../src/core/run-lock'

/**
 * A process that claims one run lock and holds it until it is killed — the
 * driver's half of the lock with nothing else of the driver, so a test can
 * SIGSTOP it, kill -9 it or launch it inside a sandbox (drive-visibility 2.1).
 * Prints the claim's kind, and why when it is unavailable.
 *
 *   node holder.mjs <repo root> <run id> [exlock|flock1]
 */
const [root, runId, primitive] = process.argv.slice(2)
const claim = await claimRunLock(root!, runId!, primitive ? { primitive: primitive as LockPrimitive } : {})
process.stdout.write(claim.kind === 'unavailable' ? `unavailable: ${claim.why}\n` : `${claim.kind}\n`)
if (claim.kind === 'claimed') setInterval(() => {}, 60_000)
