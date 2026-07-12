/**
 * Library entry: "@alignlabs/sofar/engine" (library-surface 1.1, L1).
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
  type ExportResult,
  type ImportResult,
  type ReadEventsResult,
} from '../core/cursor'

export { serializeEvent } from '../core/log'
