# Hot-path contract inventory (rust-core 1.1)

Hand-written. Cite sections of THIS file with `§` (CLAUDE.md, the § rule);
cite tasks and decisions by id. docs/SPEC.md stays authoritative: where this
file and SPEC disagree, SPEC wins and the disagreement is a gap listed in
§SPEC gaps. Inventoried against engine 0.32.0 (`packages/engine`), schema
`packages/schema/src`, and SPEC as of commit 839bb53.

Purpose: the surface a Rust `sofar-core` must reproduce byte-for-byte
(rust-core D1) and the surface the conformance suite (rust-core 1.2) must
drive. Everything below is observable from OUTSIDE the process — argv, stdin,
env, files, subprocesses, stdout, stderr, exit code — or is a rule the
observable bytes depend on.

## Scope

IN (the hot path — fires per tool use, per prompt, per status-bar render):
- `sofar event session-start | post-tool | user-prompt | stop | session-end`
  (the five Claude Code hook shims, SPEC §Hooks)
- `sofar event append` (the MCP-less write surface, SPEC §CLI)
- `sofar statusline` (SPEC §CLI)
- `sofar status [slug]` (one-shot; `--watch` is interactive and OUT)

ADJACENT, not in the plan's list, decision needed (§Open decisions):
- `sofar commit-trailer <msgfile>` — git's prepare-commit-msg worker, fires
  per commit, shares `homeInitiative` with the hooks.

OUT: `init`, `doctor`, `new`, `switch`, `close`, `list`, `next`, `why`,
`related`, `find`, `drive`, `review`, `serve`, `mcp`, `upgrade`,
`update-check`, sync client, everything under `core/graph.ts`,
`core/index-reach.ts`, `core/lexicon.ts` (locked off the hot path already).

## Entry points and dispatch

`dist/cli.js` (`cli/boot.ts`) is a stub: `process.argv[2]` of `event` or
`statusline` loads `dist/fast.js` (`cli/fast.ts`); anything `runFast` does
not own falls through to `dist/full.js` (commander). The fast path owns
EXACTLY these argv shapes, with `--root <dir>` / `--root=<dir>` the only
option; any other token (or an empty `--root=`) returns false and the full
CLI reports the error:

| argv | handler |
| --- | --- |
| `event session-start [--root D]` | handleSessionStart |
| `event post-tool [--root D]` | handlePostTool |
| `event user-prompt [--root D]` | handleUserPrompt |
| `event stop [--root D]` | handleStop |
| `event session-end [--root D]` | handleSessionEnd |
| `statusline [--root D] [--no-color] [--color]` | runStatusline |

`event append …` is full-CLI only (commander: `--type` and `--payload`
required; `--session` default `cli`; `--source` default `cli`; `--actor`
default `agent`; optional positional `[slug]`; `--root`).

Root = `resolve(--root ?? cwd)`. Every handler returns `{exitCode, stdout,
stderr}`; `mirror` writes stdout verbatim, stderr with a trailing `\n`
appended if absent, and sets `process.exitCode` (never `process.exit`).
stdin: read to EOF as UTF-8; if stdin is a TTY, treated as empty string.

The integration seam for rust-core 3.1: `boot.ts` is the natural dispatch
point — the six shapes above are the whole Rust-owned surface, and `runFast`
returning false is already the fallback contract.

## Hook input (all five `event` subcommands)

stdin is Claude Code hook JSON. Parsed defensively: unparseable or non-object
→ `{}`; a field is used only when it is a NON-EMPTY string (`strField`), so
`"session_id": ""` reads as absent. Fields consumed:

| field | used by |
| --- | --- |
| `session_id` | all five; post-tool falls back to `cli` when absent |
| `source` (`startup`/`resume`/`clear`/`compact`) | session-start (cold-resume advisory needs `resume`) |
| `transcript_path` | session-start (stat for size only) |
| `tool_name`, `tool_input.file_path`, `tool_input.command` | post-tool |
| `stop_hook_active` (=== true) | stop |
| `reason` | session-end (default `unknown`) |
| `cwd`, `hook_event_name` | read by nothing |

BD22 law: every resolution failure — no `.sofar/`, no binding, bad stdin,
missing id, any thrown error — exits 0 with empty stdout/stderr. The ONE
non-zero exit is Stop's 2.

## Record resolution (shared)

`createToolContext(root)`: `sofarDir = root/.sofar`, `bindingsPath =
.sofar/bindings.json`, `initiativeDir(slug) = .sofar/initiatives/<slug>`,
`eventsPath = <dir>/events.jsonl`.

`resolveInitiative(explicit?)`: explicit wins; else branch from `.git/HEAD`
(worktree `gitdir:` file followed; detached → error) → `bindings.json[branch]`
(only string values count; invalid JSON / non-object → `io_error`). Then
containment: `resolve(initiativeDir(slug))` must equal `join(initiativesRoot,
slug)` and start with `initiativesRoot + sep` (rejects `..`, `/`, empty,
unicode separators) → else `unknown_initiative`. Then the directory must
exist → else `unknown_initiative` with the `available initiatives: a, b …
(details: sofar list)` suffix (≤10 named, `, …+N more`), or `no initiatives
exist yet — create one with \`sofar new <slug>\`` when none.

