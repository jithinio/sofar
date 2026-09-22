//! The lexicon tier (`core/index-lexicon.ts`, memory-lead 3.1, D15; mirrored
//! as rust-core 2.11): every decision, note and stall handoff in the repo as
//! BM25 postings, so the prompt hook ranks the whole record without
//! tokenizing any of it.
//!
//! Three parts under one `gen`, stamped shards first and the doc table last:
//! `lexicon.json` (the doc table the incremental pass maintains, read every
//! prompt), `lexicon-p<nn>.json` (postings in 32 FNV-1a shards, a query reads
//! its own terms' shards) and `lexicon-h.json` (render heads, read only when a
//! line renders). A shard whose gen differs from the table's is stale: the
//! reader drops the table and falls back, and the next refresh rebuilds all
//! three. The bytes are the TypeScript writer's, so either implementation
//! extends the other's tier.

use std::collections::{HashMap, HashSet};
use std::fmt::Write as _;

use crate::index_pass::{PassResult, SlugReducer, pass_over_record};
use crate::index_store::{INDEX_SCHEMA_VERSION, read_index_file, write_index_file};
use crate::index_tail::IndexedEvent;
use crate::index_tier1::superseded_ordinal;
use crate::js_math::js_log;
use crate::json::{Json, Object, number_to_string, usize_to_f64};
use crate::layout::Layout;
use crate::lexicon::{lexical_counts, query_terms};
use crate::text::{cmp_utf16, js_trim, one_line, utf16_prefix};

const LEXICON_FILE: &str = "lexicon.json";
const LEXICON_META: &str = "meta-lexicon.json";
const HEADS_FILE: &str = "lexicon-h.json";

/// Postings shards. A power of two, so the hash's low bits pick one.
pub const LEXICON_BUCKETS: u32 = 32;
/// Prose per doc tokenized — the fold path's `LESSON_DOC_CHARS`.
pub const LEXICON_DOC_CHARS: usize = 1_200;
/// What a doc keeps to render.
pub const LEXICON_HEAD_CHARS: usize = 200;

const K1: f64 = 1.2;
const B: f64 = 0.75;

/// A doc indexed in this refresh, waiting to be written to the shards.
#[derive(Debug, Clone, PartialEq)]
struct Pending {
    at: usize,
    counts: Vec<(String, f64)>,
    over: HashSet<String>,
    /// `chose \t over` for a decision, `text \t session` otherwise.
    heads: String,
}

/// One initiative's doc table (`SlugLexiconState`). `docs` is one line per
/// doc, `k \t id \t ts \t len \t n \t until('1'|'')`.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct SlugLexiconState {
    decisions: f64,
    ids: Vec<String>,
    ruled: String,
    superseded: Vec<f64>,
    count: f64,
    tokens: f64,
    docs: String,
    /// Per-refresh bookkeeping, never serialized: what this pass indexed.
    pending: Vec<Pending>,
    /// Rebuilt from empty in this pass — its old postings must go.
    fresh: bool,
}

impl SlugLexiconState {
    fn to_json(&self) -> Json {
        let mut o = Object::with_capacity(7);
        o.insert("decisions", Json::Num(self.decisions));
        o.insert(
            "ids",
            Json::Arr(self.ids.iter().map(|i| Json::Str(i.clone())).collect()),
        );
        o.insert("ruled", Json::Str(self.ruled.clone()));
        o.insert(
            "superseded",
            Json::Arr(self.superseded.iter().map(|n| Json::Num(*n)).collect()),
        );
        o.insert("count", Json::Num(self.count));
        o.insert("tokens", Json::Num(self.tokens));
        o.insert("docs", Json::Str(self.docs.clone()));
        Json::Obj(o)
    }

    /// `isSlugState`, then the fields.
    fn from_json(v: &Json) -> Option<Self> {
        let o = v.as_obj()?;
        Some(Self {
            decisions: o.get("decisions")?.as_f64()?,
            ids: o
                .get("ids")?
                .as_arr()?
                .iter()
                .map(|i| i.as_str().map(str::to_owned))
                .collect::<Option<_>>()?,
            ruled: o.get("ruled")?.as_str()?.to_owned(),
            superseded: o
                .get("superseded")?
                .as_arr()?
                .iter()
                .map(Json::as_f64)
                .collect::<Option<_>>()?,
            count: o.get("count")?.as_f64()?,
            tokens: o.get("tokens")?.as_f64()?,
            docs: o.get("docs")?.as_str()?.to_owned(),
            pending: Vec::new(),
            fresh: false,
        })
    }
}

