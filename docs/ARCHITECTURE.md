# Architecture

How sofar is shaped. `SPEC.md` is authoritative for *what must be true*;
this describes *how the pieces fit*. Where they disagree, SPEC wins.

Every module in `packages/*/src` is named here. A test enforces that
(`test/architecture-doc.test.ts`), so a module added without a line in this
file fails the suite — the doc cannot silently go stale.

---

## The one idea

**One append-only log per initiative is the truth. Everything else is derived.**

```
.sofar/initiatives/<slug>/events.jsonl        ← truth, append-only, never rewritten
        │
        ├─ fold ──────────→ InitiativeState ──→ projections (plan.md, decisions.md, …)
        ├─ adjacency ─────→ typed edges ──────→ graph (cross-record)
        └─ index ─────────→ cursors ──────────→ Tier 0 (hot) / Tier 1 (keyed lookup)
```

Three consequences run through every design decision in the codebase:

- **Corrections are new events.** History is never rewritten, so a derivation
  over a prefix stays valid forever. That is what makes incremental indexing
  sound — nothing is ever invalidated, only extended.
- **Any derived artifact can be deleted and rebuilt.** Projections, the index,
  the graph. If a derived thing disagrees with the log, the log wins.
- **Replay is ULID-ordered, not file-ordered.** `events.jsonl` carries
  `merge=union` in `.gitattributes`, so two branches appending concurrently
  merge without conflict and still fold identically.

---

## Layers

### 1. Truth — the log and its envelope

| module | what it owns |
| --- | --- |
| `schema/src/events.ts` | Event payload shapes. The **only** place payload schema lives. |
| `schema/src/guards.ts` | Guard grammar (`path:`/`cmd:` globs) and matching. |
| `schema/src/tool-inputs.ts` | MCP tool input schemas and descriptions. |
| `core/envelope.ts` | Envelope v1: mint, validate, canonical field order. |
| `core/log.ts` | `appendEvent` — O_APPEND, one line, never partial. Canonical serialization. |
| `core/atomic.ts` | `writeFileAtomic` — temp + rename, so readers never see a torn file. |
| `core/redact.ts` | Secret redaction on captured commands before they reach the log. |
| `core/identity.ts` | Optional `user` stamp from git config. `identity.browser.ts` is the browser build. |

### 2. Derivation — pure functions of the log

| module | what it derives |
| --- | --- |
| `core/fold.ts` | `InitiativeState` — the fold. Tolerant (corrupt lines skipped, never fatal), deterministic, ULID-ordered. Also `openSessionFiles`, `openSessionFileConflicts`, `overlappingWritebacks`, `sessionDebt`, `sessionGuardViolations`, `reviewWatermark`, `openFindings`. |
| `core/adjacency.ts` | Typed edges (`touched`, `ran`, `changed`, `worked`) and the derived `SessionActivity`. Caps live here (`ACTIVITY_LIST_CAP`, `TASK_FILES_CAP`). |
| `core/graph.ts` | The cross-record adjacency graph — facts that outlive one log. **Never on the hot path**: it reads N logs where a shim can afford one. |
| `core/citations.ts` | The citation grammar — scan handles from prose (lexical, permanent), bind them to initiatives (current, because `sofar new` changes the answer). Below `graph.ts` so the index can reach it. |
| `core/warmth.ts` | Has a log grown recently? Read from the log's own newest event, never filesystem mtime — `git checkout` rewrites mtime on every file. |
| `core/cross-conflicts.ts` | Files under concurrent edit by sessions in *different* initiatives. Gated on the hot path, exhaustive in `doctor`. |
| `core/listing.ts` | `initiativeSlugs` and the portfolio listing behind `sofar list`. |
| `core/bindings.ts` | `.sofar/bindings.json` — which branch serves which initiative. |
| `core/git.ts` | Branch, HEAD, upstream — read from `.git` files, no subprocess. |
| `core/attribution.ts` | Commit → initiative from `Sofar-Initiative:` trailers (D4). Spawns `git log`, so it is kept OUT of `git.ts` to preserve that file's no-subprocess guarantee; every walk is bounded and gated on a ref having moved (D6). Falls back to the INDENTED trailer a squash merge leaves in the body, and only when the real trailer block is empty (2.3). |
| `core/shipwatch.ts` | Per-session `origin/<branch>` marks in the derived index — the free ref-movement gate that lets the per-prompt path pay for `attribution.ts`'s walk only when a push actually happened (3.4, D11). Edge-triggered: marking is what stops a transition being announced twice. |
| `core/closeout.ts` | The mechanical audit run at close (5.1) — outstanding tasks, unresolved phases, done tasks with no file evidence, unaddressed guard crossings, drift since the write-back, unreviewed phases. Refuses nothing: the findings ride on the close event so an override is recorded rather than prevented (5.2). |
| `core/cursor.ts` | Export/import cursors: the entire sync interface. |
| `core/peers.ts` | Resolves a Claude Code session id to the name its `SendMessage` addresses, from the host's own registry. Best-effort; absent means no address. |

### 3. Index — derived, local, incremental