`resolveSessionFirst(ctx, sessionId)` (every hook, the statusline):
1. `branchSlug = resolveInitiative()` or null on any throw.
2. If sessionId non-empty: `home = homeInitiative(sofarDir, sessionId,
   branchSlug)`; if non-null → `{slug: home, via: home === branchSlug ?
   'branch' : 'session'}`.
3. Else `{slug: branchSlug, via: 'branch'}`, or null when both miss.

`homeInitiative`: `cli` and empty ids → null. Read `preferred`'s log first
(substring pre-filter on the id, then per-line JSON parse looking for
`type === 'session_started' && session === id`, taking its `ts`); then every
other slug from `initiativeSlugs` (readdir of `.sofar/initiatives`,
directories not starting with `.`, sorted), SKIPPING any log whose mtime is
older than the standing candidate's ts (`statSync.mtimeMs >= Date.parse(ts)`
keeps it; any stat/parse failure keeps it). LATEST `ts` wins (strict `>`);
ties keep `preferred`. Corrupt lines skipped.

Git facts (`core/git.ts`) are FILE reads only: `gitDir` (dir or `gitdir:`
pointer), `commonGitDir` (`commondir` pointer, relative to gitDir),
`currentBranch` (`ref: refs/heads/<b>` in HEAD, else null), `readRef`
(loose `refs/heads/<b>` / `refs/remotes/origin/<b>` as 40-hex, then
`packed-refs` lines `<sha> <ref>`). `readGitState` → `{branch, head(7),
headFull, upstream(7)|null, upstreamFull|null, synced}` or null.

## Per-command contract

### session-start

Reads: stdin; `.sofar/bindings.json`; `.git/*`; every `events.jsonl`
(homeInitiative scan, pruned by mtime); bound log (full fold); every OTHER
log's TAIL (16,384 bytes) for the recent-work line; `.sofar/repo.md`;
`transcript_path` (stat, resume only); Tier 1 index files; `shipwatch.json`.
Spawns: `git log`, `git rev-list` (shippingNotice, bounded 30 commits —
allowed here by commit-attribution D6, forbidden per prompt); no identity
spawn, because this hook never calls `makeEvent`.
Writes: `shipwatch.json` (noteUpstream mark, when session_id and git state
both resolve); `guards.json`/`graph.json` + their meta files (refreshNeighbours);
NEVER events.jsonl (lazy registration, record-hygiene D2).

stdout, exit 0 always:
- Nothing resolves AND repo has no `.sofar/initiatives` entries → empty.
- Nothing resolves but initiatives exist → the unbound notice (verbatim in
  `unboundNotice`, ≤10 slugs named, `, …+N more`), capped by `enforceStatusLimit`.
- Otherwise `preface + "\n\n" + status` (or `status` alone when the preface
  is empty), the composed output re-capped by `enforceStatusLimit`. Preface
  parts, in this order, joined by `\n\n`, each omitted when null:
  1. recent-work-elsewhere line (`via === 'branch'` only; strictly newer
     tail among other logs whose newest event is not
     `initiative_status_changed`; clipped to 480; uses `Date.now()` for the
     `Nm`/`Nh`/`Nd` labels),
  2. closed banner (status ∈ done|dropped|superseded; superseded names the
     successor; up to 3 overrides then `(+N more — \`sofar status <slug>\`)`),
  3. cold-resume advisory (`source === 'resume'`, transcript ≥ 80,000 bytes,
     last parseable event ts older than 3,600,000 ms; `~Nh`/`~Nd` and
     `~Nk tokens` = bytes/4000, uses `Date.now()`),
  4. shipping notice (`unverified`, or `NOT on origin yet`; null when
     everything pushed or on any failure).
- `status = renderStatus(state, {repoMemory?, sessionId?, git?,
  neighbours?})` — §Status block.

### post-tool

Reads: stdin; env `SOFAR_DRIVE_NUDGE` (+ the file it names); resolution as
above; bound log (fold, only when appending); `guards.json` refresh (every
edit); `graph.json` refresh (only when a guard matched a path subject).
Spawns: `git config user.email` once per process on the first `makeEvent`.
Writes: `events.jsonl` (append), the four projections (§Projection files),
index files.

Logic, in order:
1. `session = session_id ?? 'cli'`; `nudge = readNudge()` → nudge line first
   (delivered even when the record does not resolve).
2. Unresolved → stdout is the nudge context or empty; exit 0.
3. `tool_name`: `Edit|MultiEdit|Write` with `file_path` → `file_touched
   {path, op: Write→'write' else 'edit'}`, domain `path`, subject = path.
   `Bash` with `command` → `command_run {cmd: redactCommand(command)}`,
   domain `cmd`, subject = the REDACTED cmd; `exempt =
   isSelfRecordingCommand(RAW command)`. Any other tool or missing field →
   nudge-only output.
4. Guard notice computed BEFORE the append (§Guards on the hot path).
5. Unless exempt: fold; if `session !== 'cli'` and not registered → append
   `session_started {tool: 'claude-code'}` with `{session, source: 'hook'}`
   (actor `agent`); then append the event. Each append regenerates
   projections.
6. stdout: empty when no lines; else ONE line
   `{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"<lines joined by \n>"}}\n`
   with nudge line(s) first, guard lines after. Exit 0 always.

