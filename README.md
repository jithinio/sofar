# sofar

Memory for AI coding assistants, kept inside your project.

Works with Claude Code, the Claude desktop app, Codex, Cursor, OpenCode, and
any other tool that reads `AGENTS.md` or speaks MCP.

## The problem

Every new chat starts from nothing. You explain the project again. You explain
what you already tried and why it did not work. Sooner or later the assistant
suggests the exact approach you ruled out last week, and you spend another
afternoon finding out again that it does not work.

## What sofar does

sofar keeps a written record of the work in your project folder. Your assistant
reads it when a session starts, adds to it while it works, and leaves a
handover note before it stops. The next session picks up where the last one
left off, even in a different tool, on a different machine, weeks later.

The record holds four things:

* **The goal.** What this piece of work is for.
* **The plan.** Tasks grouped into phases, with what is done and what is not.
* **The decisions.** What was chosen, what it was chosen over, and why.
* **The sessions.** What each one did, and the single next action.

The decisions matter most. Knowing that an idea was already tried and rejected
is what stops the same dead end being walked twice.

Everything is plain text that lives in your repo. There is no account and no
server to run. sofar never calls an AI model itself, so it adds nothing to your
bill and sends nothing anywhere.

## Install

```
npm install -g sofar.sh
```

Needs Node 18 or newer. To try it without installing, use
`npx sofar.sh status`. Update later with `sofar upgrade`.

To build from a clone of this repo instead:

```
npm install
npm run build
npm install -g ./packages/engine
```

## Get started

```
cd your-project
sofar init
sofar new password-reset --goal "Let users reset a forgotten password"
sofar status
```

`sofar init` sets up the record and connects your tools. It is safe to run
twice and only adds what is missing.

After that, work as usual. In Claude Code the assistant keeps the record
current on its own. Other tools follow a short instruction block that `init`
writes into `AGENTS.md`.

## You can just ask

Once the project is set up you rarely type these commands yourself. Ask your
assistant in ordinary words:

* "Start a new initiative for the password reset work."
* "Where did we get to on this?"
* "Mark the login task done."
* "Record that we went with Postgres over SQLite, and why."
* "Write up this session before you stop."

It runs the right commands and keeps the record in order. The CLI is there for
when you want to look for yourself.

## How a session runs

1. **Start.** The assistant receives the goal, the progress, recent decisions
   and the next action before you type anything.
2. **During.** Decisions and finished tasks get written down as they happen.
3. **End.** The assistant writes a summary and the next action. In Claude Code
   a hook holds the session open until it does.

## Sharing with your team

The record is files in git, so it travels with the code.

```
# one person, once
sofar init
git add .sofar .gitattributes .claude .mcp.json CLAUDE.md AGENTS.md
git commit -m "adopt sofar"

# everyone else
npm install -g sofar.sh
git pull
sofar status
```

Two branches working on the same initiative will not fight over the record.
Entries are only ever added to the end, never edited, so git keeps both sides
and the result still reads correctly.

## What it plugs into

* **Claude Code**, in the terminal, in the Claude desktop app on Mac and
  Windows, or in the VS Code and JetBrains extensions. `init` wires up the MCP
  server and the hooks. Nothing else to do.
* **Codex, Cursor, OpenCode**, and anything else that reads `AGENTS.md`.
  `init` writes an instruction block there, and those tools follow the same
  loop using the `sofar` command. No extra setup.
* **Any other MCP client.** Point it at `sofar mcp` in its own config to get
  the same nine tools over stdio.

## Commands

| Command | What it does |
| --- | --- |
| `sofar init` | Set up the record here and connect your tools |
| `sofar new <name>` | Start a piece of work and tie it to the current branch |
| `sofar switch <name>` | Point the current branch at a different initiative (reopens it if it was closed) |
| `sofar close [name]` | Mark work finished — or `--drop --reason <why>` if it was abandoned — and take every branch off it |
| `sofar status` | Goal, progress, phases, next action (`--watch` for live) |
| `sofar list` | One line per initiative |
| `sofar next` | The next action for every initiative |
| `sofar why <path>` | Every task, session and decision behind a file, across all initiatives |
| `sofar related <task-id>` | Tasks that worked on the same files, ranked by shared paths |
| `sofar remember <text>` | Keep an operational fact — a release command, a failure mode — where later sessions will find it |
| `sofar statusline --install` | Put the status line in Claude Code's status bar — this repo, or `--user` for every project (`--uninstall` takes it back off) |
| `sofar doctor` | Check the setup and the record for problems |
| `sofar upgrade` | Update sofar itself — sofar tells you when there is something to update to |