/// `head`: one line, clipped to what a lesson line can show.
fn head(text: &str) -> String {
    utf16_prefix(&one_line(text), LEXICON_HEAD_CHARS)
}

fn str_of<'a>(event: &'a IndexedEvent, key: &str) -> Option<&'a str> {
    event.payload.get(key).and_then(Json::as_str)
}

/// `isStall`: a stall handoff with a detail worth reading.
fn stall_detail(event: &IndexedEvent) -> Option<&str> {
    if str_of(event, "reason") != Some("stall") {
        return None;
    }
    str_of(event, "detail").filter(|d| !js_trim(d).is_empty())
}

struct DecisionDoc {
    n: f64,
    until: bool,
    over: HashSet<String>,
}

/// `index`.
fn index(
    state: &mut SlugLexiconState,
    event: &IndexedEvent,
    kind: char,
    heads: (&str, &str),
    prose: &str,
    decision: Option<DecisionDoc>,
) {
    let counts = lexical_counts(prose);
    let len: f64 = counts.iter().map(|(_, n)| n).sum();
    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "count is a small non-negative integer"
    )]
    let at = state.count as usize;
    let (n, until, over) = match decision {
        Some(d) => (number_to_string(d.n), d.until, d.over),
        None => (String::new(), false, HashSet::new()),
    };
    state.pending.push(Pending {
        at,
        counts,
        over,
        heads: format!("{}\t{}", heads.0, heads.1),
    });
    let _ = writeln!(
        state.docs,
        "{kind}\t{}\t{}\t{}\t{n}\t{}",
        event.id,
        event.ts,
        number_to_string(len),
        if until { "1" } else { "" }
    );
    state.count += 1.0;
    state.tokens += len;
}

struct LexiconReducer;

impl SlugReducer for LexiconReducer {
    type State = SlugLexiconState;

    fn empty(&self) -> SlugLexiconState {
        SlugLexiconState {
            fresh: true,
            ..SlugLexiconState::default()
        }
    }

    fn relevant(&self, event: &IndexedEvent) -> bool {
        match event.event_type.as_str() {
            "decision_logged" | "note_added" => true,
            "handoff" => stall_detail(event).is_some(),
            _ => false,
        }
    }

    fn apply(&self, state: &mut SlugLexiconState, event: &IndexedEvent, _slug: &str) {
        match event.event_type.as_str() {
            "decision_logged" => {
                let p = &event.payload;
                // Counted before anything can skip: `D<n>` is a position among ALL decisions.
                state.decisions += 1.0;
                let ordinal = state.decisions;
                let ruled = p.get("rule").and_then(Json::as_str).is_some();
                state.ruled.push(if ruled { '1' } else { '0' });
                state.ids.push(event.id.clone());
                // The fold's rule: backward only, and a ruled target falls
                // only to a ruled superseder.
                if let Some(handle) = p.get("supersedes").and_then(Json::as_str)
                    && let Some(n) = superseded_ordinal(p, handle, state.ids.len(), &state.ids)
                    && n.fract() == 0.0
                    && n >= 1.0
                    && n < ordinal
                {
                    #[allow(
                        clippy::cast_possible_truncation,
                        clippy::cast_sign_loss,
                        reason = "1 <= n < ordinal"
                    )]
                    let at = n as usize - 1;
                    let marked = state.superseded.contains(&n);
                    if (state.ruled.as_bytes().get(at) != Some(&b'1') || ruled) && !marked {
                        state.superseded.push(n);
                        state.superseded.sort_by(f64::total_cmp);
                    }
                }
                let (Some(chose), Some(over)) = (
                    p.get("chose").and_then(Json::as_str),
                    p.get("over").and_then(Json::as_str),
                ) else {
                    return;
                };
                let because = p.get("because").and_then(Json::as_str).unwrap_or("");
                let prose = utf16_prefix(&format!("{chose} {over} {because}"), LEXICON_DOC_CHARS);
                let over_terms = lexical_counts(&utf16_prefix(over, LEXICON_DOC_CHARS))
                    .into_iter()
                    .map(|(t, _)| t)
                    .collect();
                let until = p.get("until").and_then(Json::as_str).is_some();
                index(
                    state,
                    event,
                    'd',
                    (&head(chose), &head(over)),
                    &prose,
                    Some(DecisionDoc {
                        n: ordinal,
                        until,
                        over: over_terms,
                    }),
                );
            }
            "note_added" => {
                let Some(text) = str_of(event, "text") else {
                    return;
                };
                if js_trim(text).is_empty() {
                    return;
                }
                let prose = utf16_prefix(text, LEXICON_DOC_CHARS);
                index(state, event, 'n', (&head(text), ""), &prose, None);
            }
            "handoff" => {
                let Some(detail) = stall_detail(event) else {
                    return;
                };
                // `${p.session_id}`: the schema requires it.
                let session = str_of(event, "session_id").unwrap_or("undefined");
                let prose = utf16_prefix(detail, LEXICON_DOC_CHARS);
                index(state, event, 'f', (&head(detail), session), &prose, None);
            }
            _ => {}
        }
    }
}

