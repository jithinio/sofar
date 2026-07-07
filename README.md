# sofar

Event-sourced initiative memory for coding agents.

Truth lives in one append-only event log per initiative
(`.sofar/initiatives/<slug>/events.jsonl`). Everything a session reads —
`plan.md`, `decisions.md`, per-session summaries, the status block injected
at session start — is a generated projection of that log, regenerated on
every append and never hand-edited. A session orients from the record, logs
decisions and task changes as events while it works, and writes back a
summary + next action before it finishes — so the next session (any tool,
any model, zero context) resumes without asking.

## Install

Not yet on the npm registry. From a checkout:

```
npm install
npm run build
cd packages/engine
npm pack
npm install -g ./alignlabs-sofar-0.1.0.tgz
```

The tarball installs with zero runtime dependencies — `dist/cli.js` is fully
bundled. Published as `@alignlabs/sofar`: `npm install -g @alignlabs/sofar` (the command is still `sofar`), or `npx @alignlabs/sofar <command>`.
Requires Node ≥ 18.

## Quickstart

```
cd your-repo
sofar init                          # scaffold .sofar/, install hooks + registrations
sofar new my-feature --goal "..."   # create an initiative, bind it to the current branch
sofar status                        # fold the log: goal, progress, phase tree, next action
```

The work loop, per session:

1. Session starts → orient from the injected status context (or `sofar status`).
2. During work → append events: task status changes, decisions, notes;
   file/command events land mechanically via hooks.
3. Before finishing → write back `session_ended` (summary + next action).
   Under Claude Code the Stop hook blocks a session that skips this.

## Integration surfaces

`sofar init` wires all three; a tool uses whichever it can.

**MCP server** (Claude Code, any MCP client). Registered in `.mcp.json` as
`sofar mcp` (stdio). Tools: `sofar_get_state`, `sofar_start_session`,
`sofar_end_session`, `sofar_update_task`, `sofar_log_decision`,
`sofar_update_plan`, `sofar_add_note`. Every tool is
validate payload → append event → regenerate projections; nothing mutates
state except through an event.

**Hook shims** (Claude Code). Standalone scripts installed to
`.claude/hooks/` and registered in `.claude/settings.json`; they contain no
logic — each invokes the CLI.

- `SessionStart` — registers the session in the log and prints the status
  projection as injected context (hard limit 10,000 chars), including a
  budgeted "Repo memory" section from `.sofar/repo.md` when it has content.
- `PostToolUse` — appends mechanical `file_touched` / `command_run` events
  for Edit/Write/MultiEdit/Bash calls.
- `Stop` — the write-back gate: if the session has not appended
  `session_ended`, exits 2 and blocks finishing until it does
  (loop-guarded via `stop_hook_active`).
- `SessionEnd` — mechanical close marker, fallback only.

**AGENTS.md dialect** (tools without MCP or hooks — OpenCode, Codex, plain
shells). `init` installs a protocol block into `AGENTS.md` that drives the
same loop through the CLI alone: orient with `sofar status`, then one
`sofar event append --type <event_type> --payload '<json>'` per write —
session start, task changes, decisions, and the mandatory `session_ended`
write-back. No hook can block these tools, so the convention states
write-back as mandatory.

## Record layout

```
.sofar/
  repo.md                      # repo-scoped memory (hand-written, NOT generated)
  bindings.json                # { "<git-branch-or-worktree>": "<slug>" }
  initiatives/<slug>/
    events.jsonl               # TRUTH — append-only
    plan.md                    # generated projection
    decisions.md               # generated projection
    sessions/<session-id>.md   # generated per-session summaries
```

Events are immutable single-line JSON with a stable envelope (ulid ids,
atomic O_APPEND writes); corrections are new events referencing the target
id, never rewrites. Projections are written atomically (temp file + rename),
so readers never see a half-written file.

## CLI

```
sofar init                     make a repo sofar-ready (idempotent)
sofar new <slug> [--goal]      create an initiative, bind the current branch
sofar switch <slug>            rebind the current branch
sofar status [slug]            fold and print the full initiative tree
sofar export [slug] [--since]  event log as NDJSON (sync cursor primitive)
sofar import <file|-> [slug]   append missing events, dedupe by id
sofar event append ...         validated single-event append (the dialect surface)
sofar serve [--port]           localhost JSON state + SSE on change (127.0.0.1 only)
sofar mcp [--root]             stdio MCP server
```

## Contracts

Authoritative contracts — envelope, event types, state shape, tool
signatures, hook behavior, acceptance criteria — live in
[docs/SPEC.md](docs/SPEC.md). This repo tracks its own development with the
same protocol — self-hosted in its own `.sofar/` record.

## Build-tool hygiene

The record (`.sofar/`) is prose committed into your repo — plans, decisions,
notes. Tools that scan your whole tree for content can ingest it. Known case:
**Tailwind v4** auto-scans every non-gitignored file for class candidates and
can mint invalid CSS from code-like prose in projections. Exclude the record
in your `globals.css`:

```css
@source not "../.sofar";
```

The same principle applies to any scanner with tree-wide globs: point it away
from `.sofar/`.