Never truth. Lives gitignored under `.sofar/.index/`, is never committed or
synced, and any absence, staleness, or corruption falls back to reading the logs.

| module | role |
| --- | --- |
| `core/index-store.ts` | The store: self-ignoring directory, schema version, per-initiative cursors, atomic writes. Every failure collapses to one signal — start cold. |
| `core/index-tail.ts` | Reads only what a log grew by. The cursor stores the byte offset where its event's line *starts*, so the seek is self-corroborating. |
| `core/index-pass.ts` | The one incremental pass every tier shares. Holds the four cases where resuming would be unsound, each falling back to a full read. |
| `core/index-tier0.ts` | **Hot tier.** Open sessions and the files they hold. Byte-sized, so the shim can read it. Faithful to the fold's caps rather than better than them. |
| `core/index-tier1.ts` | **Keyed tier.** Declared relevance (which decisions guard this path) and derived relevance (who else touched it, from which initiative). |
| `core/index-reach.ts` | **Reach tier.** What `sofar find` traverses: decisions, notes, files, sessions and citation edges, each carrying the event id that produced it. Read only when asked, so it can afford prose the hot tiers cannot. |
| `core/lexicon.ts` | Turns a question into seeds when nothing denotes it: tokenize, fold plurals and tenses, rank by IDF. No model, and every match returns the words that carried it. |

### 4. Projections — state rendered to disk

Regenerated on every append. Never hand-edited.

| module | renders |
| --- | --- |
| `projections/generator.ts` | Writes all projections for an initiative after an append. |
| `projections/templates/plan.ts` | `plan.md` — goal, phases, tasks, next action. |
| `projections/templates/decisions.ts` | `decisions.md` — decisions, standing constraints, rejected approaches. |
| `projections/templates/session.ts` | `sessions/<id>.md` — one file per session. |
| `projections/templates/memory.ts` | `memory.md` — promoted operational facts. |
| `projections/templates/status.ts` | The status digest — what SessionStart injects. |
| `projections/templates/review.ts` | The review evidence packet — diff range, tasks claimed done, standing constraints, rejected approaches. Text only; the judging is the reviewing session's, never sofar's. |
| `projections/templates/next.ts` | The single next action. |
| `projections/templates/list.ts` | The portfolio view. |
| `projections/templates/shared.ts` | Shared rendering helpers. |

### 5. Surfaces — how agents and humans reach the record

**Hooks** — installed by `sofar init` as shims in `.claude/hooks/`. Each is
four lines; the CLI owns behaviour. All five run on the user's critical path
under a **100ms end-to-end budget**, and all are best-effort: a failure is
silence, never a broken session.

| hook | what it does |
| --- | --- |
| SessionStart | Injects the record — goal, progress, next action, decisions, standing constraints, rejected approaches, repo memory. |
| UserPromptSubmit | Live hazards first: file conflicts, reachable peers, crossed guards, parallel wrap-ups, git state, drift nudge. |
| PostToolUse | Captures file touches and commands as events. The point-of-use guard fires here. |
| Stop | Blocks a session that owes a write-back. |
| SessionEnd | Closes the session. |

A sixth shim, `hooks/prepare-commit-msg.sh`, is a **git** hook rather than a
Claude Code one — installed into `.git/hooks/` and never clobbering an existing
file. It stamps `Sofar-Initiative:` onto the commit message (D5). It cannot
`exec` like the five above: it runs inside `git commit`, so it guards on the
binary existing and exits 0 unconditionally — a hook that can abort a commit is
worse than no attribution.

| module | surface |
| --- | --- |
| `cli/index.ts` | Command registration. |
| `cli/event.ts` | All five hook handlers, plus `sofar event append`. |
| `cli/review.ts` | `sofar review` — prints the evidence packet (read half). `sofar_review` records the verdict (write half). |
| `cli/commit-trailer.ts` | `sofar commit-trailer` — the prepare-commit-msg worker that stamps `Sofar-Initiative:` from the session that made the commit (D5). Session-only resolution; never fails a commit. |
| `cli/init.ts` | `sofar init` — hooks, MCP wiring, protocol block, `.gitattributes`. Owns the protocol-block ledger. |
| `cli/uninit.ts` | `sofar uninit` — removes what init wrote. |
| `cli/new.ts` | `sofar new` — create an initiative, bind the branch. |
| `cli/close.ts` | `sofar close` — close an initiative, unbind its branches. |
| `cli/status.ts` | `sofar status` — the digest. |
| `cli/next.ts` | `sofar next` — the single next action. |
| `cli/list.ts` | `sofar list` — the portfolio. |
| `cli/doctor.ts` | `sofar doctor` — the audit: records, lifecycle, split sessions, concurrency, guards, repo memory, scanners. |
| `cli/graph.ts` | `sofar graph` — cross-record queries. |
| `cli/find.ts` | `sofar find` — traverse from a seed within a hop budget. Offers adjacency, never asserts relevance; every row cites its event. |
| `cli/remember.ts` | `sofar remember` — promote an operational fact. |
| `cli/statusline.ts` | `sofar statusline` — the one-line host status. Resolves session-first. |
| `cli/serve.ts` | `sofar serve` — localhost JSON state server. |
| `cli/transfer.ts` | `sofar export` / `sofar import`. |
| `cli/adopt.ts` | `sofar adopt` — migrate a legacy prose record. |
| `cli/cloud.ts` | `sofar login` / `link` / `push` / `pull`. |
| `cli/scanners.ts` | Host-config scanners (e.g. emitted stylesheet directives). |
| `cli/upgrade.ts`, `cli/update-check.ts` | Version checks and self-upgrade. |
| `cli/boot.ts`, `cli/fast.ts`, `cli/shared.ts` | Startup path, fast path, shared helpers. |
| `cli/user-config.ts` | User-level config. |
| `cli/ui/*` | Terminal rendering: `caps`, `style`, `symbols`, `text`, `frames`, `spinner`, `layout`, `index`. Semantic ANSI-16 only; agent-facing surfaces stay byte-plain. |