Self-recording exemption (`shellSegments`): split at `&&`, `||`, `;`, `|`,
`\n`, and a lone `&` not preceded by `>`/`<`, counting separators only
outside quotes; `'…'` literal; inside `"…"` and unquoted, `\` escapes the
next char; any backtick or `$(` anywhere (outside single quotes) → cannot
scan → LOGGED; unbalanced quote → LOGGED. Exempt iff ≥1 non-blank segment
and EVERY segment's leading token (skipping `NAME=value` words, basename of
a path) ∈ {`git`, `sofar`}.

Redaction (`core/redact.ts`, applied in order): `NAME=value` where NAME
contains TOKEN|SECRET|PASSWD|PASSWORD|API[_-]?KEY|PRIVATE[_-]?KEY|ACCESS[_-]?KEY|CREDENTIAL|AUTH|OTP|SESSION|COOKIE|BEARER
(case-insensitive) → `NAME=[redacted]`; `--flag=value` / `-f value` of the
same names; `authorization:`/`proxy-authorization:` header values (scheme
kept); `scheme://user:pw@` → `scheme://user:[redacted]@`; bare token shapes
(`sk-`, `sfr_`, `gh[pousr]_`, `github_pat_`, `xox[abprs]-`, `AKIA…`,
`AIza…`, JWT `eyJ….….`) → `[redacted]`. Regex classes are JS non-unicode
semantics (§Text-semantics pins).

### user-prompt

Reads: stdin; resolution; bound log (fold); `open.json` + `meta.json`
refresh (Tier 0, every prompt); `~/.claude/sessions/*.json` (or
`$CLAUDE_CONFIG_DIR/sessions`), liveness via `kill(pid, 0)`; `.git/*`;
`shipwatch.json`. Spawns: NONE on a quiet prompt (commit-attribution D6,
pinned by counting spawns); `git log` (bounded 100) ONLY when
`origin/<branch>` moved since this session's mark. Writes: `shipwatch.json`
(every prompt: noteUpstream refreshes `seq`; noteEngine writes only on
change); `open.json`/`meta.json` when logs grew; NEVER events.jsonl.

Silent (exit 0, empty) when: no session_id; unresolved; session not
registered in the bound log. Otherwise stdout = lines joined by `\n` (no
trailing newline added by the handler; `mirror` adds none to stdout), in
THIS order (each omitted when null/empty):
1. guard-crossing lines (`sessionGuardViolations(state, me, me.ended)`,
   ≤2 rules, ≤3 subjects each, `(+N more)`, overflow line names `sofar doctor`)
2. live file-conflict line (≤3 paths, `(+N more)`, clip 300)
3. cross-initiative conflict line (Tier 0; ≤3, clip 320)
4. reachable-peer line (≤3 names, ambiguous → `"name" (in <cwd>)`, clip 300)
5. parallel-wrap line (siblings ended with summary, `ended >= (me.ended ??
   me.started)`, newest first; clip 420 with next_action reserved first)
6. engine-changed line (clip 320; compares `shipwatch.json` mark to the
   running version)
7. landed line (≤3 shas, `, +N more`, `at least N` when the walk hit 100;
   clip 300) then the push-ping line (≤2 records, clip 340; only when a
   registry names a live peer)
8. push-state line (unconditional when git resolves): `sofar: <branch> @
   <head>, pushed (in sync with origin/<b>).` | `NOT pushed (origin/<b> at
   <tip>).` | `never pushed.`
9. drift nudge when `sessionDebt >= 5`: `sofar: N unwritten events in THIS
   session — if the current batch of work is complete, write back now with
   sofar_end_session (summary + next action) while context is warm; an
   unwritten session gets force-blocked at Stop.`

### stop

Reads: stdin; resolution; bound log (fold). Writes: nothing. Spawns: none.
- `stop_hook_active === true` → 0.
- no session_id / unresolved / session not registered / `session.summary`
  set → 0.
- `sessionDebt(state, session) === 0` → 0. A throw or NaN inside the debt
  computation FAILS CLOSED (block).
- else exit 2, stdout empty, stderr = `Write back to the sofar record before
  finishing: call sofar_end_session (or append session_ended via \`sofar
  event append\`).` followed by guard-crossing lines (same renderer as
  user-prompt), `\n`-joined.

### session-end

Reads: stdin; resolution; bound log (fold). Writes: `events.jsonl` +
projections when it appends. Spawns: `git config user.email` on append.
No session_id / unresolved / session unknown / `session.ended` set → 0,
nothing. Else append `session_closed {reason: hook.reason ?? 'unknown'}`
with `{session, source: 'hook'}`. Exit 0 always.

### event append

NOT best-effort. Validates `--source` ∈ SOURCES, `--actor` ∈ ACTORS,
`--session` non-empty, `--payload` parses to a JSON object → else exit 1
with `{"code":"invalid_input","message":…}\n` on stderr, nothing appended.
Resolves slug (positional wins, else branch; `ToolError` → its shape on
stderr, exit 1). `appendAndProject` validates the payload against the
type's schema (`unknown_event` for an unknown type, `invalid_input` with
`errors[]` otherwise), appends, regenerates projections. Success: stdout
`{"ok":true,"event_id":"<ulid>"}\n`, exit 0. Non-`ToolError` throws →
`{"code":"io_error","message":…}`. Error shapes: `{code, message,
errors?}` with code ∈ invalid_input|unknown_initiative|unknown_tool|
unknown_event|io_error.