/// `lexiconBucket`: FNV-1a over the term's UTF-8 bytes, masked to the
/// shard count — bytes, so both implementations agree.
#[must_use]
pub fn lexicon_bucket(term: &str) -> u32 {
    let mut h: u32 = 0x811c_9dc5;
    for byte in term.bytes() {
        h ^= u32::from(byte);
        h = h.wrapping_mul(0x0100_0193);
    }
    h & (LEXICON_BUCKETS - 1)
}

fn bucket_file(bucket: u32) -> String {
    format!("lexicon-p{bucket:02}.json")
}

fn shard_names() -> Vec<String> {
    (0..LEXICON_BUCKETS)
        .map(bucket_file)
        .chain(std::iter::once(HEADS_FILE.to_owned()))
        .collect()
}

/// `isShardDisk`: the generation and the per-initiative strings.
fn read_shard(layout: &Layout, name: &str) -> Option<(String, Object)> {
    let disk = read_index_file(layout, name)?;
    let o = disk.as_obj()?;
    if o.get("version") != Some(&Json::Num(INDEX_SCHEMA_VERSION)) {
        return None;
    }
    let generation = o.get("gen")?.as_str()?.to_owned();
    let initiatives = o.get("initiatives")?.as_obj()?;
    if !initiatives.iter().all(|(_, v)| v.as_str().is_some()) {
        return None;
    }
    Some((generation, initiatives.clone()))
}

/// `isLexiconDisk`: the table's generation and every slug's state, or nothing — one
/// malformed slug cold-starts the whole tier, as the TypeScript reader does.
fn read_table(layout: &Layout) -> Option<(String, Vec<(String, SlugLexiconState)>)> {
    let disk = read_index_file(layout, LEXICON_FILE)?;
    let o = disk.as_obj()?;
    if o.get("version") != Some(&Json::Num(INDEX_SCHEMA_VERSION)) {
        return None;
    }
    let generation = o.get("gen")?.as_str()?.to_owned();
    let initiatives = o.get("initiatives")?.as_obj()?;
    let mut states = Vec::with_capacity(initiatives.len());
    for (slug, value) in initiatives.js_ordered() {
        states.push((slug.to_owned(), SlugLexiconState::from_json(value)?));
    }
    Some((generation, states))
}

/// Drop the doc table so the next refresh rebuilds every part. Silent.
fn invalidate(layout: &Layout) {
    for name in [LEXICON_FILE, LEXICON_META] {
        let _ = std::fs::remove_file(layout.index_dir().join(name));
    }
}

/// `n.toString(36)` for a non-negative integer.
fn base36(mut n: u128) -> String {
    const DIGITS: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    if n == 0 {
        return "0".to_owned();
    }
    let mut out = Vec::new();
    while n > 0 {
        out.push(DIGITS[(n % 36) as usize]);
        n /= 36;
    }
    out.reverse();
    String::from_utf8(out).expect("ascii")
}

fn f64_base36(n: f64) -> String {
    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "non-negative integers: doc numbers and term counts"
    )]
    base36(n as u128)
}

