# OpenCode adapter notes (task 5.2)

Status: **documentation + verified convention fallback** — no plugin code
ships in v1. OpenCode reads `AGENTS.md` natively, so the convention dialect
installed by `sofar init` (BD31) is the v1 integration: it drives the full
read → work → write-back loop through the `sofar` CLI alone, with no MCP
and no hooks. A native plugin is future work (`packages/adapters/*`,
post-v1); this document maps the surfaces so that plugin is a mechanical
exercise, and specifies the manual verification run for the dialect.

## 1. Hook surface mapping

Claude Code integration = four hook shims + the MCP server. OpenCode's
extension point is a plugin module exporting hook functions (names below are
the OpenCode plugin API as of this writing — re-verify before building).

| Sofar surface (Claude Code) | OpenCode plugin equivalent | Adapter behavior |
| --- | --- | --- |
| SessionStart shim → `sofar event session-start` (registers session_id in the log, prints ≤10k status block as injected context) | session lifecycle event (e.g. `session.created` via the plugin `event` hook) | Shell out to `sofar event session-start` with `{"session_id":"<opencode session id>"}` on stdin. Context injection is best-effort: if the plugin API can't inject stdout as context, orientation still happens because the AGENTS.md dialect's BEFORE-work step is `sofar status`. |
| PostToolUse shim (matcher `Edit\|Write\|MultiEdit\|Bash`) → `sofar event post-tool` | `tool.execute.after` (paired with `tool.execute.before` if pre-state is ever needed — sofar currently only consumes post-state) | Shell out to `sofar event post-tool` with Claude-Code-shaped JSON: `{"session_id":…,"tool_name":…,"tool_input":…}`. OpenCode tool names differ (lowercase `edit`/`write`/`bash`); the plugin maps them to `Edit`/`Write`/`Bash` so the CLI's BD23 mapping applies unchanged. Alternatively call `sofar event append --type file_touched/command_run` directly — same events, same validation. |
| Stop shim → `sofar event stop` (exit 2 BLOCKS the agent from finishing until session_ended exists — BD2) | **NONE.** OpenCode has an idle/completion signal (e.g. `session.idle`), but it is a notification, not a gate: a plugin cannot return exit 2 and force the model to continue. | **This is the gap.** Write-back cannot be mechanically enforced in OpenCode. The compensating control is the AGENTS.md dialect's MANDATORY write-back clause ("BEFORE FINISHING (MANDATORY): … session_ended …"). Convention, not enforcement — which is exactly why the manual verification below must prove a real OpenCode session obeys it. |
| SessionEnd shim → `sofar event session-end` (mechanical `session_closed` fallback marker, BD21) | session teardown lifecycle event (e.g. `session.deleted` / idle via the `event` hook) | Shell out to `sofar event session-end` with `{"session_id":…,"reason":"exit"}`. Fallback only; never a substitute for `session_ended`. |
| MCP tools (`sofar_get_state`, `sofar_end_session`, …) | not required | The dialect replaces them 1:1 with CLI calls: `sofar status` for get_state, `sofar event append` for every write (BD30). |

## 2. Future plugin shape (BD4 portability rule)

The plugin must be **thin — no logic**. Every hook body is a single shell-out
to the sofar CLI; behavior, validation, session correlation (BD20), and
best-effort semantics (BD22) live in the CLI and stay identical across
Claude Code, OpenCode, and Codex. Sketch:

```js
// opencode plugin — every hook is a dumb pipe into the sofar CLI
export const SofarPlugin = async ({ $ }) => ({
  event: async ({ event }) => {
    if (event.type === 'session.created')
      await $`sofar event session-start < ${json({ session_id: event.session_id })}`
    if (event.type === 'session.deleted')
      await $`sofar event session-end < ${json({ session_id: event.session_id, reason: 'exit' })}`
  },
  'tool.execute.after': async (input, output) => {
    await $`sofar event post-tool < ${json(claudeShaped(input, output))}`
  },
})
```

If a hook fails, the CLI already exits 0 silently (BD22) — the plugin never
adds retry/error logic. Anything smarter than "map field names and pipe" is
a bug in the adapter layer.

## 3. Manual verification checklist (convention fallback)

Run this in a real OpenCode session to prove the AGENTS.md dialect drives
read → work → write-back (SPEC §Acceptance Phase 5). Steps 1–3 are operator
setup in a terminal; steps 4–12 are what the OpenCode agent should do when
told: *"Follow the sofar protocol in AGENTS.md; the initiative's task v1
is your work item — mark it done, log one decision, then finish."* Verify
each expected outcome before moving on.