### statusline

stdin: Claude Code statusline JSON, parsed like hook JSON. Fields:
`model.display_name`, `workspace.current_dir`, `cwd`, `session_id`,
`context_window.used_percentage`, usage object = first of
`current_usage` / `context_window.current_usage` / `cost.current_usage`
carrying any of `cache_read_input_tokens` / `cache_creation_input_tokens` /
`input_tokens`.

Caps: `--no-color` or `NO_COLOR` present (any value) → plain; else FORCED
styled `{color: true, unicode: true}` regardless of TTY. Segments, each
omitted when its input is missing, joined by ` · ` (styled: the dot is
`dim`):
1. model: `display_name` with `\s+context` before `)` removed
   (`/\s+context(?=\s*\))/gi`); styled by family — contains `fable` →
   bold(accent), `opus` → accent, `sonnet` → info, `haiku` → success, else
   bold.
2. dir/branch: `basename(workspace.current_dir ?? cwd)`; branch from a
   bounded (32-level) upward walk for `.git` (dir or `gitdir:` file) reading
   `HEAD` `ref: refs/heads/<b>`. Styled: `warn(dir)` then `blue(branch)` as
   SEPARATE segments; plain: `dir:branch` or `dir`.
3. record: candidates `[root, workspace.current_dir, cwd]`, first where
   `resolveSessionFirst` resolves → `<pie> <slug> <done>/<total>[ (N
   dropped)]` (`total > 0`) or bare slug; pie ○◔◕● by `(done+dropped)/total`
   (ties round down; `pieFor`), colored success when all resolved, warn when
   some, dim when none; closed record → dim slug + ` <status>`. If no
   candidate resolves but any candidate's `.sofar/initiatives` is non-empty
   → `dim('unbound')`. Else no segment.
4. ctx: `dim('ctx') + ' ' + <round(pct)>%` toned success <70, warn ≥70,
   error ≥90.
5. cache: share = read/(read+creation+input); denom ≤ 0 → omitted; `cache
   <round(share*100)>%` + ` ✓` (≥50%) / ` ⚠` (<30%) once denom ≥ 10,000,
   toned success/error; below 10,000 tokens: dim, no mark; 30–50%: no mark,
   no tone.
6. update segment: reads `$XDG_STATE_HOME/sofar/update.json` (default
   `~/.local/state/sofar/update.json`); `↑<latest>` / `↻<latest>` (glyphs)
   or `update <v>` / `restart for <v>` (plain), `info`-toned; absent when up
   to date. SIDE EFFECT: when the cache is stale (>24h, missing, unparseable
   or future `checked_at`) and the binary is a global-npm install and none
   of `SOFAR_NO_UPDATE_CHECK`/`CI`/`VITEST`/`NODE_ENV=test` are set, it
   REWRITES the cache (claim) and spawns `node <dir>/cli.js update-check
   --refresh` detached. See §Open decisions.

Output: the line + `\n` when non-empty, nothing otherwise; exit 0 always;
never appends. ANSI codes: bold `\x1b[1m`/`\x1b[22m`, dim `\x1b[2m`/
`\x1b[22m`, success 32, error 31, warn 33, info 36, accent 35, blue 34 (all
closed by `\x1b[39m`), with picocolors nested-close re-opening.

### status

`sofar status [slug] [--root D]` (full CLI). Resolution: explicit slug wins,
else branch binding; `ToolError` → stderr `sofar status: <msg> (usage: sofar
status [slug])`, exit 1. Missing log → `emptyState()` with slug filled. Fold
warnings → stderr, one `warning: <w>` per line, exit stays 0. stdout:
`renderFullStatus(state)` when color is OFF (the agent-readable bytes, the
byte-identity target); when color is on (stdout TTY not `dumb`, or
`FORCE_COLOR`/`--color`, and no `NO_COLOR`/`--no-color`), the
`cli/ui/layout.ts` styled renderer at full zoom, width from the terminal —
a large second renderer (§Open decisions). `withUpdateNotice` appends the
update line to STDERR only, when the cache says so.

### commit-trailer (adjacent)

`sofar commit-trailer <msgfile> [--root D]`: exit 0 on every path.
`CLAUDE_CODE_SESSION_ID` absent → no-op; `resolveForCommit` = branch binding
as `preferred` → `homeInitiative`; null → no-op (never guesses); reads the
message, inserts `Sofar-Initiative: <slug>` above git's comment block /
scissors line unless already present; writes the file back.

## Event envelope and log I/O

Envelope (SPEC §Event envelope) fields in this fixed order: `v`(1), `id`
(26-char Crockford ulid, `[0-9A-HJKMNP-TV-Z]{26}`), `ts`, `initiative`,
`session`, `source` ∈ claude-code|opencode|codex|cli|hook, `actor` ∈
agent|human, `user`? (omitted when absent; when present non-empty),
`type`, `payload` (object). Unknown extra envelope keys are preserved after
`payload`, sorted by code point.

