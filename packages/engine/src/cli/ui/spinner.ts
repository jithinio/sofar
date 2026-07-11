/**
 * Spinner kernel (1.4). Lives on stderr (clig.dev: stdout is the report,
 * stderr is the messaging channel) so `sofar doctor | tee` never captures
 * frames. Degrades per caps.animate:
 *
 * - animate: redraw `\r␛[K <frame> <text>` on an unref'd interval, cursor
 *   hidden while running, restored on stop and on SIGINT (which is then
 *   re-raised so ^C still terminates the process).
 * - static (piped/CI/dumb): one `⋯ text` line at start and one per text
 *   update — CI logs stay readable, never frame spam.
 *
 * Frame glyph renders in accent; succeed/fail close with the ✓/✗
 * vocabulary from symbols.ts.
 */

import type { Caps } from './caps'
import { createStyle } from './style'
import { symbolsFor } from './symbols'
import { framesFor, type FrameSet, type SpinnerUseCase } from './frames'

export interface SpinnerStream {
  write(chunk: string): unknown
}

export interface SpinnerOptions {
  caps: Caps
  text: string
  /** Picks the frame set; default 'scan'. Ignored when `frames` given. */
  useCase?: SpinnerUseCase
  frames?: FrameSet
  stream?: SpinnerStream
}

export interface Spinner {
  start(): Spinner
  /** Replace the label; static mode prints one new line per change. */
  update(text: string): void
  /** Stop with a green ✓ line. */
  succeed(text?: string): void
  /** Stop with a red ✗ line. */
  fail(text?: string): void
  /** Stop; optional final line replaces the frame silently. */
  stop(finalText?: string): void
}

const HIDE_CURSOR = '\x1b[?25l'
const SHOW_CURSOR = '\x1b[?25h'
const CLEAR_LINE = '\r\x1b[K'

export function createSpinner(options: SpinnerOptions): Spinner {
  const { caps } = options
  const stream: SpinnerStream = options.stream ?? process.stderr
  const style = createStyle(caps.color)
  const symbols = symbolsFor(caps.unicode)
  const staticMark = caps.unicode ? '⋯' : '...'
  const set = options.frames ?? framesFor(options.useCase ?? 'scan', caps.unicode)

  let text = options.text
  let timer: ReturnType<typeof setInterval> | undefined
  let frameIndex = 0
  let running = false

  const restoreCursor = (): void => {
    if (caps.animate) stream.write(SHOW_CURSOR)
  }

  const onSigint = (): void => {
    restoreCursor()
    // `once` has already removed this listener; re-raise so the default
    // terminate-on-SIGINT disposition still applies (installing ANY
    // listener suppresses it — Node semantics). Restore-then-re-raise is
    // the restore-cursor/ora practice: a spinner must never make ^C stop
    // killing the process.
    process.kill(process.pid, 'SIGINT')
  }

  const renderFrame = (): void => {
    const glyph = style.accent(set.frames[frameIndex % set.frames.length]!)
    stream.write(`${CLEAR_LINE}${glyph} ${text}`)
    frameIndex += 1
  }

  const finish = (line?: string): void => {
    if (!running) return
    running = false
    if (caps.animate) {
      if (timer !== undefined) clearInterval(timer)
      timer = undefined
      stream.write(CLEAR_LINE)
      restoreCursor()
      process.removeListener('SIGINT', onSigint)
    }
    if (line !== undefined) stream.write(`${line}\n`)
  }

  const spinner: Spinner = {
    start() {
      if (running) return spinner
      running = true
      if (caps.animate) {
        process.once('SIGINT', onSigint)
        stream.write(HIDE_CURSOR)
        renderFrame()
        timer = setInterval(renderFrame, set.intervalMs)
        // never hold the process open for a forgotten spinner
        timer.unref?.()
      } else {
        stream.write(`${staticMark} ${text}\n`)
      }
      return spinner
    },
    update(next: string) {
      if (next === text) return
      text = next
      if (!running) return
      if (caps.animate) renderFrame()
      else stream.write(`${staticMark} ${text}\n`)
    },
    succeed(finalText?: string) {
      finish(`${style.success(symbols.ok)} ${finalText ?? text}`)
    },
    fail(finalText?: string) {
      finish(`${style.error(symbols.fail)} ${finalText ?? text}`)
    },
    stop(finalText?: string) {
      finish(finalText)
    },
  }
  return spinner
}
