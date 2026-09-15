# Repo memory

Hand-written, repo-scoped notes for agents working here: conventions,
commands, gotchas — anything true of the repo across all initiatives.
Sofar never generates or overwrites this file; initiative state lives in
.sofar/initiatives/<slug>/ instead.

## Boopada repo notes

- Runtimes (boopada M1): `next start` runs on Node 24, `bun test` on Bun. SQLite goes
  through `apps/web/lib/server/db.ts` only (node:sqlite / bun:sqlite loaded at runtime);
  schema changes are new entries appended to `MIGRATIONS`. Web tests call route handlers
  directly with `BOOPADA_DB_PATH` pointing at a temp file.
- Gotchas (boopada M2): `.sofar` is excluded from Biome (generated index JSON fails lint).
  Smoke-test `bun run start` on a random free `PORT` — other local next servers occupy
  fixed ports and curl will hit them silently.
- Dynamic routes (boopada M3): `route<{ params: Promise<{ id: string }> }>(…)`; `route()`
  keeps the context arg optional. `bun run typecheck` includes Next's generated
  `.next/types/validator.ts`, so bad handler signatures fail there (TS2344) even when
  `bun test` passes.
- Deleting (boopada D6): soft delete only, via `softDelete()` in
  `apps/web/lib/server/deletions.ts`; register new entities in its `ENTITIES`.
- Trip dates (boopada M4, D8): a day's index/date are derived from live `trip_days` rows
  in position order (date = start_date + index − 1) — never stored. "Today" for a day is
  judged only in that day's city zone via `apps/web/lib/server/trip-time.ts`
  (`localDate`, `todayIndex`; zones from `getCatalog().timeZones`). Prove server-zone
  independence with `TZ=Pacific/Kiritimati bun test test/trips-api.test.ts`.
- Env: `BOOPADA_DB_PATH` (default `./data/boopada.sqlite`, relative to `apps/web` when
  started there), `BOOPADA_NOW` (ISO timestamp, else system clock), `PORT`.
- Money: `{ amount_minor, currency }` everywhere; convert provider decimal strings with
  `parseDecimal` in `apps/web/lib/money.ts`.
- Pricing (boopada M5): money shown to the traveller is in the profile home currency.
  Get `await getPricing()` (`apps/web/lib/server/pricing.ts`) once per request and pass it
  to sync readers (`getTrip`, `listTrips`, `undoLastDeletion`, ENTITIES loaders); convert
  with `inHome` / `convertMoney` (exact, half-even). Itinerary edits live in
  `apps/web/lib/server/itinerary.ts`; items reference `trip_days.id`, never a day index.
- Totals (boopada phase 5): day/trip totals come only from `tripSummary(trip, pricing)` in
  `apps/web/lib/server/summary.ts` (sum of rounded item `cost`); both
  `GET /api/trips/{id}/summary` and the `/trips/{id}` page use it. The page is two columns:
  left itinerary (`components/itinerary-editor.tsx` + trip total), right `trip-side` aside
  reserved for destination info.
- To-dos (boopada M6, phase 6): `todos` table (migration 5) hangs off `trip_days.id`; all
  logic in `apps/web/lib/server/todos.ts` (`addTodo`, `updateTodo`, `removeTodo` soft via
  ENTITIES "todo", `tripNow`). "Where am I now" (`day_index`, `city_id`, `arrived`, open
  to-dos of every day in that city) comes only from `tripNow(trip)` — used by
  `GET /api/trips/{id}/now` and the `/trips/{id}` arrival banner
  (`components/arrival-banner.tsx`). Adding a field to `TripDay` breaks exact `toEqual`
  day assertions in `test/trips-api.test.ts` and `test/itinerary-api.test.ts`.
- Smoke-test cleanup (M6): stop only the server you started (`lsof -ti tcp:$PORT | xargs
  kill`); never `pkill -f "next start"` — it kills other local next servers too.
