import { readIndexFile, writeIndexFile } from './index-store'

/**
 * Per-session ref-movement marks — the gate that makes the live shipping
 * signal affordable (commit-attribution 3.4, D11).
 *
 * The problem 3.2 left open: the SessionStart notice fires ONCE, so a window
 * already running when a sibling pushes learns nothing until it restarts. That
 * is the user's original complaint, still open in exactly the case they
 * described. Answering it per prompt means asking "did MY commits reach
 * origin", and that question needs a trailer walk — a subprocess D6 forbids on
 * the hot path outright.
 *
 * The escape D6 was written with is that the expensive answer only CHANGES
 * when a ref moves, and detecting movement is free: origin/<branch> is a file,
 * already read by readGitState with no subprocess. So the hot path compares one
 * sha against the last one this session saw, and the walk is paid only on an
 * actual push. Steady state is a small JSON read and nothing else.
 *
 * The mark lives in the derived index, which is the right home by its own three
 * rules (record-index D1): disposable — losing it costs one missed line, never
 * a wrong one; local, never committed — a mark is about one session on one
 * machine and would conflict on every parallel append; and self-ignoring, so no
 * repo .gitignore has to know. It carries its own version rather than riding
 * INDEX_SCHEMA_VERSION, so a shape change here cold-starts THIS file instead of
 * forcing a full index rebuild.
 *
 * EDGE-TRIGGERED, unlike every other line on that path. The drift nudge and the
 * conflict lines re-fire statelessly because they restate a condition that is
 * still true; this one reports a TRANSITION, and "just landed" repeated ten
 * prompts later is simply false. Marking is therefore a write, and the write is
 * what stops the repeat.
 *
 * CONCURRENCY: sessions share one worktree here, so they share this file. The
 * write is atomic, but a read-modify-write race between two prompts in the same
 * instant REVERTS the loser's mark rather than dropping it — the winner writes
 * back the copy it read, which still carries the loser's OLD sha. So the loser
 * does not read as a first look (silent); it re-detects the same movement and
 * announces the push a second time. Stated plainly because the first version of
 * this comment claimed the opposite, and the difference is the whole
 * edge-trigger property: the race costs a DUPLICATE line, never a missed one,
 * and never a wrong attribution, since a mark is only ever replaced by a sha
 * read from the same refs.
 */

/** Filename inside the index dir. Version lives in the payload, not the name. */
export const SHIPWATCH_FILE = 'shipwatch.json'

/** Bump on ANY change to the on-disk shape — a mismatch cold-starts. */
export const SHIPWATCH_VERSION = 1

/**
 * Marks kept before the oldest are evicted. Sessions are never cleaned up on
 * end (a crashed session ends nothing), so without a cap this grows for the
 * life of the repo. Generous enough that every plausibly-live window keeps its
 * mark; small enough that the file stays a few KB on the hot path.
 */
export const SHIPWATCH_MAX_MARKS = 64

export interface WatchMark {
  /** Branch the mark was taken on — a switch invalidates it (different ref). */
  branch: string
  /**
   * Full sha of origin/<branch> when this session last looked, or null when the
   * ref did not exist then.
   *
   * Null is a WATCHED state, not an unwatchable one, and getting that wrong is
   * what made the first version miss its own headline case: a branch's first
   * push creates the ref, so treating "no upstream" as nothing to watch made
   * the most unambiguous shipping event of all — the work leaving the machine
   * for the first time — the one event that could never be reported.
   */
  upstream: string | null
  /**
   * Write order — the highest on disk plus one. Eviction only; never compared
   * against event time or anything outside this file.
   *
   * A counter rather than a clock, because eviction has to be a total order and
   * a clock is not one here: several marks routinely land inside the same
   * millisecond, and sorting on a tie makes eviction arbitrary — a fresh mark
   * can lose its place to one that has been stale for hours. Deriving the next
   * value from the file also keeps the module free of any clock at all.
   */
  seq: number
}

interface WatchDisk {
  version: number
  marks: Record<string, WatchMark>
}

export interface WatchLook {
  /**
   * The sha this session last saw on this branch. Null carries two different
   * meanings, and `moved` is what separates them: with `moved` false there was
   * no usable mark at all (a first look, a branch switch, an evicted entry),
   * and with `moved` true the ref genuinely did not exist last time — so the
   * range to walk is everything reachable from the new ref, not a delta.
   */
  previous: string | null
  /** True only when a usable mark existed AND the ref differs from it. */
  moved: boolean
}

