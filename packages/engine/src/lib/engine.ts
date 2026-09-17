/**
 * Library entry: "sofar.sh/engine" (library-surface 1.1, L1).
 *
 * The state layer for programmatic consumers: the deterministic, total,
 * ulid-normative fold (EXACTLY what the CLI uses — fold parity is the point,
 * SPEC-v2 Phase 3 prerequisite), the folded-state types and cross-session
 * derivations, and the cursor primitive (the entire sync interface). Pure
 * re-exports — importing this module executes no CLI code and has no side
 * effects.
 */

export {
  ACTIVITY_LIST_CAP,
  emptyState,
  foldLines,
  foldLog,
  freshnessTotal,
  openSessionFileConflicts,
  overlappingWritebacks,
  staleActivePhases,
  type DecisionState,
  type FileConflict,
  type FoldResult,
  type FreshnessState,
  type InitiativeState,
  type NoteEntry,
  type OrphanTaskEvent,
  type ParallelWriteback,
  type PhaseState,
  type SessionActivity,
  type SessionState,
  type StalePhase,
  type TaskState,
} from '../core/fold'

export {
  exportEvents,
  exportNDJSON,
  importNDJSON,
  readEvents,
  readEventsSince,
  type ExportResult,
  type ImportResult,
  type ReadEventsResult,
  type SinceResult,
} from '../core/cursor'

// The incremental fold (r1-fixes 5.1, D20, D21): the same fold, retained as
// a versioned snapshot — `foldAll` once, `fold` per tail, `stateOf` to read.
export {
  currentSchemaHash,
  currentVersion,
  fold,
  foldAll,
  parseSnapshot,
  serializeSnapshot,
  stateOf,
  type FoldRefusal,
  type FoldStep,
  type ParsedSnapshot,
  type Snapshot,
  type SnapshotVersion,
} from '../core/snapshot'

export { serializeEvent } from '../core/log'