- Suggestions & transport (boopada M7, phase 7): every suggester calls `offer(kind,
  storedAction, reason, pricing)` in `apps/web/lib/server/suggestions.ts`; new action types
  go in its `ACTIONS` registry (`resolve()` → `{ok:false, why}` or `{ok:true, action,
  apply}`), so nothing unapplicable is ever returned. Stored actions reference rows by
  stable id (`trip_day_id`); migration 6 `suggestions` keys them by kind + action JSON (same
  proposal → same id). `POST /api/suggestions/{id}/apply` re-resolves (409
  `suggestion_not_applicable`). Shape types + `proposedStartTime` in `apps/web/lib/suggestions.ts`;
  transport costs via `cityTransport()` in `lib/server/transport.ts`. UI: `components/trip-side.tsx`
  (aside) and `components/suggestion-list.tsx` (Add buttons, also in the arrival banner).
  Adding a `TripNow` field breaks exact `toEqual` in `test/todos-api.test.ts`; don't pin
  `user_version` to the latest migration in tests.
- Curation advisor (boopada M8, phase 8): rules live only in `detectAdvice()`
  (`apps/web/lib/server/advisor.ts`, pure, never imports suggestions.ts); `tripAdvice()` in
  `lib/server/suggestions.ts` publishes them through `offer()`. ACTIONS gained `remove_item`,
  `move_item`, `replace_item`. `applySuggestion` re-runs detection for `ADVICE_KINDS`
  (`lib/suggestions.ts`) → 409 unless the same kind+action is still advised. Route
  `GET /api/trips/{id}/advice` → `{advice}`; UI `components/advice-list.tsx` tops the aside
  (`advice-{kind}-{n}`, `advice-apply-{n}`, n = 1-based position). Sync insert for atomic
  replace: `insertItem()` in itinerary.ts. Fixture facts for tests: rainy low-season months
  only hanoi (7,8), ho-chi-minh-city (6–10), da-nang/hoi-an (9–11); london, san-francisco,
  singapore, dubai, mumbai have no climate (provider throws → no risk); da-nang has no culture
  activity; closed days: tokyo-act-2 Sun, kyoto-act-2 Wed, lisbon-act-2 Mon, petra-act-2 open
  Mon/Wed/Thu only; 2027-04-11 is a Sunday.
- Chat (boopada M9, phase 9): `POST /api/chat` → `runChat()` in `apps/web/lib/server/chat.ts`,
  a `commands` table of `[regex, handler]` over the normalized message (lowercase, single
  spaces, trailing `.!?` stripped). A new command goes in `commands` AND `CHAT_COMMANDS`
  (`apps/web/lib/chat.ts`; the help reply and UI hint chips read it). Handlers only dispatch
  to existing functions (`addActivity`, `removeItem`, `undoLastDeletion`,
  `tripAdvice`+`applySuggestion`, `updateProfile`). Rephrasable misses → 200
  `changed:false`; unknown interest → 400 field `message` (D2). UI
  `components/trip-chat.tsx` tops the trip aside (`chat-input`, `chat-send`, `chat-reply`,
  `chat-suggestion-apply-{n}`, `chat-hint-{n}`). Fixture durations: lisbon-act-3 Sintra 540
  min, lisbon-act-1 150; tokyo-act-1 150, -2 180, -3 360.
- Demo polish (boopada M10, phase 10): `POST /api/sample-trip` → `createSampleTrip()`
  (`apps/web/lib/server/sample-trip.ts`) builds Tokyo & Kyoto starting today in Tokyo's zone
  via the normal create/add functions (fills only blank profile interests/budget); button
  `components/sample-trip-button.tsx` (home + /trips empty state). Shared nav
  `components/site-nav.tsx`; home dashboard `app/page.tsx` uses `tripTiming()` (lib/server/trips.ts:
  now/upcoming/past, city-zone). Date labels: `formatDate` in `apps/web/lib/dates.ts`. API
  hardening: every route file exports `methodNotAllowed(...)` (lib/server/api.ts) for verbs it
  lacks (JSON 405); catch-all is `app/api/[[...path]]`; `apps/web/proxy.ts` turns malformed
  %-escapes under /api into JSON 404; provider-map id checks use `Object.hasOwn`, never `in`.
  Migration 7 `deletions.replaced_by_item_id`: undoing a replace_item swap hides the replacement
  (`linkReplacement` in deletions.ts). Drive the real UI with playwright-core from the bun cache +
  system Chrome (see M10); tests for all of this in `apps/web/test/demo-polish.test.ts`.
