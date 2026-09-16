//! sofar's native hot-path core (rust-core D1).
//!
//! Behaviour is defined by `docs/SPEC.md` plus the black-box conformance suite
//! in `packages/engine/test/conformance`, and every byte follows the JavaScript
//! text semantics pinned in `docs/HOTPATH.md` §Text-semantics pins (D2) —
//! never Rust defaults. Payload types come from [`sofar_schema`], generated
//! from `packages/schema/src`; payload RULES are ported by hand in [`payload`].
//!
//! Modules by task: argv grammar (2.1: [`cli`]); envelope, canonical
//! serializer, JS-semantics JSON, payload validation, identity, append and
//! the tolerant decode, the registration lock (2.2: [`envelope`], [`json`],
//! [`payload`], [`identity`], [`log`], [`lock`], [`layout`]); fold (2.3);
//! digest, projections, full status and record resolution (2.4: [`status`],
//! [`projections`], [`status_cli`], [`resolve`], [`git`]); hooks (2.5);
//! statusline (2.6).

pub mod atomic;
pub mod cli;
pub mod collections;
pub mod derived;
pub mod entropy;
pub mod envelope;
pub mod fold;
pub mod fold_cli;
pub mod git;
pub mod guards;
pub mod identity;
pub mod json;
pub mod layout;
pub mod lock;
pub mod log;
pub mod payload;
pub mod projections;
pub mod resolve;
pub mod sha256;
pub mod snapshot;
pub mod status;
pub mod status_cli;
pub mod text;

#[cfg(test)]
pub(crate) mod testing;
