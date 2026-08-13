# SPEC.md — Sofar v1 engine contracts (authoritative)

## Repo layout (npm workspaces monorepo — see BD11)
```
sofar/                   # workspace root: toolchain devDeps, shared tsconfig
  packages/
    schema/              # @sofar/schema — the ONLY schema home
      src/events.ts      #   event payload types + validation (source-shipped
      src/tool-inputs.ts #   internal pkg — main/types point at src, no build
      test/              #   step yet); tool-inputs = MCP tool arg schemas
    engine/              # sofar — the npm bin (CLI + MCP server + hooks)
      src/core/          # envelope.ts, log.ts (append), fold.ts, cursor.ts
      src/client/        # v2 sync client: config/http/device/repos/push/
                         # pull/doorbell — §Sync client
      src/mcp/           # server.ts + one file per tool
      src/cli/           # commands: init, new, switch, status, export,
                         # import, event (used by hook shims), serve
      src/cli/ui/        #   terminal rendering kernel (caps/style/symbols/
                         #   frames/spinner/layout) — §CLI UI; human
                         #   surfaces ONLY, agent surfaces never import it
      src/projections/   # generator.ts + templates/ (plan.md, decisions.md,
                         # status)
      src/hooks/         # shim script sources, installed to .claude/hooks/
      test/
  CLAUDE.md              # protocol — repo root so cold sessions auto-load
                         # it (BD34); points at docs/SPEC.md
  AGENTS.md              # thin router for AGENTS.md-reading tools (Codex,
                         # OpenCode) → CLAUDE.md + docs/ (BD35)
  docs/                  # SPEC.md, opencode-adapter.md, and the archived
                         # pre-migration prose record (pre-rename name)
```
Future packages (ui, sync, adapters) join packages/* post-v1; the
engine-only scope law still applies during the Fable window.

## Architectural invariants

- **Zero model API calls.** sofar never calls a model: no API keys, no
  inference costs, no user content fed to any model. Everything the engine
  produces is a read-side derivation computed locally; record write-backs
  are the agent's own tool-call args, which keeps their output tokens
  minimal by construction. Any change that would add a model call to sofar
  (e.g. cheap-model or Batch-API bookkeeping) is rejected until a Decision
  explicitly revisits this invariant (felt-cost D3, Jul 2026). The ONLY
  egress in the product is the v2 sync client (§Sync client, sync-client
  D4, Jul 2026): record events pushed to the user's OWN authenticated
  sofar-cloud repo, opt-in via `sofar login` + `sofar link`, revocable
  server-side — nothing else ever leaves the machine.
- **Injection byte-stability.** For an unchanged record, the SessionStart
  status block renders byte-identically — no timestamps, counters, or other
  volatile bytes are introduced at render time (all dates in the block come
  from event data). Pinned by regression test (felt-cost 1.2). Any
  cache-cost play built on this must cite token-optimization's rejected
  "leading with prompt caching" as an informed re-test (felt-cost D2).

## Record layout (what the engine manages inside a user repo)
```
.sofar/
  repo.md                      # repo-scoped memory (hand-written, NOT generated)
  bindings.json                # { "<git-branch-or-worktree>": "<slug>" }
  .index/                      # DERIVED, local, gitignored — §Derived index
  initiatives/<slug>/
    events.jsonl               # TRUTH — append-only
    plan.md                    # generated projection
    decisions.md               # generated projection
    memory.md                  # generated projection — only once something
                               #   is promoted; staging list for repo.md
    sessions/<session-id>.md   # generated per-session summaries
```

A slug MUST match `[a-z0-9-]+` (security-hardening 1.1). This is not a
cosmetic rule: the engine resolves an initiative by joining the slug under
`.sofar/initiatives/`, so a slug containing `..` or a separator walks out of
the record and writes events.jsonl and every projection into whatever
directory it lands in. The shape is enforced in TWO places, because they
close different doors: `@sofar/schema` rejects a non-slug `initiative`
argument at the MCP tool boundary, and `resolveInitiative` asserts the
RESOLVED path is still contained under `.sofar/initiatives/<slug>` — which
also covers the routes the schema never sees, namely a hand-edited or merged
`bindings.json` (a committed, team-shared file) and CLI `--initiative` flags.
Session ids are NOT slugs — they come from the agent tool in whatever shape
it uses — so they are sanitized into a filename instead (`[^A-Za-z0-9._-]`
→ `_`) and never constrained.

## Event envelope (v1 — stable; payloads evolve, envelope does not)
One JSON object per line in events.jsonl:
```json
{"v":1,"id":"<ulid>","ts":"<ISO8601>","initiative":"<slug>",
 "session":"<session-id|cli>","source":"claude-code|opencode|codex|cli|hook",
 "actor":"agent|human","user":"<git user.email — OPTIONAL>",
 "type":"<event_type>","payload":{}}
```
Rules: ulid ids (sortable); appends are atomic single-line writes with
O_APPEND; a reader must tolerate a torn final line (skip + warn); events are
immutable — corrections are new events of type `correction` referencing the
target id.
Canonical serialization (0.9.1): serializeEvent is the ONLY envelope
serializer, and its byte form is a pure function of the envelope value —
envelope fields in the fixed schema order above (`user` omitted when
absent; unknown additive fields preserved after `payload`, sorted);
payload and every nested object with keys sorted lexicographically by
code point, arrays in order; no whitespace; `ts` is carried verbatim,
never reformatted. Writer and puller therefore emit identical bytes for
the same event even when a store reorders keys (Postgres jsonb does) —
events.jsonl is git-committed, so byte divergence on identical events
would mean spurious diffs/merge conflicts. Canonicalization is
forward-only: existing log lines are never rewritten (append-only
stands); a historical line whose payload keys were inserted unsorted
keeps its bytes in place and only fresh serializations (push wire,
export, pull appends) carry the sorted form. Pull writes the canonical
form of the PARSED event, never raw wire bytes — a non-canonical server
can never poison a local log.
`user` (team-readiness T1, Jul 12) is OPTIONAL author identity: stamped when
the event is minted, from `git config user.email`, and omitted whenever that
is unavailable — the identity lookup must NEVER fail an append. Strictly
additive: the envelope stays v1, events without `user` remain valid forever,
and every reader (fold included) tolerates absence; when present it must be
a non-empty string (a malformed value fails envelope validation like any
other corruption — skip + warn, never fatal). `sofar import` never restamps:
imported events keep their original `user` (or its absence) — authorship is
minting-machine truth.

## Event types (payload schemas in packages/schema/ — the swappable part)
initiative_created · initiative_status_changed (status:
active|done|dropped, note? — note REQUIRED for `dropped`;
initiative-lifecycle 2.1 — overrides? — what the close-time audit found still
outstanding when the close went ahead anyway; commit-attribution 5.2, see
§Initiative statuses) · plan_updated (full plan structure) ·
phase_status_changed · task_added · task_status_changed (id, status:
pending|active|done|blocked|dropped, note?) · decision_logged (chose, over,
because, rule? — optional standing-constraint clause, one short imperative;
presence makes the decision a standing constraint with a verbatim-render
contract: never clipped, never aged out; drift-hardening D1 — guard? — the
mechanical half of that same clause, a `path:`/`cmd:` glob list valid ONLY
alongside `rule`; see §Decision guards, drift-hardening D3) ·
session_started (tool, model?) · session_ended (summary, next_action) ·
session_closed (reason — mechanical close from the SessionEnd hook; never
carries summary/next_action, added Phase 3, BD21) ·
file_touched (path, op) · command_run (cmd) · note_added ·
memory_promoted (text — a fact its author declares repo memory, addressable
as `<slug> M<n>`; repo-memory-capture D1) ·
review_recorded (scope: phase|final, verdict: pass|findings|blocked,
watermark?, phase?, findings? — a review that was actually performed;
commit-attribution 4.4, see §Review) · correction (ref)
`watermark` is review_recorded's load-bearing field, not `verdict`: it is the
sha the review read THROUGH, and it is what makes the next review's range
computable. That is why a review is an event and could never have been a
note. `findings` is REQUIRED and non-empty when verdict is `findings` —
validation rejects the pair, because a verdict claiming something was found
while recording nothing anyone can act on is a rubber stamp wearing the wrong
hat, and the next review would have nothing to carry forward.

## State (result of fold)
InitiativeState = { slug, goal, status: active|done|dropped, status_ts,
status_note, status_overrides[], phases[ {name, status, tasks[ {id, title,
status} ]} ], decisions[], memories[ {id, ts, text} ],
sessions[ {id, tool, model?, started, ended?,
summary?, next_action?, closed_reason?, activity?} ],
files_touched[], task_files, drop_notes, guard_violations[ {decision, rule,
guard, domain, subject, event_id, ts, session} ], reviews[ {id, ts, scope,
verdict, watermark?, phase?, findings[]} ], current: {active_phase,
next_action, blocked_on?}, freshness, cursor: <last event id> }

### Task statuses (task-drop-state D1)
`blocked` and `dropped` are NOT synonyms. `blocked` means "wants to happen,
cannot yet" — it stays outstanding and keeps nagging. `dropped` is terminal:
decided not to happen. `done` and `dropped` are both RESOLVED (no work
remains) but only `done` means delivered.

Progress therefore carries THREE terms, never two: drops are folded into
neither the numerator nor the denominator. Counting a drop as `done` would
claim delivery for work nobody built; subtracting it from the total would let
an initiative reach 100% by dropping its hard half, with the lost scope
leaving no trace. So `total` holds every task ever planned, and surfaces
render the drop count beside it:
- no drops: `9/10 tasks done (90%)` — byte-identical to pre-0.18 output, on
  which the injected digest's token budget depends
- with drops: `9 done, 1 dropped, 0 remaining` — "0 remaining" is the
  completion signal that `N/T done` can no longer give honestly
- percentages count drops as resolved, so a record with nothing outstanding
  reaches 100%; `pct` still never claims 100% while work remains

A phase is stale-active when every task is RESOLVED (done or dropped) and the
phase itself is neither done nor dropped. A dropped phase is not open work and
is excluded from the digest's itemized phase list.

`drop_notes` (task id → reason) retains the justification; reviving a dropped
task discards it. `sofar_update_task` REJECTS a drop with no note (D3), and
doctor warns when a drop's reason cites no decision.

### Initiative statuses (initiative-lifecycle 2.1, D1, D3)
An initiative carries the same two terminal words as tasks and phases:
`active` (the default — a log with no initiative_status_changed event folds
exactly as it always did), `done` (finished) and `dropped` (abandoned, and a
note is REQUIRED — unlike a dropped task there is no sibling work left to
infer the reason from). `blocked` is deliberately absent: a blocked
initiative is still active work, which its blocked TASKS already say.

Closed-ness is DERIVED (`isClosedInitiativeStatus`), never stored as a second
flag that could disagree with the status it summarises. `status_ts` and
`status_note` describe the status IN FORCE, so reopening overwrites both
rather than accumulating a closure the record has since undone.

**Closing unbinds (D1).** `sofar close [slug]` / `sofar_close_initiative`
appends the status event and then removes EVERY bindings.json entry pointing
at that slug — not just the current branch. Order is load-bearing: the log is
truth, so a crash between the steps leaves a record correctly marked closed
with a stale binding, which doctor reports and re-running close repairs; the
reverse order would unbind branches from a record that never closed —
invisible, and repetition would not fix it. Idempotent by the same rule:
already at this status appends nothing and still unbinds.

**Closing is AUDITED, and the audit refuses nothing** (commit-attribution
5.1/5.2/5.3). Closing used to be an unconditional append: the record said
"done" because someone said so, and nothing looked. `core/closeout.ts` runs
the tier that needs no model and no judgement — doctor scoped to ONE
initiative, asked at the one moment the answer still costs nothing to act on,
and the mirror of initiative-lifecycle 4.3 asking the same shape of question
from outside. Findings: tasks never resolved; phases never resolved; tasks
marked done that no file_touched event ever attributed a file to (asked only
of a record that touched files at all — in one that never did, every task
would flag and a finding firing on every member of a class says nothing about
any of them); guarded-rule crossings never addressed; drift since the last
write-back; phases never reviewed, above D9's three-phase floor; and no final
review, which is asked at EVERY size because it is the pass no phase review
can perform. Ids and names are capped per finding with a `(+N more)` tail.
MECHANICAL ONLY in the sense §State means it: every check reads structure —
statuses, counts, event presence. That is why "a next action left dangling" is
answered as DRIFT since the write-back rather than as a reading of the
sentence: content-semantic staleness inference is banned (D3/D12).
NOTHING IS REFUSED. A hard gate on a solo tool grows a `--force`, the flag
becomes the habit, and the check ends up worth less than nothing because
everyone has learned to step over it. Instead the findings ride ON the close
event as `overrides` and render from then on — under the record's `Status:`
line in `sofar status`, and on the SessionStart CLOSED banner, which is the
surface an agent actually reads (named up to 3, then a `(+N more)` pointer at
`sofar status`, because that banner precedes a block with a hard budget).
"Closed over 3 finding(s)" is a sentence its author has to live beside.
Both surfaces return them as well as recording them: the closing agent is the
only party who can still act, and a finding it never sees is aimed at nobody.
Absent `overrides` means the audit found NOTHING, never that it was skipped;
`status_overrides` is overwritten by the next status event on status_note's
rule, so reopening clears it rather than carrying forward a complaint about a
closure the record has since undone.
A DROP IS AUDITED TOO, and asks a different question (5.3). Dropping claims
the work was abandoned, so pending tasks are the point rather than a problem —
but tasks left ACTIVE are the landmine that makes a drop worth auditing at
all: half-built work, still wired in, with nobody coming back for it. Every
other check is asked unchanged. A dropped record arguably needs this more than
a finished one, since a drop otherwise demands only a prose reason.

**Reopening (D3)** happens by working on it again: `sofar switch <closed-slug>`
appends status `active` and binds, with no flag — switching a branch onto a
record IS that act — but never silently: it is announced and recorded, so the
log shows closed-then-reopened rather than an unexplained return to active.

Closed records are omitted from `sofar next` (a finished record has no next
action), sorted below open ones in `sofar list` and tagged with their status
in place of the branch tag, and carry a `Status:` line in `sofar status`.

### Forward compatibility of plan_updated (task-drop-state D2)
plan_updated is a FULL REPLACE, so rejecting one whole event for a single
unreadable status silently reverts the reader to the previous plan — losing
the goal, done statuses, and every task and phase added in that same event.
A task or phase status this build does not recognise is therefore coerced to
`pending` and warned about, keeping the rest of the plan. `pending` is the
conservative target: a stale reader over-reports remaining work rather than
quietly claiming something was resolved. Structural corruption (missing id,
malformed shape) is still skipped whole — the tolerance covers statuses only.
Engines predating 0.18 skip `dropped` events entirely; no data is lost (the
log is intact, only their render is wrong) and it self-heals on upgrade.
task_files (speed T4) = derived file-locality map, task id → file paths
touched while that task was ACTIVE at replay time: existing file_touched
events only (payload-valid, unvoided, any session/source incl. cli — the
freshness precedent), attributed to EVERY task active at that point in
ulid order; deduped most-recent-first (a re-touch moves the path to the
front), capped at 20 per task (oldest drops, no sentinel). Zero new event
types, zero new capture — read-side and retroactive over every existing
record; derived only from record events, so an identical record folds to
identical task_files (injection byte-stability holds by construction).
activity (Phase 7, BD44) = derived per-session aggregation of mechanical
events attributed by envelope.session (session "cli" excluded; unregistered
session ids stay unattached): { files[] deduped in first-touch order,
commands count, task_changes[] as "<id> → <status>" in log order } — lists
capped at 20 entries + "+N more" sentinel; present only when ≥1 such event
exists. closed_reason = the session_closed reason when that close set ended.
freshness (staleness-detection 1.1) = fold-time drift derivation from
MECHANICAL signals only — content-semantic staleness inference is banned
(D3/D12): { events_since_writeback: {files, commands, tasks, notes,
decisions, memories, reviews} counting payload-valid, unvoided file_touched /
command_run / task_status_changed / note_added / decision_logged /
memory_promoted / review_recorded events appended after
the last session_ended (ANY session/source incl. cli), unattributed_
mutations: how many of those COUNTED mutations carry no registered session
(envelope session "cli", or an id this log never registered) — a cross-cut
of the same events, never a seventh kind, notes: [{ts, text}]
— the CONTENT of the counted note_added events (notes-in-digest 1.2: the
counters say THAT the record drifted, the notes say WHAT), log order,
uncapped at fold, notes.length === counts.notes by construction; when
nothing ever wrote back the window is the whole log — every note is
un-absorbed, last_writeback_ts: ts of that session_ended, or null when
nothing ever wrote back }.
session_ended is the ONLY reset (session_closed resets nothing); zero new
event types — the derivation is read-side and retroactively covers every
existing record.
freshnessTotal(freshness) = files + tasks + notes + decisions + memories +
reviews.
`commands` is counted in the struct and deliberately EXCLUDED from the
total (drift-signal D1): drift asks whether the recorded next_action is
now wrong, and a command cannot make it wrong. A REVIEW can and does
(commit-attribution 4.4): it settles findings the next action has to absorb,
and a session whose whole job was the review would otherwise owe the record
nothing and pass the Stop gate with its verdict unexplained — the one session
whose conclusions are least recoverable from the diff. Speed T1 counted it on the
premise "pure reads emit no events", which an agent reading through Bash
disproves continuously — command_run was 57% of every event in this repo's
own records. Commands are still logged, still carried per session by
describeActivity, and still feed `sofar graph` command nodes.
SessionState.unwritten (drift-signal 1.1) = the same window and the same
kinds asked of ONE session: mutation-class events carrying its id since
its OWN last session_ended (resolved as applyEvent resolves it — payload
session_id ?? envelope session). Companion sessionDebt(state, session) =
session.unwritten + freshness.unattributed_mutations — what that session
owes the record, and the single definition the Stop gate and the
UserPromptSubmit nudge share. A sibling's ATTRIBUTED work is absent by
construction: it is owed to that sibling's own gate, which is what makes
concurrent gates independent (the Phase 7 law) without an OR. Companion derivation staleActivePhases(state) (the D-P11
stale-phase check extracted from doctor — one detector, two surfaces) lists
phases whose tasks are all done but whose status was never set to done.
Companion derivation overlappingWritebacks(state, referenceSessionId?)
(task 12.4, BD58 family): current.next_action is last-writer-wins (BD9), so
when concurrent sessions each write back, the losers' next actions vanish
from the scalar — this lists ended, next_action-bearing sessions whose
[started, ended] interval overlaps the reference session's, excluding
duplicates of the reference's text; newest-ended first. The reference
defaults to the winner (max ended, tie → later session order). Rendered in
renderStatus (SessionStart block + get_state digest, ≤3 lines, 260-char
clip) and `sofar status` (uncapped), directly under the next action.
`referenceSessionId` pins a named session as the reference instead
(writeback-collisions 1.2) — an id naming no next_action-bearing session
falls back to the winner. The write-time surface needs this because the
caller is NOT reliably the winner: same-millisecond `ended` timestamps are
routine, and ties resolve by session_started order rather than by who
appended last, so "did I win" is the wrong question for a writer to ask.
"What differs from what I just wrote" is well-defined either way.
FoldResult additionally carries orphan_task_events (task 12.2, BD58):
task_status_changed events that were skipped at replay AND whose task id
is absent from the FINAL plan — replay-time skips later legitimized by a
task_added/plan_updated (clock-skew ordering, D-sync-1 rider b) are NOT
orphans. Additive; InitiativeState itself is unchanged.
**Git state** (record-integrity 4.1) is DERIVED at render time and never
recorded: core/git.ts readGitState(rootDir) resolves branch, local tip
(refs/heads/<branch>), and origin tip (refs/remotes/origin/<branch>) from
loose refs then packed-refs, yielding {branch, head, upstream, synced}.
Commits and pushes leave no trace in the record by design (record-hygiene
D1 exempts git from PostToolUse), which is precisely why a session could
not tell whether work was pushed; git is an authoritative self-describing
ledger, so it is READ rather than copied. Refs only — no subprocess and no
commit-graph walk, because this runs inside the 100ms shim budget (speed
T2) — so the answer is "same or different", not an ahead/behind count. In
a shared checkout every session sees one .git, so a push by any of them
updates the origin ref for all of them at once. Best-effort: null renders
nothing. The status block carries it as one `Git:` line above Goal, and the
UserPromptSubmit shim emits it as its own unconditional line (4.4).
Its honest limit is the TIP. In a shared worktree that tip belongs to whoever
committed last, so refs alone can never say whether THIS record's work
shipped — only whether the branch is level with origin. §Commit attribution
answers the per-initiative question, from a bounded walk deliberately kept off
this path.
FoldResult also carries unregistered_sessions (record-integrity 2.1): every
session id appearing on an event in THIS log that no session_started here
ever registered, sorted, never including "cli". The fold attaches activity
to registered sessions only (BD21/BD44), so such events were previously
counted by freshness and files_touched while attributable to no session —
invisible mass. A non-empty list is the misroute signature and feeds
doctor's session-routing audit. Additive; InitiativeState unchanged.
**Reviews** (commit-attribution 4.4) fold in log order and are load-bearing
state rather than a history of opinions. Two derivations read them, and both
are single-definition: reviewWatermark(state) is the watermark carried by the
LATEST review that carried one — the lower bound of the next review's range —
and openFindings(state) is the findings of the latest review per scope+phase,
flattened. A review of the same scope and phase SUPERSEDES its predecessor, so
a re-review after fixes clears its findings; a `blocked` review carries no
watermark and therefore leaves the previous one standing rather than resetting
the range to the start of the record. Contract in §Review.
### Decision guards (drift-hardening D3)
The MECHANICAL tier of a standing constraint. `rule` states the law in prose
(D1); `guard` is the half of that same law a machine can check, and it lives
on the same event, because the warning it raises has to name the decision it
enforces — a side file drifts from the clause it claims to guard. Valid only
alongside `rule`: a guard with no clause has nothing to cite.

Grammar (packages/schema/src/guards.ts — the payload contract, so it lives in
the schema package): `path:<globs>` matches file_touched paths, `cmd:<globs>`
matches command_run commands; comma-separated, a leading `!` EXEMPTS, and a
guard fires when ≥1 positive pattern matches and no exemption does. Globs
carry `*` (not crossing `/` in the path domain), `**` (crossing it, and
matching zero directories as a leading segment) and `?`. `path` patterns
anchor at a `/` boundary on the left and at end-of-string on the right, so
`packages/schema/**` means the same thing against the ABSOLUTE paths hooks
log on any machine; `cmd` patterns match as a SUBSTRING, because
`cmd:npm publish` silently never firing would be a guard that reads as
compliance. Not regex: agent-authored patterns must be safe to compile and
cheap inside the 100ms shim budget, and every ambiguity resolves toward a
non-match. An all-exemption guard is rejected at validation for the same
reason — it can never fire.

Evaluation is fold-time and NON-RETROACTIVE by construction: guards run
inside the replay against the decisions already logged, so a guard only ever
sees the work that followed it and never flags the work that motivated it.
Crossings land in `state.guard_violations` deduped per (rule, session,
subject) — a file edited thirty times is one violation of one rule — and
capped at 100 so one broad guard cannot grow the fold without bound. A voided
decision guards nothing.

WARN, NEVER BLOCK: no exit code anywhere moves because a guard fired. Three
surfaces read the one derivation — `sofar doctor`'s decision-guards axis
(WARN, whole record), the UserPromptSubmit line (this session's crossings
since its last write-back, rendered first), and the Stop message, which
appends crossings to a block the gate had ALREADY raised for a missing
write-back and never converts an exit 0 into an exit 2. The rule text renders
verbatim on every one of them (D2): subjects drop whole with a count pointer
and paths render repo-relative, but nothing clips inside the clause.

Repo-level derivation listInitiatives(rootDir) (initiative-list 1.2):
every directory under .sofar/initiatives/ summarized — slug, bound
branches (bindings.json inverted), tasks done/total, active phase, next
action, last envelope-valid event id — ordered by last-event ulid
DESCENDING (record recency), never-logged initiatives last by slug asc;
tolerant like the fold (unreadable log or corrupt bindings.json → warning
+ thinner entry, never fatal); zero new event types.

## Record graph (repo-wide adjacency derivation — record-graph 1.1)
`buildGraph(rootDir)` (core/graph.ts) is ONE mechanical, read-side adjacency
derivation over every `.sofar/initiatives/*/events.jsonl` in the repo. It
subsumes the bespoke per-edge reducers (task_files, activity) and recovers
the cross-initiative provenance the per-initiative fold structurally drops —
a session, a file path, and a cited decision all outlive the log they were
written to, and the fold sees one log at a time.

**Guarantees (each one load-bearing, not aspirational):**
- **Zero new event types, zero new capture.** Every node and edge is derived
  from envelopes and payloads already present. The write path is untouched;
  nothing is added to any hook or tool.
- **Retroactive over every existing record.** Coverage is whatever logs
  exist, pre-rename history included — no backfill, no migration, no schema
  change. (Contrast the rejected declared-`scope` field, which would have
  been the first non-retroactive derivation in this engine.)
- **Zero model API calls** (§Architectural invariants, felt-cost D3).
  Citation extraction is a CLOSED LEXICAL GRAMMAR with literal matching
  only — no inference, no embeddings, no entity resolution.
- **Deterministic.** Replay order is ulid order, as in the fold (D-sync-1);
  node and edge order is a pure function of the event set. The same records
  build a deep-equal graph with identical warnings.
- **Tolerant.** Corrupt or unknown lines skip with a warning, never fatal,
  never rewritten; an unreadable log degrades to a warning and a thinner
  graph (the listInitiatives precedent).
- **Never in the hot path.** buildGraph reads N logs where the fold reads
  one, so it cannot fit the 100ms shim budget (speed T2). Its ONLY consumers
  are explicit CLI surfaces (`sofar why`, `sofar related`) and doctor;
  no hook, statusline, or shim path may import it (pinned by test, 3.4).

**Nodes** — id is stable and unique repo-wide; `kind` discriminates:
```
initiative:<slug>            slug, goal
phase:<slug>#<name>          initiative, name, status
task:<slug>#<task id>        initiative, task_id, title, status
session:<session id>         tool?, model?, started?, ended?
file:<repo-relative path>    path
command:<event ulid>         initiative, session, ts, cmd
decision:<event ulid>        initiative, session, ts, ordinal, chose/over/because, dangling[]
note:<event ulid>            initiative, session, ts, text
```
Three families, and the difference is the point. STRUCTURAL nodes
(initiative, phase, task) come from each initiative's FINAL folded state, so
a plan_updated that drops a task drops its node — they describe the plan as
it now stands. OCCURRENCE nodes (command, decision, note) are one per
sourcing event, keyed by its ulid: an occurrence has no identity apart from
the event that recorded it. JOIN nodes (session, file) are deliberately NOT
slug-scoped — the session id and the repo-relative path are the same
identity in every log that mentions them, and that shared identity is the
entire cross-initiative edge. Task ids are NOT repo-unique (`1.1` exists in
most initiatives), so every structural id carries its slug.

**Edges** — `{kind, from, to, initiative, event_id?, ts?, attrs?}`:
```
structural (final folded plan; no event_id)
  has_phase   initiative -> phase
  has_task    phase      -> task
