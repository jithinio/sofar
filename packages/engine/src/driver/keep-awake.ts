import { spawn, type ChildProcess } from 'node:child_process'

/**
 * Keeping the Mac awake for a run (drive-visibility D5; SPEC §Driver,
 * "Keeping the Mac awake").
 *
 * On macOS, with keep-awake on, the driver runs `caffeinate -i -w <its own
 * pid>` from the moment it takes the run. `-w` ends the assertion by itself
 * when the watched process exits — kill -9 included — so nothing is cleaned
 * up after a crash and no pid is stored anywhere. `-i` blocks IDLE sleep
 * only: closing the lid still sleeps the Mac, and the opening line says so.
 *
 * What decides it, first match wins: the run's own flag (`--keep-awake` /
 * `--no-keep-awake`, never saved), else the saved `drive.keep_awake`, which a
 * run with no flag reads again before every launch — so an operator an agent
 * asked in chat mid-run gets the answer from the next session on. Unset is
 * off, and said so in the opening lines as a warning, since a detached or
 * agent-launched run never prompts (D5) and the agent relaying the lines is
 * who asks. Elsewhere than macOS the setting is inert, and a run that asked
 * for it is told.
 */

export const CAFFEINATE = '/usr/bin/caffeinate'

export interface KeepAwakeOptions {
  /** `--keep-awake` (true) or `--no-keep-awake` (false): wins for this run and is not saved. */
  flag?: boolean
  /** The saved `drive.keep_awake`; undefined while unset. Read again before every launch. */
  setting: () => boolean | undefined
  /** Test seam (default process.platform). */
  platform?: NodeJS.Platform
  /** Test seam: the binary that holds the assertion (default CAFFEINATE). */
  bin?: string
  /** Test seam: the process the assertion lives as long as (default this one). */
  pid?: number
}

export interface KeepAwake {
  /** What the run's opening lines say about keep-awake, from the answer as it stands now. */
  opening(): string[]
  /** Take the assertion if keep-awake is on — called once the run is taken. */
  start(progress: (line: string) => void): void
  /** Re-read the setting before a launch; a line to report when the answer changed. */
  beforeLaunch(): string | undefined
  /** Idempotent. Ends the assertion; a driver that dies instead leaves `-w` to end it. */
  release(): void
}

const SETTING = '`sofar drive --keep-awake-setting on` (or off)'

export function createKeepAwake(options: KeepAwakeOptions): KeepAwake {
  const platform = options.platform ?? process.platform
  const bin = options.bin ?? CAFFEINATE
  const pid = options.pid ?? process.pid
  const answer = (): boolean | undefined => options.flag ?? options.setting()
  let on = answer() === true
  let child: ChildProcess | undefined
  let progress: (line: string) => void = () => {}
  let released = false

  const take = (): void => {
    if (child !== undefined || released) return
    const held = spawn(bin, ['-i', '-w', String(pid)], { stdio: 'ignore' })
    child = held
    // The assertion must not keep the driver's event loop alive: `-w`, not a
    // reference, is what ties it to the driver.
    held.unref()
    held.on('error', (err) => {
      if (child !== held) return
      child = undefined
      progress(`warning: keep-awake could not start ${bin} (${(err as NodeJS.ErrnoException).code ?? err.message}) — idle sleep is not blocked`)
    })
    held.on('exit', (code, signal) => {
      if (child !== held) return
      child = undefined
      progress(`warning: keep-awake ended early — ${bin} exited ${code ?? signal}; idle sleep is no longer blocked`)
    })
  }
  const drop = (): void => {
    const held = child
    child = undefined
    held?.kill()
  }

  return {
    opening() {
      const given = answer()
      if (platform !== 'darwin') {
        return given === true ? [`warning: keep-awake is macOS-only — on ${platform} this run does not block sleep`] : []
      }
      if (given === true) {
        const why = options.flag === true ? ' for this run (--keep-awake)' : ''
        return [`keep-awake on${why} — caffeinate blocks idle sleep for this driver's life; closing the lid still sleeps the Mac`]
      }
      if (given === false) {
        return [`keep-awake off${options.flag === false ? ' for this run (--no-keep-awake)' : ''} — idle sleep can pause this run`]
      }
      return [
        `warning: keep-awake is unset — idle sleep can pause this run. Ask the operator, then ${SETTING} saves the answer; this run reads it again before every launch`,
      ]
    },
    start(report) {
      progress = report
      if (platform === 'darwin' && on) take()
    },
    beforeLaunch() {
      if (platform !== 'darwin' || options.flag !== undefined || released) return undefined
      const next = options.setting() === true
      if (next === on) return undefined
      on = next
      if (on) {
        take()
        return 'keep-awake now on (drive.keep_awake changed) — caffeinate blocks idle sleep from this session on'
      }
      drop()
      return 'keep-awake now off (drive.keep_awake changed) — idle sleep can pause this run'
    },
    release() {
      released = true
      drop()
    },
  }
}
