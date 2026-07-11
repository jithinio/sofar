#!/usr/bin/env node
/**
 * cli-ui 3.3 live-fire — drive the BUILT bundle (packages/engine/dist/cli.js)
 * through a real repo lifecycle, once per env mode, and assert the SPEC
 * §Acceptance "CLI UI" byte laws against actual process stdout/stderr:
 *
 *   sequence: init → new → new --no-bind → status → list → doctor →
 *             switch → uninit → doctor (broken wiring → exit 1)
 *
 *   modes (stdout+stderr always piped — spawnSync pipes by default):
 *     piped-default            zero ESC bytes on stdout AND stderr
 *     piped-CI (CI=true)       zero ESC bytes (ambient CI stripped when piped)
 *     FORCE_COLOR=1            semantic ANSI-16 SGR on report stdout; zero
 *                              spinner/cursor bytes on stderr
 *     NO_COLOR=1 FORCE_COLOR=1 zero ESC bytes (NO_COLOR beats FORCE_COLOR)
 *
 *   plus a byte-identity pass: on ONE frozen repo, status/list/doctor stdout
 *   must be byte-identical across piped-default, piped-CI, and
 *   NO_COLOR+FORCE_COLOR.
 *
 * Usage:  node packages/engine/test/livefire.cli-ui.mjs
 *         SKIP_BUILD=1 node packages/engine/test/livefire.cli-ui.mjs
 * Exits non-zero when any cell fails; prints the full matrix either way.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const engineDir = resolve(here, '..')
const repoRoot = resolve(engineDir, '..', '..')
const cliPath = join(engineDir, 'dist', 'cli.js')

// --- build the real bundle (npm run build), unless explicitly skipped -------
if (process.env.SKIP_BUILD !== '1') {
  const build = spawnSync('npm', ['run', 'build'], { cwd: repoRoot, encoding: 'utf8' })
  if (build.status !== 0) {
    process.stderr.write(`npm run build failed\n${build.stdout}\n${build.stderr}\n`)
    process.exit(1)
  }
}
if (!existsSync(cliPath)) {
  process.stderr.write(`missing bundle: ${cliPath} — run npm run build first\n`)
  process.exit(1)
}

// --- byte laws ---------------------------------------------------------------
const ESC = /\x1b/
const SGR_RE = /\x1b\[([0-9;]*)m/g
const SEMANTIC_SGR = new Set(['1', '2', '22', '31', '32', '33', '35', '36', '39'])

function nonSemanticEscapes(text) {
  const bad = []
  const rest = text.replace(SGR_RE, (seq, codes) => {
    for (const code of codes.split(';')) if (!SEMANTIC_SGR.has(code)) bad.push(JSON.stringify(seq))
    return ''
  })
  if (ESC.test(rest)) bad.push('(escape byte outside any SGR sequence)')
  return bad
}

// --- env modes ---------------------------------------------------------------
/** Baseline env: the ladder's inputs pinned, everything else inherited. */
function baseEnv() {
  const env = { ...process.env }
  for (const key of ['NO_COLOR', 'FORCE_COLOR', 'CI', 'CLICOLOR', 'CLICOLOR_FORCE']) delete env[key]
  env.TERM = 'xterm-256color'
  return env
}

const MODES = [
  { name: 'piped-default', env: {}, wantSgr: false },
  { name: 'piped-CI', env: { CI: 'true' }, wantSgr: false },
  { name: 'FORCE_COLOR=1', env: { FORCE_COLOR: '1' }, wantSgr: true },
  { name: 'NO_COLOR>FORCE_COLOR', env: { NO_COLOR: '1', FORCE_COLOR: '1' }, wantSgr: false },
  // flag registration (SPEC §CLI UI): commander accepts the pair, the
  // kernel reads argv — --color forces piped SGR, --no-color vetoes a force
  { name: '--color flag', env: {}, args: ['--color'], wantSgr: true },
  { name: '--no-color>FORCE_COLOR', env: { FORCE_COLOR: '1' }, args: ['--no-color'], wantSgr: false },
]

// --- scratch repo + CLI runner -------------------------------------------------
const scratches = []
function scratchRepo() {
  const root = mkdtempSync(join(tmpdir(), 'sofar-livefire-'))
  scratches.push(root)
  mkdirSync(join(root, '.git'), { recursive: true })
  writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  // Tailwind v4 fixture (exclusion already in place): doctor's tree scan runs
  // for real, so a piped stderr proves the spinner stays silent end-to-end.
  writeFileSync(
    join(root, 'package.json'),
    `${JSON.stringify({ dependencies: { tailwindcss: '^4.1.0' } }, null, 2)}\n`,
  )
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'app.css'), '@import "tailwindcss";\n@source not "../.sofar";\n')
  return root
}

