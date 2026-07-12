/**
 * Library entry: "@alignlabs/sofar/schema" (library-surface 1.1, L1).
 *
 * The format layer for programmatic consumers (sofar-cloud sync, D11 third
 * parties): the v1 event envelope with its tolerant runtime guard, and every
 * event payload type + validator from the single schema home. Pure
 * re-exports — importing this module executes no CLI code and has no side
 * effects. The guard VALIDATES, it never throws or repairs: skip-and-warn
 * semantics stay the caller's decision, exactly as in the fold.
 */

export {
  ACTORS,
  ENVELOPE_VERSION,
  SOURCES,
  makeEvent,
  validateEnvelope,
  type Actor,
  type EnvelopeError,
  type EnvelopeValidation,
  type EventEnvelope,
  type MakeEventInput,
  type Source,
} from '../core/envelope'

export * from '@sofar/schema'