occurrence (exactly ONE edge per sourcing event; carries event_id + ts)
  touched     session    -> file       file_touched            attrs.op
  ran         session    -> command    command_run
  changed     session    -> task       task_status_changed     attrs.status
  decided     session    -> decision   decision_logged
  noted       session    -> note       note_added
  worked      task       -> file       file_touched x every task ACTIVE then
derived from decision prose (closed lexical grammar; no event_id)
  cites       decision   -> decision | task
```
Occurrence edges are multi-edges by design: they are NOT deduped into
pairs. Losing the per-event grain would make the consolidation in Phase 4
impossible — activity's `task_changes` renders every status change in log
order, including repeats on one task, and its `files` list is
first-touch-ordered. Deduping is a READ-side choice each query makes.
`edge.initiative` is the envelope.initiative of the sourcing event (the home
slug for structural edges), which is what makes cross-initiative provenance
a filter rather than a join.

Session-anchored edges form only for events whose `envelope.session` is a
real session id: `cli` is not a session identity and gets no node (the
activity rule, BD44). A cli-sourced file_touched still mints its file node
and still forms `worked` edges — task_files and freshness both count cli
events, and this derivation subsumes task_files, so it must match. The
`worked` edge is exactly the task_files rule generalized repo-wide: a
file_touched attributes to EVERY task active at that point in ulid order.

**Citation grammar (the `cites` edge, record-graph 1.3).** Matched over the
concatenated decision text (chose + over + because):
- QUALIFIED `<slug> <handle>` — `<slug>` must be an initiative directory
  that EXISTS; `<handle>` is `D<n>`, `T<n>`, or `<n>.<n>`. Binding is
  case-insensitive: slugs are lowercase by construction (`sofar new`
  validates `[a-z0-9-]+`), so `Felt-cost D3` at a sentence start is
  orthography, not a different name — and an exact-match rule would not
  leave it unbound, it would silently degrade the handle to an UNQUALIFIED
  one bound to the WRONG (home) initiative. A word that case-folds to no
  known slug qualifies nothing; the handle stays home-bound, since every
  unqualified citation follows some prose word.
- UNQUALIFIED `D<n>` or `T<n>` alone — resolved against the CITING
  decision's own initiative.
- Bare `<n>.<n>` is NOT a handle. Measured on the live record it matches
  version strings (`0.1`, `0.7`, `0.8`) and an IP octet (`127.0`) — 20 false
  positives, zero true ones. A dotted task id needs its slug.
- `BD<n>` and `D-<label>` (`D-P11`, `D-sync-1`) are NOT handles: they name
  the archived pre-migration prose record and hand-coined labels, neither of
  which has a node here. They are outside the grammar entirely — never
  matched, so they neither resolve nor land in `dangling[]`. The archived
  record is cited pervasively (BD22/BD16 7x each on the live record);
  recording those tokens would flood `dangling[]`, which is reserved for
  grammar-matched handles precisely so it stays a finding, not noise.
- `M<n>` (a promoted memory, repo-memory-capture D2) is OPT-IN and matched
  only by the `.sofar/repo.md` scan, which reads qualified handles and never
  resolves. It is absent from the decision-prose grammar because promoted
  memories have no nodes to resolve against, so matching it there would send
  every legitimate mention to `dangling[]` — the same flooding the BD<n>
  exclusion exists to prevent. Minting memory nodes would lift the
  restriction; until then M<n> resolves nowhere.

Resolution is literal and refuses to guess:
- `D<n>` → the nth decision_logged in that initiative's log in ulid order,
  1-based (`decision.ordinal`). This numbering is not invented for the
  graph — it is the convention the record already uses, and it round-trips:
  felt-cost D3 resolves to the zero-model-API-calls decision that
  §Architectural invariants cites by that handle.
- `T<n>` / `<n>.<n>` → the task with that EXACT id in that initiative's
  final plan.
- A decision target resolves only when its event id sorts BEFORE the citing
  decision's: a decision cannot cite the future.
- A decision naming its OWN ordinal is a self-label, not a citation, and is
  dropped (no self-edges).
- Anything else is DANGLING: carried on the citing decision node as
  `dangling[]`, never silently discarded. Dangling citations are a finding,
  not noise — `record-integrity 4.4` and `4.5` dangle because that
  initiative's plan never held tasks by those ids.

Measured over the live record (2026-08-03; 140 decisions, 15 logged
initiatives): 62 handle tokens → 22 decision edges, 11 task edges, 5
self-labels, 5 future refs, 19 dangling; 8 of the 33 resolved edges cross an
initiative boundary. That cross-boundary set is the whole basis of
`repoGeneral` (2.3): repo-generality is OBSERVED from citation behaviour
rather than declared at log time, and its top result on this repo is
felt-cost D3 — cited from record-graph and sync-client — the decision
CLAUDE.md and §Architectural invariants already treat as repo-wide law.

**Queries (record-graph 2.1-2.4)** — read-only over a built graph:
- `whyFile(graph, path)` → every session, task and decision behind a path,
  across ALL initiatives, newest-first. Sessions (`touched`) and tasks
  (`worked`) are DIRECT edges. Decisions are a documented TWO-HOP join
  (decision ← session → file) and a weaker claim: the record knows which
  session logged a decision and which files that session touched, never that
  the decision was ABOUT the file — surfaces must not present it as direct.
- `relatedTasks(graph, taskNodeId)` → co-touched-file neighbours ranked by
  shared-path count, cross-initiative included. Joins on file-node identity
  as recorded.
- `repoGeneral(graph)` → decisions cited from initiatives other than their
  own, ranked by DISTINCT citing initiatives, then citation volume, then
  oldest. Uncapped at derivation (the overlappingWritebacks precedent) — it
  feeds doctor (3.3) as well as renders.

Ordering and dedupe follow the task_files precedent: dedupe most-recent
first, newest-first out. Lists cap at GRAPH_RESULT_CAP (20) and report
overflow as a NUMERIC `omitted` count — never as a `+N more` element inside
a typed list, because query results feed doctor as well as renderers and the
in-band sentinel in `activity.files` is already why openSessionFileConflicts
must defend with `startsWith('+')`. Rendering `+N more` is a surface concern.

**Path identity.** file_touched records the path the agent actually edited —
an ABSOLUTE path — so one logical file accumulates a node per checkout it
was ever edited from. Measured here: 229 file nodes, 89 outside the current
root, 38 under `.claude/worktrees/`, and 21 paths split across checkouts;
`packages/engine/src/cli/doctor.ts` exists under four, including
`/Users/jins/IO/harness/...`, this repo's PRE-RENAME root. Recorded paths
are never rewritten and no prefix rule recovers a directory rename, so node
identity stays verbatim and `resolveFileNodes` joins at READ time: an exact
hit wins outright, otherwise every recorded path ending at a segment
boundary with the query matches, and callers report `matched_paths`. Literal
matching, no inference; the caller controls specificity.

**Surfaces (record-graph 3.1-3.4).** buildGraph has exactly THREE consumers —
`sofar why <path>`, `sofar related <task-id>` (both in §CLI) and doctor's
repo-memory axis — and the exclusion is as normative as the derivation. The
shims fire on the user's critical path against a 100ms end-to-end budget
(speed T2) and the CLI is built as separate bundles for exactly that reason
(`dist/fast.js` for the shims and statusline, `dist/full.js` for everything
else), so a graph import inside the hot path would be paid on every tool use.
Two static locks hold it: no module under `mcp/` or `projections/`, and
neither `cli/fast.ts`, `cli/boot.ts`, `cli/event.ts` nor `cli/statusline.ts`,
may reach `core/graph.ts` by any import chain; and the rebuilt hot-path bundle
must not contain a byte of graph code (which also catches a dynamic import or
a barrel re-export the walk would miss). The `mcp/`+`projections/` half of
that set doubles as the pin on a rejected approach — feeding graph results
into the SessionStart block or the `sofar_get_state` digest, which would put
an N-log read behind every session start and spend the digest budget on
adjacency.

Rendering follows the ladder in §CLI UI: capability-gated styling over a
shared section model, so the styled path paints the plain one rather than
re-deriving it. Plain output is WIDTH-INDEPENDENT — prose clipped at a fixed
budget, never wrapped to `$COLUMNS` — so piped output is byte-stable across
terminals.

**Consolidation (record-graph 4.1-4.3) — where the ONE rule lives.** The
adjacency vocabulary and the single emission rule live in `core/adjacency.ts`,
BELOW both the fold and the graph:
```
core/adjacency.ts   node ids, edge vocabulary, edgesForEvent(),
                    taskFilesFromEdges(), activityFromEdges()
core/fold.ts        state replay — EMITS this log's edges as it goes,
                    derives task_files + each session's activity from them
core/graph.ts       repo-wide union of those per-log edge lists,
                    + occurrence-node minting, citations, queries
```
That direction is forced, not stylistic: `graph.ts` imports `fold.ts`, so
`fold → graph` would be a cycle, and it would hand the hot path the N-log read
this section forbids. Below-both gives one rule with neither problem — the
fold already tracks the live plan, so "which tasks were active when this file
was touched" (speed T4) is decided exactly once, and `FoldResult.edges` is
slug-qualified and directly unionable.

The gate was byte-identity and it was MEASURED, pre- vs post-consolidation
over the live record: the whole repo-wide graph (3205 nodes, 4300 edges, in
order) plus every initiative's `task_files`, per-session `activity`,
`files_touched`, `freshness`, `phases`, warnings, orphans and unregistered
sessions came out identical. Cost: `foldLines` on the largest log 0.90ms →
1.04ms against speed T2's 100ms shim budget (pin still green); `buildGraph`
stays ~17ms and off the hot path. Deleted by it: the graph's own plan tracker
and event switch, the fold's `recordTaskFiles` and `recordActivity`.

`unregistered_sessions`, `overlappingWritebacks` and
`openSessionFileConflicts` deliberately STAY in the fold. They are read-only
queries over the folded session table rather than per-edge reducers, and each
needs a fact the graph deliberately drops: `unregistered_sessions` is PER-LOG
registration (the misroute signature) where the graph makes a session id one
identity across every log — the very property the cross-initiative join rests
on — and `overlappingWritebacks` needs write-back prose for a `next_action`
that is per-initiative by construction (BD9).

## Commit attribution (commit-attribution — read from git, never recorded)
The record cannot see git and git cannot see the record. That gap is why a
session could not tell whether ITS work had shipped: §Git state answers "is
the tip level with origin", and in a shared worktree the tip belongs to
whoever committed last. The binding that closes it is a COMMIT TRAILER (D4),
written at commit time by the session that made the commit:

```
Sofar-Initiative: <slug>
```

**Recorded in git, derived from git, never in the record.** sofar appends no
event about a commit and stores no sha. The split is not a preference (D2): a
commit's initiative NEVER changes, so the recorded half cannot go stale where
it lives, while push and merge state change constantly — force-push, rebase,
branch deletion — so recording those would strand a false fact the record
could never retract. Logging a commit would also collide with record-hygiene
D1, which exempts git from PostToolUse precisely so a working tree can be
settled. Attribution is therefore never inferred from timestamps or file
overlap either: an unattributed commit reads back EMPTY, and that is a
first-class answer rather than a failure to guess (1.3).

**Read incantation** (core/attribution.ts, probed on git 2.50.1):
`git log --max-count=<n> --format=…%H…%(trailers:key=Sofar-Initiative,valueonly,separator=%x2C)…%B`.
Always pass `separator=` — bare `valueonly` emits a TRAILING NEWLINE that
corrupts any line-oriented parse. Records are split on RS/US (`\x1e`/`\x1f`)
rather than newlines, because a trailer value may legally fold across lines
and a newline parse would tear one commit into two. Survival, measured rather
than assumed: cherry-pick and rebase PRESERVE the trailer; an untrailered
commit reads back empty; `git merge --squash` indents it (see below). A slug
must match `[a-z0-9-]+` — anything else is dropped rather than surfaced, since
the trailer is free text a human can mistype and an invented initiative name
is exactly the wrong attribution D5 forbids. MORE THAN ONE slug on a commit is
legitimate, not corruption: a squash carries several, and saying so is the
honest reading.

**Two rules bound every read (D6).** (1) NEVER run the walk unconditionally on
the hot hook path. core/attribution.ts is deliberately NOT core/git.ts, whose
"reads FILES, no subprocess" guarantee the 100ms shim budget rests on (speed
T2); putting a spawn behind that file's name would void the guarantee silently
for every caller. (2) ALWAYS bound the walk: spawn cost is fixed, an unbounded
walk is O(history) and grows without limit. Measured on this repo at 454
commits (20 iterations, median): bare `git rev-parse HEAD` 8.35ms — so spawn
alone dominates — a 20-commit trailer walk 10.35ms, last-100 15.55ms, a full
walk 21.21ms with a 45.25ms tail. Against ~33ms of shim headroom
(record-integrity D13 measured 63-67ms already spent) the full walk's tail
alone would blow the budget. Prefer a RANGE over a count: `origin/<branch>..HEAD`
is both cheaper and exactly the question the shipping signal asks. Callers gate
on a ref having actually MOVED, which §Git state answers for free from files.
Best-effort by contract throughout, like gitUserEmail: no git, no repo, a
malformed trailer → null or an empty list, never a throw. Attribution is a
signal, and a missing signal must never break a caller.

**Squash recovery (D16).** `git merge --squash` writes SQUASH_MSG with each
original message indented four spaces, which puts the trailer OUTSIDE git's
own trailer block: the squashed commit reads back unattributed and a shipped
initiative reports as un-shipped. A false negative — the safe direction — but
it becomes the normal case the first time work lands through a squashed PR
rather than straight to main. The slug is still in the commit object verbatim,
so recovering it is still READING git rather than guessing, and two gates keep
it on that side of D4's line: it runs ONLY when git's own trailer block
yielded nothing, so prose can never override a real trailer, and it matches
ONLY INDENTED occurrences, so it looks exclusively at the shape a squash
produces. `%B` rides the existing walk, so the fallback costs output bytes,
never a second spawn. NOT recoverable by construction: committing a squash
with `-m` or `-F` discards SQUASH_MSG entirely, so the slug is not in the
object at all and the commit stays honestly unattributed.

**Who writes it (D5).** A `prepare-commit-msg` hook — automatic, never
remembered. Resolution is session-first and session-ONLY: git hooks inherit
`CLAUDE_CODE_SESSION_ID`, `sofar commit-trailer <msgfile>` maps it through
homeInitiative to the log that actually registered that session, and the
branch binding is passed only as `preferred`, where it can break a tie but can
never invent an answer. A session registered nowhere resolves to null and
NOTHING is written: a wrong attribution is worse than a missing one, and in
this repo the branch binding IS wrong most of the time — main is bound to one
initiative while several are worked on it. Idempotent by design, because
prepare-commit-msg fires again on `git commit --amend` and a message
accumulating one trailer per amend would forge a single commit into a fake
multi-initiative squash. The trailer is appended above git's comment block
(everything from the scissors line or the trailing `#` lines), separated from
the body by a blank line, or git reads it as prose and `%(trailers)` returns
nothing. It NEVER fails a commit: no session, no record, an unreadable message
file, a missing binary — every failure path is a silent success, and the shim
exits 0 unconditionally. A hook that can block `git commit` is worse than no
attribution at all.

**Shipping, derived (3.1).** Per initiative, over a bounded window: `pushed` /
`local` / `unknown`. ONE spawn answers the whole set — `git rev-list
origin/<branch>..HEAD` yields the unpushed shas and membership labels every
commit; the obvious alternative, `git merge-base --is-ancestor` per sha, is a
spawn each (~168ms for a 20-commit window at the measured floor, against ~9ms
here) and is bounded by the window rather than by the unpushed delta.
`unknown` is a first-class answer, not a failure dressed up: with no remote ref
fetched there is genuinely no way to tell, and reporting `local` would assert
"your work has not shipped" on no evidence — the exact false alarm this
initiative exists to remove. The walk skips the second spawn entirely when
nothing in the window is attributed, which is the dominant case (every repo
before it adopts attribution) and halves the cost there. LOCAL ONLY (D8):
shipping is answered from refs and trailers, never by querying GitHub or any
forge API — not on egress grounds, since a call carrying no user content is
already carved out by §Architectural invariants, but on cost, dependency and
marginality.

**First push subtracts (D17).** On the FIRST appearance of `origin/<branch>`
there is no previous sha to diff against, and bare reachability from the new
tip is not the answer: a feature branch cut from an already-pushed base
reports the whole base as newly landed (measured: 4 commits when 1 had
arrived). The walk therefore subtracts every OTHER origin ref — `<tip> --not
--exclude=origin/<branch> --remotes=origin`, the `origin/<branch>` form being
the one git actually honours here, since it matches relative to refs/remotes/
and both the bare branch and the full refname silently exclude NOTHING. The
answer becomes what THIS push put on the remote. A branch that is the only one
on the remote subtracts nothing and every commit is genuinely new, which is
the honest answer for a true first push.

## Review (commit-attribution — phase boundaries, watermark ranges, gates nothing)
Closing an initiative was an unconditional append: nothing rechecked that the
execution was RIGHT. And a reviewer handed only the record can do nothing but
re-read the initiative's own prose and agree with it — the same session's
claims, restated. Attribution supplies the missing half, the DIFF the work
actually produced; the record supplies the half no code-review tool can hold,
the CONSTRAINTS the work was supposed to honour.

**When (D9).** At PHASE BOUNDARIES, and only for initiatives of three or more
phases — below that the close pass is the whole review and a per-phase one is
ceremony. Plus one FINAL pass at close (D10).

**Range (D9).** watermark..HEAD, filtered to this initiative's
trailer-attributed commits. The watermark rides on the review_recorded event
itself, which is the whole reason a review is an event and not a note. NEVER a
range derived from task or phase timestamps: that is the time-window guess
record-integrity D6 rejected, and it misreads interleaved parallel sessions.
With no prior review the walk falls back to a bounded window (200 commits),
never to all of history (D6).

**The final pass asks only what a phase review structurally cannot (D10)** —
goal conformance (does the finished thing achieve the goal stated at the top
of the record), cross-phase drift (did a later phase violate a decision taken
in an earlier one), integration (every phase passed alone; do they compose),
and findings left unresolved. It never re-audits per-phase correctness:
re-treading ground is how a close review becomes a rubber stamp, and it trains
a reader to skim.