Minting (`makeEvent`): `id` from a MONOTONIC ulid factory (same-millisecond
ids strictly increase within a process); `ts = new Date().toISOString()` —
always `YYYY-MM-DDTHH:MM:SS.mmmZ`; `user = git config user.email` via a
`git` SUBPROCESS (`execFileSync`, stdin ignored, 2,000 ms timeout, cached
per process; empty/failed → field omitted). This spawn happens on every
hook process that appends (post-tool, session-end, append).

Validation (`validateEnvelope`): `ts` must match
`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$` AND
`Date.parse` it; `initiative`/`session`/`type` non-empty strings; `payload`
a plain object. Errors are `field: message` joined by `; `.

Canonical serialization (`serializeEvent`): envelope keys in the order
above, extras sorted; `payload` and every nested object with keys sorted by
Unicode CODE POINT (not UTF-16 unit); arrays in order; no whitespace;
scalars EXACTLY as `JSON.stringify` (number formatting per ECMAScript
`Number::toString`; strings escape `"` `\\` and control chars U+0000–U+001F
as `\b \f \n \r \t` or `\u00xx` lowercase hex, lone surrogates as `\udxxx`,
nothing else escaped); `undefined` values dropped from objects, `null` in
arrays. One line + `\n`, written with ONE `write()` on an fd opened
`O_WRONLY|O_CREAT|O_APPEND` mode 0644, parent dirs created; a short write
throws. Every event is validated before any write in a batch.

## Fold

`foldLog(path)` = `foldLines(readFileSync(path,'utf8').split('\n'),
basename(dirname(path)))`. Pass 1 (`decodeLines`): per line, `trim()`;
blank → skip silently; `JSON.parse` failure → warning `line N: unparseable
JSON — skipped (torn or corrupt line)`; envelope failure → `line N: invalid
envelope (<detail>) — skipped`. Collect `voided` = `ref` of every
payload-valid `correction`. STABLE sort by `id` (code-unit compare;
duplicates keep file order). Warnings stay in file order.

Pass 2 per event in id order: `state.cursor = id` (even if voided); voided
→ skip; unknown type → `line N: unknown event type "T" — skipped`;
`plan_updated` → coerce unknown phase/task statuses to `pending` with
`line N: <path> ("<subject>") has status "<s>", which this build does not
know — counted as pending; upgrade sofar to read it correctly`; payload
invalid → `line N: invalid <type> payload (<errs joined ; >) — skipped`;
record `seenSessions` (≠ `cli`); `plan_updated` omitted-status warning
`line N: <path> ("<subject>") was <was> and this plan omits its status —
counted as pending; restate a status to keep it` (present entry, no
`status` key, prior status done|dropped); `applyEvent`; emit edges
(`edgesForEvent` against tasks active AFTER apply); `recordFreshness`;
`recordGuardViolations`; orphan candidate for a `task_status_changed`
whose id is not in the plan.

`applyEvent` rules and warnings (verbatim text matters for `sofar status`
stderr): `phase "<name>" not in plan — created implicitly`; `task "<id>"
already exists — task_added skipped`; `task "<id>" not found —
task_status_changed skipped`; `run "<id>" already started — skipped`;
`handoff for run "<id>" that never started — skipped`; `run "<id>" stopped
without run_started — skipped`; `run "<id>" already stopped — skipped`;
`stop requested for run "<id>" that never started — skipped`; `session
"<id>" already started — skipped`; `session "<id>" ended without
session_started — stub created` (tool `unknown`); `session "<id>" closed
without session_started — skipped`. Each prefixed `line N: `.
`session_ended` targets `payload.session_id ?? envelope.session`, sets
`ended/summary/next_action` (last wins) and `current.next_action`;
`session_closed` sets `ended` + `closed_reason` only if `ended` unset;
`initiative_status_changed` overwrites status/status_ts/status_note/
status_overrides/successor; `phase_status_changed` sets or DELETES
`phase.note`; `task_status_changed` maintains `blockNotes` and
`drop_notes`; `decision_logged` pushes `{id, ts, chose, over, because,
rule?, guard?}`; `file_touched` dedupes into `files_touched` in first-touch
order; `command_run`/`note_added`/`correction` change no state.

Post-pass: `task_files = taskFilesFromEdges` (most-recent-first, dedupe,
cap 20); `activity` attached to REGISTERED sessions only (files first-touch
order cap 20 + `+N more` sentinel, commands count, task_changes `<id> →
<status>` cap 20 + sentinel); `deriveCurrent` (first `active` phase;
`blocked_on` = `phase <name>` / `task <id>: <note>` / `task <id> (<title>)`
joined by `; `); orphans = candidates whose id the FINAL plan lacks;
`unregistered_sessions` sorted.

