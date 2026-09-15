import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { FixtureSpec, Materialized, Step } from './harness'

/**
 * The conformance catalogue (rust-core 1.2). One entry per golden file;
 * each runs a sequence of steps against a fresh copy of its fixture and
 * then diffs the record. Tags name the open decision a case depends on
 * (docs/HOTPATH.md §Open decisions) — `SOFAR_CONFORMANCE_SKIP=O2,O4,O5`
 * skips them until the run owner rules — and `full-cli` marks output the
 * fast path hands to the commander CLI: argv shapes a native core never
 * owns (docs/HOTPATH.md §Entry points and dispatch).
 */

export interface ConformanceCase {
  name: string
  fixture: FixtureSpec
  steps: Step[]
  tags?: string[]
}

// ---------------------------------------------------------------------------
// Fixture specs.
// ---------------------------------------------------------------------------

/** This repo's own record, frozen at commit 7535e75 (55 initiatives, 7.6 MB of logs). */
const REPO: FixtureSpec = {
  record: 'records/repo',
  git: { branch: 'rust-core', head: '7535e751b81e3938ebf96984792761f41aa524b6' },
}
/** The same record on `main`, bound to session-driver, which other logs have outpaced; pushed and in sync. */
const REPO_ON_MAIN: FixtureSpec = {
  record: 'records/repo',
  git: {
    branch: 'main',
    head: 'c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00',
    upstream: 'c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00',
  },
}
const CELL_SHA = 'ce11ce11ce11ce11ce11ce11ce11ce11ce11ce11'
const CELL_OLD = '0ld00ld00ld00ld00ld00ld00ld00ld00ld00ld0'
const cell = (name: string, upstream?: string): FixtureSpec => ({
  record: `records/${name}`,
  git: { branch: 'main', head: CELL_SHA, ...(upstream !== undefined ? { upstream } : {}) },
})
const synthetic = (name: string, git: FixtureSpec['git'] = { branch: 'main', head: CELL_SHA }): FixtureSpec => ({
  record: `synthetic/${name}`,
  git,
})

/** A registered session in the repo record's `speed` initiative (homeInitiative routing). */
const SPEED_SESSION = 'aefa6315-3725-4e4d-9f9a-224ff6f86ddb'
/** The last written-back session on `rust-core` at the snapshot. */
const RUST_CORE_SESSION = '38d26db0-c497-44bf-b41d-11623a8486f5'

// ---------------------------------------------------------------------------
// stdin shapes.
// ---------------------------------------------------------------------------

function hook(name: string, fields: Record<string, unknown>): Record<string, unknown> {
  return {
    session_id: 'conf-session',
    transcript_path: '<ROOT>/transcript.jsonl',
    cwd: '<ROOT>',
    hook_event_name: name,
    ...fields,
  }
}
const start = (fields: Record<string, unknown> = {}) => hook('SessionStart', { source: 'startup', ...fields })
const prompt = (fields: Record<string, unknown> = {}) => hook('UserPromptSubmit', { prompt: 'continue', ...fields })
const stop = (fields: Record<string, unknown> = {}) => hook('Stop', { stop_hook_active: false, ...fields })
const end = (fields: Record<string, unknown> = {}) => hook('SessionEnd', { reason: 'exit', ...fields })
const edit = (path: string, fields: Record<string, unknown> = {}) =>
  hook('PostToolUse', { tool_name: 'Edit', tool_input: { file_path: path, old_string: 'a', new_string: 'b' }, tool_response: {}, ...fields })
const bash = (command: string, fields: Record<string, unknown> = {}) =>
  hook('PostToolUse', { tool_name: 'Bash', tool_input: { command, description: 'x' }, tool_response: {}, ...fields })

function statusline(fields: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    hook_event_name: 'Status',
    session_id: 'conf-session',
    transcript_path: '<ROOT>/transcript.jsonl',
    cwd: '<ROOT>',
    model: { id: 'claude-fable-5-1', display_name: 'Fable 5.1 (1M context)' },
    workspace: { current_dir: '<ROOT>', project_dir: '<ROOT>' },
    version: '2.1.0',
    context_window: {
      used_percentage: 42.4,
      current_usage: { input_tokens: 1_200, cache_creation_input_tokens: 3_000, cache_read_input_tokens: 40_000 },
    },
    ...fields,
  }
}

const transcript = (bytes: number) => (m: Materialized) => {
  writeFileSync(join(m.root, 'transcript.jsonl'), `${'{"type":"assistant","text":"padding"}\n'.repeat(Math.ceil(bytes / 40))}`)
}