**The packet** (projections/templates/review.ts, rendered by `sofar review`)
carries: the goal; the range, with the commits listed EXPLICITLY as
`git show <sha> <sha> …` rather than as `oldest..newest` — a two-dot range
means "reachable from newest but not oldest" and silently EXCLUDES the oldest
commit, losing the first commit of every phase, while parent notation breaks
on a root commit; tasks claimed done with the files their events touched;
standing constraints VERBATIM (clipping a constraint in the one document whose
job is conformance would defeat the packet entirely); rejected approaches,
because re-entering one looks like progress and is invisible from the diff
alone; guarded rules the record already crossed; and findings still open from
earlier reviews. An EMPTY range renders as a FINDING, never as an empty
section: either the work landed without the trailer — attribution is silently
off, and `sofar doctor` says which — or the phase was completed with no code
change at all, and a review of a diff you cannot see is worth nothing.

**The instruction is HOST-AGNOSTIC (D3, amended by D12).** It spells the
code-quality work out — correctness bugs, unhandled edge cases, error paths,
resource leaks, and anything a simpler construction would do better, each with
file and line — and offers a named skill only as a SHORTCUT where the host
happens to have one (in Claude Code, `/code-review` then `/simplify`). sofar
runs under any agent, which is what the AGENTS.md dialect exists for (BD31),
so naming a host-specific command AS the instruction would render an
instruction most readers cannot follow. sofar ships no analysis code and makes
no model call (§Architectural invariants): the reviewing SESSION does the work
and `sofar_review` records what it concluded.

**DECOUPLED from close (4.5).** `sofar_review` gates nothing. If passing a
review were what let a session go home, the reviewing agent would have an
incentive to pass and would find nothing. Close reads the verdicts separately
and reports what is open. A `blocked` verdict SKIPS rather than
resetting the watermark, so a review that could not run cannot silently widen
the next one's range back to the start of the record.

## Derived index (record-index — local, incremental, never truth)
Every cross-record question — which initiatives hold open sessions, who else
has this file, what guards this path, what else bears on this work — costs a
sweep of the whole record when answered from the logs, and the shims that need
those answers fire against speed T2's 100ms end-to-end budget. The index is
the other shape. Events are APPEND-ONLY and ulid-ordered, so a derivation over
a PREFIX is permanently valid: nothing is ever invalidated, only extended.
That makes maintenance O(new events) and makes a stale index a PARTIAL index
rather than a wrong one — which is the property the whole safety argument
rests on.

**Layout** (created on demand; every file disposable):
```
.sofar/.index/
  .gitignore          # `*` — ignores the directory AND itself, so the user's
                      #   own .gitignore never has to learn this exists
  meta.json           # Tier 0 cursors
  open.json           # TIER 0 — open sessions per initiative + files held
  meta-guards.json    # Tier 1 declared cursors
  guards.json         # TIER 1 DECLARED — every guarded decision in the repo
  meta-graph.json     # Tier 1 derived cursors
  graph.json          # TIER 1 DERIVED — path → session → (ts, touches)
  meta-reach.json     # Tier 1 reach cursors
  reach.json          # TIER 1 REACH — clipped prose, citation handles, terms
  shipwatch.json      # NOT A TIER — per-session origin/<branch> marks
                      #   (commit-attribution 3.4); own version, no cursor
```

**Three rules, and they are the whole safety argument (record-index D1).**
1. DERIVED, NEVER TRUTH. Truth is events.jsonl. Any file here may be deleted
   at any moment and rebuilt with no loss. Absence, staleness or corruption
   MUST fall back to reading the logs — a reader may answer more slowly
   because the index was missing, never differently.
2. LOCAL, NEVER COMMITTED, NEVER SYNCED. It is not append-only, so the
   `merge=union` bargain that makes events.jsonl mergeable (team-readiness T2)
   does not apply to it, and it would arrive stale in every clone. It is not
   part of §Cursor primitive's export/import stream either.
3. VERSION-STAMPED. `INDEX_SCHEMA_VERSION` (4) is written into every tier file
   and every meta file. Absent, unreadable, malformed, wrong version and wrong
   shape all collapse to the SAME null — start cold — because they mean the
   same thing to a caller, and distinguishing them would tempt a reader into
   trusting a partially-valid file. `shipwatch.json` carries its OWN version
   instead, for the same reason it has no cursor: it derives from refs rather
   than from events, so a shape change there should cold-start that one file
   and never force a full index rebuild.

**Cursor semantics.** Distinct from §Cursor primitive, which is the sync
cursor over event ids; this is a per-initiative READ POSITION in one log:
`{ id, offset, size, mtimeMs, maxId?, voided? }`. `offset` is the byte offset
where the line of `id` STARTS, not where it ends, and that is what makes a
seek self-corroborating — the first line read back must carry `id`, and when
it does not, the offset is lying (an import, a rewrite, a restore, a
truncation that landed plausibly) and the reader falls back to reading the
whole log. Offsets are computed in BYTES: payloads carry prose, and a UTF-16
length would drift from the file position on the first em dash. There is no
configuration for this and no way to force the fast path — an index that can
be talked into a wrong answer is worse than no index.

`size` + `mtimeMs` together answer "has this file been touched since I read
it" from ONE stat, which is what keeps a quiet initiative costing a syscall
instead of a read. Neither half stands alone: an append always grows the file,
so `size` catches every append, while a rewrite can preserve size, so
`mtimeMs` catches the import/restore/checkout that size cannot see. Both must
match to skip a log. mtime is never TRUSTED here, only used as a difference
detector — the one thing it is honest about, and the opposite of why
`warmth.ts` rejects it as a warmth signal.

**When resuming is UNSOUND** — four cases, each falling back to reading the
whole log rather than to a guess, because the cost of being wrong is silent
and permanent while the cost of being conservative is one re-read:
1. THE CURSOR DOES NOT DESCRIBE THIS FILE — caught by the corroboration above.
2. THE TAIL IS NOT IN ULID ORDER. The fold replays in ulid order, not file
   order (§Cursor primitive, convergent fold), and `merge=union` interleaves
   two branches' lines. An arriving id that is not above everything already
   applied forces a rebuild, and a rebuild sorts exactly as the fold does.
3. A CORRECTION VOIDS SOMETHING ALREADY APPLIED. `correction` is the one
   retroactive act in an append-only log: it names an event id and the fold
   drops that event wherever it sits. A correction reaching back past the
   current batch rebuilds the log; ignoring it would keep reporting work the
   record has withdrawn.
4. A LATER EVENT WAS ALREADY VOIDED — so voids are remembered ON the cursor
   (`voided`), not merely applied to the batch that carried them.

**One loop, one reducer per tier.** `core/index-pass.ts` owns the loop and all
four judgments above; a tier supplies only what an empty state is and what one
event does to it. A quiet initiative is carried forward BY REFERENCE rather
than cloned — with nothing to apply there is nothing to mutate, and cloning it
made one appended event deep-copy the whole repo's derived state.

**Tiering: one file per question, each on its OWN cursor file.** Sharing a
cursor across tiers would let whichever tier refreshed first advance the
cursor past events the others never saw. Sharing a FILE is the same mistake in
the other direction — it makes the cheap question pay the expensive one's
parse and rewrite:

| file | answers | read by | refreshed | sized by |
| --- | --- | --- | --- | --- |
| `open.json` | which sessions are open, holding what | UserPromptSubmit shim | on that shim | live sessions |
| `guards.json` | does any decision ANYWHERE guard this subject | PostToolUse | every edit | guarded decisions (6 of 208 here) |
| `graph.json` | who else has touched this path | PostToolUse dedupe, priming line | after a guard MATCHES; once per session | the repo's whole touch history |
| `reach.json` | what else bears on this | `sofar find` / `sofar_find` | on a query | prose + terms of every decision and note |

Read frequency, not taste, draws these lines — and they coincide with D2's
authority split, which is usually what a real boundary looks like. Measured
costs and the pins are in §Hooks and §Acceptance criteria.

**One tenant that is NOT a tier: `shipwatch.json`** (commit-attribution 3.4,
D15). Per-session marks of `origin/<branch>`, `{version, marks: {<session id>:
{branch, upstream|null, seq}}}` — the gate that makes the live shipping line
affordable. Every other file here derives from EVENTS on a cursor; this one
records what a session last SAW on a ref, so it has no cursor, no tier and no
reducer. It earns its place here by the same three rules: disposable (losing it
costs one missed line, never a wrong one), local and never committed (a mark is
about one session on one machine, and would conflict on every parallel append),
self-ignoring.
EDGE-TRIGGERED, unlike every other line on that path. The drift nudge and the
conflict lines re-fire statelessly because they restate a condition that is
still true; this one reports a TRANSITION, and "just landed" repeated ten
prompts later is simply false. So the mark is a WRITE, and the write is what
stops the repeat. A null upstream is a WATCHED state, never an unwatchable one:
a branch's FIRST push CREATES the ref, so treating "no upstream" as nothing to
watch made the most unambiguous shipping event of all — work leaving the
machine for the first time — the one event that could never be reported. `seq`
is a counter, never a clock: eviction needs a total order, several marks
routinely land inside one millisecond, and sorting on a tie lets a fresh mark
lose its place to one that has been stale for hours. The mark refreshes on
EVERY look, not only on change, so `seq` orders by last LOOK — write-order
alone starves the quiet session, whose seq freezes until SHIPWATCH_MAX_MARKS
(64) writes by busier sessions evict a window that is still live, making the
push it was waiting for precisely the one it never hears.
CONCURRENCY, stated exactly because the property is easy to get backwards:
sessions share one worktree and therefore this file. The write is atomic, but a
read-modify-write race REVERTS the loser's mark rather than dropping it — the
winner writes back the copy it read, which still carries the loser's OLD sha —
so the loser re-detects the same movement and announces the push a SECOND time.
The race costs a DUPLICATE line, never a missed one, and never a wrong
attribution, since a mark is only ever replaced by a sha read from the same
refs. The two failure shapes are opposites and both safe by that same argument:
with nothing ever persisted (an unwritable index dir) every look reads as a
first look and the caller stays SILENT; with a stale mark that can no longer be
updated the caller REPEATS until something can write again.

**FAITHFUL, NOT BETTER.** Every tier mirrors the fold's and the graph's
semantics exactly, including their limits: first-touch order and
`ACTIVITY_LIST_CAP` in Tier 0, `GRAPH_RESULT_CAP` (20) with a numeric
`omitted` in every query result, the `D<n>` ordinal counting the decisions the
fold counts, `cli` anchoring no session-side edge (BD44), a session created
only by `session_started`. An index that answered a slightly better question
would be an index whose answers could not be checked against the logs. If a
cap should be larger, the FOLD is the place to change it and this follows.

ONE BOUNDARY, stated rather than left to be found (record-index 4.2). The fold
derives a session's held files from the whole edge list at the end, so a
`file_touched` is attributed wherever that session is registered in the log;
Tier 0 replays event by event and can only attribute a touch to a session it
has already seen registered. A touch sorting BEFORE its own `session_started`
therefore goes to the fold and not to Tier 0. Reaching it needs those two
events to invert in ulid order — monotonic within a process, so it takes two of
the session's short-lived processes (the MCP server, a hook shim) landing in
the same MILLISECOND with the random halves falling the wrong way; measured
over this repo's record, 0 of 172 registered sessions. It is left open because
closing it means STORING every touch of every unregistered session in the file
read on each prompt (here: 11 sessions, 318 touches), and the error runs toward
silence — a held file is missed, never invented. Tier 0 alone is affected: the
derived and reach halves attribute a touch by its own event.

**Retrieval authority — the ladder (record-index D2).** Relevance the record's
author DECLARED may be asserted; relevance the engine DERIVED may only be
offered:
- DECLARED — a decision's own `guard` matching the subject. Asserted to the
  agent, rule verbatim (§Hooks, point-of-use guard). UN-SCOPED by
  construction: the subject is tested against every guarded decision in the
  REPO, which is what the fold's own guard check structurally cannot do, since
  it replays one log against that log's decisions while the work is appended
  to another. Even so a guard may INFORM, never gate (D6): no surface may turn
  a guard match into a non-zero exit, a `block` decision, or a refusal.
- DERIVED — graph adjacency (`touched`, `decided`, `noted`, `cites`). Offered
  as worth reading, never asserted: the record knows the work happened in the
  same places, never that a decision was ABOUT the file. Every result cites
  the event id that produced its edge, so the claim is checkable.
- TEXT — words from the question appearing in decision or note prose (BM25,
  no model, §Architectural invariants). Weaker still: OFFERED as prose
  containing the asker's words, never as an answer and never as a traversal
  hit with a `via` edge (D14). A literal reading of the query always wins;
  text is only reached when the query denotes nothing.

**An initiative is a DESTINATION, never a corridor (D12).** Initiative nodes
carry no adjacency. A traversal that reaches one REPORTS it and stops, citing
the member it was reached through; only an initiative SEED expands, to what it
holds. Traversing THROUGH one would put every record two hops from every
other and the answer would be "the repo" — the hub hazard 3.3 measured on
files, one level up and structural rather than statistical.

**Bounded, and it says when it is.** `reach.json` stores prose CLIPPED to
`REACH_PROSE` (300 chars) — the index exists to say what is worth reading, not
to become the thing that is read, and a full copy invites being read as truth
(D1). Terms are the one thing derived from the WHOLE prose, since a term set
is not readable prose and 68% of this record's decision vocabulary lives past
the clip. Traversal defaults to `REACH_DEFAULT_HOPS` (2), caps at
`REACH_MAX_HOPS` (3) and stops at `VISIT_CAP` (20,000) nodes visited; text
seeding caps at `LEXICAL_SEED_CAP` (5). Every cap reports what it dropped as a
COUNT — a truncated answer that says so is usable, a silent one is a lie about
coverage.

**Never in the hot path.** `core/index-reach.ts` is the pull layer and only
the pull layer: the full CLI (`sofar find`) and the `sofar_find` MCP tool
reach it, and no shim, hook or statusline bundle carries a byte of it —
`dist/fast.js` and the `cli/boot.ts`, `cli/event.ts`, `cli/statusline.ts`
entries are clean of reach and lexicon code. Same rule as §Record graph's
exclusion of `core/graph.ts`, for the same reason and one layer down: the
declared half is what a shim may afford, and it is sized so that it is.

## Cursor primitive (sync-ready contract)
`export(sinceId?) → NDJSON stream of events` ; `import(stream)` appends
events not already present (dedupe by id — idempotent). Per-initiative
streams; ordering by ulid. This is the entire future sync interface.
Fold replay order is NORMATIVELY ulid id order, not file order (convergent
fold: same event set → identical state on every replica; D-sync-1, Jul 11).
Riders: (a) writers MUST mint monotonic ulids within a process; (b) fold is
total under cross-machine clock skew — causally-misordered events resolve
by id order via the normal skip-with-warning tolerance; accepted-in-v1,
vector/hybrid-clock upgrade reserved for a future envelope version.
Implemented task 13.1: foldLines sorts envelope-valid events by id (stable
— a duplicated id keeps file order) before pass-2 replay; pass-1 decode
warnings keep file order (they describe lines, not events); cursor is
therefore the MAX event id, identical on every replica.

## Sync client (v2 — api.sofar.sh, the D14 seam; sync-client, Jul 2026)
The client half of sofar-cloud sync. The server (private repo) is
authoritative for the wire; the client implements it exactly and stays
useful with the API completely gone — local work is NEVER blocked by sync.

Base URL resolution: `--api` flag > `SOFAR_API_URL` env > `.sofar/
remote.json` api_url > `https://api.sofar.sh`. The resolved api_url MUST be
https, or http with a loopback host (localhost/127.0.0.1/::1) — the documented
dev-server case; anything else is refused before a request is made
(security-hardening 2.2). remote.json is committed, so "which URL" is not
purely the local user's choice: without this rule a merged change could move
every teammate's bearer token onto the wire in clear. Errors on /v1 are
`{"error":{"code":"snake_case","message":"…"}}`; the device endpoints
speak OAuth flat-string errors (`{"error":"code"}`) — the client
normalizes both. Cross-org/unknown resources return 404, never 403;
client copy never pretends to distinguish "doesn't exist" from "not a
member".

Storage triad (sync-client D2 — three homes, three lifetimes):
- `.sofar/remote.json` — COMMITTABLE `{version, api_url, org, name,
  repo_id}` written by `sofar link`; repo_id is not a secret, teammates
  share the binding.
- `~/.config/sofar/credentials.json` (XDG_CONFIG_HOME-aware) — sfr_
  tokens keyed by normalized api_url, file mode 0600, dir 0700.
  Credentials never touch the repo and are NEVER printed after mint.
- `~/.local/state/sofar/sync/<sha256(clone-path)>.json`
  (XDG_STATE_HOME-aware) — per-CLONE cursors `{streams: {<slug>:
  {pushed, pulled}}}`, invalidated when api_url/repo_id change. Never
  committed: cursors mutate per sync; a lost cursor file is safe because
  push/pull are idempotent by event id.

Commands (styled-capable confirmation surfaces; wording identical plain):
- `sofar login [--api <url>] [--scopes sync|read]` — RFC-8628 device
  flow (client_id `sofar-cli`): POST /api/auth/device/code → print
  user_code + verification_uri_complete, attempt a browser open → poll
  /api/auth/device/token every `interval`s (`authorization_pending`
  continues, `slow_down` adds 5s, `access_denied`/`expired_token` abort
  with clear copy, the `expires_in` deadline aborts as expired) → the
  short-lived access_token immediately mints the real credential at
  POST /v1/tokens `{name: <hostname>, scopes}` → store, discard the
  access_token. `--scopes read` mints a read-only token.
- `sofar link --org <slug> [--name <repo>]` — POST /v1/repos (idempotent
  on org+name, 201/200 → {repo_id}), writes `.sofar/remote.json`.
- `sofar push [slug|--all] [--full]` — per initiative stream, wire lines
  are the engine's canonical envelope JSONL (exactly what `sofar export`
  emits — never re-serialized), ulid order, FROM EVENT ZERO on first
  push (the server refolds the whole stream; a stream missing genesis
  folds to an empty slug/goal). Batches ≤1000 lines AND ≤5MB (server
  413s; a stricter 413 halves the batch), uncompressed. Response
  `{accepted, duplicates, invalid[], head}`: partial acceptance is
  normal; `invalid` lines are a client bug surfaced loudly, never fatal,
  and never wedge the queue. Idempotent by event id: 429 (Retry-After
  honored)/5xx/network re-send the SAME batch with capped exponential
  backoff; the ack cursor advances only on 2xx and persists per batch.
  The offline queue IS the log after the ack cursor — an unreachable API
  fails the command politely, local work is untouched, the next push
  drains with zero loss and no duplicate state effects.
- `sofar pull [slug|--all] [--full] [--watch]` — GET …/events?since=
  <cursor>&limit=<n> pages in ulid order; every response carries
  X-Sofar-Cursor; empty body = caught up. Pages import with `sofar
  import` semantics (dedupe by id — pulling your own pushed events back
  is safe by construction), projections regenerate when anything landed,
  and the inbound cursor persists AFTER each imported page (crash
  between the two re-pulls a page; the reverse order could lose one).
  Inbound cursor is independent of the push ack cursor. `--full` drops
  the stream cursor (re-pull/re-push from genesis — recovery, cheap
  under dedupe).
- `--watch` — doorbell: GET /v1/doorbell?streams=<repo_id>/<slug>,…
  (SSE, authed). `data:` events are `{"stream","head"}`; `: heartbeat`
  comments ~25s; NOTIFICATION ONLY — every ring and every (re)connect
  after a drop triggers a since-cursor pull, so a missed doorbell can
  never lose data. Reconnect uses capped backoff + an idle watchdog;
  401/404 stop the loop (they need a human, not a retry). Every failed
  or dropped cycle ALSO fires the catch-up pull (onGap), so against an
  SSE-hostile path (idle-killed connections, buffering proxies, a down
  doorbell) watch mode degrades to capped-backoff polling instead of
  going deaf — data always flows through pull.

Library subpath "sofar.sh/client" (sync-client D1): the whole
client core — config/credential/cursor stores, device flow, createRepo,
pushStream/pullStream/splitBatches, runDoorbell — importable by the
Tauri shell and iOS app. Same laws as /schema and /engine: side-effect-
free import (env/fs resolved at call time), self-contained d.ts, zero
runtime deps (native fetch; the SSE reader is hand-rolled), bin and
manifest law unchanged.

