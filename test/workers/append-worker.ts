// Spawned by test/log.test.ts as a separate OS process to exercise
// cross-process concurrent appends against a single events.jsonl.
import { makeEvent } from '../../src/core/envelope'
import { appendEvent } from '../../src/core/log'

const logPath = process.argv[2]
const workerId = process.argv[3]
const count = Number(process.argv[4])

if (!logPath || !workerId || !Number.isInteger(count) || count <= 0) {
  console.error('usage: append-worker <logPath> <workerId> <count>')
  process.exit(1)
}

for (let i = 0; i < count; i++) {
  appendEvent(
    logPath,
    makeEvent({
      initiative: 'stress',
      session: `worker-${workerId}`,
      source: 'cli',
      actor: 'agent',
      type: 'note_added',
      // padding lengthens lines so non-atomic writes would visibly interleave
      payload: { worker: workerId, i, padding: 'x'.repeat(256) },
    }),
  )
}