const s = (title: string, argv: string[], stdin?: Step['stdin'], rest: Partial<Step> = {}): Step => ({
  title,
  argv,
  ...(stdin !== undefined ? { stdin } : {}),
  ...rest,
})

// ---------------------------------------------------------------------------
// The catalogue.
// ---------------------------------------------------------------------------

export const CASES: ConformanceCase[] = [
  // ---- this repo's record ------------------------------------------------
  {
    name: 'repo.session-start',
    fixture: REPO,
    steps: [
      s('startup on the bound record', ['event', 'session-start'], start()),
      s('same stdin again: byte-stable', ['event', 'session-start'], start()),
      s('resume with a cold transcript (advisory)', ['event', 'session-start'], start({ source: 'resume' }), {
        before: transcript(120_000),
      }),
      s('resume with a small transcript (no advisory)', ['event', 'session-start'], start({ source: 'resume' }), {
        before: transcript(1_000),
      }),
      s('session already written back on this record', ['event', 'session-start'], start({ session_id: RUST_CORE_SESSION })),
      s('session homed in another record (via session)', ['event', 'session-start'], start({ session_id: SPEED_SESSION })),
      s('empty session_id reads as absent', ['event', 'session-start'], start({ session_id: '' })),
      s('no session_id at all', ['event', 'session-start'], { hook_event_name: 'SessionStart', source: 'clear' }),
      s('unparseable stdin', ['event', 'session-start'], 'not json at all'),
      s('stdin is a JSON array', ['event', 'session-start'], '[1,2]'),
      s('empty stdin', ['event', 'session-start']),
      s('--root as a separate token', ['event', 'session-start', '--root', '<ROOT>'], start()),
      s('--root=dir form', ['event', 'session-start', '--root=<ROOT>'], start()),
    ],
  },
  {
    name: 'repo.status',
    fixture: REPO,
    steps: [
      s('bound record', ['status']),
      s('explicit slug: the largest log', ['status', 'drift-certification']),
      s('explicit slug: driven runs', ['status', 'session-driver']),
      s('explicit slug: a closed record', ['status', 'speed']),
      s('explicit slug: benchmark record', ['status', 'bench-refresh']),
      s('--no-color is the same bytes', ['status', '--no-color', 'rust-core']),
      s('--root form', ['status', '--root', '<ROOT>', 'felt-cost']),
      s('unknown slug', ['status', 'no-such-record']),
      s('slug escaping the tree', ['status', '../rust-core']),
    ],
  },
  {
    name: 'repo.hook-lifecycle',
    fixture: REPO,
    steps: [
      s('prompt before registration: silent', ['event', 'user-prompt'], prompt()),
      s('stop before registration: passes', ['event', 'stop'], stop()),
      s('Edit registers the session and appends file_touched', ['event', 'post-tool'], edit('<ROOT>/packages/engine/src/core/fold.ts')),
      s('Write', ['event', 'post-tool'], hook('PostToolUse', { tool_name: 'Write', tool_input: { file_path: '<ROOT>/docs/NEW.md', content: 'x' } })),
      s('MultiEdit', ['event', 'post-tool'], hook('PostToolUse', { tool_name: 'MultiEdit', tool_input: { file_path: '<ROOT>/packages/engine/src/cli/event.ts', edits: [] } })),
      s('Bash with secrets is redacted', ['event', 'post-tool'], bash(
        'export OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz0123456789 && curl -H "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijklmnop" https://user:hunter2@example.com/x --token=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 -p AKIAIOSFODNN7EXAMPLE',
      )),
      s('Bash that only touches git and sofar is exempt', ['event', 'post-tool'], bash('git status && sofar status | head -3; GIT_PAGER=cat git log -1')),
      s('Bash with a subshell cannot be scanned: logged', ['event', 'post-tool'], bash('git commit -m "$(cat msg)"')),
      s('Bash with an unbalanced quote: logged', ['event', 'post-tool'], bash("git status && echo 'oops")),
      s('Read tool appends nothing', ['event', 'post-tool'], hook('PostToolUse', { tool_name: 'Read', tool_input: { file_path: '<ROOT>/README.md' } })),
      s('Edit without file_path appends nothing', ['event', 'post-tool'], hook('PostToolUse', { tool_name: 'Edit', tool_input: {} })),
      s('prompt after drift: nudge and push state', ['event', 'user-prompt'], prompt()),
      s('stop blocks the unwritten session', ['event', 'stop'], stop()),
      s('stop_hook_active short-circuits', ['event', 'stop'], stop({ stop_hook_active: true })),
      s('session-end closes the session', ['event', 'session-end'], end()),
      s('session-end again is a no-op', ['event', 'session-end'], end({ reason: 'other' })),
      s('write-back through append', ['event', 'append', '--type', 'session_ended', '--session', 'conf-session', '--source', 'hook', '--payload', '{"summary":"conformance lifecycle finished","next_action":"read the golden"}']),
      s('stop passes once written back', ['event', 'stop'], stop()),
      s('prompt after write-back', ['event', 'user-prompt'], prompt()),
      s('status shows the session', ['status']),
      s('statusline after the run', ['statusline', '--no-color'], statusline()),
    ],
  },
  {
    name: 'repo.append',
    fixture: REPO,
    steps: [
      s('note on the bound record', ['event', 'append', '--type', 'note_added', '--payload', '{"text":"conformance note"}']),
      s('explicit slug', ['event', 'append', 'felt-cost', '--type', 'note_added', '--payload', '{"text":"note on another record"}', '--session', 'conf-cli', '--actor', 'human']),
      s('unknown event type', ['event', 'append', '--type', 'bogus_event', '--payload', '{}']),
      s('payload is not JSON', ['event', 'append', '--type', 'note_added', '--payload', '{']),
      s('payload is not an object', ['event', 'append', '--type', 'note_added', '--payload', '[1]']),
      s('payload fails the schema', ['event', 'append', '--type', 'decision_logged', '--payload', '{"chose":"x"}']),
      s('bad source', ['event', 'append', '--type', 'note_added', '--payload', '{"text":"x"}', '--source', 'nope']),
      s('bad actor', ['event', 'append', '--type', 'note_added', '--payload', '{"text":"x"}', '--actor', 'nope']),
      s('empty session', ['event', 'append', '--type', 'note_added', '--payload', '{"text":"x"}', '--session', '']),
      s('unknown slug', ['event', 'append', 'no-such-record', '--type', 'note_added', '--payload', '{"text":"x"}']),
      s('task_status_changed for an unknown task appends (fold warns)', ['event', 'append', '--type', 'task_status_changed', '--payload', '{"id":"9.9","status":"done"}']),
      s('numbers and escapes re-serialize canonically', ['event', 'append', '--type', 'note_added', '--payload', '{"text":"esc \\u0001 \\ud83d\\ude00 \\ud800 \\"q\\" \\\\ / \\u2028","z":1e21,"a":1e-7,"m":-0,"f":1.0,"big":12345678901234567890,"s":0.30000000000000004,"tiny":5e-324,"nest":{"b":[null,1,{"y":2,"x":1}],"a":true},"dup":1,"dup":2}']),
      s('status after the appends', ['status']),
      s('status of the other record', ['status', 'felt-cost']),
    ],
  },
  {
    name: 'repo.statusline',
    fixture: REPO,
    steps: [
      s('styled, every segment', ['statusline'], statusline()),
      s('--no-color', ['statusline', '--no-color'], statusline()),
      s('NO_COLOR env (empty value counts)', ['statusline'], statusline(), { env: { NO_COLOR: '' } }),
      s('--color with NO_COLOR: NO_COLOR wins', ['statusline', '--color'], statusline(), { env: { NO_COLOR: '1' } }),
      s('model name variants', ['statusline', '--no-color'], statusline({ model: { display_name: 'Claude Opus 5 (200k Context)' } })),
      s('sonnet', ['statusline'], statusline({ model: { display_name: 'Sonnet 5' } })),
      s('haiku', ['statusline'], statusline({ model: { display_name: 'Haiku 4.5' } })),
      s('unknown family', ['statusline'], statusline({ model: { display_name: 'GPT-5' } })),
      s('ctx at 70 and 90 thresholds', ['statusline', '--no-color'], statusline({ context_window: { used_percentage: 69.5 } })),
      s('ctx 90', ['statusline', '--no-color'], statusline({ context_window: { used_percentage: 90 } })),
      s('cache below 10k tokens: dim, no mark', ['statusline'], statusline({ context_window: { current_usage: { input_tokens: 500, cache_read_input_tokens: 400 } } })),
      s('cache share under 30%: warning mark', ['statusline'], statusline({ context_window: { current_usage: { input_tokens: 9_000, cache_read_input_tokens: 2_000 } } })),
      s('cache share 30-50%: no mark', ['statusline'], statusline({ context_window: { current_usage: { input_tokens: 6_000, cache_read_input_tokens: 4_500 } } })),
      s('usage at the top level', ['statusline', '--no-color'], statusline({ context_window: { used_percentage: 10 }, current_usage: { input_tokens: 1, cache_read_input_tokens: 99_999 } })),
      s('usage under cost', ['statusline', '--no-color'], statusline({ context_window: { used_percentage: 10 }, cost: { current_usage: { input_tokens: 50_000 } } })),
      s('zero denominator omits the cache segment', ['statusline', '--no-color'], statusline({ context_window: { current_usage: { input_tokens: 0, cache_read_input_tokens: 0 } } })),
      s('session homed in another record', ['statusline', '--no-color'], statusline({ session_id: SPEED_SESSION })),
      s('cwd only, no workspace', ['statusline', '--no-color'], statusline({ workspace: undefined })),
      s('no fields at all', ['statusline', '--no-color'], {}),
      s('unparseable stdin', ['statusline', '--no-color'], 'nope'),
      s('empty stdin', ['statusline', '--no-color']),
      s('--root form', ['statusline', '--no-color', '--root', '<ROOT>'], statusline({ workspace: { current_dir: '<HOME>' }, cwd: '<HOME>' })),
      s('directory outside any record', ['statusline', '--no-color'], statusline({ workspace: { current_dir: '<HOME>' }, cwd: '<HOME>' }), { env: {} }),
    ],
  },
  {
    name: 'repo.branch-elsewhere',
    fixture: REPO_ON_MAIN,
    steps: [
      s('bound record outpaced by others: the recent-work line', ['event', 'session-start'], start()),
      s('statusline', ['statusline', '--no-color'], statusline()),
      s('status', ['status']),
      s('register', ['event', 'post-tool'], edit('<ROOT>/x.ts')),
      s('prompt shows the in-sync push state', ['event', 'user-prompt'], prompt()),
      s('a session homed elsewhere sees no recent-work line', ['event', 'session-start'], start({ session_id: SPEED_SESSION })),
    ],
  },
  {
    name: 'repo.peers',
    fixture: REPO,
    steps: [
      s('register then prompt with two live peers, one ambiguous name', ['event', 'post-tool'], edit('<ROOT>/a.ts')),
      s('prompt with peers', ['event', 'user-prompt'], prompt(), {
        before: (m) => {
          const dir = join(m.home, '.claude', 'sessions')
          mkdirSync(dir, { recursive: true })
          const live = process.pid
          writeFileSync(join(dir, 'a.json'), JSON.stringify({ sessionId: RUST_CORE_SESSION, name: 'alpha', cwd: m.root, pid: live }))
          writeFileSync(join(dir, 'b.json'), JSON.stringify({ sessionId: SPEED_SESSION, name: 'alpha', cwd: join(m.root, 'elsewhere'), pid: live }))
          writeFileSync(join(dir, 'c.json'), JSON.stringify({ sessionId: 'conf-session', name: 'me', cwd: m.root, pid: live }))
          writeFileSync(join(dir, 'dead.json'), JSON.stringify({ sessionId: 'dead-session', name: 'ghost', cwd: m.root, pid: 2_147_483_646 }))
          writeFileSync(join(dir, 'bad.json'), '{"sessionId":"","name":"x"}')
          writeFileSync(join(dir, 'notjson.json'), 'nope')
        },
      }),
    ],
  },
  {
    name: 'repo.drive-nudge',
    fixture: REPO,
    steps: [
      s('nudge with gauge', ['event', 'post-tool'], edit('<ROOT>/a.ts'), {
        env: { SOFAR_DRIVE_NUDGE: '<ROOT>/nudge.json' },
        before: (m) => writeFileSync(join(m.root, 'nudge.json'), '{"ts":"2026-09-01T10:00:00.000Z","pct":83.6,"tokens":167000}\n'),
      }),
      s('nudge without detail', ['event', 'post-tool'], bash('npm test'), {
        env: { SOFAR_DRIVE_NUDGE: '<ROOT>/nudge.json' },
        before: (m) => writeFileSync(join(m.root, 'nudge.json'), 'not json'),
      }),
      s('nudge file missing: nothing', ['event', 'post-tool'], bash('npm test'), { env: { SOFAR_DRIVE_NUDGE: '<ROOT>/absent.json' } }),
      s('nudge delivered even when the tool is not recorded', ['event', 'post-tool'], hook('PostToolUse', { tool_name: 'Read', tool_input: {} }), {
        env: { SOFAR_DRIVE_NUDGE: '<ROOT>/nudge.json' },
        before: (m) => writeFileSync(join(m.root, 'nudge.json'), '{"pct":91}\n'),
      }),
    ],
  },

  // ---- benchmark cells ---------------------------------------------------
  ...(['calib-1', 'smoke-4-sofar', 'smoke-4-drive', 'round-1-sofar'] as const).map((name, i) => ({
    name: `cell.${name}`,
    fixture: cell(name, i === 0 ? CELL_SHA : i === 1 ? CELL_OLD : undefined),
    steps: [
      s('status', ['status']),
      s('session-start', ['event', 'session-start'], start()),
      s('statusline', ['statusline'], statusline()),
      s('statusline plain', ['statusline', '--no-color'], statusline()),
      s('Edit', ['event', 'post-tool'], edit('<ROOT>/src/app/page.tsx')),
      s('Bash', ['event', 'post-tool'], bash('pnpm test -- --run')),
      s('prompt', ['event', 'user-prompt'], prompt()),
      s('stop', ['event', 'stop'], stop()),
      s('session-end', ['event', 'session-end'], end()),
      s('status after', ['status']),
    ],
  })),

  // ---- synthetic ---------------------------------------------------------
  {
    name: 'syn.baseline',
    fixture: synthetic('baseline', { branch: 'main', head: CELL_SHA, upstream: CELL_OLD }),
    steps: [
      s('status', ['status']),
      s('session-start', ['event', 'session-start'], start()),
      s('prompt for the drifted session: nudge', ['event', 'user-prompt'], prompt({ session_id: 'sess-open' })),
      s('stop blocks the drifted session', ['event', 'stop'], stop({ session_id: 'sess-open' })),
      s('prompt for the written-back session', ['event', 'user-prompt'], prompt({ session_id: 'sess-done' })),
      s('stop passes the written-back session', ['event', 'stop'], stop({ session_id: 'sess-done' })),
      s('statusline', ['statusline', '--no-color'], statusline({ session_id: 'sess-open' })),
      s('worktree-style .git file', ['event', 'session-start'], start(), {
        before: (m) => {
          const gitdir = join(m.dir, 'gitdir')
          mkdirSync(gitdir, { recursive: true })
          writeFileSync(join(gitdir, 'HEAD'), 'ref: refs/heads/main\n')
          writeFileSync(join(m.root, '.git', 'HEAD'), 'ref: refs/heads/main\n')
        },
      }),
      s('Edit under a drifted session', ['event', 'post-tool'], edit('<ROOT>/src/module/file-9.ts', { session_id: 'sess-open' })),
      s('session-end', ['event', 'session-end'], end({ session_id: 'sess-open', reason: 'prompt_input_exit' })),
      s('status after', ['status']),
    ],
  },
  {
    name: 'syn.corrupt',
    fixture: synthetic('corrupt'),
    steps: [
      s('status: every warning on stderr', ['status']),
      s('session-start', ['event', 'session-start'], start()),
      s('append after the torn tail', ['event', 'post-tool'], edit('<ROOT>/src/b.ts', { session_id: 'sess-a' })),
      s('append through the CLI', ['event', 'append', '--type', 'note_added', '--payload', '{"text":"after corruption"}']),
      s('status after', ['status']),
      s('prompt', ['event', 'user-prompt'], prompt({ session_id: 'sess-a' })),
      s('stop', ['event', 'stop'], stop({ session_id: 'sess-a' })),
    ],
  },
  {
    name: 'syn.unicode',
    fixture: synthetic('unicode', { branch: 'feature/\u00fcn\u00efcode', head: CELL_SHA }),
    steps: [
      s('status', ['status']),
      s('session-start', ['event', 'session-start'], start({ session_id: 'sess-u' })),
      s('statusline with a non-ASCII model and dir', ['statusline', '--no-color'], statusline({ model: { display_name: 'Fable 5.1 \u{1F600} (1M context)' }, session_id: 'sess-u' })),
      s('Edit a non-ASCII path', ['event', 'post-tool'], edit('<ROOT>/src/\u65e5\u672c/\u{1F600}.ts', { session_id: 'sess-u' })),
      s('Bash with control characters and NBSP', ['event', 'post-tool'], bash('echo "a\u00a0b" \u2014 \u0001 && printf \'\\x7f\'', { session_id: 'sess-u' })),
      s('append a note with every JSON edge', ['event', 'append', '--type', 'note_added', '--session', 'sess-u', '--payload', '{"text":"\\u0000\\u001f\\u007f\\u0080\\u2028\\u2029\\ufeff\\ud83d\\ude00\\ud800\\udc00x","\\u00e9":1,"Z":2,"a":3,"\\ufb01":4,"\\ud83d\\ude00":5,"10":7,"9":8}']),
      s('prompt', ['event', 'user-prompt'], prompt({ session_id: 'sess-u' })),
      s('status after', ['status']),
    ],
  },
  {
    name: 'syn.budget',
    fixture: synthetic('budget'),
    steps: [
      s('session-start hits the 10,000 unit cap', ['event', 'session-start'], start()),
      s('status is uncapped', ['status']),
      s('statusline', ['statusline', '--no-color'], statusline()),
      s('prompt for an open session', ['event', 'user-prompt'], prompt({ session_id: 'budget-sess-11' })),
    ],
  },
  {
    name: 'syn.guards',
    fixture: synthetic('guards'),
    steps: [
      s('session-start lists the standing rules', ['event', 'session-start'], start({ session_id: 'sess-clean' })),
      s('Edit crossing the legacy guard', ['event', 'post-tool'], edit('<ROOT>/src/legacy/old.ts', { session_id: 'sess-clean' })),
      s('Edit the exempted file', ['event', 'post-tool'], edit('<ROOT>/src/legacy/README.md', { session_id: 'sess-clean' })),
      s('Edit outside the tree (relative path)', ['event', 'post-tool'], edit('src/legacy/deep/x.ts', { session_id: 'sess-clean' })),
      s('Edit a schema-guarded path', ['event', 'post-tool'], edit('<ROOT>/packages/engine/src/x.ts', { session_id: 'sess-clean' })),
      s('Bash crossing the publish guard', ['event', 'post-tool'], bash('npm publish --access public', { session_id: 'sess-clean' })),
      s('Bash matching the second pattern', ['event', 'post-tool'], bash('npm run release', { session_id: 'sess-clean' })),
      s('prompt reports the crossings', ['event', 'user-prompt'], prompt({ session_id: 'sess-clean' })),
      s('stop reports them too', ['event', 'stop'], stop({ session_id: 'sess-clean' })),
      s('the earlier session crossed before this run', ['event', 'user-prompt'], prompt({ session_id: 'sess-g' })),
      s('status', ['status']),
    ],
  },
  {
    name: 'syn.lifecycle',
    fixture: synthetic('lifecycle'),
    steps: [
      s('closed with overrides: banner', ['event', 'session-start'], start()),
      s('status of the closed record', ['status']),
      s('statusline on the closed record', ['statusline', '--no-color'], statusline()),
      s('superseded record names its successor', ['event', 'session-start'], start(), {
        before: (m) => writeFileSync(join(m.root, '.git', 'HEAD'), 'ref: refs/heads/renamed\n'),
      }),
      s('session homed on the superseded record while on the successor branch', ['event', 'session-start'], start({ session_id: 'sess-moved' }), {
        before: (m) => writeFileSync(join(m.root, '.git', 'HEAD'), 'ref: refs/heads/successor\n'),
      }),
      s('dropped record', ['status', 'abandoned']),
      s('binding to a slug with no directory', ['event', 'session-start'], start(), {
        before: (m) => writeFileSync(join(m.root, '.git', 'HEAD'), 'ref: refs/heads/ghost\n'),
      }),
      s('status on that binding', ['status']),
      s('binding that escapes the tree', ['status'], undefined, {
        before: (m) => writeFileSync(join(m.root, '.git', 'HEAD'), 'ref: refs/heads/escape\n'),
      }),
      s('a directory with no log yet', ['status'], undefined, {
        before: (m) => writeFileSync(join(m.root, '.git', 'HEAD'), 'ref: refs/heads/blank\n'),
      }),
      s('session-start on the empty record', ['event', 'session-start'], start()),
      s('append to the empty record', ['event', 'append', '--type', 'initiative_created', '--payload', '{"slug":"never-written","goal":"now written"}']),
      s('unbound branch: the notice', ['event', 'session-start'], start(), {
        before: (m) => writeFileSync(join(m.root, '.git', 'HEAD'), 'ref: refs/heads/unbound\n'),
      }),
      s('unbound statusline', ['statusline', '--no-color'], statusline()),
      s('unbound status', ['status']),
      s('unbound post-tool appends nothing', ['event', 'post-tool'], edit('<ROOT>/x.ts')),
      s('detached HEAD', ['status'], undefined, {
        before: (m) => writeFileSync(join(m.root, '.git', 'HEAD'), `${CELL_SHA}\n`),
      }),
      s('detached session-start', ['event', 'session-start'], start()),
      s('detached but the session is homed', ['event', 'session-start'], start({ session_id: 'sess-home' })),
      s('bindings.json is not JSON', ['status'], undefined, {
        before: (m) => {
          writeFileSync(join(m.root, '.git', 'HEAD'), 'ref: refs/heads/main\n')
          writeFileSync(join(m.root, '.sofar', 'bindings.json'), '{oops')
        },
      }),
      s('bindings.json is an array', ['event', 'session-start'], start(), {
        before: (m) => writeFileSync(join(m.root, '.sofar', 'bindings.json'), '[]'),
      }),
      s('binding value is not a string', ['status'], undefined, {
        before: (m) => writeFileSync(join(m.root, '.sofar', 'bindings.json'), '{"main": 42}'),
      }),
    ],
  },
  {
    name: 'syn.many',
    fixture: synthetic('many'),
    steps: [
      s('bound record while rec-10 was worked more recently', ['event', 'session-start'], start()),
      s('unbound notice lists ten and counts the rest', ['event', 'session-start'], start(), {
        before: (m) => writeFileSync(join(m.root, '.git', 'HEAD'), 'ref: refs/heads/other\n'),
      }),
      s('unknown slug names the available ones', ['status', 'rec-99']),
      s('session homed elsewhere', ['event', 'session-start'], start({ session_id: 'sess-elsewhere' }), {
        before: (m) => writeFileSync(join(m.root, '.git', 'HEAD'), 'ref: refs/heads/main\n'),
      }),
      s('conflicting edit across records', ['event', 'post-tool'], edit('<ROOT>/src/shared.ts')),
      s('prompt reports the cross-record conflict', ['event', 'user-prompt'], prompt()),
      s('statusline', ['statusline', '--no-color'], statusline()),
    ],
  },
  {
    name: 'syn.no-record',
    fixture: { git: { branch: 'main', head: CELL_SHA } },
    steps: [
      s('session-start with no .sofar', ['event', 'session-start'], start()),
      s('post-tool', ['event', 'post-tool'], edit('<ROOT>/x.ts')),
      s('user-prompt', ['event', 'user-prompt'], prompt()),
      s('stop', ['event', 'stop'], stop()),
      s('session-end', ['event', 'session-end'], end()),
      s('statusline', ['statusline', '--no-color'], statusline()),
      s('status', ['status']),
      s('append', ['event', 'append', '--type', 'note_added', '--payload', '{"text":"x"}']),
      s('nudge still delivered', ['event', 'post-tool'], edit('<ROOT>/x.ts'), {
        env: { SOFAR_DRIVE_NUDGE: '<ROOT>/nudge.json' },
        before: (m) => writeFileSync(join(m.root, 'nudge.json'), '{"pct":95,"tokens":190000}\n'),
      }),
    ],
  },
  {
    name: 'syn.no-git',
    fixture: { record: 'synthetic/baseline' },
    steps: [
      s('session-start without git', ['event', 'session-start'], start()),
      s('session-start homed by session id', ['event', 'session-start'], start({ session_id: 'sess-open' })),
      s('status', ['status']),
      s('status by slug', ['status', 'baseline']),
      s('statusline', ['statusline', '--no-color'], statusline({ session_id: 'sess-open' })),
      s('append by slug', ['event', 'append', 'baseline', '--type', 'note_added', '--payload', '{"text":"no git here"}']),
      s('post-tool homed by session', ['event', 'post-tool'], edit('<ROOT>/x.ts', { session_id: 'sess-open' })),
    ],
  },

  // ---- argv grammar: what the fast path owns and what it hands over --------
  {
    name: 'argv.fast-path',
    fixture: synthetic('baseline'),
    tags: ['full-cli'],
    steps: [
      s('bare event', ['event']),
      s('unknown hook name', ['event', 'wat'], start()),
      s('unknown flag on a hook', ['event', 'session-start', '--bogus'], start()),
      s('empty --root=', ['event', 'session-start', '--root='], start()),
      s('--root without a value', ['event', 'session-start', '--root'], start()),
      s('--root pointing at a flag', ['event', 'session-start', '--root', '--no-color'], start()),
      s('positional after a hook', ['event', 'session-start', 'extra'], start()),
      s('statusline with an unknown flag', ['statusline', '--weird'], statusline()),
      s('statusline --color', ['statusline', '--color'], statusline()),
      s('statusline --no-color --color', ['statusline', '--no-color', '--color'], statusline()),
      s('append without --type', ['event', 'append', '--payload', '{}']),
      s('append without --payload', ['event', 'append', '--type', 'note_added']),
      s('--version', ['--version']),
    ],
  },

  // ---- open decisions ----------------------------------------------------
  {
    name: 'open.O2-update-segment',
    fixture: synthetic('baseline'),
    tags: ['O2'],
    steps: [
      s('cache says a newer version exists', ['statusline'], statusline(), {
        before: (m) => {
          const dir = join(m.home, '.local', 'state', 'sofar')
          mkdirSync(dir, { recursive: true })
          writeFileSync(join(dir, 'update.json'), '{"version":1,"latest":"99.0.0","checked_at":"2026-09-01T00:00:00.000Z"}\n')
        },
      }),
      s('plain form', ['statusline', '--no-color'], statusline()),
      s('installed but not restarted', ['statusline', '--no-color'], statusline(), {
        before: (m) => {
          const dir = join(m.home, '.local', 'state', 'sofar')
          writeFileSync(join(dir, 'update.json'), '{"version":1,"latest":"99.0.0","checked_at":"2026-09-01T00:00:00.000Z","installed":{"version":"99.0.0","at":"2026-09-01T00:00:00.000Z"}}\n')
        },
      }),
      s('cache is up to date: no segment', ['statusline', '--no-color'], statusline(), {
        before: (m) => {
          const dir = join(m.home, '.local', 'state', 'sofar')
          writeFileSync(join(dir, 'update.json'), '{"version":1,"latest":"0.0.1","checked_at":"2026-09-01T00:00:00.000Z"}\n')
        },
      }),
      s('status prints the update line on stderr', ['status'], undefined, {
        before: (m) => {
          const dir = join(m.home, '.local', 'state', 'sofar')
          writeFileSync(join(dir, 'update.json'), '{"version":1,"latest":"99.0.0","checked_at":"2026-09-01T00:00:00.000Z"}\n')
        },
      }),
    ],
  },
  {
    name: 'open.O4-styled-status',
    fixture: synthetic('baseline'),
    tags: ['O4'],
    steps: [
      s('--color at 100 columns', ['status', '--color'], undefined, { env: { COLUMNS: '100' } }),
      s('FORCE_COLOR', ['status'], undefined, { env: { FORCE_COLOR: '1' } }),
      s('FORCE_COLOR=0 stays plain', ['status'], undefined, { env: { FORCE_COLOR: '0' } }),
      s('the big record styled', ['status', '--color'], undefined, { env: { COLUMNS: '120' } }),
    ],
  },
  {
    name: 'open.O5-commit-trailer',
    fixture: synthetic('baseline'),
    tags: ['O5'],
    steps: [
      s('registered session stamps the trailer', ['commit-trailer', '<ROOT>/msg-1'], undefined, {
        env: { CLAUDE_CODE_SESSION_ID: 'sess-open' },
        before: (m) => writeFileSync(join(m.root, 'msg-1'), 'fix: a thing\n\nbody line\n\n# Please enter the commit message\n# Lines starting with # will be ignored\n'),
        artifact: (m) => readFileSync(join(m.root, 'msg-1'), 'utf8'),
      }),
      s('scissors block', ['commit-trailer', '<ROOT>/msg-2'], undefined, {
        env: { CLAUDE_CODE_SESSION_ID: 'sess-open' },
        before: (m) => writeFileSync(join(m.root, 'msg-2'), 'feat: x\n# ------------------------ >8 ------------------------\n# Do not modify or remove the line above.\ndiff --git a/x b/x\n'),
        artifact: (m) => readFileSync(join(m.root, 'msg-2'), 'utf8'),
      }),
      s('already stamped', ['commit-trailer', '<ROOT>/msg-3'], undefined, {
        env: { CLAUDE_CODE_SESSION_ID: 'sess-open' },
        before: (m) => writeFileSync(join(m.root, 'msg-3'), 'feat: y\n\nSofar-Initiative: baseline\n'),
        artifact: (m) => readFileSync(join(m.root, 'msg-3'), 'utf8'),
      }),
      s('no session env: untouched', ['commit-trailer', '<ROOT>/msg-4'], undefined, {
        before: (m) => writeFileSync(join(m.root, 'msg-4'), 'chore: z\n'),
        artifact: (m) => readFileSync(join(m.root, 'msg-4'), 'utf8'),
      }),
      s('unregistered session: untouched', ['commit-trailer', '<ROOT>/msg-5'], undefined, {
        env: { CLAUDE_CODE_SESSION_ID: 'nobody' },
        before: (m) => writeFileSync(join(m.root, 'msg-5'), 'chore: w\n'),
        artifact: (m) => readFileSync(join(m.root, 'msg-5'), 'utf8'),
      }),
      s('missing message file', ['commit-trailer', '<ROOT>/msg-none'], undefined, { env: { CLAUDE_CODE_SESSION_ID: 'sess-open' } }),
    ],
  },
]
