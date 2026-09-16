//! sofar's native hot-path core (rust-core D1).
//!
//! Behaviour is defined by `docs/SPEC.md` plus the black-box conformance suite
//! in `packages/engine/test/conformance`, and every byte follows the JavaScript
//! text semantics pinned in `docs/HOTPATH.md` §Text-semantics pins (D2) —
//! never Rust defaults. Payload types come from [`sofar_schema`], generated
//! from `packages/schema/src`.
//!
//! 2.1 lays the workspace down; the modules land task by task:
//! envelope + append (2.2), fold (2.3), digest (2.4), hooks (2.5),
//! statusline (2.6).

pub mod cli;
