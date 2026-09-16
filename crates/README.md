# sofar Rust workspace (rust-core)

The native hot path: the same CLI and hook contract as the TypeScript
engine, proven by the black-box conformance suite in
`packages/engine/test/conformance` and gated by the perf baseline next to it
(rust-core D1, D5). Toolchain pinned by `rust-toolchain.toml` (1.98.1, edition
2024); runtime crates are exactly serde, serde_json, ulid and lexopt (D9).

| crate | what |
| --- | --- |
| `crates/sofar-schema` | payload types **generated** from `packages/schema/src/events.ts` — never hand-written |
| `crates/sofar-core` | the engine core and the `sofar-core` hook binary (argv grammar 2.1; envelope, JS-semantics JSON, payload rules, append, tolerant decode, registration lock 2.2; fold 2.3, digest 2.4, hooks 2.5, statusline 2.6) |
| `xtask` | developer commands, never shipped: `cargo xtask schema [--check]` |

## Schema codegen

```
packages/schema/src/events.ts
   │  npm run schema:emit          ts-json-schema-generator 2.9.0 (own TypeScript 5.9 — TS 7 has no programmatic API)
   ▼
crates/sofar-schema/schema/events.schema.json     committed; draft-07; rooted at KnownEventPayloads so a new
   │  cargo xtask schema           payload flows through with no list to maintain
   ▼                               typify 0.8, formatted by the pinned rustfmt
crates/sofar-schema/src/generated.rs              committed; `npm run schema:check` / `npm test` fail when stale
```

Shapes are generated; RULES are not. The conditional validation in
`events.ts` (a `note` required when a status is `dropped`, a `guard` needing
its `rule`, `findings` non-empty for a `findings` verdict, integer ranges)
is logic, ported by hand in `sofar-core` and proven by the conformance
goldens, the same way the guard grammar is. Integer fields carry
`@asType integer` in the TypeScript so they generate as `i64`, not `f64`.

```
cargo test --workspace          # unit tests + the fixture round-trip through the generated types
# byte-for-byte cross-check of the envelope path against the TypeScript reference (see canon-pairs.ts):
SOFAR_CANON_PAIRS=/tmp/canon-pairs.tsv cargo test -p sofar-core --test canonical_crosscheck -- --ignored
cargo clippy --workspace --all-targets
cargo build --release -p sofar-core   # target/release/sofar-core
```
