import { makeEvent } from '../../src/core/envelope'
import { appendEvent } from '../../src/core/log'
import type {
  Adapter,
  AdapterCapabilities,
  AgentSession,
  LaunchRequest,
  SessionExit,
  Usage,
} from '../../src/driver/adapter'

/**
 * A scripted adapter for driver tests (session-driver 1.3). It behaves the
 * way a real agent looks from the driver's side: registers a session in the
 * record when launched, reports whatever usage its script says, writes back
 * (or not) before exiting, and shows its session id on exit only when told
 * its transport does. Everything the driver derives — wrote_back, which
 * session a launch became — is derived from the record the fake wrote, never
 * from the fake's own say-so, which is the contract under test.
 */
export interface FakeScript {
  /** Log the fake writes its session events into. */
  logPath: string
  /** Initiative slug for the envelope. */
  initiative: string
  /** Session id the fake registers at launch; omit to register nothing (an agent that never called sofar). */
  session_id?: string
  /** `usage()` answers in order; the last repeats. Empty or absent: usage() is undefined forever. */
  usage?: Usage[]
  /** Append a session_ended before exiting. */
  write_back?: boolean
  exit?: { code: number | null; signal?: string }
  /** Whether the exit carries the session id — a transport that shows it. */
  report_session_id?: boolean
  capabilities?: Partial<AdapterCapabilities>
}

export class FakeSession implements AgentSession {
  nudged = 0
  killed: NodeJS.Signals | undefined
  private readonly usages: Usage[]
  private calls = 0

  constructor(
    private readonly script: FakeScript,
    readonly request: LaunchRequest,
  ) {
    this.usages = script.usage ?? []
  }

  usage(): Usage | undefined {
    if (this.usages.length === 0) return undefined
    const index = Math.min(this.calls, this.usages.length - 1)
    this.calls += 1
    return this.usages[index]
  }

  nudge(): void {
    this.nudged += 1
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): void {
    this.killed = signal
  }

  async wait(): Promise<SessionExit> {
    const { script } = this
    if (script.session_id !== undefined && script.write_back === true) {
      appendEvent(
        script.logPath,
        makeEvent({
          initiative: script.initiative,
          session: script.session_id,
          type: 'session_ended',
          payload: { summary: `fake did ${this.request.task?.id ?? 'the next action'}`, next_action: 'next' },
          source: 'cli',
          actor: 'agent',
        }),
      )
    }
    const exit = script.exit ?? { code: 0 }
    const last = this.usages.length > 0 ? this.usages[this.usages.length - 1] : undefined
    return {
      ...exit,
      ...(script.report_session_id === true && script.session_id !== undefined
        ? { session_id: script.session_id }
        : {}),
      ...(last !== undefined ? { usage: last } : {}),
    }
  }
}

export class FakeAdapter implements Adapter {
  readonly name = 'fake'
  readonly capabilities: AdapterCapabilities
  readonly sessions: FakeSession[] = []

  constructor(private readonly script: FakeScript) {
    this.capabilities = {
      usage: (script.usage?.length ?? 0) > 0,
      nudge: true,
      model: false,
      effort: false,
      ...script.capabilities,
    }
  }

  launch(request: LaunchRequest): FakeSession {
    const { script } = this
    if (script.session_id !== undefined) {
      appendEvent(
        script.logPath,
        makeEvent({
          initiative: script.initiative,
          session: script.session_id,
          type: 'session_started',
          payload: { tool: this.name },
          source: 'cli',
          actor: 'agent',
        }),
      )
    }
    const session = new FakeSession(script, request)
    this.sessions.push(session)
    return session
  }
}