Freshness: `session_ended` resets the struct (keeps `last_writeback_ts`)
and zeroes the named session's `unwritten`; file_touched/task_status_changed/
phase_status_changed/note_added/decision_logged/memory_promoted/
review_recorded count as mutations (initiative counter + the registered
session's `unwritten`, else `unattributed_mutations`); `command_run` counts
`commands` only; driver events count nothing; notes keep `{ts, text}`.
`freshnessTotal` = files+tasks+phases+notes+decisions+memories+reviews;
`sessionDebt` = `session.unwritten + unattributed_mutations`.

Guards (`recordGuardViolations`): for file_touched (domain path, subject
path) / command_run (domain cmd, subject cmd), test every decision logged
BEFORE this event that has both `rule` and `guard`; compiled specs cached;
dedupe key `<decisionIndex> <session> <subject>`; cap 100.
Grammar and matching: `packages/schema/src/guards.ts` (`path:` anchored
`(?:^|/)<body>$`, trailing `/` → `/**`, `*` → `[^/]*`, `**/` → `(?:.*/)?`,
`**` → `.*`, `?` → `[^/]`; `cmd:` unanchored, `*` → `.*`, `?` → `.`;
leading `!` exempts, exemptions win; ≤400 chars, ≤12 patterns, ≥1 positive).

Derived read-side functions the surfaces call: `standingRules`,
`sessionGuardViolations(state, id, since)` (strictly `ts > since`),
`staleActivePhases`, `openSessionFiles(state, alsoLive?)` (skips `+`
sentinel), `openSessionFileConflicts`, `overlappingWritebacks`,
`latestRun`, `reviewWatermark`, `openFindings`.

## Projection files (regenerated on every append)

`regenerateProjections(dir, foldState(slug))` after each append — so a
post-tool that registers a session writes twice. Each file is written via
temp + rename ONLY when its bytes differ. `plan.md`, `decisions.md` always;
`memory.md` only when `memories.length > 0`; `sessions/<id>.md` for every
session, filename `id.replace(/[^A-Za-z0-9._-]/g, '_') + '.md'`. Every file
starts `<!-- generated by sofar — do not hand-edit; truth lives in
events.jsonl -->` + blank line; `doc()` strips trailing newlines and adds
exactly one. Templates: `projections/templates/{plan,decisions,memory,
session}.ts` — short, port verbatim.

## Status block (`renderStatus`) and full status

`renderStatus(state, opts)` is the SessionStart injection and the
`get_state` digest; byte-stable for an unchanged record (SPEC §Architectural
invariants). Section order: `# Sofar status: <slug>` · `Session: <id> —
when calling sofar_start_session, pass this as session_id.` · `Git: <b> @
<head> — <sync>` · `Goal:` · standing constraints · `Progress:` · `Active
phase:` / `Current task:` (+ `  files: …`) / `Next task:` · `Next action:`
· parallel write-backs · staleness line · notes · `Blocked on:` ·
concurrent edits · adjacent records · blank · repo memory · `Phases:` (open
≤12, `- done: …`, `- dropped: …`) · `Last session (…)` · `Driven:` ·
derived unwritten session · other unwritten sessions · `Recent decisions`
(last 5) · `Rejected approaches — do NOT re-propose (N):` · `Read-back: …`
· `(generated by sofar — full detail in plan.md, decisions.md, sessions/)`.

Budgets (chars = UTF-16 units, §Text-semantics pins):

| constant | value |
| --- | --- |
| STATUS_CHAR_LIMIT / marker | 10,000 / `…truncated — run sofar status for full detail` |
| REPO_MEMORY_CHAR_BUDGET / marker | 1,500 / `…truncated — read .sofar/repo.md for the rest` |
| SESSION_ID 120 · GOAL 600 · TASK_LINE 200 · NEXT_ACTION 500 · BLOCKED 500 | |
| PHASE_LINE 100 · MAX_PHASE_LINES 12 · DONE_PHASES_LINE 220 | |
| SESSION_SUMMARY 1,200 · DERIVED_SESSION 600 · UNWRITTEN_SIBLING_CAP 5 | |
| DECISION_LINE 280 · MAX_DECISIONS 5 · REJECTED_OVER_LINE 90 · REJECTED_LEDGER 2,800 | |
| STANDING_LEDGER 2,000 · CONFLICT_LINE 200 · MAX_CONFLICT_LINES 8 | |
| STALENESS_LINE 200 · PARALLEL_LINE 260 · MAX_PARALLEL_LINES 3 | |
| NOTE_LINE 200 · MAX_NOTES 5 · TASK_FILES_LINE 300 · MAX_TASK_FILES 8 | |
| NEIGHBOUR_LINE 200 · MAX_NEIGHBOURS 3 · DRIVEN_LINE 300 | |

`clip(text, max)`: collapse `\s+` → space, trim; over budget → first
`max-1` units + `…`. `clipBlockDetect` keeps lines, cuts to `budget -
len("\n"+marker)`, `trimEnd`, appends marker. `enforceStatusLimit` cuts to
`10000 - len("\n"+marker+"\n")` and appends. `pct` floors, never 100 while
work remains; `progressText` two forms (drops present or not).

`renderFullStatus` (plain `sofar status`) is uncapped: `# <slug>`,
`Status:` (closed only) + overrides, `Goal:`, standing constraints,
`Progress:`, `Phases:` with `[x]/[~]/[!]/[ ]/[-]` task marks and the stale
phase bracket, `Next action:`, parallel write-backs, `Blocked on:`,
`⚠ Staleness:`, notes (full ts), concurrent edits, last session, `Driven
(N runs):` with permissions/allow/deny and handoffs, `Files touched (N):`.

## Derived index on the hot path

`.sofar/.index/` (created on demand with a `.gitignore` of `*`). Any file
absent/unreadable/malformed/wrong-version → cold start, never a wrong
answer. `INDEX_SCHEMA_VERSION = 5` on every tier and meta file. Files and
who touches them on the hot path:

| file | reader/writer on hot path |
| --- | --- |
| `meta.json` + `open.json` (Tier 0: slug → session → files\|null) | user-prompt (refresh) |
| `meta-guards.json` + `guards.json` (every guarded decision + decision counts per slug) | post-tool (every edit), session-start |
| `meta-graph.json` + `graph.json` (slug → path → session → [ts, touches]) | post-tool (after a path match), session-start |
| `shipwatch.json` (`{version: 2, marks: {sid: {branch, upstream\|null, engine?, seq}}}`, ≤64 marks by `seq`) | session-start, user-prompt |

Cursor: `{id, offset(bytes, line START), size, mtimeMs, maxId?, voided?}`;
untouched log (size AND mtimeMs equal) → skip; usable cursor → seek,
corroborate the first line's id, else full read; out-of-ulid-order tail or
a correction reaching back → full read; a slug with a cursor but no state →
full read. Reducers: `index-tier0.ts` `apply`, `index-tier1.ts`
`applyGuard`/`applyFile`; JSON written with `JSON.stringify` + `\n`.

## Files read and written (hot path)

READ: `.sofar/bindings.json`; `.sofar/repo.md`; every
`.sofar/initiatives/*/events.jsonl` (bound: full; others: registration scan
with mtime pruning; tails for recency); `.git` / `.git/HEAD` /
`refs/heads/*` / `refs/remotes/origin/*` / `packed-refs` / `commondir`;
`transcript_path` (stat); `$SOFAR_DRIVE_NUDGE`; `~/.claude/sessions/*.json`;
`$XDG_STATE_HOME/sofar/update.json`; index files above.
WRITTEN: `events.jsonl` (append); `plan.md`, `decisions.md`, `memory.md`,
`sessions/<id>.md` (atomic, if-changed); index files (atomic, silent on
failure); `update.json` (statusline claim, temp+rename); the git commit
message file (commit-trailer).

## Environment variables

| var | where |
| --- | --- |
| `NO_COLOR` (presence) | statusline plain mode; status caps |
| `FORCE_COLOR`, `TERM`, `CI` | status caps ladder (NO_COLOR > --no-color > FORCE_COLOR=0 off > FORCE_COLOR/--color on > TTY&&TERM!=dumb > CI when TTY) |
| `SOFAR_DRIVE_NUDGE` | post-tool nudge file path |
| `CLAUDE_CONFIG_DIR` | peer registry dir (`<dir>/sessions`), default `~/.claude/sessions` |
| `HOME` (homedir) | registry, update cache defaults |
| `XDG_STATE_HOME` | update cache path |
| `SOFAR_NO_UPDATE_CHECK`, `CI`, `VITEST`, `NODE_ENV=test` | suppress the update refresh spawn |
| `CLAUDE_CODE_SESSION_ID` | commit-trailer only |
| `GIT_CONFIG_*`, git's own env | inherited by the `git config user.email` spawn |
| `XDG_CONFIG_HOME` | refresh child only (auto-upgrade preference) |

## Subprocesses on the hot path

| spawn | when |
| --- | --- |
| `git config user.email` (2 s timeout) | first `makeEvent` in a process: post-tool (non-exempt), session-end, append |
| `git log --no-color --max-count=30 --format=<RS>%H<US>%(trailers:key=Sofar-Initiative,valueonly,separator=%x2C)<US>%B [range]` and `git rev-list origin/<b>..HEAD` | session-start shipping notice |
| `git log … --max-count=100 <prev>..<upstream>` (or `<tip> --not --exclude=origin/<b> --remotes=origin` on a first push) | user-prompt, ONLY when the mark says origin/<b> moved |
| `node <dir>/cli.js update-check --refresh` (detached) | statusline / status, ≤ once per 24 h |
| `kill(pid, 0)` | user-prompt peer liveness (not a spawn) |

## Text-semantics pins (JS behaviours the bytes depend on)

These are not in SPEC and every one of them decides byte identity. The Rust
core must reproduce the JS semantics, NOT the Rust defaults:
- P1 LENGTH AND SLICING are in UTF-16 code units. "chars" in SPEC (10,000
  cap, every budget) means UTF-16 units; `slice(0, n)` can cut a surrogate
  pair and Node then emits U+FFFD for the lone half.
- P2 `\s` (clip's collapse, `leadingToken`'s split, `trim()`) is JS
  WhiteSpace ∪ LineTerminator: includes U+FEFF and U+00A0, U+1680,
  U+2000–U+200A, U+2028, U+2029, U+202F, U+205F, U+3000.
- P3 Regex classes in `redact.ts`, `guards.ts`, `shellSegments`,
  `matchRecordedPaths`, the statusline model regex are JS NON-unicode mode:
  `\b`/`\w` are ASCII, `.` excludes `\n \r    `, `i` flag uses
  simple case folding.
- P4 Sorting: `parsed.sort` by id and `compareCodePoints` are code-point
  order, BUT conflicts, cross-conflict holders, Tier 0 flattening, peers'
  ambiguity and several listings use `localeCompare` (ICU root collation:
  base letters compare first and case only as a tertiary difference, so
  `a < A < b`; punctuation sorts before digits before letters — none of
  which is code-point order). Ordering of sorted output lines depends on it.
- P5 JSON numbers serialize per ECMAScript (`1e+21`, `1e-7`, no `.0`,
  shortest round-trip); `JSON.parse` accepts lone-surrogate escapes and
  keeps last-wins on duplicate keys; big integers lose precision to f64.
- P6 `Date.parse` leniency in `lastEventMs`, `newestIn`, `modifiedAfter`
  (any V8-parseable date, not just the envelope regex).
- P7 `path.relative(root, subject)` (Node semantics) for guard subjects;
  `basename` for the statusline dir.
- P8 `Math.round` is round-half-up toward +∞ (`-0.5 → -0`), used for
  percentages and the `~Nh` labels.
- P9 ISO timestamps: `toISOString()` millisecond precision, `Z` suffix.

## SPEC gaps

Found while inventorying; each needs either a SPEC edit or a Decision
before rust-core 1.2 can pin it:
- G1 §Derived index says `INDEX_SCHEMA_VERSION (4)`; the code writes 5.
- G2 §Hooks names THREE different lines as "FIRST" on UserPromptSubmit
  (guard crossings "rendered first", the file-conflict line "FIRST, ahead
  of parallel-wrap", the engine-changed line "FIRST of all"). The code's
  actual order is §Per-command contract, user-prompt (guards, conflicts,
  peer, wrap, engine, landed, ping, push, nudge). SPEC must state one order.
- G3 §Hooks, SessionStart: the preface composition order (recent-work,
  closed banner, cold-resume advisory, shipping notice, then the block) is
  only partially stated; the closed banner's position and the `\n\n` joiner
  are unspecified.
- G4 §Hooks/§CLI never state that "chars" means UTF-16 code units (P1) nor
  any of P2–P9. SPEC §Event envelope's "exactly as JSON.stringify emits
  them" is the only text-semantics pin that exists.
- G5 `sofar event append` failure output stream (stderr) is unspecified in
  §CLI; success stream (stdout) is implied.
- G6 SessionEnd's default `reason` (`unknown`) and the `""`-is-absent rule
  for every hook field are unspecified.
- G7 Two `Date.now()` reads (recent-work labels, cold-resume advisory)
  make session-start output time-dependent; SPEC pins byte-stability of the
  BLOCK only. A conformance suite needs an injectable clock — no env var or
  flag exists for it.
- G8 `makeEvent` spawns `git` on every appending hook process; SPEC
  §Commit attribution's "no subprocess on the hot path" law names
  core/git.ts and attribution, not identity. Either an exemption or a
  file-read implementation of `user.email` (with git's precedence) must be
  written down.
- G9 The `file_touched.op` vocabulary (`edit`|`write`, MultiEdit → `edit`)
  is not in §Event types.
- G10 The statusline's update-segment SIDE EFFECT (cache claim write +
  detached `node cli.js` spawn) is described under §Update check but
  §CLI's statusline entry calls it "a CACHE READ, never a network call" —
  true of the network, false of the write and spawn.
- G11 `sofar status` styled output (`cli/ui/layout.ts`, `text.ts`) is
  described in §CLI UI by rules, not bytes; there is no plain-vs-styled
  parity anchor other than "plain is byte-identical to renderFullStatus".
- G12 The fast-path argv grammar (which shapes `runFast` owns, `--root=`
  form, fall-through) exists only in code comments (speed-2 T1).
- G13 `unboundNotice`'s text and its `≤10 slugs` cap are documented under
  initiative-lifecycle in prose spread across §MCP tools; §Hooks does not
  mention that SessionStart prints it.
- G14 `homeInitiative`'s mtime-pruning rule (`mtimeMs >= Date.parse(ts)`,
  failures keep the log) is a correctness-affecting optimisation absent
  from SPEC §Hooks/§State.
- G15 Peer registry file shape (`{sessionId, name, cwd, pid}`), the
  128-file scan cap, and `kill(pid, 0)` liveness are code-only
  (peer-messaging notes them as undocumented host behaviour).

## Open decisions (for the run owner)

- O1 Sort collation (P4): keep ICU `localeCompare` (Rust would need ICU or
  a vendored root collation) or switch BOTH implementations to code-point
  order in 1.2 (a TS behaviour change on mixed-case/punctuated paths;
  needs a Decision citing SPEC's "sorted by path").
- O2 Update refresh spawn (G10): the Rust statusline reads the cache and
  renders the segment; does it also claim and spawn `node cli.js
  update-check --refresh` (needs node on PATH and the npm layout), or is
  the refresh left to the TS surfaces (`status`, `init`, `doctor`)?
- O3 Identity spawn (G8): keep `git config user.email` as a subprocess in
  Rust (parity, ~8 ms) or read git config files directly (faster, must
  match git's precedence and `include`s).
- O4 `sofar status` styled path (G11): port `cli/ui/layout.ts` + `text.ts`
  (visible-width, wrapping, ANSI sanitising) into Rust, or scope Rust
  `status` to the plain renderer and dispatch styled output to TS.
- O5 `commit-trailer`: in scope for the Rust core (it is a per-commit hook
  and reuses `homeInitiative`) or explicitly out.
- O6 Clock injection (G7): add a `SOFAR_NOW` override (test-only,
  documented) so 1.2 can compare session-start bytes exactly, or have the
  suite mask the two time-dependent lines.