**MCP** — the `sofar` server and its `sofar_*` tools.

| module | tool |
| --- | --- |
| `mcp/server.ts`, `mcp/register.ts`, `mcp/context.ts` | Server, tool registration, tool context and initiative resolution. |
| `mcp/start-session.ts` | `sofar_start_session` — pins which record writes land in. |
| `mcp/end-session.ts` | `sofar_end_session` — the write-back. Reports parallel write-backs and reachable peers. |
| `mcp/log-decision.ts` | `sofar_log_decision` — including standing constraints and guards. |
| `mcp/update-task.ts`, `mcp/update-plan.ts` | Task status, whole-plan replace. |
| `mcp/add-note.ts` | `sofar_add_note`. |
| `mcp/remember.ts` | `sofar_remember`. |
| `mcp/review.ts` | `sofar_review` — records a performed review and its watermark. Records, never judges. |
| `mcp/get-state.ts` | `sofar_get_state`. |
| `mcp/close-initiative.ts` | `sofar_close_initiative`. |
| `mcp/find.ts` | `sofar_find` — index-backed retrieval. Read-only, appends nothing, never builds the graph. |

**Library** — importable entry points, side-effect free.

| module | entry |
| --- | --- |
| `lib/engine.ts` | `sofar.sh/engine` — the fold, state types, cross-session derivations, cursors. |
| `lib/client.ts` | `sofar.sh/client` — the sync client. |
| `lib/schema.ts` | `sofar.sh/schema` — event payload types. |

### 6. Sync client — the seam to `api.sofar.sh`

The engine ships the **client only**. No service code lives here.

| module | role |
| --- | --- |
| `client/config.ts` | API URL precedence, credential and cursor stores. |
| `client/device.ts` | RFC-8628 device flow for `sofar login`. |
| `client/http.ts` | Authed fetch, typed errors, retry honouring `Retry-After`. |
| `client/repos.ts` | `sofar link` — bind a clone to a remote record. |
| `client/push.ts` | Batched push from a cursor, idempotent, partial acceptance surfaced. |
| `client/pull.ts` | Since-cursor paging, dedupe-by-id import, projection regen. |
| `client/doorbell.ts` | SSE doorbell — pull on every ring. |
| `client/url.ts` | URL normalization. |

`core/types.d.ts` holds ambient type declarations.

---

## Invariants

These are load-bearing. Breaking one requires a logged Decision.

1. **Zero model API calls.** sofar never calls a model. No API keys, no
   inference cost, no user content leaving the machine. Every derivation is
   mechanical — citation extraction is a closed lexical grammar, never inference.
2. **The log is truth.** Corrupt lines are skipped with a warning during fold,
   never rewritten, never fatal.
3. **Projections are generated.** Never hand-edited; rebuilt on every append.
4. **The index is derived.** Never committed, never synced; absence or
   corruption falls back to the logs.
5. **Best-effort surfaces.** A hook, statusline, or scanner failure is silence.
   It must never break the session it decorates.
6. **Reported, never prevented.** No locks, no leases. Collisions are surfaced
   to whoever can still act on them.
7. **100ms shim budget.** Every hook completes end-to-end inside it — process
   spawn, CLI boot, fold, render, append.
8. **Schema lives in two places only:** `packages/schema/src` (payloads) and
   `projections/templates` (rendering).

---

## Three walkthroughs

**A session starts.** Claude Code runs the SessionStart shim → `sofar event
session-start` → resolve the initiative (session pin, else branch binding) →
fold that log → render the digest → stdout becomes injected context. One log
folded, never all of them.

**An agent edits a file.** PostToolUse fires → the edit is appended as
`file_touched` → guards are checked at the point of use → the next
UserPromptSubmit derives live hazards from the fold plus Tier 0: is another
live session in this file, in this initiative or any other, and can it be
reached by name.

**A session ends.** `sofar_end_session` appends `session_ended` → projections
regenerate → the fold is re-run to find concurrent sessions whose next action
differs → those are returned to the caller, with a peer address where the host
knows one. The Stop hook blocks a session that skipped this.