/// `newGen`: opaque, unique enough that two writers never share one.
fn new_gen() -> String {
    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "now_ms is a positive integer-valued double"
    )]
    let ms = crate::date::now_ms() as u128;
    // A ulid's last 8 characters are random bits (Crockford base 32).
    let id = crate::envelope::mint_ulid(std::time::SystemTime::now()).to_lowercase();
    format!("{}-{}", base36(ms), &id[id.len() - 8..])
}

/// `postingsMap`.
fn postings_map(text: &str) -> HashMap<String, String> {
    let mut map = HashMap::new();
    for line in text.split('\n') {
        if let Some(tab) = line.find('\t')
            && tab > 0
        {
            map.insert(line[..tab].to_owned(), line[tab + 1..].to_owned());
        }
    }
    map
}

/// `postingsText`: a leading newline makes `\n<term>\t` a unique needle.
fn postings_text(map: &HashMap<String, String>) -> String {
    let mut terms: Vec<&String> = map.keys().collect();
    terms.sort_by(|a, b| cmp_utf16(a, b));
    let mut out = String::from("\n");
    for term in terms {
        out.push_str(term);
        out.push('\t');
        out.push_str(&map[term]);
        out.push('\n');
    }
    out
}

/// The states in `Object.entries` order: array-index slugs first, ascending.
fn js_entries(states: &[(String, SlugLexiconState)]) -> Vec<&(String, SlugLexiconState)> {
    let mut o = Object::with_capacity(states.len());
    for (i, (slug, _)) in states.iter().enumerate() {
        o.insert(slug.clone(), Json::Num(usize_to_f64(i)));
    }
    o.js_ordered()
        .into_iter()
        .filter_map(|(_, i)| {
            #[allow(
                clippy::cast_possible_truncation,
                clippy::cast_sign_loss,
                reason = "an index this function stored"
            )]
            i.as_f64().map(|i| &states[i as usize])
        })
        .collect()
}

/// `writeShards`: what this refresh indexed, into the shards and heads,
/// under a new generation. False when the old shards cannot be trusted to extend.
fn write_shards(
    layout: &Layout,
    states: &[(String, SlugLexiconState)],
    old_gen: Option<&str>,
    generation: &str,
) -> bool {
    let names = shard_names();
    let all_fresh = states.iter().all(|(_, s)| s.fresh);
    let mut shards: Vec<Object> = Vec::with_capacity(names.len());
    for name in &names {
        if all_fresh {
            shards.push(Object::new());
            continue;
        }
        let Some((disk_gen, disk)) = read_shard(layout, name) else {
            return false;
        };
        if Some(disk_gen.as_str()) != old_gen {
            return false;
        }
        // An initiative that vanished leaves every shard with it.
        let mut kept = Object::with_capacity(disk.len());
        for (slug, text) in disk.js_ordered() {
            if states.iter().any(|(s, _)| s == slug) {
                kept.insert(slug, text.clone());
            }
        }
        shards.push(kept);
    }
    let heads_at = names.len() - 1;
    for (slug, state) in js_entries(states) {
        if state.fresh {
            for shard in &mut shards {
                shard.remove(slug);
            }
        }
        if state.pending.is_empty() {
            continue;
        }
        let mut heads = shards[heads_at]
            .get(slug)
            .and_then(Json::as_str)
            .unwrap_or("")
            .to_owned();
        for d in &state.pending {
            heads.push_str(&d.heads);
            heads.push('\n');
        }
        shards[heads_at].insert(slug.clone(), Json::Str(heads));
        let mut by_bucket: Vec<(u32, Vec<(&str, String)>)> = Vec::new();
        for d in &state.pending {
            let at = base36(d.at as u128);
            for (term, tf) in &d.counts {
                let b = lexicon_bucket(term);
                let entry = format!(
                    "{at}:{}{}",
                    f64_base36(*tf),
                    if d.over.contains(term) { "!" } else { "" }
                );
                match by_bucket.iter_mut().find(|(x, _)| *x == b) {
                    Some((_, rows)) => rows.push((term, entry)),
                    None => by_bucket.push((b, vec![(term, entry)])),
                }
            }
        }
        for (b, rows) in by_bucket {
            let file = &mut shards[b as usize];
            let mut map = postings_map(file.get(slug).and_then(Json::as_str).unwrap_or(""));
            for (term, entry) in rows {
                match map.get_mut(term) {
                    Some(list) => {
                        list.push(',');
                        list.push_str(&entry);
                    }
                    None => {
                        map.insert(term.to_owned(), entry);
                    }
                }
            }
            file.insert(slug.clone(), Json::Str(postings_text(&map)));
        }
    }
    for (name, initiatives) in names.iter().zip(shards) {
        let mut o = Object::with_capacity(3);
        o.insert("version", Json::Num(INDEX_SCHEMA_VERSION));
        o.insert("gen", Json::Str(generation.to_owned()));
        o.insert("initiatives", Json::Obj(initiatives));
        write_index_file(layout, name, &Json::Obj(o));
    }
    true
}