## Library surface (library-surface, L1/L2 — added for sofar-cloud + D11)
sofar.sh additionally publishes typed ESM subpath exports so other
services consume the engine programmatically (fold parity: cloud state must
come from the engine's OWN fold, never a reimplementation):
- "sofar.sh/schema" — the v1 envelope type + validateEnvelope (the
  tolerant guard: validates, never throws or repairs — skip-and-warn stays
  the caller's decision) + makeEvent, and every event payload type/validator
  from @sofar/schema (events module).
- "sofar.sh/engine" — foldLines/foldLog (deterministic, total,
  ulid-normative — EXACTLY the CLI's fold), InitiativeState + component
  types + the cross-session derivations, the cursor primitive (readEvents /
  exportEvents / exportNDJSON / importNDJSON), and serializeEvent.
- "sofar.sh/client" — the v2 sync client core (§Sync client;
  sync-client D1, Jul 2026).
Laws: importing a subpath executes no CLI code and has no side effects; the
bin and the zero-runtime-deps manifest are unchanged; the d.ts tree under
dist/types is SELF-CONTAINED — the private @sofar/schema name never appears
in published declarations (build-time specifier rewrite, L2); consumers use
bundler-style module resolution. The @sofar/schema workspace package itself
stays private and unpublished (D13: one stewarded npm name; the bare name
also collides with a sofar-cloud-internal package).

## MCP tools (server name: sofar)
- sofar_get_state({initiative?, view?}) → progressive disclosure (token-opt):
  view "digest" (DEFAULT) returns the summary-dense orientation projection as
  text (goal, active/next task, next action, phase summary, last-session
  resume, recent decisions WITH rationale — the compaction-proof orient, ~1k
  tok, rationale kept first-class); view "full" returns the complete folded
  InitiativeState (re-injectable in full, architecture Open-Q#5). Resolves
  initiative from bindings.json + current branch when omitted; neither view
  appends. The digest shares renderStatus with the SessionStart block, so it
  carries the same staleness signals (staleness-detection 2.1/2.2/2.4): the
  budgeted `⚠ next action may be stale: N events since write-back
  (breakdown)` line when mechanical drift exists, stale-phase markers on
  phase lines, and the clipped-summary pointer — plus the budgeted
  notes-since-write-back section (notes-in-digest 2.1) directly under the
  staleness line: newest-last window of ≤5 notes, one date-prefixed line
  each clipped to 200 chars, overflow labeled "(last K of N)"; header is
  "Notes:" when nothing ever wrote back; absent when no notes selected.
  view "initiatives" (initiative-list 3.1) returns the budgeted portfolio
  listing over §State's listInitiatives — one clipped line per initiative
  (slug, bound branch(es) or "unbound", done/total tasks with %, active
  phase, next action), count-capped at 20 with an "+N more (run sofar
  list)" overflow line — and is the ONLY view that skips initiative
  resolution entirely (`initiative` ignored): it must work from an
  unbound branch, which is exactly when a session needs it.
  NOT called at session start (speed-2 T5a): the digest is
  renderStatus(state) and the SessionStart block is renderStatus(state,
  {repoMemory, sessionId, git}) — the same projection with strictly more, so
  re-reading it after injection can only return less, at the cost of a full
  model round trip. The MCP protocol block directs agents to skip it and
  reach for it only when the injected block is missing or truncated (both
  share STATUS_CHAR_LIMIT) or when reading a DIFFERENT initiative. This does
  NOT extend to sofar_start_session, which must still be called — see its
  entry below. The AGENTS.md dialect keeps its orient-first step: MCP-less
  tools have no hook injection for it to be redundant with.
- sofar_start_session({initiative?, tool, model?, session_id?}) →
  {session_id} — session_id (from the SessionStart context "Session:" line)
  adopts exactly that session, OPEN OR ENDED; an unknown id is registered
  via session_started; omitted → mint a fresh ulid. No open-session
  heuristic (adopt-by-id, Phase 7, BD43).
  Adopting an ended id is pin-only (record-integrity 5.1): no append, and
  `ended`/`summary` are left standing as history. It used to be a typed
  invalid_input on the principle that a finished identity is never resumed
  silently — but adopt-by-id already requires naming the exact session, so
  the guard mostly fired on the legitimate path (write back mid-conversation,
  keep working, re-orient), where it forced ONE agent to mint a SECOND
  identity that the fold cannot distinguish from a genuinely parallel
  session. Reopening at fold level was rejected: clearing `summary` to
  re-arm the Stop gate would erase the prior write-back from
  sessions/<id>.md while its event still stands in the log. Events after a
  session_ended are already routine (hooks emit them) and a repeat
  session_ended is legal and last-wins.
  ALWAYS called, even though get_state at start is not (speed-2 T5a): the
  call's load-bearing effect is ctx.session.set(), not the event. Without an
  active session, resolveWriteInitiative falls back to the branch binding —
  which moves mid-session — so writes land wherever the branch now points,
  and appendAndProject stamps envelope.session "cli", detaching decisions and
  task changes from the session (sessions/<id>.md loses them; the Stop
  write-back linkage breaks). That is the record-integrity misroute class,
  and the side-index workaround for it is already rejected.
- sofar_end_session({session_id, summary, next_action}) → {ok, event_id,
  parallel_writebacks?}  # the write-back. `parallel_writebacks` carries
  overlappingWritebacks(state, session_id) computed AFTER the append — the
  concurrent sessions whose next action differs from the one just written —
  and is OMITTED when there is none, so the ordinary case is byte-identical
  to the bare `{ok, event_id}` it returned before (writeback-collisions
  1.2). The same collision already reaches the next SessionStart, but that
  is a fresh agent inheriting two next actions with no context for how they
  relate; the writer still has it, so the write-time surface is the only
  one where reconciling is cheap. Reported, never prevented: the append is
  a single O_APPEND write with no in-flight window to wait on, and a lease
  held by a killed agent would deadlock against the Stop gate that blocks
  exit on a missing write-back.
  Each entry MAY carry `peer` (peer-messaging 2.2): the name Claude Code's
  own SendMessage tool addresses, resolved from the host's live-session
  registry by session id — plus `peer_cwd` when that name is shared by more
  than one live session and so cannot address one on its own. Both are
  OMITTED when the registry does not know the session, which is the ordinary
  case (the sibling may be on another tool, another machine, or a Claude Code
  without messaging), leaving the entry byte-identical to its 1.2 shape.
  sofar ADDRESSES, never delivers: it binds no socket and sends nothing, so
  reported-never-prevented and the zero-model-calls invariant both hold. The
  peer fields are added at the tool layer, never on the folded
  ParallelWriteback — who is reachable is a fact about live host processes,
  and folding it in would make one log fold differently on two machines.
- sofar_update_task({initiative?, task_id, status, note?}) → ok
  # status=active also returns standing_constraints (drift-hardening 4.1):
  # the [D<n>]-tagged rules, resurfaced at the point of use
- sofar_log_decision({initiative?, chose, over, because, rule?, guard?}) → ok
  # rule (drift-hardening D1): standing-constraint clause, rendered verbatim
  # on every surface — never clipped, never aged out of the digest
  # guard (drift-hardening D3): the machine-checkable half of that rule —
  # `path:`/`cmd:` globs (§Decision guards). Requires `rule`; a malformed
  # guard fails payload validation and appends nothing. Warns, never blocks.
- sofar_update_plan({initiative?, plan}) → ok   # full-structure replace
- sofar_add_note({initiative?, text}) → ok
- sofar_remember({initiative?, text}) → ok   # promote a fact to repo memory
  (repo-memory-capture D1): operational knowledge that is NOT a decision — a
  release command, a failure mode — whose repo-wide scope is known when it is
  learned and which no citation behaviour can surface, because nothing derives
  a fact that was never written down. Appends memory_promoted, addressable as
  `<slug> M<n>`; the destination .sofar/repo.md stays hand-written, and doctor
  reports the promotion until repo.md names that handle.
- sofar_review({initiative?, scope, verdict, watermark?, phase?, findings?})
  → {ok, event_id}   # record a review that was actually performed
  (commit-attribution 4.4, §Review). `watermark` is the load-bearing field,
  not `verdict`: it is the sha the review read THROUGH and it bounds the next
  review's range, which is why this is an event and not a note — omit it only
  when the range was empty. `scope` is `phase` (one phase just completed) or
  `final` (the close-time pass, which asks ONLY what a phase review cannot);
  `phase` names the phase and is absent for `final`. A verdict of `findings`
  MUST list them — a review that can only ever say "looks good" is a rubber
  stamp, so if nothing is wrong say so with `pass`, but the verdict must be
  able to be "no". GATES NOTHING (4.5): it does not let a session close and
  close does not require it, because a review that buys the reviewer's exit
  is one the reviewer has an incentive to pass.
- sofar_close_initiative({initiative?, status, note?}) → {ok, event_id,
  unbound[], overrides[]}  # close an initiative (§Initiative statuses):
  `overrides` is what the close-time audit found still outstanding, recorded on
  the event and returned here because the close went ahead anyway (5.2) — empty
  when it found nothing, and likewise on the idempotent path, where no event is
  appended and there is no close to audit; status is
  `done`|`dropped` only — reopening is a binding act (`sofar switch`) — and
  `dropped` REQUIRES a note. Appends initiative_status_changed, then removes
  every branch binding pointing at the slug; `event_id` is null when it was
  already at that status (idempotent, no second event). Resolves to the
  ACTIVE session's pinned initiative like every other write tool.
- sofar_find({seed, hops?, initiative?}) → ReachResult   # READ-ONLY, appends
  nothing (record-index 3.4). Traverses the reach index out from a LITERAL
  seed — a path (resolved across checkouts, §Path identity), a session id, an
  initiative slug, a decision handle `<slug> D<n>`, or a node id — and returns
  what is within `hops` (default 2, max 3), grouped by kind and capped at
  GRAPH_RESULT_CAP per group with a numeric `omitted`. Every hit carries
  `via.event_id`: the event that produced the edge, so any claim can be
  checked against the log. A bare `D<n>` needs `initiative` — unlike the write
  tools this is NOT resolved from the branch, because a read that silently
  answers about a different record is worse than one that finds nothing. A seed
  denoting nothing is matched against decision and note prose (record-index 3.5)
  and comes back as `seed.kind: 'text'` with `seed.matches[]` — each carrying the
  event id whose prose holds the words, the words themselves, and a score — plus
  `seed.omitted` for what the cap left out. Matches never appear in `groups`:
  they seeded the traversal, and word overlap is not an edge. A query matching
  neither way is `kind: null` with no groups, never a nearest match.
  Everything returned is DERIVED relevance (record-index D2): offered as worth
  reading, never asserted as a rule, and the tool description says so because
  the result is JSON with no room for a caveat line.
Every tool = validate payload → append event → regenerate projections →
return. No tool mutates state except via an event (sofar_get_state and
sofar_find are reads and append nothing).
Transports (speed T3): stdio (`sofar mcp`) is the DEFAULT and the only
transport `sofar init` registers — zero-config users lose nothing. The
SAME frozen 11-tool surface is additionally served over streamable HTTP at
`/mcp` on the `sofar serve` daemon (127.0.0.1 only), opt-in via a
documented .mcp.json entry `{"type": "http", "url":
"http://127.0.0.1:4173/mcp"}` — sessions connect to the running daemon
instead of spawning a per-session process. One MCP session = one fresh
server handle with its OWN ToolContext and active-session pin (BD58: the
pin is never shared between concurrent agent sessions on the daemon).
Transport only — tool definitions, results, and typed errors are
parity-locked stdio vs HTTP by test. Daemon absent → the HTTP connection
is refused immediately (never a hang); the documented fallback is to
start `sofar serve` or keep the stdio registration.
Write tools (update_task, log_decision, add_note, update_plan) with
`initiative` omitted resolve to the ACTIVE session's pinned initiative when
one exists (task 12.1, BD58) — the pin is set by start_session, so a
concurrent branch switch on the shared checkout cannot misroute an
already-started session's writes (the Phase 11 incident's root cause);
branch → bindings resolution is the fallback when no session is active,
and an explicit `initiative` always wins. end_session resolves via the
active session (BD15), and the pin SURVIVES the write-back
(record-integrity 4.5): clearing it made every LATER write — a second
write-back, a decision, a task update — fall through to branch resolution,
so a parallel `sofar new` rebinding the branch mid-flight sent a write-back
into a sibling's brand-new initiative while the session's own record showed
no wrap-up at all. A pin is a routing key, not a liveness flag, and a
session's home does not stop being its home when it summarises — the same
premise 0.13.0 settled when start_session learned to adopt an ENDED session
and the parallel-wrap window began handling a session that writes back and
keeps working. A write-back naming a session that is NOT the active one
(no pin, e.g. a restarted server) resolves home → branch, the order
resolveBound has used since 1.2, so it lands in the session's own log
rather than wherever HEAD points. get_state keeps branch resolution — it is a read
(explicit `initiative` scopes cross-initiative reads). start_session
resolves by branch ONLY when `initiative` is named or the session has no
home yet (record-integrity 1.4): lazy registration (D2) means the
PostToolUse hook has usually registered the session already, so resolving
by branch alone registered the same id a SECOND time in another log
whenever the binding moved in between — the dominant tear shape observed
(11 of 14 double-registrations were hook-then-claude-code across two
initiatives). With a home present it adopts there; an explicit `initiative`
still re-homes deliberately.
RE-HOMING IS THE SUPPORTED WAY TO MOVE A SESSION (session-orientation 1.1,
1.3), and the protocol blocks both dialects install now say so: calling
start_session again with an explicit `initiative` appends a session_started
into that log, and because a home is the LATEST such registration
(record-integrity D9) every surface follows at once — statusline, hook
writes, the SessionStart digest on resume, and the Stop gate. Passing
`initiative` to any other write tool routes ONE write; re-homing moves the
SESSION. That distinction is load-bearing because end_session takes NO
`initiative` and never will: a write-back belongs where the session lives,
and an arg would append a session_ended into a log holding no
session_started for that id — the split record-integrity 1.1-1.4 exists to
eliminate, in its worst form (the record holding the work carries no
wrap-up, the record holding the wrap-up carries no work), while leaving the
Stop gate armed in the home the write-back skipped. The CLI dialect has no
re-homing and no session home at all: `sofar event append [slug]` resolves
its optional leading slug through the branch, so MCP-less tools pass that
slug on EVERY append, the session_ended one above all.
HOOK writes are pinned too (record-integrity 1.2, D1). A hook runs in a
fresh process where the in-memory pin above is always null, so before this
it resolved by branch alone — and a branch switch during live work sent
file_touched/command_run to whatever branch HEAD named while the same
session's decisions and write-back went to its real initiative. Every hook
subcommand now resolves through the session's HOME initiative: the one
whose log registered it with session_started, derived from the logs rather
than stored in a second place (D1). Branch → bindings is computed first and
passed as the preferred candidate, so the common case (branch and
registration agree) costs one file read; siblings are scanned only on a
miss, and among them the LATEST session_started wins so a deliberate
re-home beats a stale registration. A session registered nowhere falls back
to the branch and registers there (lazy registration, D2 — unchanged). An
UNBOUND branch is a miss rather than an error for a registered session,
which also ends the silent event drop unbound branches used to cause.
SESSION-BEFORE-BRANCH IS ONE SHARED PRECEDENCE (initiative-lifecycle 1.2,
3.1): `resolveSessionFirst` is its single definition, and the statusline
uses it too — it read the branch alone before, so closing an initiative,
which unbinds every branch pointing at it, blanked the line of the very
session that closed it. Measured on a 22-initiative, 2.8 MB record: 0.07 ms
when branch and registration agree, 2.9 ms for the full scan on a miss,
against a ~55 ms statusline — which is why the mechanism stays a derivation
over the truth logs rather than a persisted pin that could desync (D1) and
would need stale-pin cleanup.
When NEITHER a session pin nor a branch binding resolves (initiative-lifecycle
D4), hooks still drop the event silently and exit 0 — lazily binding would
recreate the misrouting record-integrity 1.2 fixed, and would let a hook
silently undo a close. The drop is per-event but the CONDITION is
per-session, so it is named ONCE where the agent reads: SessionStart injects
an unbound notice naming `sofar switch` / `sofar new`, and the statusline
renders `unbound`. Both are scoped to repos that carry a record — a repo
sofar has never touched is unchanged.
unknown_initiative errors — from any tool or CLI command that resolves a
slug (explicit or branch-bound) — carry a count-capped (10) `available
initiatives:` suffix, or a `sofar new` hint when none exist
(initiative-list 2.2): the dead-end orients instead of blocking.

## Hooks (installed by `sofar init` as standalone scripts in .claude/hooks/)
- SessionStart shim → `sofar event session-start` then prints the status
  projection to stdout (context injection). The block opens with a
  `Session: <id> — when calling sofar_start_session, pass this as
  session_id.` line carrying the session id from the hook payload
  (adopt-by-id, Phase 7, BD43). This shim APPENDS NOTHING: registration is
  LAZY (record-hygiene D2) — a session enters the log on its first real
  event, via sofar_start_session's unknown-id branch or the first
  PostToolUse append. A session that only reads and exits is never
  registered, so it mints no session_started, no session_closed, and no
  sessions/<id>.md. Includes a "Repo memory" section
  sourced from .sofar/repo.md when it exists and is not the untouched init
  stub, budget-clipped to ~1,500 chars (added Phase 6, BD40). Staleness
  surfacing (staleness-detection, mechanical signals only): when counted
  events postdate the last write-back the block renders ONE budgeted line
  `⚠ next action may be stale: N events since write-back (breakdown)`
  under the next action (absent on a fresh record); a stale phase renders
  as `[<status> — all tasks done; mark phase done?]` on its phase line. The
  derived resume line names ONE unwritten session (the best resume point);
  every OTHER session that did mechanical work without writing back renders
  as one budgeted `⚠ N other session(s) did work without writing back` line
  listing up to 5 ids (record-integrity 4.3). The derived line stops at the
  newest written-back session by design, which is right for resuming and
  wrong for accounting: with parallel sessions a single write-back used to
  hide every other session's unwritten work from the block entirely. A
  last-session summary cut by its budget carries `(clipped — full text in
  sessions/<id>.md)` INSIDE the budget. Un-absorbed notes (notes-in-digest
  2.1) render as a budgeted section under the staleness line — see
  §MCP tools, get_state digest, for the exact rule; both surfaces share
  renderStatus.
  File-locality hint (speed T4): directly under the "Current task" line,
  ONE budgeted line `files: a.ts, b.ts, …` naming the active task's
  task_files (§State) — at most 8 files, most-recent first, 300-char clip,
  silently absent when the task has no data. Both renderStatus surfaces
  (SessionStart block + get_state digest) carry it; ablation-gated (the
  automated resume ablation re-ran on introduction — result recorded in
  the speed initiative).
  Cold-resume advisory (felt-cost 2.1/2.2): on source=resume ONLY, when the
  record's last event predates the longest cache TTL (1h — heuristic, the
  TTL is server-controlled) AND the transcript file is ≥80KB (~20k tokens
  at bytes/4), ONE advisory line precedes the block naming the estimated
  re-warm cost and the fresh-start alternative. Best-effort: any failure
  (missing transcript, empty log, unparseable ts) renders no advisory,
  never an error. The advisory composes AROUND the status block — never
  inside renderStatus (byte-stability, §Architectural invariants) — and the
  composed output is re-capped to the same hard limit.
  Recent work elsewhere (session-orientation 2.1/2.2): when this session's
  record was resolved BY THE BRANCH — not by the session's own home — and
  some OTHER initiative's log carries a strictly newer last event, ONE
  budgeted line (≤480 chars) LEADS the composed output, naming that
  initiative, both records' last-event ages, and the single
  sofar_start_session call that re-homes. It leads because every other part
  of the output describes the bound record and this line questions whether
  the bound record is the right one at all. Resolution itself is UNCHANGED,
  and deliberately so: the same resolution routes every hook write, and
  "most recently active" is a repo-wide fact that may be a PARALLEL
  session's work, so the block names the candidate and the session decides
  (a wrong answer is worse than a missing one). Silent when the bound
  record is already the most recent — every session in a single-initiative
  repo — when the session has its own home, when the bound log cannot be
  read, and when the newer log's own newest event is
  initiative_status_changed, since a record just closed or reopened is not
  work in progress. Recency comes from each log's TAIL (§State, warmth):
  O(1) in log size, ~0.03ms per initiative and 1.7ms across 38, never a
  fold and never filesystem mtime.
  ADJACENT RECORDS (record-index 3.3) — the priming line, rendered last in
  the current-situation block (after concurrent edits) because it is the only
  entry there that is not about this record: `Adjacent records — N decisions
  across M other initiative(s) that have worked this one's files, densest
  first:`, then up to 3 `- <slug> — N shared file(s), N decision(s)` lines,
  then `…and N more. Adjacency, not aboutness — offered as worth reading,
  never as a rule.` A FACT WITH A COUNT, never a capability blurb: an offer
  ("you can search the record") is ignored because nothing in it says there
  is anything to find, while a number and three names create the intent to
  look. Ranked by SHARED PATHS — the direct edge, and the honest answer to
  who is on your ground — with decisions then name breaking ties; the header
  leads with the decision total because the densest neighbour may hold few.
  Deliberately NOT the two-hop `decision <- session -> file` join whyFile
  exposes: measured on this record that join is dominated by hub files every
  initiative has edited, which makes the whole repo adjacent to everything.
  Sourced from the Tier 1 index (declared half for decision counts, derived
  half for the overlap), REFRESHED once per session — nothing else on the
  tool path maintains the derived half, so a repo that has never crossed a
  guard would otherwise carry a permanently cold index and never see the
  line. DERIVED relevance under D2: offered as worth reading, never asserted
  — the record knows these initiatives worked the same files, never that
  their decisions are ABOUT those files. Absent when the index is unreadable
  or nothing overlaps, so a single-initiative repo renders byte-identically
  to before it existed, and best-effort per BD22: a failure here costs the
  line only.
  Per-initiative SHIPPING notice (commit-attribution 3.2): composed around
  the status block, ONE line, and only when there is something to act on —
  `sofar: N of this record's commit(s) are NOT on origin yet …`, or
  `sofar: N commit(s) of this record are unverified — origin not fetched …`
  when the upstream ref is missing and the answer is honestly `unknown`.
  SILENCE MEANS SHIPPED, and that silence is the signal: a session that sees
  the line, then sees it gone after a sibling's push, has learned its work
  landed without anyone saying so. Announcing "all 6 commits pushed" every
  session would be noise on the one surface with a 10,000-char budget, and
  the standing culture here (guard notice, drift nudge) is that conditional
  lines earn their place. Two spawns, ~17ms — affordable for the same reason
  the adjacency line pays up to 33ms, because SessionStart runs ONCE per
  session; D6 forbids this on the per-prompt path and it is deliberately not
  placed there. Best-effort: any failure is silence.
  HARD LIMIT:
  output ≤10,000 chars — projection generator must guarantee this.
- UserPromptSubmit shim (felt-cost 4.1/4.2, D5) → the batch-complete nudge:
  when the prompt's session_id is registered AND sessionDebt(state, me) —
  THIS session's own unwritten mutations plus unattributed drift, the same
  number the Stop gate enforces — is ≥5, stdout (exit 0 =
  additionalContext for this hook; lands after the cached prefix, so it is
  cache-safe) carries ONE line nudging an in-flow sofar_end_session — a
  write-back while context is warm makes the Stop gate a fallback instead
  of a forced extra turn. Session-scoped, not initiative-scoped
  (drift-signal 1.2): the line asks THIS session to act, and the
  initiative-wide total nagged sessions that had already written back, for
  sibling edits they could not speak to. Stateless: re-fires on every
  prompt until this session's own write-back clears its debt
  (staleness-line precedent). Repeat session_ended
  events for one session are LEGAL and last-wins in the fold (ended/
  summary/next_action overwritten, freshness reset, Stop passes once any
  exists). Best-effort (BD22): every failure path is silence, never a
  blocked prompt.
  The same shim also emits the PARALLEL-WRAP line (record-integrity 4.2),
  independently of the drift nudge — both may appear, newest first. It fires
  when another session in this initiative ENDED with a real write-back
  (summary present, so a mechanical session_closed does not qualify) inside
  THIS session's live span, and carries that session's id, summary and next
  action — clipped to 420 chars.
  The window opens at THIS session's last write-back, falling back to its
  start (0.13.0). Anchoring on `started` alone never closes, so one sibling
  wrap-up was announced for the rest of the session's life; suppressing the
  line whenever `me.ended` was set (0.12.1) went too far the other way and
  silenced a REAL parallel wrap-up, because a session that writes back and
  keeps working still has `ended` set — the hook firing at all is proof it
  is alive. The write-back anchor closes the window when the session
  absorbs the record and re-opens it for new sibling activity, matching the
  frame the drift counter already uses. The phantom sibling that motivated
  0.12.1 was really the identity split (5.1). Budget
  order is next_action FIRST, summary absorbing the
  remainder — the summary is the least actionable part, and rendering it
  first let a long one clip the next action away entirely.
  This is the answer to the cross-session blind spot the initiative opened
  on: before it, a sibling could commit and push and no other live session
  had any way to learn it, so a human had to announce it in every window.
  Stateless and re-firing like the nudge — there is no "already told you"
  bit, and repeating a true fact costs less than storing one.
  The same shim emits the PUSH-STATE line (record-integrity 4.4)
  UNCONDITIONALLY — whenever §Git state is readable, regardless of any
  sibling activity: `sofar: <branch> @ <head>, ` then `pushed (in sync with
  origin/<branch>).` | `NOT pushed (origin/<branch> at <tip>).` | `never
  pushed.` Ordering is news, then state, then nudge: parallel-wrap, push
  state, drift. 4.2 carried push state inside the wrap line, which meant a
  session learned it ONLY when a sibling happened to write back in the
  window — so a long-lived session saw push state once at SessionStart and
  thereafter by luck. That coupling lost the initiative's own motivating
  case a second time: a window committed a README rewrite, a sibling pushed
  that commit with the 0.13.0 release, and the window had to reconstruct the
  answer from git log. Unbinding costs nothing — refs-only state, a line
  bounded by construction, and the same stateless re-fire as the nudge, so
  the 420-char wrap budget bounds the WRAP line only, never the whole
  payload. Repo-level by construction: it reports HEAD against origin, never
  "your commits". Refs alone cannot say more, and time-window attribution —
  the obvious substitute — misreads interleaved parallel sessions. The
  per-initiative question is answered by the LANDED line below instead,
  which pays for a walk only when a ref has actually moved.
  The same shim emits the LANDED line (commit-attribution 3.4, D11), the
  live half of the shipping signal: `sofar: N commit(s) of this record just
  landed on origin/<branch> (<sha>, <sha>…) — that work has SHIPPED; if a
  next action was waiting on the push, it is done.`, at most 3 shas named
  with a `, +N more` tail, clipped to 300 chars. It closes the residual gap
  the SessionStart notice leaves: that notice fires ONCE, so a window
  already running when a sibling pushes learns nothing until it restarts —
  the original complaint, still open in exactly the case it was raised for.
  No transport is involved (D11): refs are shared across a worktree, so a
  push updates them for everyone at once and each session simply READS.
  Nothing is asked of the pushing session, and no surface may notify a peer
  of a push.
  The GATE is what makes it legal on this path. D6 forbids an unconditional
  git subprocess here, and this pays one ONLY when `origin/<branch>` has
  moved since this session last looked — a comparison of two shas both
  already read from files (§Derived index, shipwatch.json). The walk that
  follows is bounded twice over: `previous..current` is the push itself
  rather than history, and a 100-commit cap bounds even that. A push larger
  than the cap under-reports the count, the safe direction this module takes
  everywhere. Range semantics carry the precision: `previous..current` is
  exactly the set that ARRIVED on origin, so filtering it by trailer answers
  "did MY work land" rather than the weaker "is the tip in sync" the
  push-state line reports. On a first look the range is instead the new tip
  with every other origin ref subtracted (D17). A rebase or force-push whose
  old sha is gone makes git error, the read returns null and the line is
  SILENT — the mark is advanced anyway, so the session resynchronises rather
  than getting stuck. Silent too when the arriving commits belong to other
  records, the common case on a shared branch: that this record still has
  unpushed work is what SessionStart already said.
  The same shim emits the LIVE FILE-CONFLICT line (writeback-collisions
  2.1) FIRST, ahead of parallel-wrap: `sofar: N file(s) you touched are
  ALSO open in another live session — <path> (session <id>); …`, at most 3
  paths named with a `(+N more)` tail, clipped to 300 chars. Source is
  openSessionFileConflicts(state, sessionId) filtered to conflicts this
  session is party to. It leads because it is the only line about work
  still IN MOTION — the others report settled facts, and a hazard you can
  still scope around outranks news you can only absorb.
  Immediately after it the same shim emits the CROSS-INITIATIVE CONFLICT
  line (record-index 2.2): `sofar: N file(s) you touched are ALSO open in a
  live session on ANOTHER initiative — <path> (session <id> on <slug>); …`,
  at most 3 paths named with a `(+N more)` tail, clipped to 320 chars. This
  is the collision a per-initiative fold structurally cannot see — the hook
  folds one log and the sibling appends to another — and it ranks SECOND
  because the sibling sharing your record is the likelier collision and the
  cheaper one to settle: you will at least read each other's write-backs.
  Source is the derived Tier 0 open-session index (record-index 2.1),
  REFRESHED on the path rather than merely read: an index nobody maintains
  reports an empty open set, and empty is indistinguishable from "no
  conflict". The caller's own hold comes from the fold the shim already
  paid for, never from the index, because `alsoLiveSessionId` re-admits an
  ended caller and Tier 0 cannot carry that re-admission. Holders on the
  caller's OWN initiative are dropped from the rendering — the line above
  names them — but never from the derivation. Best-effort on its own
  (BD22): a failure here costs this line only, never the lines after it.
  Directly after both, and ONLY when the host's live-session registry
  resolves a colliding session id, the same shim emits the REACHABLE-PEER line
  (peer-messaging 2.1): `sofar: that session is live in Claude Code as
  "<name>" — message it if your change affects its work, then RECORD what it
  says; a message is not in the record.` At most 3 names with a `, +N more`
  tail, clipped to 300 chars; an ambiguous name — one the registry shows for
  two or more live sessions — carries `(in <cwd>)`, the host's own
  tie-breaker, rather than implying a precision the name does not have. A
  SEPARATE line, never text folded into the conflict line: the conflict line
  must stay byte-identical whether or not a peer resolves, so a host without
  messaging renders exactly what shipped before this existed. Siblings named
  by EITHER hazard line feed it, same-initiative first — a cross-initiative
  collision is where messaging matters most, since neither agent will ever
  read the other's write-back, and a record with no cross-initiative sibling
  still renders the identical line. Resolution is
  best-effort per BD22 — an absent, unreadable, or reshaped registry, or a
  registered process that is gone, yields no line and never an error.
  The optional second argument counts the CALLER as open even though
  `ended` is set. A session that writes back mid-flight and keeps working
  has `ended` — the drift nudge asks for exactly that — so the bare rule
  drops it and the line would go silent for the rest of a session, the
  0.12.1 failure the parallel-wrap line already paid for. Only the caller
  is re-admitted, never siblings: the hook firing is proof the caller is
  alive, whereas a sibling with no session_closed may be a CRASHED process
  that would linger as a false conflict forever. `sofar doctor` passes no
  id and is unchanged.
  Reports a hazard, never a verdict — two sessions in one file is routine
  when they hold different regions, and nothing in the record says which.
  Self-closing with no "already told you" state (D5): the sibling leaving
  the open set ends the line. Until then it re-fires statelessly, the same
  bargain the drift nudge and push-state line make.
- PostToolUse shim (matcher: Edit|Write|MultiEdit|Bash) → appends
  file_touched / command_run from stdin JSON (tool_name, tool_input),
  preceded by a session_started for an unregistered session (lazy
  registration, record-hygiene D2; envelope session "cli" is never
  registered).
  SELF-RECORDING COMMANDS ARE EXEMPT (record-hygiene D1): a Bash command
  whose every shell segment leads with `git` or `sofar` appends NOTHING.
  Both keep their own ledger — git its history, sofar the record itself —
  and logging them makes the record un-settleable: committing the record is
  a Bash call, so it would append an event about committing the record and
  the tree would be dirty the instant it is clean. The tree can only reach
  clean if some record-committing action appends zero events. Nothing is
  lost: the fold counts command_run and never reads `cmd`.
  SECRETS ARE REDACTED FROM `cmd` BEFORE THE APPEND (security-hardening 3.1):
  credential-shaped material — `NAME=value` where NAME contains
  TOKEN/SECRET/PASSWORD/API_KEY/…, `--flag value` of the same names,
  Authorization headers, `user:pw@host` in a URL, and recognizable standalone
  token shapes — becomes `[redacted]`, keeping the surrounding structure so
  the command still reads. The log is append-only and committed, and pushed
  once the repo is linked, so a credential that reaches it cannot be edited
  out — only rewritten out of history by everyone who ever cloned. The
  self-recording exemption scan runs on the RAW text, so redaction can never
  change which commands are exempt. Segments split at
  `&&`, `||`, `;`, `|`, `&` and newline only OUTSIDE quotes
  (record-hygiene-quotes D1): a separator inside a commit message body is not
  a separator, or this repo's own multi-line messages would defeat the
  exemption and the tree could never settle. A command that cannot be scanned
  confidently is LOGGED — unbalanced quotes, or a `$(…)`/backtick
  substitution whose nested command the scan never descends into. Every
  ambiguity resolves toward LOGGING, so the exemption can never swallow real
  work (`cd x && git push`, `git log | head`, `git push & npm test` and
  `git log $(rm -rf x)` are all logged).
  The same shim emits the POINT-OF-USE GUARD NOTICE (record-index 3.2), the
  only thing it says back to the agent: `sofar: [<slug> D<n>] standing rule
  guards <subject> — "<rule>" (guard: <spec>) — obey it verbatim, or log a
  decision that supersedes it.` Emitted as exit-0 JSON on stdout —
  `{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":
  …}}` — which is the only PostToolUse output Claude Code injects into the
  model's context; plain stdout on this hook is transcript-only. NEVER exit 2
  and never `decision: "block"`: a guard that could stop work would let one
  false positive stop real work (drift-hardening D3).
  UN-SCOPED, which is the point: the subject is tested against EVERY guarded
  decision in the repo via the Tier 1 declared index, not against the bound
  initiative's decisions alone. The fold's own guard check (§State,
  guard_violations) replays ONE log against THAT log's decisions, so a rule
  declared in one initiative had never been tested against work appended to
  another — structurally, not rarely.
  The handle carries the declaring record (`[<slug> D<n>]`) unless the rule is
  from the session's own initiative, where `D<n>` is already unambiguous. The
  rule renders VERBATIM and is never clipped (drift-hardening D2); the subject
  renders repo-relative for paths and clips at 60 chars for commands. At most
  GUARD_RULES_MAX (2) rules render, OTHER initiatives first — the session's
  own standing constraints already render verbatim in its SessionStart digest,
  so under the cap the rule worth keeping is the one it cannot otherwise see.
  Overflow drops whole rules and names the initiatives they live in (never a
  pointer at `sofar doctor`, which audits one initiative).
  SAID ONCE PER (session, rule, subject), mirroring the fold's own dedupe ("a
  file edited thirty times is one violation of one rule, not thirty
  warnings"): a rule fires for a path only when it was logged strictly AFTER
  that session's last recorded touch of it, so a re-edit is silent and a newly
  declared rule still gets its first warning. Ties resolve toward silence.
  Commands are not deduped — the index keys touches by path, and each run of a
  guarded command is its own act.
  A SELF-RECORDING COMMAND IS STILL READ though it is never appended: the
  exemption exists to keep the tree settleable and a read appends nothing, so
  `cmd:*git push*`-shaped rules become enforceable for the first time. The
  guard matches the REDACTED command text — what the record holds — so the
  hook and the fold can never disagree about whether a rule fired.
  COST, and the reason Tier 1 is two files on two cursors: the DECLARED half
  (`guards.json`) is sized by the repo's guarded decisions and is refreshed on
  every edit (0.5/1.5/4.4ms at 30/300/1000 initiatives, matching Tier 0); the
  DERIVED half (`graph.json`) is sized by the whole repo's touch history
  (1.5/9.7/33.0ms) and is refreshed ONLY once a rule has matched and the dedupe
  needs it. Sharing one file cost the derived half's price on every edit.
  Best-effort per BD22 and D1: any failure yields no notice, never an error and
  never a wrong answer — a missing, stale or corrupt index rebuilds and answers
  correctly, more slowly.
- Stop shim → reads stdin JSON; if stop_hook_active is true → exit 0
  (loop guard). Else if no session_ended event exists for this session_id
  AND gate-relevant drift is nonzero → exit 2 with stderr: "Write back to
  the sofar record before finishing: call sofar_end_session (or append
  session_ended via `sofar event append`)." Else exit 0.
  Gate-relevant drift (drift-signal 1.2, superseding speed T1) =
  sessionDebt(state, session): the stopping session's OWN unwritten
  mutations plus freshness.unattributed_mutations. Read-side, zero new
  event types, and the same number the UserPromptSubmit nudge states, so
  the warning and the block can never disagree.
  Two scopes, deliberately: a session is answerable for what it did, and
  for drift no session owns (cli-appended work has no other candidate
  writer), never for a sibling's attributed edits — those are owed to that
  sibling's own gate, which is what keeps concurrent gates independent
  (the Phase 7 law) by construction rather than by the OR speed T1 needed.
  Mutation-class only: command_run is logged but never gates (D1 — T1's
  "pure reads emit no events" was false for an agent that reads through
  Bash, and a session that only ran greps was being blocked with nothing
  to write back); session lifecycle and plan-structure events stay
  uncounted, matching the staleness line. Zero → exit 0 silently even
  without a write-back (nothing owed, nothing to write back). ANY error
  in the drift computation enforces
  the block (fail closed — never a silent skip); every other resolution
  failure keeps exiting 0 (BD22). The gate only ever converts an exit-2
  into an exit-0 — no today-exit-0 path becomes blocking.
- SessionEnd shim → appends mechanical session-close marker (fallback only;
  cannot feed back to the agent).
- prepare-commit-msg shim → `.git/hooks/prepare-commit-msg`, the one shim that
  is GIT's rather than the host's (commit-attribution 2.5, D7). Calls
  `sofar commit-trailer "$1"` and exits 0 unconditionally. Unlike every shim
  above it CANNOT `exec`: it runs inside `git commit`, so a missing binary or
  any non-zero status would abort the user's commit — hence `command -v sofar`,
  `>/dev/null 2>&1 || true`, and a bare `exit 0`.
  INSTALLED BY `sofar init`, NEVER CLOBBERING (D7): `core.hooksPath` is checked
  FIRST and reported as a skip, because setting it makes `.git/hooks` inert and
  writing there would be a file that silently never runs; a hook we did not
  write is left BYTE-IDENTICAL and reported as skipped, with the one line to
  add by hand; our own older copy is kept current, identified by the marker
  string `sofar prepare-commit-msg shim`. `sofar uninit` mirrors it and removes
  the file ONLY while it still carries that marker — a user's own hook that
  calls `sofar commit-trailer` is the user's file, and `.git/hooks` has no
  other owner to ask.
  VERSION SKEW is the silent failure mode this shape leaves open, and doctor
  is what surfaces it: `command -v sofar` succeeds for ANY installed sofar,
  including one predating the `commit-trailer` subcommand, and the `|| true`
  swallows the error — so attribution is simply off, with no symptom at the
  commit. See doctor's attribution audit in §CLI.
Shims contain no logic — they invoke the sofar CLI.

## CLI
- `sofar init` — create .sofar/, write repo.md stub, install hook shims
  (including git's own `.git/hooks/prepare-commit-msg`, never clobbering —
  commit-attribution D7, §Hooks)
  + .claude/settings.json hooks block, emit .mcp.json registration, append
  protocol blocks to CLAUDE.md and AGENTS.md (idempotent; the AGENTS.md
  block is the CLI convention dialect for MCP-less tools — added Phase 5,
  BD31). Writes the union-merge rule for committed event logs to
  .gitattributes — the exact line `.sofar/**/events.jsonl merge=union`
  (team-readiness T2): file created when missing, otherwise MERGED (rule
  appended, user content byte-preserved — never clobbered); idempotent,
  and any existing line already targeting `.sofar/**/events.jsonl` wins
  over ours (the customized-entry precedent). Union merge is safe for the
  record and ONLY for it: the log is append-only and the fold replays in
  ulid id order (D-sync-1), so a merge that keeps both sides' lines in
  arbitrary order folds to the same state on every clone. Each installed protocol block
  MUST include: (a) all work state lives in sofar records — never in tool
  memory or scratch files; (b) work matching no existing initiative requires
  creating one (sofar new) before proceeding; (c) bindings resolve which
  record a session serves. [Field finding, Jul 4: singular-record protocol
  caused a second initiative's state to leak into Claude Code native memory
  + a scratch dir — jurisdiction must be total, not per-file.]
  With `--statusline`, init also merges the rent-meter wiring
  `"statusLine": { "type": "command", "command": "sofar statusline",
  "refreshInterval": 10 }` into .claude/settings.json — ONLY when the key is
  absent: an existing statusLine, whatever its value, is the user's and wins
  (felt-cost D4's clobber concern, honored under explicit opt-in — D4
  informed re-test, init-statusline D1). `refreshInterval` ships in the
  entry because the host re-runs a statusLine command only on session start,
  a new assistant message, compact and mode toggles, so an idle session
  renders a frozen line without it (statusline-refresh D1). Without the flag, when the project settings carry
  no statusLine, init prints a plain opt-in hint (points at
  `sofar init --statusline`, notes a project statusLine shadows a personal
  ~/.claude/settings.json one).
  As its FINAL output, init prints a scanner-defense hint when a tree-wide
  class scanner is detected (Tailwind v4: `tailwindcss>=4` in package.json) —
  the scanner would ingest committed `.sofar/` records; the hint points at
  `sofar doctor --fix` (added Phase 10, D-P10). The statusline hint, when
  both fire, prints before it — the scanner hint keeps the final slot.
- `sofar doctor [--fix]` — audit a host repo across seven axes: (1) wiring
  integrity (init's shims/settings/.mcp.json/protocol blocks intact), plus the
  ATTRIBUTION check (commit-attribution 2.4), which is deliberately EMPIRICAL
  rather than diagnostic: it asks whether the last 20 commits actually carry
  trailers, not why they might not. Attribution goes silently off for several
  unrelated reasons — `.git/hooks` is not cloned so a fresh clone never has the
  hook, the `sofar` on PATH predates `commit-trailer` and the shim's `|| true`
  swallows the failure, CLAUDE_CODE_SESSION_ID stops being exported — and
  enumerating causes would miss the next one, while the empirical question
  catches all of them including causes nobody has thought of. Missing hook →
  WARN; hook present but a whole window unattributed → WARN naming the silence
  and how to check; some attributed → OK line. NEVER FAIL: unattributed commits
  are legitimately normal (everything committed before adopting this, and every
  commit made from a plain terminal), and a permanently red doctor trains
  people to ignore it (record-integrity D3). Bounded per D6 — a fixed small
  window, never a full-history walk; (2)
  record health — initiative logs fold without stub sessions or corrupt lines,
  no STALE PHASE (all tasks done but the phase still active/pending, missing a
  phase_status_changed — D-P11), no UNTRACKED WORK (a wrapped session with real
  file activity but zero task changes — work missing from the plan, or
  fragmented onto a sibling session because the hook session was not adopted),
  no ORPHAN TASK EVENTS (task_status_changed whose id the plan never absorbed
  — the misroute symptom of a branch-switched write, task 12.2, BD58; one WARN
  per distinct orphan id, skew-ordered events later legitimized by task_added/
  plan_updated excluded);
  (3) session routing — no session id spans more than one initiative
  (record-integrity 2.2). Two shapes, both from the pre-pin misroute — TORN
  (registered by session_started in ≥2 initiatives, so MCP writes and hook
  writes went to different logs) and LEAKED (events in an initiative that
  never registered the session, counted by that initiative's freshness and
  files_touched while attributable to no session). Severity grades by
  LIVENESS, not shape (D3): a split with a session still OPEN reports FAIL
  (a pre-fix session actively tearing), one where every session has ENDED
  reports WARN — settled history, unrepairable by construction since no event
  carries a self-evident misplacement marker, and a permanently failing audit
  trains people to ignore it. Derived from FoldResult.unregistered_sessions
  plus each state's registered ids; deterministic, sessions sorted by id and
  footprints by slug;
  (4) concurrency — no file under concurrent edit by ≥2 OPEN sessions (a live
  clobber risk), reported in two scopes: WITHIN each initiative, and ACROSS
  initiatives (cross-initiative-conflicts 3.1), the latter naming every
  initiative holding the path. A clobber is physical and does not respect the
  record boundary, and per-slug detection structurally cannot see it. The
  cross scope is computed from the states doctor has ALREADY folded and is
  never gated: core/graph.ts's law keeps cross-record derivations off the hot
  path because a shim can afford one log where they read N, and doctor is the
  other side of that bargain — the on-demand audit where the exhaustive answer
  is the point. However narrow the live surfaces are, the complete answer
  always exists behind this one command. A conflict inside a single initiative
  is reported by the within scope only, never by both;
  (5) decision guards — every crossing in `guard_violations`
  (§Decision guards), one WARN naming `[D<n>]`, the subject, and the rule
  VERBATIM. Always WARN and never FAIL: the audit's exit code is the very
  exit code D3 forbids a guard from moving; (6) repo memory — two halves, both checked against the
  hand-written `.sofar/repo.md`, the one file every SessionStart injects.
  OBSERVED: every decision the record TREATS as repo-wide (§Record graph
  `repoGeneral`: cited FROM another initiative). DECLARED: every fact promoted
  with `sofar_remember` / `sofar remember` (repo-memory-capture D1), which is
  the only way knowledge that is not a decision reaches this axis — a fact
  never written down produces no citation behaviour to observe. Presence is
  literal and uses the record's own citation grammar: the QUALIFIED handle
  `<slug> D<n>` or `<slug> M<n>`. Unqualified handles cannot count — repo.md has
  no home initiative, so a bare handle would be ambiguous repo-wide; prose
  matching would be inference (felt-cost D3) and would rot on either side's
  rewording. DETECTION ONLY, always WARN: repo.md is hand-written per
  §Record layout and sofar never generates or rewrites it, so both the curation
  and the SessionStart token budget stay the author's (record-graph 3.3);
  (7) scanner hazards (Tailwind v4 entry stylesheet lacking a
  `@source not` exclusion for `.sofar`). Record-health, concurrency and
  repo-memory findings
  are WARN (surfaced, non-fatal); exit 1 only when a FAIL-level finding remains,
  0 on a clean repo. `--fix` performs the one deterministic, safe repair:
  inserting `@source not "<path-relative-to-stylesheet>/.sofar";` after the
  `@import "tailwindcss"` line in each unprotected entry (idempotent); it never
  touches wiring (re-run init) or record prose (added Phase 10, D-P10; deepened
  Phase 11, D-P11). The repair is VERSION-GATED (scanner-version-gate D1):
  `@source not` landed in Tailwind 4.1 and parses as an unquoted path before it
  ("Error: `@source` paths must be quoted"), so `--fix` writes only when the
  version that will build is KNOWN to be >= 4.1 — the version installed under
  `node_modules/tailwindcss` when present, else the declared range's LOWER
  BOUND. Otherwise the hazard is still reported (FAIL, unchanged) with the
  pre-4.1 remedy named — narrowing the import's scan base, `@import
  "tailwindcss" source("<dir>")`, which exists in 4.0 — and nothing is written.
  Both mechanisms count as protection when auditing: an `@source not` resolving
  to `.sofar` or an ancestor, and a `source(...)` base that excludes it (or
  `source(none)`). The concurrent-edit signal also surfaces in the SessionStart
  context and `sofar status` (rendered only when open sessions overlap, D-P11).
- `sofar uninit [--purge]` — exact inverse of init, surgical: remove the
  five hook shims, `.git/hooks/prepare-commit-msg` ONLY while it still carries
  the `sofar prepare-commit-msg shim` marker (D7 — a user's own hook that calls
  `sofar commit-trailer` is the user's file, and `.git/hooks` has no other
  owner to ask), our settings.json hook entries (matched on the shim path),
  the settings.json statusLine entry ONLY when it is the one `--statusline`
  installs — matched on `type` + `command`, tolerating a retuned
  `refreshInterval` and the two-key entry installed before that key shipped,
  and refusing any other extra key (a customized statusLine is user config —
  kept; init-statusline D1, statusline-refresh D1), .mcp.json's sofar server, our exact .gitattributes
  union-merge line (a customized events.jsonl rule is user content — kept;
  team-readiness T2), and the protocol blocks (markers + one seam
  blank line), preserving all user content; .sofar/ is kept with a notice
  unless --purge deletes it (--purge alone may also delete files the run
  emptied — the byte-clean round-trip). Idempotent (added Phase 8, BD45).
- `sofar new <slug> [--goal]` / `sofar switch <slug>` — create/select
  initiative; bind current branch in bindings.json. `switch` onto a CLOSED
  slug reopens it (§Initiative statuses, D3): appends status `active`,
  announces the revival, then binds.
- `sofar close [slug] [--drop] [--reason <text>]` — record the initiative
  terminal (`done`, or `dropped` which REQUIRES `--reason`) and remove every
  bindings.json entry pointing at it (§Initiative statuses, D1). Slug
  resolves from the branch when omitted. Idempotent: already at that status
  appends nothing and still unbinds, so re-running repairs a stale binding.
  Prints whatever the close-time audit found, headed `closed with N finding(s)
  OVERRIDDEN — recorded on the event and rendered from here on` — read back at
  the one moment the closer can still act, and NOT a warning that re-running
  clears: it is what the log now says (5.1/5.2).
- `sofar adopt <legacy-file> [slug] [--mark]` — guided migration for
  pre-sofar prose records: validates env (legacy file, .sofar/, target
  initiative — positional wins, else branch binding), prints a self-contained
  MIGRATION BRIEF (exact `sofar event append` replay templates with the
  slug + a fresh session id baked in, repo-knowledge move, protocol
  retirement checklist, verification line) for an agent to execute; --mark
  stamps an idempotent SUPERSEDED banner into the legacy file. NO freeform
  markdown parsing — the agent transcribes (added Phase 8, BD46).
- `sofar status [slug]` — fold and print: goal, progress %, phase tree
  with statuses (stale phases marked, staleness-detection 2.2), next action,
  blocked, last session; plus an UNCAPPED `⚠ Staleness:` section (terminal
  surface, no 10k cap) when any mechanical signal fires: drift breakdown
  since the last write-back, stale phases with the phase_status_changed fix,
  and a pointer when the capped surfaces clip the last write-back summary
  (staleness-detection 2.3). Un-absorbed notes render UNCAPPED after the
  staleness section (notes-in-digest 2.2): every selected note, full
  timestamp, no count cap or length clip, whitespace collapsed to keep each
  entry one list line; absent when none.
- `sofar list` — every initiative under .sofar/initiatives/, one line each
  (slug, bound branch(es) or "unbound", done/total tasks with %, active
  phase, next action), most recently active first per §State's
  listInitiatives; UNCAPPED entry count (terminal surface, the
  sofar-status precedent), lines whitespace-collapsed so each initiative
  stays one line; derivation warnings to stderr without failing — an
  uninitialized repo prints the empty listing with a `sofar new` hint
  (initiative-list 2.1).
- `sofar next` — the portfolio next-actions surface: one line per
  initiative (slug, bound branch(es) or "unbound", the next action the
  last write-back recorded or "(no next action recorded)"), most recently
  active first per §State's listInitiatives; an initiative whose record
  moved since its last write-back (drift_events > 0, the staleness-
  detection freshness signal) carries a `⚠ may be stale (N events since
  write-back)` suffix — an initiative that never wrote back carries none;
  UNCAPPED entry count (terminal surface), lines whitespace-collapsed so
  each initiative stays one line; derivation warnings to stderr without
  failing — an uninitialized repo prints the empty listing with a
  `sofar new` hint (next-command 1.1).
- `sofar why <path>` — every task, session and decision behind a path,
  across ALL initiatives, newest-first (§Record graph `whyFile`). Prints the
  recorded paths the query resolved to (§Path identity) VERBATIM — those are
  the node ids the answer joined on — then three sections, each headed with
  its TRUE total and listing at most GRAPH_RESULT_CAP entries followed by a
  `+N more` line. The `+N more` string exists only here: the query reports a
  numeric `omitted` (record-graph 2.4). The decisions section carries the
  two-hop caveat inline — logged by a session that also touched this path, not
  necessarily about it — because the record cannot know the stronger claim. An
  untouched path is an empty answer, not an error (exit 0, with the hint that
  paths are recorded per checkout and a shorter query matches more broadly);
  fold warnings go to stderr without failing (record-graph 3.1).
- `sofar related <task-id> [--initiative <slug>]` — tasks that worked on the
  same recorded files, ranked by shared-path count, cross-initiative
  neighbours included (§Record graph `relatedTasks`). Task ids are not
  repo-unique, so the id needs a slug from somewhere: `<slug>#<task-id>`,
  `"<slug> <task-id>"` (the record's own citation form), the `task:` node id,
  `--initiative`, else the branch binding — four literal shapes, never a
  search. A task the plan never held is exit 1 naming the id and initiative
  looked for — including an id only stray status events name: the orphan
  node keeps such edges visible in the graph, but the CLI refuses to anchor
  on a status the plan cannot vouch for. A task with no neighbours is exit 0
  saying so (record-graph 3.2).
- `sofar find <seed> [--hops <n>] [--initiative <slug>]` — traverse the reach
  index out from a seed and report what is within the budget, grouped by kind
  (initiatives, decisions, notes, files, sessions), each row citing the event
  id that produced its edge (record-index 3.4). Seeds resolve LITERALLY FIRST,
  in a fixed order — node id, initiative slug, decision handle (`<slug> D<n>`,
  `<slug>#D<n>`, or `D<n>` with `--initiative`), session id, then path across
  checkouts. A query denoting NONE of those is treated as a question and matched
  against decision and note prose (record-index 3.5): tokenized, plurals and
  tenses folded, ranked by BM25 over the whole record with NO model, and reported
  in a `Matched` block that names the words which carried each hit and the event
  whose own prose holds them. The matches are the traversal's seeds; they are
  never presented as traversal hits, because word overlap is not an edge. At most
  5 become seeds and the rest are COUNTED, so a query that matched two hundred
  documents says so. A query matching nothing either way is exit 0 naming the
  seed vocabulary, not a nearest match. `--hops` defaults to 2 and is capped at
  3; out of range is exit 1. Unlike `sofar why` / `sofar related` this NEVER
  builds the record graph — measured on this record, 3.0ms end to end for a text
  question (0.2ms of it ranking) against `sofar why`'s 35.4ms — because the index
  is maintained incrementally on its own cursor. The surface offers, never
  asserts (record-index D2): it states what each edge IS ("logged by", "touched
  by", "cited by") and carries the caveat that adjacency is not a rule about the
  work; a text seed carries a WEAKER caveat still, because the record can prove
  only that the words are there, never that they answer the question. An
  expansion that hits the visit ceiling says so rather than presenting a partial
  answer as whole.
- `sofar review [slug] [--final] [--phase <name>]` — print the evidence packet
  a reviewing session works from (commit-attribution 4.6, contract in §Review).
  The READ half of the loop; `sofar_review` is the write half, split
  deliberately: rendering is cheap and repeatable while recording a verdict is
  an append, and a session must be able to re-read the packet without emitting
  an event every time it looks. Range is watermark..HEAD filtered to this
  initiative's attributed commits, falling back to a bounded window when no
  review has run. Defaults to the ACTIVE phase; `--phase` names another,
  `--final` is the close-time pass. Unknown phase, or no active phase and none
  named, is exit 1 saying so — never a silent review of the wrong range.
- `sofar commit-trailer <msgfile>` — the prepare-commit-msg worker (D5;
  §Commit attribution). Stamps `Sofar-Initiative: <slug>` onto a commit message
  from the SESSION that made the commit. Exits 0 on every path by contract,
  because it runs inside `git commit`: no session, no record, an unreadable
  message file and an already-present trailer are all silent successes.
- `sofar export [slug] [--since <id>]` / `sofar import <file|-> [slug]`
  — per-initiative NDJSON over the §Cursor primitive; slug resolves like
  status (explicit wins, else branch binding) (extended Phase 4, BD28)
- `sofar login` / `sofar link` / `sofar push` / `sofar pull [--watch]`
  — the v2 sync client against api.sofar.sh; full contract in
  §Sync client (sync-client, Jul 2026).
- `sofar event <subcommand>` — append-side surface: session-start,
  post-tool, stop, session-end are internal subcommands for the hook shims;
  `event append --type <event_type> --payload <json-object> [--session <id>]
  [--source <source>] [--actor <actor>] [slug]` is the convention-dialect
  surface for MCP-less tools — validate payload, append ONE event,
  regenerate projections, print {ok, event_id} JSON; any failure exits 1
  with the typed-error JSON and appends nothing (added Phase 5, BD30; slug
  resolves like status).
- `sofar statusline` (felt-cost 3.1/3.2, D4; identity segments D6; styling
  D7/D8) — the rent-meter, wired as Claude Code's statusLine command. Reads
  statusline JSON from stdin, prints ONE line: `<model> · <dir> ·
  <branch> · <pie> <slug> <done>/<total> · ctx <used%> ·
  cache <warm%>[⚠|✓][ · ↑<version>]`. The trailing update segment
  (auto-update 2.1) appears ONLY when the cached check knows of a newer
  release: `↑<version>` normally, `↻<version>` when a background
  auto-install already applied it and the running process is still the old
  binary; `update <version>` / `restart for <version>` without glyphs. It
  is cyan — the info tone, since an available release is information, not a
  warning about the user's state — and it is a CACHE READ, never a network
  call (§Update check). Icons are house-vocabulary text
  GLYPHS, never emoji (D8); D12 dropped the decorative ▸ dir and ⎇ branch
  markers, making dir and branch ordinary top-level segments carried by the
  same separator as the rest, so the kernel progress pie (○◔◕●) is the only
  glyph left — task progress on the record segment (D9, next.ts
  coloring: success done / warn in-progress / dim untouched). D13 removed
  the $<total_cost_usd> segment entirely and put ctx ahead of cache.
  Both meters keep their TEXT label in every mode (D10, extended to ctx by
  D11) — the word carries the meaning; only the ✓/⚠ band marks accompany
  cache, and D13 dims the constant `ctx` label so the band tone falls on
  the number. The leading model (model.display_name) and dir/branch
  segments restore what Claude Code's default status line shows — a custom
  statusLine REPLACES the default, and the rent-meter must not cost the
  user the line they had (D6). Branch comes from .git/HEAD via bounded
  upward walk from workspace.current_dir (worktree `gitdir:` file aware) —
  one file read, no subprocess; detached HEAD drops the branch. STYLED BY
  DEFAULT (D7): the consumer renders ANSI even though stdout is
  piped, so the command forces styled caps (bold model, success-green
  branch, accent slug, band-colored cache — success/error by band, dim
  unjudged — and ctx success/<70, warn/≥70, error/≥90, dim separators); TTY
  detection is deliberately bypassed. The IDENTITY segments are the one
  exception to the semantic color law (D14): dir renders YELLOW and branch
  BLUE because those are Claude Code's own default status-line colors, and
  D6 restored that line as a reproduction — a reproduction that recolors
  its source is not one. These are quotations, not meanings; sofar's own
  segments (record, ctx, cache) still obey D1. `Style.blue` exists solely
  for this and must never be used to express state. The model label also
  drops the word `context` from a parenthesised window size (D14) —
  "Opus 5 (1M context)" renders as "Opus 5 (1M)", since a line that already
  reports ctx fill does not need the noun spelled out.
- `sofar statusline --install` (felt-cost D14) — wire `sofar statusline`
  into <root>/.claude/settings.json and exit, touching NOTHING else: no
  hooks, no .sofar/, no CLAUDE.md block. The statusline is read-side and
  degrades to model/dir/branch/ctx/cache with no record present, so wanting
  the line is not wanting the tracking. Same merge law as
  `init --statusline` (init-statusline D1): an existing statusLine — ours,
  customized, or a third party's — is the user's and is never rewritten;
  reports wired / already / kept. Unparseable settings.json aborts with
  exit 1 and changes nothing.
- `sofar statusline --uninstall` (felt-cost D15) — the inverse: delete the
  statusLine key so the host tool's own status line returns, reporting
  removed / absent / foreign. The theirs-wins law holds from this side too:
  an entry that is not BYTE-FOR-BYTE sofar's is never deleted, so the
  command can only undo what sofar did. The settings file survives even
  when the removal empties it to `{}` — dropping a line is not a reason to
  delete a user's config. `--install` and `--uninstall` together are an
  error, not a precedence rule.
- `--user` (felt-cost D15) — retarget either verb at
  ~/.claude/settings.json, which Claude Code applies to EVERY project,
  instead of the repo's. Same merge and removal laws at both scopes. A
  project statusLine shadows the personal one, so `--install` at the repo
  scope still overrides a personal line.
- The statusline HINT printed by `sofar init` (init-statusline D1) is
  suppressed when the personal ~/.claude/settings.json already wires
  sofar's line (D15): the project having no statusLine of its own does not
  mean none renders, and a hint that says "not wired" must not fire when
  the line is, in fact, wired. That probe is read-only and best-effort — a
  missing, unreadable or unparseable personal file answers "not wired"
  rather than aborting an unrelated init. `--no-color` or NO_COLOR falls back
  to the plain line (`dir:branch`, `cache`/`ctx` labels, no ANSI, no glyph
  icons); runStatusline's library default is the plain line. D13 retired
  the guarantee that the plain line stays byte-identical to 0.8.0 —
  dropping cost and reordering ctx/cache are content changes and apply in
  both modes. Warm share = cache_read /
  (cache_read + cache_creation + input) from the first usage object found
  (top-level current_usage, context_window.current_usage, or
  cost.current_usage). Health judged only after ≥10k tokens: <30% → ⚠
  (prefix non-determinism), ≥50% → ✓ (healthy stable-prefix band, 50–80%
  per the Jul-12 research). Every segment independent and omitted when its
  inputs are missing; exit 0 always; READ-SIDE ONLY (never appends);
  no model call ever (§Architectural invariants). Root resolution: --root
  or cwd, falling back to the JSON's workspace.current_dir then cwd. NOT
  auto-installed by `sofar init` by default (never clobber an existing
  statusLine config — felt-cost D4); `sofar init --statusline` opts in,
  merging the entry only when the project settings has none (an existing
  statusLine always wins), plain init prints an opt-in hint while unwired,
  and `sofar uninit` removes the entry only when it is exactly ours
  (D4 informed re-test, init-statusline D1) — README documents the flag
  and the one-line settings.json entry.
- `sofar serve [--port 4173]` — chokidar watch on .sofar/ → GET /state
  (JSON InitiativeState per initiative), Server-Sent Events on change;
  plus the opt-in MCP endpoint at /mcp (streamable HTTP, POST/GET/DELETE,
  one isolated server handle per MCP session — §MCP tools, transports;
  speed T3). Still 127.0.0.1 only, JSON only.
  EVERY request must carry a loopback `Host` naming the listening port, and
  an `Origin` that is either absent (not a browser) or itself loopback;
  anything else gets 403 before routing (security-hardening 1.2). Binding to
  127.0.0.1 keeps other machines out but NOT the browser on this machine: a
  page can point a hostname it controls at 127.0.0.1 (DNS rebinding) and then
  it is same-origin with this server, free to read the whole record from
  /state and drive every write tool on /mcp — which is unauthenticated
  precisely because "localhost" was assumed to be doing the authenticating.
  A rebound request still carries the attacker's hostname in Host, which is
  what makes the check work. The MCP transport sets the SDK's
  enableDnsRebindingProtection/allowedHosts as a second lock;
  allowedOrigins is deliberately left unset there because the SDK treats a
  MISSING Origin as failure, which would lock out every non-browser client.
- `sofar mcp [--root <dir>]` — start the stdio MCP server (server name:
  sofar) exposing §MCP tools; --root overrides the repo root (default:
  cwd). Added in Phase 2 (BD13); `sofar init` registers it in .mcp.json.
- `sofar upgrade [version] [--check|--dry-run|--force]` — self-update the
  globally-installed CLI to `latest` (or a pinned version). Derives the real
  npm prefix from the running binary's own path (…/lib/node_modules/…) rather
  than `npm config get prefix`, so a custom-prefix install is updated in place
  instead of a naive `npm i -g` installing to the wrong root. --check reports
  installed-vs-latest and the resolved prefix; --dry-run prints the exact npm
  command; --force reinstalls at the target. Non-global installs (local dep,
  npx cache) print manual guidance and never run npm. `--auto <on|off>`
  writes the opt-in auto-install preference and exits (§Update check); a
  successful upgrade pitches `--auto on` in its success message, but only
  while the preference is off — the moment the user just paid the chore is
  the only place that offer is information rather than nagging
  (auto-update 3.3).
- `sofar update-check [--refresh]` — inspect the cached update check
  (installed, latest, when it last ran, whether auto-install is on, the
  cache path, the notice that would render); `--refresh` performs the check
  itself and is the detached child's entry point (§Update check).

## Update check (auto-update D1)

Telling the user sofar is out of date, without ever installing unasked.
`sofar upgrade` already solves installing correctly; the gap it cannot
close is that nobody runs it, because nobody knows there is anything to
run it for.

Read/refresh split — the property everything else rests on:
- **Foreground surfaces only READ.** `~/.local/state/sofar/update.json`
  (XDG_STATE_HOME honored) holds `{version:1, latest, checked_at,
  installed?}`. Reading it is one small JSON parse. No command — least of
  all `sofar statusline`, which renders on every prompt — ever waits on the
  network.
- **A detached child does the work.** When the cache is older than 24h the
  foreground process CLAIMS the slot (stamps `checked_at` before spawning)
  and then spawns `cli.js update-check --refresh` detached, unref'd, stdio
  ignored. The claim is what stops a per-prompt caller from starting a
  thundering herd of `npm view` children before the first one finishes.
- The spawn target is always the sibling **`cli.js`**, never the running
  bundle: the statusline executes inside `dist/fast.js` (§CLI, speed-2 T1),
  which has no top-level entry and would exit silently.
- Missing, corrupt, or shape-wrong cache reads as "no notice" and never
  throws. A cache that cannot be written costs a redundant check, never a
  failed command.

The check does not run at all unless someone can act on the answer:
`SOFAR_NO_UPDATE_CHECK` (any non-empty value) is off; `CI`, `VITEST`, and
`NODE_ENV=test` are off — a test run spends a real network call and a write
to the developer's HOME to learn something no one will read; and
`planUpgrade()` must resolve `global-npm` — a source checkout, a local
dependency, and an npx run either cannot self-upgrade or are already latest.

Notice comparison is against the RUNNING version, so the cache is
self-healing: after an upgrade `latest === current` and the notice
disappears with no write. Comparison is STRICTLY newer (dependency-free
semver, prerelease below its release), so a locally-built version ahead of
the registry never nags.

Surfaces:
- `sofar status`, `sofar init`, `sofar doctor` — one trailing line on
  **stderr**. Two invariants: stdout stays byte-identical, so piping gains
  nothing it did not have; and the exit code is untouched, which is why
  this is a trailing line and NOT a doctor axis — doctor's exit code is its
  verdict on the record, and a new release must never be able to change it.
- `sofar statusline` — the `↑<version>` segment (§CLI).

Auto-install is opt-in and lives in `~/.config/sofar/config.json`
(`{version:1, auto_upgrade}`, XDG_CONFIG_HOME honored) — a separate FILE
from the sync client's credentials.json so a credential rewrite can never
lose a preference. Default false; an unreadable config is not consent. When
on, the refresh child performs the install itself and records
`installed: {version, at}`, which turns the notice into "auto-upgraded to
X — restart your agent, and run `sofar init` in each repo to refresh its
wiring". That marker is dropped once the running binary catches up, so the
reminder cannot outlive its cause. Installing stays a thing the user chose
because an upgrade replaces the binary AND leaves repo wiring stale (hook
shims and the protocol block are files in the repo, speed-2 T6).

Egress: the refresh child runs `npm view sofar.sh version` against the
user's configured registry. This is the same query `sofar upgrade --check`
has always made and carries no record content — the ban on model calls in
§Architectural invariants and the "nothing else ever leaves the machine"
rule are about USER CONTENT, and a dist-tag lookup sends none.

## CLI UI (terminal rendering — human surfaces only)
Rendering kernel: src/cli/ui/ — caps, style, symbols, text, frames,
spinner, layout. Zero new dependencies (cli-ui D1/D2, Jul 11): color
detection + formatter mechanics vendored from picocolors, the unicode gate
from is-unicode-supported, frame glyph sets from cli-spinners (all MIT); no
TUI framework, no truecolor themes, no background detection. cli/ui may be
imported ONLY by human-facing CLI command modules; src/projections/**,
src/mcp/**, and src/cli/event.ts NEVER import it — the agent-facing bytes
(guaranteed-plain table below) stay plain forever.

Capability model — detectCaps({env, argv, isTTY, platform}) is a PURE
function returning three INDEPENDENT booleans (tests pass inputs, never
fake a TTY):
- color, by precedence class:
  1. veto — NO_COLOR present (ANY value, incl. empty; no-color.org:
     "regardless of its value"), `--no-color`, or FORCE_COLOR=0
     (force-color.org) → off, beats everything below;
  2. force — FORCE_COLOR set to anything but 0, or `--color` → on, even
     when piped;
  3. ambient — (isTTY && TERM ≠ dumb) || CI present → on; else off.
- unicode — non-Windows: TERM ≠ linux (kernel console); Windows: modern
  hosts only (Windows Terminal, VS Code, Cmder — via its ConEmuTask value;
  plain ConEmu is NOT detected and degrades to ASCII — Terminus, JetBrains
  JediTerm, TERM=xterm-256color|alacritty). Off → cp437-safe ASCII glyph
  substitution (✓→√ · ✗→× · ⚠→!! · ℹ→i · ●→* · ○→o · [✓]→[x] · [•]→[*] ·
  └→`- · │→| · ⋮→: · …→... · ▸→>), same layout and wording.
- animate — isTTY && CI absent && TERM ≠ dumb. Independent of color BOTH
  ways: a NO_COLOR TTY still animates (an uncolored spinner is fine); a
  FORCE_COLOR pipe never does (a colored CI log full of frames is not).

Stream scoping: stdoutCaps()/stderrCaps() derive caps from THAT stream's
own isTTY, and STRIP ambient CI when the stream is piped — piped command
output is consumed byte-for-byte by agents and tests, so only an explicit
FORCE_COLOR/--color restyles it (the CI clause stays in detectCaps for
callers that KNOW their bytes feed a CI log renderer). stdout is the
report channel; stderr is the messaging/progress channel (clig.dev).
Text landing on stderr styles under stderrCaps-derived caps: a stdout TTY
never pushes escapes into a redirected stderr, and vice versa.

Flag/env contract:

| Control | Effect |
|---|---|
| NO_COLOR (any value, incl. empty) | color off everywhere; beats TTY, FORCE_COLOR, `--color` |
| `--no-color` | same veto, per-invocation |
| FORCE_COLOR=0 | same veto |
| FORCE_COLOR=anything else | color on, even piped/CI; loses only to the vetoes; never enables animate or unicode |
| `--color` | same force, per-invocation |
| CI present | ambient color for TTY-less CI log renderers (detectCaps only — stream-scoped caps strip it when the stream is piped); animate always off |
| TERM=dumb | no ambient TTY color, no animate (CI's ambient clause or an explicit force still colors) |
| TERM=linux | unicode off → ASCII fallback glyphs |

`--color`/`--no-color` are registered as program-level commander options
(accepted before or after the subcommand); the kernel reads them from
argv directly, so registration is acceptance-only.

Progress pies (4.2): initiative headers on the styled status/list/next
surfaces carry a pie glyph quantized from tasks done/total — ○ ◔ ◕ ●
with honest endpoints (● only at 100%, ○ only at 0) and ties rounding DOWN
(exactly half → ◔) — colored on the checkbox ramp (green complete, yellow
in progress, dim untouched). The ramp EXCLUDES ◑ (U+25D1) by felt-cost
D13: common coding fonts lack it, so terminals fall back to a symbol font
that draws it wider than ○◔◕●, and a gauge whose width changes with its
value shifts every character after it. Any future ramp member must be
verified present in ordinary coding fonts. Banding derives from ramp
length, not hardcoded thresholds. The ASCII set renders no pie: the
numeric fraction already carries the value. Zero-total initiatives render
no pie and no fraction.

Color law (semantic ANSI-16, cli-ui D1): green=success/done ·
red=error/blocked · yellow=warn/active · cyan=info/identifiers ·
magenta=sofar brand accent · dim=secondary/metadata (muted) ·
bold=headers/emphasis. One deliberate non-semantic member exists:
`Style.blue` (felt-cost D14) is a QUOTATION color, reserved for the
statusline identity segments that reproduce Claude Code's own default
line. It carries no meaning and must not be used to express state — a
meaning wearing a non-semantic color is what this law forbids.
ANSI-16 SGR ONLY — never hex/256-color/truecolor
for text, never black/white foregrounds, no background detection: the
user's terminal theme supplies the palette. Mechanics: a nested style
re-opens its outer style after the inner close (the picocolors fix);
padding/alignment measures VISIBLE width (escapes stripped); truncation
happens on plain text BEFORE styling; record prose is sanitized before
styled rendering — the FULL ANSI grammar (SGR in any palette, 256-color/
truecolor included, OSC, cursor controls) is stripped and leftover control
bytes (a lone ESC, a stray BEL) dropped — so a hostile or accidental
escape sequence inside a log degrades to plain characters on the styled
layouts and the color law holds for arbitrary record content; the plain
renderers are agent contract bytes and pass record content through
untouched. Corrupt content is never fatal (repo error law). Style
disabled → every formatter is the identity function.

Degradation ladder — each capability degrades independently; the floor is
the pre-cli-ui renderer:
- color off → the styled layouts (inherently color-coded, D1) are skipped
  entirely: status/list/doctor print their pre-styling plain renders
  BYTE-IDENTICALLY (renderFullStatus, renderFullInitiativeList, the
  marker-column doctor report); confirmations keep identical wording,
  minus marks/rails.
- unicode off → glyph substitution only (table above); layout, wording,
  and color unchanged.
- animate off → shipped spinners are skipped entirely (silent stderr).
  The spinner kernel itself degrades animate → in-place redraw (\r +
  erase-line at the frame set's interval, cursor hidden while running and
  restored on stop and on SIGINT — where the handler re-raises the signal
  after restoring, so the default terminate-on-^C disposition survives the
  spinner (installing any SIGINT listener would otherwise suppress it) —
  unref'd timer) and non-animate → one static
  `⋯ text` line at start plus one per text change; but every shipped call
  site (doctor tree scan, upgrade install) constructs the spinner ONLY
  when stderr animates, so a piped/CI stderr carries zero spinner bytes —
  not even the static line.
Spinners and progress write to stderr ONLY, never stdout. Frame sets are
keyed by use case: scan=braille sweep, write=filling bar, network=packet
in flight, brand=eased ✳ pulse; ASCII fallbacks line spinner (all) /
bouncing bar (write).

Surfaces. Styled-capable (render under stream-scoped caps; with color off
the stdout bytes equal the plain renderer):

| Command | stdout (report) | stderr (messaging) |
|---|---|---|
| status | full-zoom layout grammar / renderFullStatus | fold warnings + resolution failures — always plain |
| status --watch | live full-zoom render: redraw on record changes (chokidar) + active-task marker pulses warn↔dim @600ms; TTY-gated by animate, piped/CI falls back to the one-shot result; ^C restores the cursor and re-raises | (same as status) |
| list | portfolio-zoom blocks / renderFullInitiativeList | derivation warnings — always plain |
| next | two-part entry blocks (header: pointer + pie + bold slug + dim branch tag + dim task fraction; body: hanging-indent word-wrapped action; stale warning on its own line; blank line between entries) / renderNextActions | derivation warnings — always plain |
| doctor | ✓/⚠/✗ findings report / marker-column report | scan spinner (animate-gated) |
| new, switch | ✓ confirmation + dim └ details | ✗ failure, styled under stderrCaps |
| login | code/url prompt (bold code) + ✓ confirmation + dim └ details; the sfr_ token NEVER prints | network spinner while polling (animate-gated); ✗ failure, styled under stderrCaps |
| link | ✓ confirmation + dim └ details | ✗ failure, styled under stderrCaps |
| push, pull | ✓ per-stream result lines | plain warnings (invalid lines, retries); ✗ failure, styled under stderrCaps; `--watch` banner dim |
| init | dim └ detail rails + ✓ result; scanner hint always plain (copy-paste material) | ✗ failure, styled under stderrCaps |
| uninit | dim └ details + notices + ✓ result | warnings + ✗ failures, styled under stderrCaps |
| adopt | MIGRATION BRIEF always plain (agent-executed); --mark result line ✓-styled | typed-error JSON (BD17) — always plain |
| upgrade | --check/--dry-run/result reports — plain text | network spinner (animate-gated) + npm's inherited output |
| serve | (HTTP JSON only — no terminal report) | one-line banner, accent+dim; identical wording plain |

Note: status, list, and next NEVER style stderr — their warnings AND their
failure text (e.g. a resolution error) print plain under every caps
combination. The ✗-styled failure register in the table is deliberately
scoped to the confirmation commands (new, switch, init, uninit); do not
"complete" it on status/list — the plain bytes there are locked by the
acceptance tests.

Guaranteed-plain (agent-facing — zero ESC bytes under EVERY env/flag/TTY
combination, FORCE_COLOR and `--color` included):
- sofar_get_state (all views) and every MCP tool response — mcp stdio
  (src/mcp/**)
- SessionStart hook stdout (renderStatus context block), Stop hook stderr
  block message, PostToolUse/SessionEnd — src/cli/event.ts
- `sofar event append` {ok, event_id} / typed-error JSON output
- `sofar export` NDJSON stdout and `sofar import` report
  (§Cursor primitive)
- generated projections on disk (plan.md, decisions.md, sessions/*.md) —
  src/projections/**
- `sofar serve` HTTP response bodies

Handler purity: styled command handlers keep the pure {exitCode, stdout,
stderr} shape (BD22) — caps and columns are OPTIONAL trailing parameters
defaulting to detection (stdoutCaps(), stderrCaps(),
columnsOf(process.stdout)); process/env access lives only in those
defaults, so tests inject caps and never fake a TTY. Styling is
presentation only: which initiatives/phases/tasks render and their order
stay the underlying derivation's, and exit codes are styling-independent.

## Acceptance criteria (definition of done)
- **Phase 1:** 1k concurrent appends from 4 processes → zero lost/interleaved
  lines; fold of a log with an injected corrupt line succeeds with warning;
  replay is deterministic (same log → deep-equal state); export/import
  round-trip is idempotent (re-import adds zero events).
- **Phase 2:** each tool call appends exactly its event and projections
  regenerate; invalid payloads rejected with typed errors; get_state resolves
  initiative from branch binding.
- **Phase 3:** SessionStart output verified ≤10k chars on a large synthetic
  initiative; Stop shim blocks a session lacking session_ended when
  gate-relevant drift is nonzero (drift-signal 1.2) and passes one that has
  written back; stop_hook_active loop guard verified; PostToolUse produces
  file_touched for an Edit and command_run for a Bash call, appends nothing
  for a self-recording command (git/sofar, record-hygiene D1) including one
  whose quoted commit message carries separators and newlines, and registers
  an unregistered session before its first real event (lazy registration,
  record-hygiene D2 — SessionStart alone leaves the log untouched, so a
  session that did nothing leaves no trace).
- **Repo memory capture:** `sofar remember <text>` and `sofar_remember`
  append memory_promoted and report the `<slug> M<n>` handle; ordinals follow
  log order; `memory.md` appears only once something is promoted; empty text
  is refused and an unknown initiative creates no log. doctor WARNs (exit 0)
  per promoted memory absent from `.sofar/repo.md`, clears on the QUALIFIED
  handle, ignores an unqualified `M<n>`, and never writes repo.md. `M<n>`
  stays out of the decision-prose grammar, so decision text mentioning it
  produces no dangling entry (repo-memory-capture D2).
- **Dropped tasks:** a record with no drops renders byte-identically to
  pre-0.18 on every surface (digest, plan.md, CLI zooms) — the guarantee the
  token budget rests on. With drops: progress reports `N done, M dropped, K
  remaining`; the done count never includes a drop and `total` never shrinks;
  an initiative whose only outstanding tasks were dropped reaches 100% while
  one with real work outstanding still cannot. A dropped task renders as
  neither done nor pending, a dropped phase leaves the digest's open list, and
  a phase whose tasks are all resolved (done or dropped) is stale-active until
  closed. `sofar_update_task` refuses a drop with no note; doctor WARNs (exit
  0) on a drop with no reason and on one citing no decision; reviving a
  dropped task discards its reason. A plan_updated carrying a status this
  build does not know keeps every readable part of the plan — goal, done
  statuses, added tasks and phases — coerces only the unreadable status to
  `pending`, and warns naming the path, the subject, and the upgrade; a
  structurally malformed plan is still skipped whole.
- **Phase 4:** `sofar init` on a fresh repo yields a working end-to-end
  loop (start session → tool events → end session → status shows it);
  init is idempotent (second run changes nothing); serve pushes an SSE on
  append within 500ms.
- **Phase 5:** AGENTS.md dialect drives a manual OpenCode session through
  read→work→write-back; the Jul 7 Fable→Opus handoff is executed and scored
  on the Phase 0 scorecard as an arm-C run.
- **Phase 10:** the init scanner hint fires on `tailwindcss>=4` and stays
  silent for v3 or no-tailwind; `sofar doctor` flags a Tailwind v4 entry
  lacking the `.sofar` exclusion (exit 1) and passes a clean, wired repo
  (exit 0); `sofar doctor --fix` inserts the correct stylesheet-relative
  `@source not` path after the import and is idempotent (a second run changes
  no bytes).
- **Version gate (scanner-version-gate):** on a host whose Tailwind predates
  4.1, `--fix` leaves every stylesheet byte-identical, still exits 1, and its
  hint names both the installed version and a scan-base directive that is
  correct FOR THAT stylesheet (paths are stylesheet-relative, so an entry at
  `src/app.css` gets `source("./")`, never `source("./src")`); with
  `node_modules` proving >= 4.1 under an open range the fix still applies; a
  repo protected by `source(...)` instead of `@source not` passes clean.
- **Phase 11:** `sofar doctor` flags a phase whose tasks are all done but is
  still active (stale-phase) and does not flag one marked done; flags a wrapped
  session with ≥3 files touched and zero task changes (untracked work) and not
  one that changed a task; flags a file touched by ≥2 open sessions (concurrent
  edit) and clears once one writes back; all three are WARN (exit stays 0). The
  concurrent-edit signal renders in both `sofar status` and the SessionStart
  context when open sessions overlap, and is absent otherwise.
- **Staleness (staleness-detection):** a log carrying counted mechanical
  events (file_touched / command_run / task_status_changed / note_added /
  decision_logged, any source incl. cli) after its last session_ended
  renders the `⚠ next action may be stale` line in renderStatus
  (SessionStart block + get_state digest) and the `⚠ Staleness:` section in
  `sofar status`; a log whose last event is the write-back renders neither,
  and a log that never wrote back renders no staleness line. Freshness
  counters reset on a new session_ended; replay stays deterministic (same
  log → deep-equal state incl. freshness). The SessionStart block holds ≤10k
  chars with every section at worst case, staleness line included. `sofar
  doctor` stale-phase WARN text is byte-identical after the detector's
  extraction to core (Phase 11 criteria unchanged). The clipped-summary
  pointer renders only when the last write-back summary actually exceeds
  its budget, and lands inside that budget.
- **Notes surfacing (notes-in-digest):** a log with note_added events after
  its last session_ended renders their content on all three resume surfaces
  — renderStatus (SessionStart block + get_state digest, budgeted: ≤5
  newest-last lines, 200 chars each) and `sofar status` (uncapped) — and a
  log whose write-back postdates every note renders no notes section on any
  surface; a never-written-back log renders all its notes (header "Notes:").
  Overflow past the digest cap is labeled "(last K of N)"; a voided
  (corrected) note never renders. freshness.notes carries {ts, text} in log
  order with notes.length === counts.notes; replay stays deterministic. The
  SessionStart block holds ≤10k chars with every section at worst case,
  notes section included.
- **Listing (initiative-list):** on a repo with several initiatives —
  including one with an empty/absent log and a corrupt bindings.json —
  `sofar list` renders one line per initiative, most recently active
  first, never-logged entries last by slug, warnings on stderr, exit 0;
  get_state view:"initiatives" succeeds from an UNBOUND branch (no
  unknown_initiative), count-caps at 20 lines with the overflow pointer,
  and each line holds its clip budget; unknown_initiative errors carry
  the available-initiatives suffix (≤10 named) or the `sofar new` hint on
  an initiative-less repo; the derivation is deterministic (same records
  → deep-equal listing, same warnings).
- **CLI UI (cli-ui):** with stdout and stderr both piped and no explicit
  opt-in, every command emits ZERO ESC (\x1b) bytes — ambient CI included;
  FORCE_COLOR=1 on the same piped invocation carries ANSI-16 SGR on the
  styled-capable surfaces ONLY, while every guaranteed-plain surface
  (get_state digest, hook stdout, `sofar event` JSON, export/import
  NDJSON, mcp stdio, on-disk projections) stays byte-identical under EVERY
  env/flag/TTY combination; NO_COLOR (any value, incl. empty) renders
  plain even on a TTY and beats FORCE_COLOR. With color off, status/list/
  doctor stdout is byte-identical to the pre-cli-ui plain renderers.
  Spinners never write to stdout: frames appear only on an animating
  stderr TTY, and a piped/CI stderr carries no spinner bytes at all (not
  even the static line). src/projections/**, src/mcp/**, and
  src/cli/event.ts import nothing from cli/ui (locked statically by
  test; the lock resolves bundler-style `.js`/`.mjs`/`.cjs`-suffixed
  relative specifiers, so importing '../cli/ui/index.js' from a protected
  file fails it). Exit codes are styling-independent: styled and plain
  runs over the same repo state exit identically (doctor's fail→1 law
  included). Hostile record content: with record prose (goal, phase/task
  names, next action, blocked_on, notes, write-back summary, file paths)
  carrying raw ANSI bytes — 256-color/truecolor SGR, reset-all,
  background/reverse codes, OSC sequences, lone ESC — styled status/list
  output still satisfies the semantic-ANSI-16 law with the escapes
  degraded to plain characters, while the plain renderers keep passing
  record bytes through untouched (agent contract). An animated spinner's
  SIGINT handler restores the cursor and re-raises the signal, so ^C
  still terminates the process.
- **Phase 12 (misroute hardening, BD58):** a session started on branch A
  keeps writing to A's initiative through every MCP write tool after the
  shared checkout flips to branch B; an explicit `initiative` arg and the
  CLI-slug path (`sofar event append <slug>`) are unaffected, and a server
  with no active session still resolves from the branch. `sofar doctor`
  flags an injected task_status_changed whose id is not in the plan (WARN,
  exit 0) and does not flag applied task events or skew-ordered ones the
  plan later absorbs. overlappingWritebacks surfaces the losing overlapping
  session's next_action (winner excluded, duplicates of the winner's text
  excluded, sequential sessions excluded) and renders in renderStatus and
  `sofar status` only when present.
- **Phase 13 (convergent fold, D-sync-1):** the same event set folds to a
  deep-equal state from shuffled file orders and from merged two-writer
  logs in any concatenation order, cursor included (max id); same-process
  ids from makeEvent are strictly increasing (monotonic writer, rider a); a
  task_status_changed whose id sorts before its task_added resolves totally
  by skip-with-warning from either file order with identical states, and is
  not an orphan (rider b); a duplicated id (pre-dedupe merge artifact)
  keeps file order via the stable sort and folds deterministically.
- **Sync client (sync-client):** round-trip — push a stream from one
  clone, pull since genesis into a fresh clone: byte-identical event
  set, deep-equal fold, zero-diff `sofar status`, projections present.
  Idempotency — a `--full` re-push of an already-pushed stream reports
  accepted=0, duplicates=n, and the server stream is unchanged.
  Downtime drill — with the API down, local appends are unaffected and
  push fails politely with the ack cursor intact; after restart the
  queue drains (exactly the events past the cursor), and a further push
  finds nothing to do. Retries re-send the byte-identical batch on
  5xx/network and honor Retry-After on 429; server-rejected `invalid`
  lines surface on stderr without failing the push or wedging the
  cursor. Batching splits at both 1000 lines and 5MB with every batch
  under both limits and no event dropped or reordered. Pull pages by
  X-Sofar-Cursor persisting the inbound cursor after every imported
  page; the inbound cursor is independent of the push ack. Doorbell
  rings and reconnects each trigger a since-cursor pull; heartbeats
  dispatch nothing; 401 aborts instead of looping. Login stores the
  minted credential 0600 keyed by api_url, honors slow_down (+5s),
  aborts clearly on denial/expiry, and no CLI output ever contains the
  sfr_ token. Live E2E (behind SOFAR_LIVE_API, local api.sofar.sh):
  device login via the claim+approve path, link, and the round-trip.
- **Speed (speed T1 — drift-gated Stop):** a registered session with zero
  gate-relevant drift ends ungated (exit 0, no stderr) even without a
  session_ended — covering the zero-event session and the read-only session
  (no counted events per the T1 decision; uncounted lifecycle/plan-structure
  events since the write-back do not gate); one task_status_changed since
  the last write-back gates (exit 2, exact BD2 message); an error in the
  drift computation gates (fail closed); an in-flow write-back at drift ≥5
  followed by a further eventless turn ends silently; a concurrent
  unwritten session with its own mechanical activity stays gated after
  another session's write-back resets the shared counter (Phase 7
  independent gates).
- **Drift signal (drift-signal 1.1/1.2, superseding the T1 scope above):**
  a session that ran only Bash commands owes nothing — the command_run
  events ARE in the log, freshnessTotal is 0, no nudge fires and Stop
  passes; a session that wrote back is neither nudged nor blocked by a
  sibling's subsequent edits and commands, while that sibling stays gated
  for them; a sibling's write-back resets the initiative counter without
  clearing this session's debt (nudge still fires, Stop still gates) and
  this session's OWN write-back clears it; an unattributed (session "cli")
  mutation gates the registered session, since no other session's gate
  would catch it. The loop guard and every BD22 exit-0 path are
  byte-identical to Phase 3 behavior.
- **Speed (speed T2 — shim-latency budget):** every hook shim (SessionStart,
  PostToolUse, UserPromptSubmit nudge, Stop, SessionEnd) completes in
  <100ms END-TO-END — process spawn of the built CLI, boot, fold, and its
  append/render — against a realistic seeded record (hundreds of events in
  the bound initiative, multiple sibling initiatives, repo memory present,
  drift and open sessions arming every render section). Up to 10 attempts
  per shim after one warmup spawn, early-exit on the first run inside the
  budget, assert the minimum (the pin asserts capability; scheduler noise
  from a saturated parallel test run is not a regression, while a genuine
  sleep ≥ budget has a floor no retry ducks). Mutation-checked at
  introduction: a temporary 150ms sleep in one shim fails the pin
  (byte-stability precedent, felt-cost 1.2).
- **Speed (speed T3 — persistent MCP daemon):** a genuinely spawned stdio
  `sofar mcp` server and the serve daemon's /mcp endpoint return identical
  tool listings (the frozen 7) and identical results for an identical
  call script covering every tool — digest/portfolio text byte-equal,
  typed errors included — and the two records fold to the same state
  (volatile ulids/timestamps redacted); two concurrent HTTP clients on one
  daemon hold isolated MCP sessions (each session's write-backs land
  correctly, neither blocks the other); connecting to a port with no
  daemon fails in <2s (never a hang); /state, /state/<slug>, and /events
  behavior is unchanged.
- **Speed (speed T4 — file-locality hints):** a file_touched landing while
  a task is active appears in that task's task_files (and in every
  concurrently-active task's); one landing while the task is not active
  does not; a re-touch moves the path to the front (deduped,
  most-recent-first) and the per-task list caps at 20; a voided
  file_touched never attributes; replay stays deterministic (same log →
  deep-equal state, task_files included, from shuffled file orders). The
  renderStatus "files:" line names at most 8 most-recent files inside its
  300-char clip, renders on both renderStatus surfaces, is absent for a
  task with no data, and the SessionStart block holds ≤10k chars with the
  line at worst case. The byte-stability pin passes unmodified.
- **Next actions (next-command):** on a repo with several initiatives,
  `sofar next` renders one line per initiative — slug, branch(es) or
  "unbound", next action or "(no next action recorded)" — in the same
  recency order as `sofar list`, warnings on stderr, exit 0; an
  initiative with counted mechanical events after its last session_ended
  renders the `⚠ may be stale (N events since write-back)` suffix, one
  whose last event is the write-back renders no suffix, and one that
  never wrote back renders no suffix; drift_events is additive on
  InitiativeListEntry (same records → deep-equal listing, listing
  renders byte-identical); an uninitialized repo prints the empty
  listing with the `sofar new` hint.
- **Write-back routing (record-integrity 4.5):** a session started under
  initiative A writes back, keeps working, and a parallel `sofar new`
  rebinds the branch to B; the session's SECOND write-back still lands in
  A's log and B's log stays empty. The pin is still held after the first
  write-back (getActiveSession() is non-null), so later decisions and task
  updates route to A as well. With no pin at all — a restarted server
  ending a session registered in A while the branch names B — the write-back
  still lands in A. Both cases fail against the pre-4.5 code.
- **Push awareness (record-integrity 4.4):** a registered session in a repo
  with readable refs and NO sibling session at all still gets the push-state
  line on every UserPromptSubmit — `NOT pushed (origin/<branch> at <tip>)`
  when the local tip is ahead, `pushed (in sync with origin/<branch>)` when
  the refs match, `never pushed.` when no origin ref exists. When a parallel
  window pushes mid-session (refs move, record untouched — git is exempt
  under record-hygiene D1), the session's very next prompt flips from NOT
  pushed to pushed with no sibling write-back involved. The 420-char budget
  bounds the parallel-wrap line alone, not the combined hook payload; a
  sibling that wrapped before this session's last write-back still yields no
  wrap line while the push-state line renders regardless.
- **Record graph (record-graph):** buildGraph over a repo of several
  initiatives is deterministic (same records → deep-equal graph and
  identical warnings, from shuffled file orders) and tolerant (an injected
  corrupt line and an unreadable log each yield a warning and a thinner
  graph, never a throw). A session that wrote to two initiatives yields one
  session node with edges into both — the cross-initiative fact no
  single-log fold can produce. A file path touched from two initiatives is
  ONE file node. Citation extraction resolves `D<n>` to that initiative's
  nth decision in ulid order and `<slug> <task id>` to that task, refuses
  bare `<n>.<n>` (a record carrying `0.14.0` and `127.0.0.1` in decision
  prose yields zero citations from them), binds a miscased qualifier
  (`Felt-cost D3`) to its slug rather than degrading the handle to a
  home-bound one, drops self-labels and future-sorting targets, and records
  every unresolved grammar-matched handle in `dangling[]` rather than
  discarding it. A task the final plan dropped keeps orphan endpoints for
  its `worked` edges as well as its `changed` ones — no edge dangles — and
  an orphan's status follows the log's last word. `sofar why <path>` names
  every task, decision and session that ever touched the path across ALL
  initiatives, newest-first; `sofar related <task-id>` ranks co-touched-file
  neighbours by shared-path count and exits 1 for an orphan-only anchor
  exactly as for an id the record never saw; `repoGeneral` ranks decisions
  by DISTINCT
  citing initiatives other than their own, and doctor WARNs (exit 0) when a
  repo-general decision is absent from `.sofar/repo.md` — detection only,
  repo.md is never generated. No hook shim, statusline, or UserPromptSubmit
  path imports core/graph.ts (locked statically by test, the cli-ui
  import-lock precedent), and the speed T2 shim-latency pin still passes.
  Consolidation was GO/NO-GO and resolved GO: task_files and activity are
  re-expressed as pure functions of one emitted edge list (core/adjacency.ts,
  §Record graph, Consolidation), and the graph unions those per-log lists
  instead of walking events itself. BYTE-IDENTICAL was the gate and was
  measured against the pre-consolidation engine over the live record — whole
  graph in order, plus every fold — with the byte-stability and shim-latency
  pins passing unmodified. A golden fixture pins the RULE independently of
  either implementation: two tasks active at once fan one file_touched out to
  both; a re-touch moves the path to the FRONT of task_files while activity
  keeps FIRST-touch order; a cli-sourced touch counts for task_files and never
  for activity; a status change for an id the plan never held is still real
  activity and mints an orphan node; an unregistered session attaches to
  nobody; a voided event contributes nothing.
- **Auto-update:** the cache round-trips through XDG_STATE_HOME and reads
  missing/corrupt/shape-wrong as null without throwing; an unwritable state
  dir does not throw. `isNewer` is strictly newer, sorts a prerelease below
  its release, and refuses to guess at an unparseable version. `shouldRefresh`
  is off under `SOFAR_NO_UPDATE_CHECK`, `CI`, `VITEST`, `NODE_ENV=test`, and
  for any plan that is not `global-npm`; it treats an unparseable or FUTURE
  `checked_at` as stale so a bad clock cannot pin the check off forever.
  `updateNotice` claims the slot BEFORE spawning — a second call in the same
  millisecond spawns nothing — and preserves the known `latest` while
  claiming, so the hint does not blink off during a refresh. The refresh
  re-launches `cli.js`, never `fast.js`. `withUpdateNotice` leaves stdout and
  the exit code byte-identical and appends only to stderr — a failing doctor
  stays failing, a passing one passing. The statusline segment renders
  `↑<v>` / `↻<v>` with glyphs and `update <v>` / `restart for <v>` without,
  is absent when up to date, and is absent by DEFAULT so existing callers
  stay hermetic. `runRefresh` persists the resolved latest, keeps the last
  known one when the registry is unreachable, installs only when
  `auto_upgrade` is on AND the plan is global-npm, records nothing installed
  when npm fails, and drops a spent install marker once the running binary
  has caught up. The `--auto on` pitch appears after a successful upgrade
  only while the preference is off. sofar's own packaging test — which
  installs the tarball into a temp prefix, a true global-npm layout — makes
  no network call and writes nothing outside its fixture.
- **Initiative lifecycle (initiative-lifecycle):** a log with NO
  initiative_status_changed folds to `active` with null status_ts/status_note,
  so an un-closed record is unchanged; the payload validator refuses a
  `dropped` with no note (D3) and a status outside active|done|dropped; an
  invalid status event is skipped with a warning, leaving the record active.
  `sofar close` appends the event and removes EVERY bindings.json entry
  pointing at the slug while leaving other initiatives' bindings intact;
  running it twice appends exactly one event and still leaves no binding (so
  re-running is the repair for a stale binding); `--drop` with no `--reason`
  is refused and changes nothing — no event, no unbind. `sofar switch` on a
  closed slug appends status `active`, announces the reopen and binds, while
  switching to an OPEN initiative stays byte-identical. A REGISTERED session
  keeps routing after its branch is unbound — the closing session's hooks
  still append and its statusline still shows the record, rendered distinctly
  from a live one — while an unregistered session on the unbound branch drops
  silently at exit 0 and is told, once, by SessionStart and the statusline
  `unbound` marker; a repo with no record at all gains neither. `sofar next`
  omits closed initiatives and its header count agrees; `sofar list` sorts
  them below open ones and tags them with their status; `sofar status` shows
  the status with when and why, and an open record renders byte-identically.
  doctor flags a closed initiative still bound to a branch, and one whose
  phases are all resolved but was never closed. Verified against the PUBLISHED
  previous minor (1.1): an unknown initiative_status_changed event is skipped
  with a warning, replay continues past it, the line is never rewritten, and a
  removed binding degrades rather than corrupting — no old-engine path
  re-creates a binding, so a close cannot be silently undone.
- **Write-time collision report (writeback-collisions 1.2):** two overlapping
  sessions on one initiative each call sofar_end_session with a DIFFERENT
  next action; the FIRST caller gets a bare `{ok, event_id}` (nothing to
  collide with yet — the sibling has not written back), and the SECOND gets
  `parallel_writebacks` naming the first, with its session_id, tool, ended
  and next_action. Agreement is not a collision: identical next actions
  yield no field on either call. Sequential sessions are not a collision:
  a session that ended before the caller started is superseded history and
  yields no field. A caller whose own `ended` ties the sibling's to the
  millisecond STILL gets the field, in both call orders — the reference is
  the caller, so the report never depends on which session state.sessions
  happens to order later. The field is omitted, not `[]`, when empty, so a
  no-collision result is byte-identical to the pre-1.2 shape; the log is
  identical either way (the report is read-side — no new event type, and
  the same collision still renders in both status surfaces). Parity-locked
  stdio vs HTTP like every other tool result.
- **Warm-log signal (cross-initiative-conflicts 1.1):** a log's warmth is its
  own newest event timestamp, read from the TAIL of events.jsonl — never
  filesystem mtime. Rewriting a log's mtime without changing its content (what
  `git checkout` does to every events.jsonl in the tree, and what a copy,
  restore, or `touch` does) must NOT make a cold log read warm. The newest
  timestamp among the tail's complete lines wins, not the last line's, since
  an explicit-ts append can land backdated. The partial line the tail read cuts
  through is discarded; a single event larger than the tail window falls back
  to a whole-file read; corrupt lines are skipped exactly as the fold skips
  them. An absent, empty, or unparseable log counts as WARM — ambiguity costs
  one extra fold, never a dropped warning.
- **Cross-initiative concurrency (cross-initiative-conflicts 2.1/3.1):** two
  OPEN sessions in DIFFERENT initiatives holding one path are reported as a
  conflict naming both initiatives; two in the SAME initiative are not, since
  the within-initiative surface already reports them and both would double the
  warning. The `alsoLiveSessionId` re-admission holds across the boundary
  exactly as it does within one. Given a window, only logs that grew inside it
  are read — and the window may change which logs are READ, never what counts
  as a conflict: gated and ungated agree on every initiative the gate admits.
  An unreadable record degrades to no conflicts, never to an error.
- **Cross-initiative conflict on the shim path (record-index 2.2):** the
  UserPromptSubmit line answered from Tier 0 must equal what folding every log
  answers — same paths, same holders, same initiatives — on a plain collision,
  on a file held both inside and outside the initiative, after a sibling wraps
  up, past the caller's own mid-flight write-back, and after each incremental
  append rather than only on a cold build. A same-initiative collision is
  never reported here (the within-initiative line already has it), and that
  line stays byte-identical whether or not this one fires. An index that is
  ABSENT, cold, corrupt, or describing a rewritten log yields the right answer
  on the very first prompt and repairs itself — never an empty answer, since
  empty reads as "no conflict". Steady-state cost is the pin: no log whose
  size AND mtime are unchanged is read at all, so the indexed answer stays a
  small multiple cheaper than the folded one as initiatives multiply
  (measured: shim end-to-end 67.1ms at 30, 70.3ms at 300, 83.5ms at 1000
  initiatives against the 100ms budget; derivation 0.9/1.9/5.5ms against the
  fold's 5.0/44.6/146.3ms). Building a cold index is O(total history) ONCE and
  costs about what folding costs, since it applies the same envelope and
  payload validation — 111ms at 300 and 203ms at 1000, over budget for that
  single prompt, which is the accepted price of never answering from a partial
  index.
- **Peer addressing (peer-messaging 1.1/2.1/2.2):** with the host's registry
  naming a colliding session as a live Claude Code session, its UserPromptSubmit
  line gains a SECOND line carrying the name SendMessage addresses, and
  sofar_end_session's matching `parallel_writebacks` entry gains `peer`. With
  the registry absent, unreadable, holding malformed JSON, holding an entry
  whose fields changed type, or naming a process that is gone, BOTH surfaces
  render exactly what they rendered before the feature: no peer line, no
  `peer` key, and — asserted byte for byte — an unchanged conflict line. A
  name the registry shows for two or more live sessions carries the working
  directory beside it (`peer_cwd` on the tool result), and a session is never
  offered its own address. Nothing here opens a socket or sends a message:
  sofar resolves an address and the agent decides whether to use its own tool.
- **Live file-conflict warning (writeback-collisions 2.1):** two open
  sessions that have both touched one path put the line on each one's next
  UserPromptSubmit, naming the path and the OTHER session; two open sessions
  in different files put out nothing. The line survives the caller's own
  mid-flight write-back — the case the bare open-session rule drops — and
  falls silent the moment the SIBLING wraps, with no stored "already told
  you" bit either way. It renders FIRST when a parallel-wrap line is also
  due. With many colliding paths it names at most 3, carries a `(+N more)`
  tail, reports the true total, and stays inside 300 chars. Passing no
  session id re-admits nobody, so `sofar doctor`'s concurrency audit is
  byte-identical; passing a DIFFERENT session's id re-admits only that one.
- **Decision guards (drift-hardening 5.1-5.3, D3):** `guard` validates only
  alongside `rule`, only in the `path:`/`cmd:` grammar, and never as an
  all-exemption spec — each failure appends nothing and returns the typed
  error. A `path` guard matches the tail of the ABSOLUTE path a hook logs and
  not a partial segment; `*` stops at `/` while `**` crosses it; a `cmd` guard
  matches anywhere in the command; exemptions beat positives. The fold flags
  only work logged AFTER the guarding decision, counts one crossing per (rule,
  session, subject) however many times the file is re-touched, keeps sibling
  sessions separate, ignores a voided decision, and stops at 100 violations.
  `sofar doctor` reports each crossing at WARN with the rule verbatim and
  exits 0 on a repo whose only findings are crossings; the UserPromptSubmit
  line leads with them and falls silent after the session writes back; the
  Stop message carries them only when it was already blocking for a missing
  write-back, and a session that wrote back exits 0 with a crossing on record.
  A log carrying no guard folds and renders byte-identically to before.
- **Point-of-use guard, un-scoped (record-index 3.2):** an edit under one
  initiative surfaces a rule declared in ANOTHER on the same PostToolUse, as
  exit-0 `hookSpecificOutput.additionalContext` — never exit 2, never
  `decision: "block"` — while the fold's own guard check, on the same fixture,
  reports nothing. The rule renders verbatim however long; the handle carries
  the declaring initiative unless it is the session's own; the ordinal equals
  the fold's `D<n>`, counting unguarded decisions; the path renders
  repo-relative. A malformed guard never fires, exemptions still win, and an
  unguarded subject produces EMPTY stdout and a byte-identical append. Repeat
  edits of one path by one session say it once; another session still hears
  it; a rule declared after a session's earlier touch of that path still fires
  on the next one; each run of a guarded command fires. A self-recording
  command is tested and still appends nothing. The declared half is refreshed
  on every edit and the derived half only after a rule matches — asserted
  structurally: an edit matching no guard leaves `graph.json` untouched. An
  index that is absent, deleted mid-session, or corrupt answers correctly on
  the next edit, and an unreadable log costs the notice, never the exit code.
- **Priming line (record-index 3.3):** the SessionStart block names the other
  initiatives that have touched this one's files, and the shared-path counts
  match what buildGraph answers from the logs, path for path; each named
  record's decision count equals what folding that log counts. The asking
  record is never its own neighbour, cli-sourced touches create no adjacency
  (the `touched` edge drops them too), ranking is shared-paths then decisions
  then name, and the incremental answer tracks an initiative that appears
  after the index was already warm. At most 3 are named with a `…and N more`
  tail, the D2 clause is part of the line, and the block stays ≤10,000 chars
  with a crowded neighbourhood. Nothing overlapping, an initiative that has
  touched nothing, or an unreadable index renders NO section and a block that
  is otherwise unchanged.
- **Reach traversal (record-index 3.4):** `sofar find` and `sofar_find` answer
  from a seed within a hop budget, and EVERY hit names an event that exists in
  a log and is of the type its edge claims — checked as a property over every
  result, not on a sample. The decision→decision citation edges equal the ones
  buildGraph derives from the same fixture, exactly; a citation binds to the
  slugs that exist NOW, so an initiative arriving later re-binds a handle that
  had been reading as home-scoped, and nothing ever cites the future. An
  initiative is never traversed THROUGH — two records sharing no files stay
  unconnected at max hops — while an initiative SEED expands to what it holds.
  A hit is dated by its own event, not by the edge that reached it. The
  incremental answer equals a cold rebuild after appends and after a correction
  withdraws a decision (which renumbers the survivors, as the fold does), the
  half keeps its OWN cursor file, and cli-sourced touches create no adjacency.
  The surface never states that a result bears on the work.
- **Lexical seeds (record-index 3.5):** a text question resolves to decision and
  note seeds the traversal then expands, and every match names an event that
  exists in a log and is of the type it claims. A LITERAL reading always wins:
  a query that is also a path, a slug, a session id or a decision handle resolves
  as that one, never as text. Ranking is rarity and repetition, not presence — a
  decision a word runs through outranks a shorter, newer one that mentions it
  once — and the words that carried each match come back with it, as the ASKER
  wrote them, folded so a plural or a tense need not match the record word for
  word. Terms are derived from the WHOLE prose, so a word living only in
  `because` is findable though the stored label cannot show it. A query of
  nothing but common words is a miss, not a weak guess; matches past the cap are
  counted, never dropped silently; matches are never presented as traversal hits;
  and the answer is byte-identical on a repeat and after a cold rebuild.
- **Equivalence and fallback (record-index 4.2):** over a corpus of records
  built one append at a time — a correction reaching back, a union merge out of
  ulid order, a session that ends before it starts, prose whose bytes and
  characters disagree, a path under two checkouts, lines the fold skips, an
  initiative with no log — every tier's answer equals the from-logs answer
  after EVERY append, compared as canonical JSON rather than field by field.
  Then each record is answered from a warm index and the index is DAMAGED ten
  ways — removed, emptied, truncated, garbled, version-bumped, shape-broken,
  cursors pointing at the wrong line, and split so cursors and derived state
  disagree in each direction — and every time the answer is still the one the
  logs give, still right when asked twice, and repaired on disk rather than
  recomputed forever. A log that grew, was rewritten under a plausible cursor,
  or belonged to a deleted initiative is answered correctly without a refresh
  in between. The index never writes into the record it derives from. The one
  documented divergence (§Derived index, Tier 0 and a touch that sorts before
  its own registration) is asserted in both directions, so it cannot widen
  unnoticed.
- **Reach stays off the hot path (record-index 4.1):** the shim bundle
  (`cli/fast.ts`), the router entry (`cli/boot.ts`), the event/PostToolUse
  entry (`cli/event.ts`) and the statusline carry no byte of `core/index-reach`
  — asserted against the REBUILT bundles, not the import graph, so a dynamic
  import or a barrel re-export cannot slip through. The full CLI is the
  positive control: `sofar find` lives there and does bundle it. `mcp/` is
  deliberately unprotected, unlike the graph exclusion — `sofar_find` is the
  agent asking, not the harness pushing.
- **Commit attribution (commit-attribution 1.x-3.x):** a trailered commit reads
  back with its slug and an untrailered one reads back EMPTY, never as a guess;
  a folded trailer value, a multi-slug commit and a value that is not
  slug-shaped are all parsed the way §Commit attribution states; a rev range
  that could read as a flag, a nonsensical maxCount, and running outside a repo
  all return null rather than throwing. A squash-merged commit recovers every
  slug the squash swept up from the INDENTED body trailer, body text never
  overrides a real trailer, an UNINDENTED mention is ignored, and a squash
  committed with `-m` stays honestly unattributed. Shipping splits an
  initiative's commits into pushed and local, answers PER INITIATIVE where a
  branch-level check cannot, reports `unknown` (never `local`) with no upstream
  to compare, and skips the second spawn entirely when nothing in the window is
  attributed. The trailer worker stamps a registered session's message above
  git's comment block, is idempotent across amends, adds a DIFFERENT slug to an
  already-attributed message, and writes NOTHING for a session registered
  nowhere even when the branch is bound. `sofar init` installs an executable
  hook that calls the worker, guards on the binary so it can never abort a
  commit, NEVER clobbers a hook it did not write, and keeps its own current
  across versions. doctor warns on a missing hook and on a fully unattributed
  window, reports ok once commits carry trailers, never FAILs on unattributed
  history, and is silent outside a git repo. The LIVE line tells a running
  session its commits reached origin, announces the transition ONCE rather than
  on every later prompt, counts only THIS record's commits inside a mixed push,
  counts only what a first push ADDED rather than the base behind it, reports a
  branch's first push where no upstream ref existed before, recovers rather
  than sticking when the old sha is gone, and — the D6 pin — SPAWNS NO GIT AT
  ALL on a quiet prompt. The mark keeps sessions independent, treats a branch
  switch as a first look, evicts oldest-first without starving a quiet session
  that keeps looking, and cold-starts on a corrupt file.
- **Review (commit-attribution 4.x):** `review_recorded` accepts a `pass` with
  no findings and REJECTS a `findings` verdict listing none; reviewWatermark
  returns the latest watermark and SKIPS a review that recorded none rather
  than resetting to null; openFindings carries findings forward, is superseded
  by a re-review of the SAME phase, and keeps a different phase's findings
  intact. An older engine folds a log containing review_recorded without
  failing. The packet names its commits with a runnable `git show`, lists shas
  EXPLICITLY (a two-dot range would drop the oldest), treats an empty range as
  a FINDING, renders standing constraints verbatim and unclipped, lists
  rejected approaches, and demands a verdict that can be "no". Phase and final
  packets ask DIFFERENT questions: the phase one delegates bug-hunting where a
  skill exists and STANDS ALONE where none does (D12), the final one asks goal
  conformance and explicitly forbids re-auditing per-phase correctness (D10).
  `sofar review` renders the active phase, EXCLUDES another initiative's
  commits from the range, starts at the watermark once a review has run, and
  fails clearly on a phase name that does not exist.
- **Close gate (commit-attribution 5.1/5.2/5.3):** a record that actually
  finished — every task and phase resolved, every phase reviewed, a final pass
  recorded, nothing appended since the write-back — closes with NO findings and
  no override section anywhere. Otherwise the audit names what it found:
  unresolved tasks with their statuses, unresolved phases, done tasks with no
  file evidence (and nothing at all on a record that never touched a file),
  unaddressed guard crossings by `D<n>`, drift since the write-back, phases
  unreviewed above the three-phase floor and silence below it, and a missing
  final review at every size. Ids past the cap collapse to `(+N more)`. A DROP
  ignores pending tasks and names ACTIVE ones as half-built, while asking every
  other question unchanged. Nothing is refused: both surfaces close and both
  return the findings — `sofar_close_initiative` in `overrides`, `sofar close`
  as an OVERRIDDEN block — the event carries them, `sofar status` renders them
  under `Status:` forever, the SessionStart closed banner names up to three and
  points at `sofar status` for the rest while staying byte-identical to before
  on a clean close, reopening clears them, an unknown `overrides` value fails
  validation, and an older engine folds a close carrying them without a
  warning.
