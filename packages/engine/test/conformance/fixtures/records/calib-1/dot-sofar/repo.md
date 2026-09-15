# Repo memory

Hand-written, repo-scoped notes for agents working here: conventions,
commands, gotchas — anything true of the repo across all initiatives.
Sofar never generates or overwrites this file; initiative state lives in
.sofar/initiatives/<slug>/ instead.

## Commands

```bash
bun install
bun run lint        # biome check .  (2 pre-existing a11y warnings in packages/ui; warnings do not fail)
bun run typecheck
bun run test        # turbo test -> bun test in apps/web and packages/providers
bun run build       # turbo build -> next build (Turbopack)
cd apps/web && PORT=3987 bun run start
```

## Conventions

- Monorepo on bun + turbo. App is `apps/web` (Next.js 16, App Router).
  Travel data comes from `@workspace/providers` fixtures, shared UI from
  `@workspace/ui`. One traveller, no login.
- Money in the API is always `{ amount_minor, currency }` in integer minor
  units — see `boopada-planner D1` and `apps/web/lib/money.ts`. Provider
  `QuotedPrice` decimal strings are converted at the boundary with
  `fromQuotedPrice`, never with `Number()`.
- Interests are exactly the seven provider activity categories — see
  `boopada-planner D2` and `apps/web/lib/interests.ts`.
- Storage is SQLite at `BOOPADA_DB_PATH` (default `./data/boopada.sqlite`),
  opened and migrated only through `apps/web/lib/db.ts`. Add schema changes
  as a new entry in its `MIGRATIONS` array; never edit a shipped one.
- "Now" is `BOOPADA_NOW` when set, else the system clock, via
  `apps/web/lib/providers.ts`.
- Nothing the traveller made is ever hard-deleted and nothing asks "are you
  sure?" (`boopada-planner D5`). Give every such table a nullable
  `deleted_at`, register it in `SOFT_DELETABLE` in `apps/web/lib/deletions.ts`
  and a reader in `apps/web/lib/undo.ts`, delete via `softDelete()`, and filter
  `deleted_at is null` in every list, lookup, total and suggestion.
  `POST /api/undo` restores the latest deletion by log `seq` (409
  `nothing_to_undo` when none).
- API errors are `{ "error": { "code", "message" } }` with a 4xx status,
  raised as `ApiError` and wrapped by `handle()` in `apps/web/lib/http.ts`.

## Gotchas

- `boopada-planner M1` — `providers.fx.getRates(base)` leaves `base` out of
  `rates`. Known currencies are `{base} ∪ keys(rates.rates)`; take them from
  `getReference()` in `apps/web/lib/reference.ts`, or USD fails its own
  validation.
- `boopada-planner M2` — a green `bun run build` does not prove the app runs.
  Turbopack only executes route handlers on request, and it externalises Node
  builtins reached by import/`createRequire` (`boopada-planner D4`). Always
  `bun run start` and curl the routes before finishing.
- `boopada-planner M3` — `bun test` runs all apps/web test files in one
  process: set `BOOPADA_DB_PATH` per file, and `resetProviders()` after
  setting or clearing `BOOPADA_NOW`, or the frozen clock leaks.
- Biome lints the whole tree; `.sofar/` is excluded in `biome.json` so
  sofar's generated projections do not fail `bun run lint`.