/// A shard did not match the doc table (`LexiconStale`); the caller falls back.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LexiconStale;

/// The tier as a reader holds it: the doc table, plus shards loaded on first use.
#[derive(Debug)]
pub struct LexiconIndex<'a> {
    generation: String,
    initiatives: Vec<(String, SlugLexiconState)>,
    layout: &'a Layout,
    loaded: HashMap<String, Object>,
}

/// `refreshLexicon`: bring the tier up to date. Rewrites anything only when a
/// decision, note or stall handoff arrived (the reducer's `relevant`).
///
/// # Errors
/// [`LexiconStale`] when the shards could not be trusted even after a rebuild.
pub fn refresh_lexicon(layout: &Layout) -> Result<LexiconIndex<'_>, LexiconStale> {
    refresh(layout, true)
}

fn refresh(layout: &Layout, retry: bool) -> Result<LexiconIndex<'_>, LexiconStale> {
    let prior = read_table(layout);
    let PassResult {
        mut states,
        state_changed,
        ..
    } = pass_over_record(
        layout,
        LEXICON_META,
        prior.as_ref().map(|(_, s)| s.as_slice()),
        &LexiconReducer,
    );
    let mut generation = prior.as_ref().map_or_else(String::new, |(g, _)| g.clone());
    if state_changed {
        let next = new_gen();
        if !write_shards(
            layout,
            &states,
            prior.as_ref().map(|(g, _)| g.as_str()),
            &next,
        ) {
            invalidate(layout);
            return if retry {
                refresh(layout, false)
            } else {
                Err(LexiconStale)
            };
        }
        let mut initiatives = Object::with_capacity(states.len());
        for (slug, state) in &states {
            initiatives.insert(slug.clone(), state.to_json());
        }
        let mut o = Object::with_capacity(3);
        o.insert("version", Json::Num(INDEX_SCHEMA_VERSION));
        o.insert("gen", Json::Str(next.clone()));
        o.insert("initiatives", Json::Obj(initiatives));
        write_index_file(layout, LEXICON_FILE, &Json::Obj(o));
        generation = next;
    }
    for (_, state) in &mut states {
        state.pending.clear();
    }
    Ok(LexiconIndex {
        generation,
        initiatives: states,
        layout,
        loaded: HashMap::new(),
    })
}

/// One doc, decoded from its line (`LexiconDoc`).
#[derive(Debug, Clone, PartialEq)]
pub struct LexiconDoc {
    /// `d` decision, `n` note, `f` a stall handoff's detail.
    pub k: String,
    /// Envelope id — the told key.
    pub id: String,
    pub ts: String,
    pub len: f64,
    /// Decision ordinal — the `D<n>` handle.
    pub n: Option<f64>,
    pub until: bool,
}

/// `Number(s)` for the doc table's numeric fields.
fn js_number(s: &str) -> f64 {
    let t = js_trim(s);
    if t.is_empty() {
        return 0.0;
    }
    t.parse::<f64>().unwrap_or(f64::NAN)
}

/// `docsOf`.
fn docs_of(state: &SlugLexiconState) -> Vec<LexiconDoc> {
    let mut out = Vec::new();
    for line in state.docs.split('\n') {
        if line.is_empty() {
            continue;
        }
        let mut f = line.split('\t');
        let k = f.next().unwrap_or("").to_owned();
        let id = f.next().unwrap_or("").to_owned();
        let ts = f.next().unwrap_or("").to_owned();
        let len = f.next().map_or(f64::NAN, js_number);
        let n = f.next().filter(|n| !n.is_empty()).map(js_number);
        let until = f.next() == Some("1");
        out.push(LexiconDoc {
            k,
            id,
            ts,
            len,
            n,
            until,
        });
    }
    out
}

