/**
 * One string order for every shared surface (r1-fixes 5.2, rust-core D6).
 *
 * Two implementations fold one record, and the digest, the tier indexes and
 * the listing all sort paths, slugs and ids before rendering them. Those
 * sorts used `localeCompare`, which is ICU collation: locale-dependent,
 * version-dependent, case-insensitive at its primary level and blind to
 * punctuation — `a-b` and `ab` tie, `readme.md` sorts beside `README.md`.
 * Rust's `str` orders by bytes, which for the strings here is UTF-16 code
 * unit order, and no collation library is worth carrying to disagree with
 * it. No existing fixture exercised the difference (every one is lowercase
 * ASCII, where the orders agree), so nothing failed — the first record with
 * `README.md` beside `readme.md` in two open sessions would have.
 *
 * Code-unit order is also what the fold-parity suite's purity property
 * demands: it reads no locale and no env.
 */

/** Compare two strings by UTF-16 code units — `<`/`>` on strings, as a comparator. */
export function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}
