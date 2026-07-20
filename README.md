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

## Team

```
# one person, once:
sofar init
git add .sofar .gitattributes .claude .mcp.json CLAUDE.md AGENTS.md
git commit -m "adopt sofar"

# every dev:
npm install -g @alignlabs/sofar
git pull
sofar status        # the shared record, folded locally
```

No service, no server: the record is files in git, and every clone folds
the same log to the same state.

- **Merges cannot conflict on truth.** `init` marks event logs
  `merge=union` in `.gitattributes`, so branches that both appended to an
  initiative merge cleanly. Union merge (keep both sides' lines, order
  arbitrary) is safe precisely because the log is append-only and the
  fold replays events in ulid id order — line order in the file carries
  no meaning, so any merge of the same events folds to the same state.
  Generated projections may still conflict textually; take either side —
  they are rebuilt from the log on the next append.
- **Events carry their author.** Each event is stamped with `user` from
  `git config user.email` at append time, so attribution survives merges
  and imports; a machine without a configured email just omits the field.

## Sync (sofar-cloud)

Optional, off until you opt in: push/pull the record through
[api.sofar.sh](https://sofar.sh) instead of (or alongside) git.

```
sofar login                 # device flow: code + browser approval
sofar link --org <org>      # bind this repo; writes .sofar/remote.json — commit it
sofar push [--all]          # send events (ulid order, idempotent by id)
sofar pull [--all|--watch]  # fetch events; --watch keeps pulling on the doorbell
```

Local work never blocks on sync: with the API unreachable, `push` fails
politely and the un-acked tail of the log simply waits — the next push
drains it with zero loss and no duplicates (events dedupe by id on both
sides). `.sofar/remote.json` is the only sync file that belongs in git;
credentials live in `~/.config/sofar/credentials.json` (0600) and
per-clone cursors under `~/.local/state/sofar/`. `sofar login --scopes
read` mints a read-only token for consumers that should never write.
`SOFAR_API_URL` overrides the endpoint (self-hosted / local dev).

## Integration surfaces

`sofar init` wires all three; a tool uses whichever it can.

**MCP server** (Claude Code, any MCP client). Registered in `.mcp.json` as
`sofar mcp` (stdio). Tools: `sofar_get_state`, `sofar_start_session`,
`sofar_end_session`, `sofar_update_task`, `sofar_log_decision`,
`sofar_update_plan`, `sofar_add_note`. Every tool is
validate payload → append event → regenerate projections; nothing mutates
state except through an event.

Prefer connecting to a running daemon instead of spawning a server per
session? `sofar serve` also exposes the same seven tools over streamable
HTTP at `/mcp` (localhost only). Opt in by replacing the stdio entry in
`.mcp.json`:

```json
{
  "mcpServers": {
    "sofar": { "type": "http", "url": "http://127.0.0.1:4173/mcp" }
  }
}
```

stdio stays the default — `sofar init` always registers it, and the two
transports return identical results. If the daemon is not running, the
HTTP connection is refused immediately (never a hang): start `sofar serve`
(e.g. under your process manager) or switch back to the stdio entry.

**Hook shims** (Claude Code). Standalone scripts installed to
`.claude/hooks/` and registered in `.claude/settings.json`; they contain no
logic — each invokes the CLI.

- `SessionStart` — registers the session in the log and prints the status
  projection as injected context (hard limit 10,000 chars), including a
  budgeted "Repo memory" section from `.sofar/repo.md` when it has content.
  On `--resume` of a cold session (record idle past the longest cache TTL,
  transcript worth re-warming), one advisory line precedes the block naming
  the estimated re-warm cost and the cheaper fresh-start alternative.
- `UserPromptSubmit` — the batch-complete nudge: once ≥5 record events
  accumulate after the last write-back, each new prompt carries one context
  line suggesting `sofar_end_session` while context is warm, so the Stop
  gate becomes a fallback instead of a forced extra turn.
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

**Library** (services and tooling built on the format). Typed ESM subpath
exports on the same package — importing them runs no CLI code:

```ts
import { validateEnvelope, type EventEnvelope } from '@alignlabs/sofar/schema'
import { foldLines, exportNDJSON } from '@alignlabs/sofar/engine'
import { pushStream, pullStream, runDoorbell } from '@alignlabs/sofar/client'
```

`/schema` is the format layer: the v1 envelope type, the tolerant
`validateEnvelope` guard (validates — never throws or repairs), `makeEvent`,
and every event payload type + validator. `/engine` is the state layer: the
deterministic ulid-ordered fold (exactly what the CLI uses — a consumer's
state always matches `sofar status` over the same log), `InitiativeState`
and its derivations, and the cursor primitive (`exportNDJSON` /
`importNDJSON` — the sync interface). `/client` is the sofar-cloud sync
client the CLI itself runs — device-flow login, link, push/pull, doorbell —
for shells and apps that sync programmatically. Types are self-contained;
use bundler-style module resolution.

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
sofar init [--statusline]      make a repo sofar-ready (idempotent); --statusline wires the rent-meter
sofar new <slug> [--goal]      create an initiative, bind the current branch
sofar switch <slug>            rebind the current branch
sofar status [slug]            fold and print the full initiative tree
sofar export [slug] [--since]  event log as NDJSON (sync cursor primitive)
sofar import <file|-> [slug]   append missing events, dedupe by id
sofar login [--scopes read]    sign in to api.sofar.sh (device flow), store a machine token
sofar link --org <org>         bind repo to a cloud org/repo (.sofar/remote.json, committable)
sofar push [slug|--all]        push events to the linked repo (idempotent, offline-safe)
sofar pull [slug|--all]        pull events since cursor; --watch follows the doorbell
sofar event append ...         validated single-event append (the dialect surface)
sofar statusline               rent-meter for Claude Code's statusLine (stdin JSON → one line)
sofar serve [--port]           localhost JSON state + SSE on change + MCP at /mcp (127.0.0.1 only)
sofar mcp [--root]             stdio MCP server (default registration; /mcp on serve is the opt-in)
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

**Making cost felt.** Two surfaces turn invisible harness costs into visible
moments, both read-side and both computed without a single model call (a
named invariant — sofar holds no API keys and sends nothing anywhere):

- *Cold-resume advisory* (automatic): resuming a session whose record has
  been idle past the longest cache TTL re-warms the whole transcript at full
  input price. The SessionStart injection says so — one line with the
  estimated token cost and the fresh-start alternative — and stays silent on
  warm or small resumes.
- *Rent-meter* (opt-in): `sofar statusline` renders model + ▸ dir ⎇ branch
  (the segments Claude Code's default status line showed — a custom
  statusLine replaces the default, so sofar carries them forward), record
  progress, session cost, and the cache-read share of input tokens — a
  healthy stable-prefix session runs 50–80% (green `✓`); under 30% (red
  `⚠`) means something is churning your prompt prefix; context % warms
  through yellow (≥70%) to red (≥90%) as compaction nears. Styled for the
  status bar by default; `--no-color` gives the plain line. Wire it with
  `sofar init --statusline` (merged only when `.claude/settings.json` has no
  statusLine — an existing one, e.g. your personal `~/.claude` statusline
  shining through, is never touched), or by hand:

  ```json
  { "statusLine": { "type": "command", "command": "sofar statusline" } }
  ```

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