/// What a doc renders (`LexiconHeads`).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct LexiconHeads {
    pub chose: Option<String>,
    pub over: Option<String>,
    pub text: Option<String>,
    pub session: Option<String>,
}

impl LexiconIndex<'_> {
    /// `shard`: a shard file, cached; a generation mismatch drops the table.
    fn shard(&mut self, name: &str) -> Result<&Object, LexiconStale> {
        if !self.loaded.contains_key(name) {
            match read_shard(self.layout, name) {
                Some((generation, initiatives)) if generation == self.generation => {
                    self.loaded.insert(name.to_owned(), initiatives);
                }
                _ => {
                    invalidate(self.layout);
                    return Err(LexiconStale);
                }
            }
        }
        Ok(&self.loaded[name])
    }

    fn state(&self, slug: &str) -> Option<&SlugLexiconState> {
        self.initiatives
            .iter()
            .find(|(s, _)| s == slug)
            .map(|(_, st)| st)
    }

    /// `lexiconHeads`: empty when the tier has no such doc.
    ///
    /// # Errors
    /// [`LexiconStale`] when the heads file does not match the table.
    pub fn heads(&mut self, slug: &str, doc: &LexiconDoc) -> Result<LexiconHeads, LexiconStale> {
        let Some(state) = self.state(slug) else {
            return Ok(LexiconHeads::default());
        };
        let Some(at) = docs_of(state).iter().position(|d| d.id == doc.id) else {
            return Ok(LexiconHeads::default());
        };
        let heads = self.shard(HEADS_FILE)?;
        let text = heads.get(slug).and_then(Json::as_str).unwrap_or("");
        let Some(line) = text.split('\n').nth(at) else {
            return Ok(LexiconHeads::default());
        };
        let mut parts = line.split('\t');
        let a = parts.next().unwrap_or("").to_owned();
        let b = parts.next().unwrap_or("").to_owned();
        Ok(if doc.k == "d" {
            LexiconHeads {
                chose: Some(a),
                over: Some(b),
                ..LexiconHeads::default()
            }
        } else {
            LexiconHeads {
                text: Some(a),
                session: (!b.is_empty()).then_some(b),
                ..LexiconHeads::default()
            }
        })
    }

    /// `lexiconSuperseded`.
    #[must_use]
    pub fn superseded(&self, slug: &str, ordinal: f64) -> bool {
        self.state(slug)
            .is_some_and(|s| s.superseded.contains(&ordinal))
    }
}

/// A ranked doc (`LexiconMatch`).
#[derive(Debug, Clone, PartialEq)]
pub struct LexiconMatch {
    pub slug: String,
    pub doc: LexiconDoc,
    pub score: f64,
    /// The asker's words this doc carried, strongest first.
    pub terms: Vec<String>,
    /// Share of the score carried by words in the decision's `over`.
    pub over_share: f64,
}

struct Posting {
    at: f64,
    tf: f64,
    over: bool,
}

/// `parseInt(s, 36)`: leading whitespace, a sign, then base-36 digits for as
/// long as they run; NaN when there are none.
fn parse_int36(s: &str) -> f64 {
    let t = s.trim_start_matches(crate::text::is_js_whitespace);
    let (sign, digits) = match t.as_bytes().first() {
        Some(b'-') => (-1.0, &t[1..]),
        Some(b'+') => (1.0, &t[1..]),
        _ => (1.0, t),
    };
    let mut value = 0.0f64;
    let mut any = false;
    for c in digits.chars() {
        let Some(d) = c.to_digit(36) else { break };
        value = value * 36.0 + f64::from(d);
        any = true;
    }
    if any { sign * value } else { f64::NAN }
}