Less often needed:

| Command | What it does |
| --- | --- |
| `sofar update-check` | Inspect the update check — what it knows, when it last ran, whether auto-install is on |
| `sofar export` / `sofar import` | Move events between copies of a record |
| `sofar login`, `link`, `push`, `pull` | Cloud sync, if you turn it on |
| `sofar serve` | Local server with the record as JSON |
| `sofar mcp` | The MCP server, which `init` already registers |
| `sofar statusline` | Renders the line itself — Claude Code calls this, you don't |
| `sofar event append` | Write one entry by hand |
| `sofar adopt <file>` | Bring an older, hand written project log into sofar |
| `sofar uninit` | Undo `init` |

## How it works

One file per initiative holds the truth:
`.sofar/initiatives/<slug>/events.jsonl`. Every change is a single line added
to the end of it. Nothing is edited, nothing is deleted. The readable files
beside it are rebuilt from that log whenever it changes, so they cannot drift
out of step with what actually happened.

```
.sofar/
  repo.md                      notes true across all work (you write this one)
  bindings.json                which branch maps to which initiative
  initiatives/<slug>/
    events.jsonl               the log, and the only source of truth
    plan.md                    generated
    decisions.md               generated
    sessions/<id>.md           generated
```

A correction is a new line pointing at the old one. History is never rewritten.

What the assistant reads at the start of a session is a short summary, not the
whole history, so a long running project does not crowd out the actual work.
The full detail stays on disk for when it is needed. Decisions and the
approaches they ruled out are the one thing never cut.

## Optional extras

**Status line.** `sofar statusline --install` puts task progress, context
fill and cache health in Claude Code's status bar, in one command and in
any repo — the line alone, no hooks and no `.sofar/`. Add `--user` to wire
it in `~/.claude/settings.json` for every project at once. (`sofar init
--statusline` wires the same thing as part of a full init.) It restores
what Claude Code's own status line shows, so nothing is lost by switching:
same model, directory and branch, in the same colors. An existing status
line is always left alone.

`sofar statusline --uninstall` takes it back off and Claude Code's own line
returns; `--user` removes the personal one. A status line that is not
sofar's is never removed, so this can only undo what sofar did.

**Staying current.** sofar tells you when a new release exists — a line
after `sofar status`, `init` or `doctor`, and an `↑0.18.0` on the status
bar — and leaves installing it to you, since an upgrade also wants a
`sofar init` in each repo to refresh its wiring. It never blocks: the
version lookup happens once a day in a background process, and every
command only reads the cached answer. If you would rather it just did the
upgrade, `sofar upgrade --auto on`. If you would rather it did nothing at
all, set `SOFAR_NO_UPDATE_CHECK=1` — and it never checks in CI or from a
non-global install. `sofar update-check` shows what it knows.

**Cloud sync.** Off unless you switch it on. `sofar login`, then
`sofar link --org <org>`, then `sofar push` and `sofar pull` to sync through
[api.sofar.sh](https://sofar.sh) instead of, or alongside, git. Work never
waits on the network: if the service is unreachable, unsent entries wait and go
out with the next push, with nothing lost or duplicated.

**Reading the record from your own code.** The package ships typed imports, so
a script or service can read a record without running the CLI:

```ts
import { validateEnvelope } from 'sofar.sh/schema'
import { foldLines } from 'sofar.sh/engine'
import { pushStream, pullStream } from 'sofar.sh/client'
```

**Tailwind v4.** Tailwind scans every file in a project for class names and can
produce broken CSS from the writing in the record. Add one line to your
`globals.css`:

```css
@source not "../.sofar";
```

`sofar doctor --fix` will add it for you. The same goes for any tool that
scans your whole tree: point it away from `.sofar/`.

## Docs

* [docs/SPEC.md](docs/SPEC.md) is the full specification: events, tools, hooks,
  state, and what counts as done.
* [docs/FORMAT.md](docs/FORMAT.md) describes the file format on disk, for
  anyone writing a tool that reads or writes a record without this engine.

sofar tracks its own development with sofar, in the `.sofar/` folder of this
repo.

MIT licensed.
