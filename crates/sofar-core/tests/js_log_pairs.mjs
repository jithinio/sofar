// Pairs for tests/js_log_crosscheck.rs: `<x bits> <Math.log(x) bits>` per
// line, hex, from THIS machine's Node — Math.log is fdlibm compiled with the
// target's contraction, so each target proves against its own Node.
// Deterministic: the inputs are BM25's own shapes plus a seeded sweep.
//   node crates/sofar-core/tests/js_log_pairs.mjs > pairs.txt
const f64 = new Float64Array(1)
const u64 = new BigUint64Array(f64.buffer)
const bits = (x) => {
  f64[0] = x
  return u64[0].toString(16)
}
const lines = []
const push = (x) => lines.push(`${bits(x)} ${bits(Math.log(x))}`)
// idf: 1 + (n - df + 0.5) / (df + 0.5), as core/lexicon.ts and core/index-lexicon.ts compute it.
for (let n = 1; n <= 3000; n++) for (let df = 1; df <= n; df += Math.max(1, Math.floor(n / 50))) push(1 + (n - df + 0.5) / (df + 0.5))
// The lessons floor: 1 + (N - 0.5) / 1.5 (core/lessons.ts indexFloor).
for (let n = 1; n <= 100_000; n++) push(1 + (n - 0.5) / 1.5)
// A seeded sweep (xorshift64*): [1, 2), then wide magnitudes, then edges.
let s = 0x9e3779b97f4a7c15n
const next = () => {
  s ^= s >> 12n
  s ^= (s << 25n) & 0xffffffffffffffffn
  s ^= s >> 27n
  return ((s * 0x2545f4914f6cdd1dn) & 0xffffffffffffffffn) >> 11n
}
for (let i = 0; i < 100_000; i++) push(1 + Number(next()) / 2 ** 53)
for (let i = 0; i < 100_000; i++) push((Number(next()) / 2 ** 53) * 10 ** ((i % 40) - 20))
for (const x of [0, -0, -1, 1, Infinity, NaN, 5e-324, 2.2250738585072014e-308, Number.MAX_VALUE, Math.E, 2, 0.5]) push(x)
process.stdout.write(`${lines.join('\n')}\n`)