Prereqs: `npm run build` in this repo, then make the CLI invocable as
`sofar` (`npm link` from `packages/engine`, or
`alias sofar="node <repo>/packages/engine/dist/cli.js"`).

| # | Command | Expected record outcome |
| --- | --- | --- |
| 1 | `git init -b main scratch && cd scratch && sofar init` | Output includes `created AGENTS.md (sofar protocol block)`. `AGENTS.md` contains `<!-- sofar:protocol -->`; `.sofar/initiatives/` exists. |
| 2 | `sofar new opencode-verify --goal "verify the convention dialect"` | Output: `created .sofar/initiatives/opencode-verify/…` + `bound branch "main" → opencode-verify`. `events.jsonl` has exactly **1** line: type `initiative_created`, actor `human`. |
| 3 | `sofar event append --type plan_updated --actor human --payload '{"plan":{"phases":[{"name":"Verify","tasks":[{"id":"v1","title":"prove the dialect loop"}]}]}}'` | stdout `{"ok":true,"event_id":"…"}`. Line **2**: `plan_updated`. `plan.md` shows `- [ ] v1 prove the dialect loop`. |
| 4 | *(agent, READ)* `sofar status` | Output contains `# opencode-verify`, `Goal: verify the convention dialect`, and the pending `v1` task. `events.jsonl` unchanged (still 2 lines — status never writes). |
| 5 | *(agent, START)* `sofar event append --type session_started --session oc-verify-1 --source opencode --payload '{"tool":"opencode"}'` | stdout `{"ok":true,…}`. Line **3**: `session_started`, envelope `session:"oc-verify-1"`, `source:"opencode"`, `actor:"agent"`. |
| 6 | *(agent, WORK)* `sofar event append --type task_status_changed --session oc-verify-1 --source opencode --payload '{"id":"v1","status":"done"}'` | Line **4**: `task_status_changed`. `plan.md` now shows `- [x] v1 prove the dialect loop`. |
| 7 | *(agent, WORK)* `sofar event append --type decision_logged --session oc-verify-1 --source opencode --payload '{"chose":"convention dialect","over":"native opencode plugin","because":"v1 ships without plugin code"}'` | Line **5**: `decision_logged`. `decisions.md` contains `convention dialect`. |
| 8 | *(parity probe, gate armed)* `echo '{"session_id":"oc-verify-1","stop_hook_active":false}' \| sofar event stop; echo "exit=$?"` | stderr: `Write back to the sofar record before finishing: …` and `exit=2` — the dialect session faces the SAME write-back gate Claude Code sessions face. |
| 9 | *(agent, WRITE-BACK — MANDATORY)* `sofar event append --type session_ended --session oc-verify-1 --source opencode --payload '{"summary":"dialect loop verified in opencode","next_action":"score the handoff ceremony"}'` | Line **6**: `session_ended`. `sessions/oc-verify-1.md` now exists. |
| 10 | *(parity probe, gate open)* repeat step 8's command | Silent, `exit=0` — the dialect write-back satisfies the Stop hook exactly as `sofar_end_session` does. |
| 11 | *(agent, VERIFY)* `sofar status` | Shows `Last session (opencode, ended …)` with `dialect loop verified in opencode`, `Next action: score the handoff ceremony`, and the `[x]` v1 task. |
| 12 | *(negative probe)* `sofar event append --type task_status_changed --session oc-verify-1 --source opencode --payload '{"id":"v1","status":"finished"}'; echo "exit=$?"` | `exit=1`, stderr is typed-error JSON with `"code":"invalid_input"`; `events.jsonl` STILL has 6 lines — invalid input never reaches the log. |

Pass = every expected outcome observed, **and** the agent performed steps
4–7 and 9 from the AGENTS.md block without being fed the commands verbatim
(the block, not the operator, is the protocol carrier).

## 4. Automated simulation

`packages/engine/test/acceptance.phase5.test.ts` executes steps 1–12 (same
commands, same order, via the built CLI in a temp repo) and asserts every
expected outcome above, so the checklist can never drift from what the CLI
actually does. The simulation proves the checklist is **accurate** — it does
NOT replace the manual OpenCode run, which is the only thing that can prove
an unmodified OpenCode agent obeys the convention. That manual run is
pending, part of the 5.3 ceremony prep.