function isWatchDisk(v: unknown): v is WatchDisk {
  if (typeof v !== 'object' || v === null) return false
  const disk = v as Partial<WatchDisk>
  if (disk.version !== SHIPWATCH_VERSION) return false
  return typeof disk.marks === 'object' && disk.marks !== null
}

const FULL_SHA = /^[0-9a-f]{40}$/

function readMarks(sofarDir: string): Record<string, WatchMark> {
  const disk = readIndexFile<WatchDisk>(sofarDir, SHIPWATCH_FILE, isWatchDisk)
  if (disk === null) return {}
  const clean: Record<string, WatchMark> = {}
  for (const [id, mark] of Object.entries(disk.marks)) {
    if (typeof mark !== 'object' || mark === null) continue
    const m = mark as Partial<WatchMark>
    if (typeof m.branch !== 'string' || m.branch.length === 0) continue
    if (m.upstream !== null && (typeof m.upstream !== 'string' || !FULL_SHA.test(m.upstream))) continue
    if (typeof m.seq !== 'number' || !Number.isFinite(m.seq)) continue
    clean[id] = { branch: m.branch, upstream: m.upstream, seq: m.seq }
  }
  return clean
}

/**
 * Record where origin/<branch> stands for this session, and report what moved
 * since it last looked.
 *
 * Compare-and-mark in one call rather than a read plus a write, because the two
 * halves must see the same file: reading the mark and then writing it back from
 * a second read is how a session announces the same push twice.
 *
 * Writes on every look, not only on change — see the note at the write itself:
 * ordering marks by last LOOK is what stops eviction starving a quiet session.
 *
 * Best-effort throughout — the index writer swallows its own failures — and the
 * two shapes that failure takes are worth stating exactly, because they are
 * opposites. With no mark ever persisted (an unwritable index dir), every look
 * reads as a first look and the caller stays permanently SILENT. With a mark on
 * disk that can no longer be updated, the same movement is re-detected every
 * prompt and the caller REPEATS. Silence is the safe direction and the likelier
 * one; the repeat is the annoying one, and it is bounded by the fact that
 * anything able to write the index again resynchronises on the next look.
 * Neither shape can produce a WRONG attribution, which is the property that
 * matters: a mark is only ever replaced by a sha read from the same refs.
 */
export function noteUpstream(
  sofarDir: string,
  sessionId: string,
  branch: string,
  upstream: string | null,
): WatchLook {
  // A short sha is a display value; accepting one would store a prefix that
  // can go ambiguous later, and an ambiguous rev makes the range error out.
  if (sessionId.length === 0 || branch.length === 0) return { previous: null, moved: false }
  if (upstream !== null && !FULL_SHA.test(upstream)) return { previous: null, moved: false }

  const marks = readMarks(sofarDir)
  const prior = marks[sessionId]
  // A mark taken on another branch describes a different ref entirely, so it
  // is no evidence about this one — treated as a first look, never as movement.
  const usable = prior !== undefined && prior.branch === branch ? prior : undefined

  // Refresh on EVERY look, even when nothing moved, so `seq` orders marks by
  // last LOOK rather than last WRITE. Write-order alone starves the quiet
  // session: one that has seen no push never rewrites, its seq freezes, and
  // SHIPWATCH_MAX_MARKS writes by busier sessions evict a window that is still
  // live — so the push it was waiting for is precisely the one it never hears,
  // its next look reading as a first look and staying silent. That defeats the
  // cap's stated guarantee, and the extra cost is one small write per prompt.
  marks[sessionId] = { branch, upstream, seq: nextSeq(marks) }
  writeIndexFile(sofarDir, SHIPWATCH_FILE, { version: SHIPWATCH_VERSION, marks: evict(marks) })

  if (usable === undefined) return { previous: null, moved: false }
  return usable.upstream === upstream
    ? { previous: upstream, moved: false }
    : { previous: usable.upstream, moved: true }
}

/** One past the highest write order on disk — never reused, never a clock. */
function nextSeq(marks: Record<string, WatchMark>): number {
  let max = 0
  for (const mark of Object.values(marks)) if (mark.seq > max) max = mark.seq
  return max + 1
}

/** Keep the SHIPWATCH_MAX_MARKS most recently written marks; drop the rest. */
function evict(marks: Record<string, WatchMark>): Record<string, WatchMark> {
  const ids = Object.keys(marks)
  if (ids.length <= SHIPWATCH_MAX_MARKS) return marks
  const kept: Record<string, WatchMark> = {}
  for (const id of ids.sort((a, b) => marks[b]!.seq - marks[a]!.seq).slice(0, SHIPWATCH_MAX_MARKS)) {
    kept[id] = marks[id]!
  }
  return kept
}