/// `postingsFor`: one term's entries; empty when the term is absent.
fn postings_for(text: &str, term: &str) -> Vec<Posting> {
    let needle = format!("\n{term}\t");
    let Some(start) = text.find(&needle) else {
        return Vec::new();
    };
    let from = start + needle.len();
    let end = text[from..].find('\n').map_or(text.len(), |e| from + e);
    let mut rows = Vec::new();
    // A malformed entry is skipped, never fatal: the tier is derived state.
    for entry in text[from..end].split(',') {
        let Some(colon) = entry.find(':') else {
            continue;
        };
        if colon == 0 {
            continue;
        }
        let over = entry.ends_with('!');
        let at = parse_int36(&entry[..colon]);
        let tf_text = &entry[colon + 1..];
        let tf = parse_int36(if over {
            &tf_text[..tf_text.len() - 1]
        } else {
            tf_text
        });
        let integer = |n: f64| n.is_finite() && n.fract() == 0.0;
        if integer(at) && integer(tf) && tf > 0.0 {
            rows.push(Posting { at, tf, over });
        }
    }
    rows
}

/// One slug's postings for the asked terms, in the order the TypeScript Map fills.
type SlugPostings<'t> = (String, Vec<(&'t str, Vec<Posting>)>);
/// One term's contribution to a doc: the term, its weight, whether it is in `over`.
type Hit<'t> = (&'t str, f64, bool);

/// The asked terms' postings per slug, and each term's document frequency.
fn gather<'t>(
    index: &mut LexiconIndex<'_>,
    wanted: &[&'t str],
    slugs: &[String],
) -> Result<(Vec<SlugPostings<'t>>, HashMap<&'t str, f64>), LexiconStale> {
    let mut df: HashMap<&str, f64> = HashMap::new();
    let mut found: Vec<SlugPostings<'t>> = Vec::new();
    for term in wanted {
        let file = index.shard(&bucket_file(lexicon_bucket(term)))?;
        for slug in slugs {
            let Some(text) = file.get(slug).and_then(Json::as_str) else {
                continue;
            };
            let rows = postings_for(text, term);
            if rows.is_empty() {
                continue;
            }
            *df.entry(term).or_insert(0.0) += usize_to_f64(rows.len());
            match found.iter_mut().find(|(s, _)| s == slug) {
                Some((_, terms)) => terms.push((term, rows)),
                None => found.push((slug.clone(), vec![(term, rows)])),
            }
        }
    }
    Ok((found, df))
}

/// One doc's match from its hits: strongest first, summed in that order.
fn scored(
    slug: &str,
    doc: &LexiconDoc,
    mut hit: Vec<Hit<'_>>,
    asked: &[(String, String)],
) -> LexiconMatch {
    hit.sort_by(|a, b| {
        b.1.partial_cmp(&a.1)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| cmp_utf16(a.0, b.0))
    });
    let score = hit.iter().fold(0.0, |sum, h| sum + h.1);
    let over = hit
        .iter()
        .fold(0.0, |sum, h| sum + if h.2 { h.1 } else { 0.0 });
    LexiconMatch {
        slug: slug.to_owned(),
        doc: doc.clone(),
        score,
        terms: hit
            .iter()
            .map(|(t, _, _)| {
                asked
                    .iter()
                    .find(|(f, _)| f == t)
                    .map_or_else(|| (*t).to_owned(), |(_, w)| w.clone())
            })
            .collect(),
        over_share: if score > 0.0 { over / score } else { 0.0 },
    }
}