function cli(root, args, modeEnv, modeArgs = []) {
  return spawnSync(process.execPath, [cliPath, ...args, ...modeArgs, '--root', root], {
    env: { ...baseEnv(), ...modeEnv },
    encoding: 'utf8',
    timeout: 30_000,
  })
}

// step: [label, argv, expected exit code, isReportCommand]
const STEPS = [
  ['init', ['init'], 0, false],
  ['new', ['new', 'demo', '--goal', 'live-fire pass'], 0, false],
  ['new --no-bind', ['new', 'side', '--no-bind'], 0, false],
  ['status', ['status'], 0, true],
  ['list', ['list'], 0, true],
  ['doctor', ['doctor'], 0, true],
  ['switch', ['switch', 'side'], 0, false],
  ['uninit', ['uninit'], 0, false],
  ['doctor (broken)', ['doctor'], 1, true],
]

// --- run the matrix -----------------------------------------------------------
const rows = []
let failures = 0

for (const mode of MODES) {
  const root = scratchRepo()
  for (const [label, args, wantExit, isReport] of STEPS) {
    const r = cli(root, args, mode.env, mode.args ?? [])
    const problems = []
    if (r.status !== wantExit) problems.push(`exit ${r.status} (want ${wantExit})`)

    if (mode.wantSgr) {
      // styled mode: report stdout must carry law-conformant SGR…
      const badOut = nonSemanticEscapes(r.stdout)
      if (badOut.length > 0) problems.push(`non-semantic SGR on stdout: ${badOut[0]}`)
      if (isReport && !SGR_RE.test(r.stdout)) problems.push('no SGR on report stdout')
      SGR_RE.lastIndex = 0
      // …and stderr must never carry spinner/cursor bytes on a pipe
      const badErr = nonSemanticEscapes(r.stderr)
      if (badErr.length > 0) problems.push(`non-semantic escapes on stderr: ${badErr[0]}`)
      if (/\r|\x1b\[\?25[lh]|\x1b\[K/.test(r.stderr)) problems.push('spinner bytes on piped stderr')
    } else {
      if (ESC.test(r.stdout)) problems.push('ESC byte on stdout')
      if (ESC.test(r.stderr)) problems.push('ESC byte on stderr')
    }

    if (problems.length > 0) failures++
    rows.push({ mode: mode.name, step: label, ok: problems.length === 0, detail: problems.join('; ') })
  }
}

// --- byte-identity pass: color-off REPORT stdout is byte-identical across ---
// env modes (SPEC: "status/list/doctor stdout is byte-identical to the
// pre-cli-ui plain renderers"). stdout + exit code only: with BOTH
// NO_COLOR and FORCE_COLOR set, Node itself prints a process warning to
// stderr ("The 'NO_COLOR' env is ignored…") — runtime noise, not sofar
// bytes (sofar's stderr plainness is asserted per-cell in the matrix above).
{
  const root = scratchRepo()
  cli(root, ['init'], {})
  cli(root, ['new', 'demo', '--goal', 'identity pass'], {})
  const plainModes = [{}, { CI: 'true' }, { NO_COLOR: '1', FORCE_COLOR: '1' }]
  for (const cmd of [['status'], ['list'], ['doctor']]) {
    const outputs = plainModes.map((env) => cli(root, cmd, env))
    const identical =
      outputs.every((r) => r.stdout === outputs[0].stdout) &&
      outputs.every((r) => r.status === outputs[0].status)
    if (!identical) failures++
    rows.push({
      mode: 'stdout-identity (default ≡ CI ≡ NO_COLOR+FORCE_COLOR)',
      step: cmd[0],
      ok: identical,
      detail: identical ? '' : 'plain report stdout differs across env modes',
    })
  }
}

// --- report -------------------------------------------------------------------
const width = Math.max(...rows.map((row) => row.mode.length))
for (const row of rows) {
  const mark = row.ok ? 'PASS' : 'FAIL'
  process.stdout.write(
    `${mark}  ${row.mode.padEnd(width)}  ${row.step}${row.detail ? `  — ${row.detail}` : ''}\n`,
  )
}
process.stdout.write(
  `\nlive-fire: ${rows.length - failures}/${rows.length} cells passed${failures > 0 ? ` — ${failures} FAILED` : ''}\n`,
)

for (const root of scratches) rmSync(root, { recursive: true, force: true })
process.exit(failures > 0 ? 1 : 0)
