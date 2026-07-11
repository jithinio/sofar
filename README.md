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

```
npm install -g @alignlabs/sofar    # installs the `sofar` command
```

Or one-off: `npx @alignlabs/sofar <command>`. Requires Node ≥ 18. The
package installs with zero runtime dependencies — `dist/cli.js` is fully
bundled.

Update an existing install with `sofar upgrade` (`--check` to preview,
`--dry-run` to print the exact command). It resolves the real install prefix
from the running binary, so it updates the copy actually on your `PATH` —
even a custom prefix that a plain `npm install -g` would miss.

From a checkout instead:

```
npm install
npm run build
cd packages/engine
npm pack
npm install -g ./alignlabs-sofar-<version>.tgz
```

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
sofar upgrade [version]        self-update the global install (--check, --dry-run)
```

## Contracts

Authoritative contracts — envelope, event types, state shape, tool
signatures, hook behavior, acceptance criteria — live in
[docs/SPEC.md](docs/SPEC.md). The on-disk record format — what a conforming
third-party reader or writer of `.sofar/` must implement, engine not
required — is specified in [docs/FORMAT.md](docs/FORMAT.md). This repo
tracks its own development with the same protocol — self-hosted in its own
`.sofar/` record.

## Token economics

Two different problems govern what a record costs an agent, and sofar treats
them as two levers:

**Lever A — price and latency: prompt caching.** Caching is the agent
harness's job, but sofar is built to sit well in a cached prefix. The status
block is injected once at session start, and the seven MCP tool definitions
total ~1k tokens — both land in the prefix and stop costing after the first
request. To keep it that way: orient once from the digest, and when you need
history mid-session, read the generated projections (`plan.md`,
`decisions.md`, `sessions/<id>.md`) from disk instead of re-pulling state
dumps into the conversation.

**Lever B — context-window occupancy.** Caching does not reduce the tokens a
model must attend to, so every sofar read surface is budgeted:

- `sofar_get_state` defaults to a summary-dense digest (~1–2k tokens);
  the complete folded state (often 10× that on a mature record) stays
  available via `view: "full"`.
- The injected status block carries a hard 10,000-char cap with per-section
  budgets and count caps; done phases collapse to a single summary line.
- Detail is never deleted, only relocated — the full record survives in the
  event log and its projections.

One thing is deliberately never trimmed: **rationale**. The digest keeps
recent decisions with their chose/over/because, plus a rejected-approaches
ledger listing every decision's rejected alternative. Resume-ablation
testing showed that dropping rejected alternatives is precisely what makes a
fresh agent confidently re-propose a dead end the record had already ruled
out — the cheapest tokens in the block are the ones that stop repeated work.

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