/// `rankLexicon`: BM25 over the postings, ordered by score, then newest, then
/// slug and id. `keep` filters after scoring, so what a caller drops never
/// changes another doc's score. Returns the matches and the corpus size.
///
/// # Errors
/// [`LexiconStale`] when a shard does not match the doc table.
pub fn rank_lexicon(
    index: &mut LexiconIndex<'_>,
    query: &str,
    keep: impl Fn(&LexiconIndex<'_>, &str, &LexiconDoc) -> bool,
) -> Result<(Vec<LexiconMatch>, f64), LexiconStale> {
    let asked = query_terms(query);
    let mut wanted: Vec<&str> = asked.iter().map(|(t, _)| t.as_str()).collect();
    wanted.sort_by(|a, b| cmp_utf16(a, b));
    let mut slugs: Vec<String> = index.initiatives.iter().map(|(s, _)| s.clone()).collect();
    slugs.sort_by(|a, b| cmp_utf16(a, b));
    // Summed in slug order, as the TypeScript loop sums them.
    let (mut n, mut tokens) = (0.0, 0.0);
    for slug in &slugs {
        let state = index.state(slug).expect("listed");
        n += state.count;
        tokens += state.tokens;
    }
    if wanted.is_empty() || n == 0.0 {
        return Ok((Vec::new(), n));
    }
    let (found, df) = gather(index, &wanted, &slugs)?;
    let average = tokens / n;
    let idf: HashMap<&str, f64> = df
        .iter()
        .map(|(term, count)| (*term, js_log(1.0 + (n - count + 0.5) / (count + 0.5))))
        .collect();

    let mut out: Vec<LexiconMatch> = Vec::new();
    for (slug, terms) in &found {
        let docs = docs_of(index.state(slug).expect("found"));
        // Doc position → hits, in first-seen order.
        let mut hits: Vec<(usize, Vec<Hit<'_>>)> = Vec::new();
        // Doc position → its slot in `hits`: a common term has thousands of
        // postings in one record, and a scan per posting is quadratic.
        let mut slot: HashMap<usize, usize> = HashMap::new();
        for (term, rows) in terms {
            for p in rows {
                #[allow(
                    clippy::cast_possible_truncation,
                    clippy::cast_sign_loss,
                    reason = "negative or huge positions miss the table below"
                )]
                let at = if p.at >= 0.0 {
                    p.at as usize
                } else {
                    usize::MAX
                };
                let Some(doc) = docs.get(at) else { continue };
                let damp = K1 * (1.0 - B + (B * doc.len) / average);
                let weight = idf[term] * ((p.tf * (K1 + 1.0)) / (p.tf + damp));
                if let Some(&i) = slot.get(&at) {
                    hits[i].1.push((term, weight, p.over));
                } else {
                    slot.insert(at, hits.len());
                    hits.push((at, vec![(term, weight, p.over)]));
                }
            }
        }
        for (at, hit) in hits {
            if keep(index, slug, &docs[at]) {
                out.push(scored(slug, &docs[at], hit, &asked));
            }
        }
    }
    #[allow(
        clippy::float_cmp,
        reason = "a tie is exactly a tie, as in the TypeScript comparator"
    )]
    out.sort_by(|a, b| {
        if a.score != b.score {
            return b
                .score
                .partial_cmp(&a.score)
                .unwrap_or(std::cmp::Ordering::Equal);
        }
        if a.doc.ts != b.doc.ts {
            return cmp_utf16(&b.doc.ts, &a.doc.ts);
        }
        cmp_utf16(&a.slug, &b.slug).then_with(|| cmp_utf16(&a.doc.id, &b.doc.id))
    });
    Ok((out, n))
}

#[cfg(test)]
#[allow(clippy::float_cmp, reason = "exact integers")]
mod tests {
    use super::*;

    #[test]
    fn buckets_are_pinned_with_the_typescript_writer() {
        // index-lexicon.test.ts pins these: FNV-1a over UTF-8 bytes, 5 bits.
        assert_eq!(lexicon_bucket("index"), 11);
        assert_eq!(lexicon_bucket("cursor"), 15);
        assert_eq!(lexicon_bucket("localecompare"), 6);
        assert_eq!(lexicon_bucket("graph.json"), 9);
        assert_eq!(lexicon_bucket("café"), 9);
    }

    #[test]
    fn base36_and_parse_int_round_trip() {
        assert_eq!(base36(0), "0");
        assert_eq!(base36(35), "z");
        assert_eq!(base36(36), "10");
        assert_eq!(parse_int36("10"), 36.0);
        assert_eq!(parse_int36("z!"), 35.0);
        assert!(parse_int36("").is_nan());
        assert!(parse_int36("!").is_nan());
        assert_eq!(parse_int36("-1"), -1.0);
    }

    #[test]
    fn postings_text_sorts_by_code_unit_and_reads_back() {
        let mut map = HashMap::new();
        map.insert("b".to_owned(), "0:1".to_owned());
        map.insert("a".to_owned(), "1:2!,3:1".to_owned());
        let text = postings_text(&map);
        assert_eq!(text, "\na\t1:2!,3:1\nb\t0:1\n");
        let rows = postings_for(&text, "a");
        assert_eq!(rows.len(), 2);
        assert!(rows[0].over && rows[0].at == 1.0 && rows[0].tf == 2.0);
        assert!(postings_for(&text, "c").is_empty());
    }
}
