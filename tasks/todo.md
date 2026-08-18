# Plan: RunTracker v2 — multi-user, Railway-hosted, Apple Health sync

Request (2026-08-17): convert the single-file app into a robust hosted product:
Railway hosting, multiple users, and automatic sync of full run data from
Apple Health/Fitness (route, time of day, weather, pace, bpm, cadence,
elevation) instead of manual logging.

## Context

Today the app is one 1,953-line `index.html`: vanilla JS, Tailwind CDN, all
state in a single `APP` object persisted to localStorage + IndexedDB, Claude
called directly from the browser with a user-pasted key. Run records hold only
date / distance / duration / effort / notes. There is no backend, auth, or
database — this conversion builds that infrastructure and enriches the run
data model, with the current UI and coach logic as the reference.

## Owner decisions (2026-08-17)

1. **Health sync: Health Auto Export** (App Store app, $24.99 lifetime/user)
   POSTing workouts to our webhook. No iOS dev work. Ingestion API designed
   source-pluggable so Strava/native-app could be added later. (Aggregator
   APIs ruled out at $300–500/mo; Strava API now needs a paid sub AND bans AI
   use of its data — fatal for the coach; native iOS app = weeks of Swift +
   $99/yr + flaky background delivery.)
2. **Auth: invite-only magic links** (passwordless email). No public sign-up.
3. **Stack: Next.js (App Router, TypeScript) + Postgres**, single Railway
   service + managed Postgres. Drizzle ORM. Tailwind (real build, keep the
   existing dark/glass design language).
4. **AI coach: one server-side Anthropic key** (Railway env var), all calls
   proxied through the server, per-user usage caps.
5. Weather: **Open-Meteo** (free, no key) backfilled server-side from run
   timestamp + first GPS point.

## Architecture

- **Repo**: same repo, restructured. `index.html` moves to `legacy/` as the
  reference implementation (kept working for data export).
- **Services (Railway)**: 1 Next.js web service (serverless sleep OFF — must
  never miss webhooks) + Postgres. Railway cron hits a sweep route nightly.
- **Email**: Resend free tier for magic links + invites.
- **Ingestion**: `POST /api/ingest/health-auto-export` authenticated by a
  per-user ingest token (user generates it in Settings, pastes it into the
  Health Auto Export app as a header). Raw payload always stored → reprocess
  later without re-sync. Dedup on (user, source, external id/start time).

## Data model (Postgres, via Drizzle)

- `users` — id, email, name, role (owner/member), created_at
- `invites` — token, email, expires_at, used_at
- `sessions` / `magic_link_tokens` — Auth.js (email provider) tables
- `ingest_tokens` — user_id, token hash, label, last_used_at
- `runs` — id, user_id, source (`manual` | `apple_health`), external_id,
  started_at (timestamptz — time of day at last!), timezone, distance_m,
  duration_s, effort, notes, avg_hr, max_hr, avg_cadence, elevation_gain_m,
  weather jsonb (temp, humidity, wind, precip, condition), created_at
- `run_streams` — run_id, kind (`route` | `heart_rate` | `altitude` |
  `cadence`), data jsonb (timestamped samples / GPS points)
- `ingest_events` — user_id, source, received_at, status, raw jsonb
  (audit + "last synced" indicator + reprocessing source)
- `plans` — user_id, settings jsonb (start/race date, distance, target pace),
  weeks jsonb (**same shape as today's `APP.plan`** so the generator and
  `:::plan-change` protocol port unchanged), completed jsonb, skipped jsonb
- `chat_messages` — user_id, role, content, created_at
- `ai_usage` — user_id, day, tokens_in/out (enforce per-user daily cap)

Backwards compat: a v1 `exportData()` JSON must import losslessly (runLog →
`runs` with source=`manual` and started_at at local noon, plan/completed/
skipped/chatHistory → their tables).

## Phases & checklist

### Phase 0 — Scaffold & deploy skeleton
- [x] 1. Move `index.html` + `bg.jpg` to `legacy/`; scaffold Next.js +
      TypeScript + Tailwind + Drizzle; port the Tailwind color/glass theme
      from the inline `tailwind.config` + custom CSS
      (Next 16.3.1, Tailwind v4 @theme tokens; local PG on port **5433** —
      5432 was taken by another container. Capture half of item 13 is
      already live: `POST /api/ingest/health-auto-export` + `/latest`,
      shared-secret `x-ingest-token` from `.env.local`, verified incl.
      3.5MB/40k-point route payload round-trip.)
- [x] 2. Local Postgres via docker-compose; Drizzle migrations set up
- [x] 3. Railway project: web service + Postgres, deploy hello-world, custom
      domain, confirm serverless sleep off
      (Project "runtracker", services `web` + `Postgres` (private-network
      DATABASE_URL reference), migrations via railway.json
      `preDeployCommand: pnpm db:migrate`, domain
      https://runtracker.up.railway.app — prod capture endpoint verified
      401/401/200 + /latest. Prod INGEST_TOKEN set in Railway vars.)

### Phase 1 — Auth & users
- [x] 4. Auth.js v5, email (magic link) provider via Resend
      (next-auth 5.0.0-beta.32 + @auth/drizzle-adapter 1.11.3, JWT sessions,
      Auth.js tables added in migration 0001. Resend delivery lives in
      `src/lib/auth-email.ts`; with `RESEND_API_KEY` unset the link is
      printed as `[auth] magic link for <email>: <url>` instead of sent.)
- [x] 5. Invite flow: owner creates invite → email with link → account
      created on first login; no open registration path
      (`signIn` callback gates on users/open invites *before* the mail is
      sent; refusals return the same redirect a real send does, so the raw
      `/api/auth/signin/resend` endpoint can't enumerate addresses. Owner-only
      `/invites` page; members get 404.)
- [x] 6. Seed owner account; middleware gating all app routes + APIs
      (`pnpm db:seed-owner` reads `OWNER_EMAIL` — owner is
      **simon@gauthierboudreau.me**. Gating is `src/proxy.ts` — Next 16
      renamed `middleware.ts` to `proxy.ts` — allowing only `/login`,
      `/api/auth/*` and `/api/ingest/*`; pages redirect to `/login`, API
      routes get a 401 JSON. The proxy only verifies the JWT signature, so
      the root layout re-reads the user row and signs out a token whose
      account is gone. Owner-only actions check the role server-side, not
      just on the page — verified by replaying the `createInvite` action
      with a member's session.)
      **Railway env to set for prod:** `AUTH_SECRET`, `AUTH_URL`,
      `RESEND_API_KEY`, `AUTH_EMAIL_FROM`,
      `OWNER_EMAIL=simon@gauthierboudreau.me` (then run the seed).
      (ALL SET + VERIFIED IN PROD 2026-08-17: owner seeded, Resend delivery
      from `RunTracker <login@mygeoscore.app>` (Simon's existing verified
      domain — swap when a dedicated one is verified), Simon received a real
      magic-link email at 12:26 and logged in on runtracker.up.railway.app.)

### Phase 2 — Port the app (feature parity with v1)
- [x] 7. Data layer: server actions/API for runs, plan, chat replacing
      localStorage; per-user scoping everywhere
      (Runs + plan done; chat stays with item 10. `src/lib/plan.ts` and
      `src/lib/runs.ts` are the data layer — every function takes `userId` as
      its first argument and scopes its query on it; the `"use server"`
      wrappers in `src/lib/plan-actions.ts` / `src/lib/run-actions.ts` are the
      only callers from the UI and always get that id from `requireUser()`.
      Plan `weeks`/`completed`/`skipped` keep the v1 shape verbatim. Complete
      and skip toggle in a single SQL statement, so mutual exclusion can't be
      raced. Pace is always derived, never stored.)
- [x] 8. Plan view: port `generateDefaultPlan()`, plan rendering, edit modal,
      skip/complete, week finished badges (logic lifts from legacy JS)
      (`generateDefaultPlan` verified byte-identical to the legacy function
      across 120 distance × pace × week-count combinations. AI generation is
      deliberately left out — it needs the Anthropic proxy from item 10.)
- [x] 9. Log view: manual run form (now with optional time-of-day), weekly
      mileage chart, history list
      (Time of day defaults to local noon, matching the v1 import convention.
      The browser's timezone rides along on each run and in a `tz` cookie
      (`src/lib/today.ts`) so server-rendered views know the runner's "today".)
- [x] 10. Coach view: chat UI; server route proxies Anthropic (streaming),
      ports `buildCoachContext()` + full `:::plan-change` protocol +
      `applyPlanChange()`; `ai_usage` caps enforced
      (Model `claude-sonnet-5` (one constant in `src/lib/anthropic.ts`),
      thinking disabled + effort medium per claude-api skill. NDJSON
      streaming via `/api/coach/message`; parser/`isPlanChangeApplied` are
      pure+client-safe in `src/lib/plan-change.ts`, `applyPlanChange` writes
      atomically via one `savePlan` in `src/lib/plan.ts`. AI plan generation
      ported into `createPlanAction` (`intent=ai`). 30/30 unit checks +
      live-verified end-to-end incl. a real plan-change apply (~$0.03 total).
      Per-user daily cap `AI_DAILY_TOKEN_LIMIT`, default 300k. Prod needs
      `ANTHROPIC_API_KEY` + optional `AI_DAILY_TOKEN_LIMIT`.)
- [x] 11. v1 JSON importer in Settings (accepts existing `exportData()` file);
      v2 export for backup parity
      (Settings page + nav tab: preview→confirm import (replace semantics,
      idempotent, synced runs + streams survive, `apiKey` dropped), `GET
      /api/export` v2 backup (`?streams=1` for series), danger zone with
      typed-email confirm. Simon's REAL backup imported locally and
      cross-checked to the metre/second: 62 runs = 339.050 km = 129824 s,
      30 weeks, 64/6 maps, 207 chat msgs, all at local noon
      America/Toronto. Phase 3 should reuse `manualRunValues()` in
      `src/lib/runs.ts` and `savePlan(..., tx)` for same-transaction
      completion marking.)
- [x] 11b. Coach always visible (Simon, 2026-08-17): persistent right
      sidebar on desktop (legacy `lg:` behavior) instead of a separate
      destination; keep the Coach tab on mobile only.
      (ONE CoachChat instance mounted in the root layout — sticky 420px
      column at `lg:`, `/coach` redirects to `/` on desktop, chat
      state/draft survive navigation. Scrollback capped at 100 rendered
      msgs, API context at last 20. Live plan-change apply from the
      sidebar updates the adjacent Plan view. Follow-up DONE: only the
      newest plan-change block stays clickable — three-state cards
      (Applied beats age / Live / Superseded), `newestChangeMessageId()`
      shared by thread AND server action (stale-tab apply rejected,
      verified end-to-end); Simon's history went 4 live Apply buttons → 1.
      Mobile header email-overlap fixed (`hidden sm:block`).)
- [x] 12. Verify parity in browser (Playwright): plan gen, log, chart, coach
      plan-change round-trip, import of Simon's real v1 export
      (Covered cumulatively by the phase agents' Playwright runs, each
      against the real local DB: setup/plan gen + toggles + edit + log +
      chart (2a), live coach round-trip + plan-change apply incl. from the
      sidebar (2b), real 62-run v1 import with metre/second cross-checks
      (2c), supersede + stale-tab rejection (2b follow-up). Final check on
      prod happens at deploy.)

### Phase 3 — Apple Health ingestion (the point of all this)
- [x] 13. **Schema-verification spike first**: capture-only endpoint that dumps
      real Health Auto Export payloads (Simon runs one workout sync at
      minimum settings, one with route+HR enabled); confirm exact field
      names for route GPS, HR series, cadence, elevation BEFORE freezing the
      parser. (Research flag: cadence/elevation presence is likely but
      unverified.)
      (DONE 2026-08-17 with a real 2-run payload from Simon's phone —
      full findings in `tasks/hae-schema.md`; raw fixture gitignored at
      `fixtures/hae/real-payload-2026-08-17.json`. Cadence ✓ elevation ✓
      route ✓ HR series ✓; temp/humidity native but nullable; localized
      names/units — parse by field name only.)
- [x] 14. `POST /api/ingest/health-auto-export`: ingest-token auth, store raw
      `ingest_events` row, parse → `runs` + `run_streams`, dedup, derive
      pace/elevation gain; non-running workouts ignored (config choice)
      (Parser `src/lib/ingest/hae.ts` (pure, 90-assertion suite
      `pnpm check:hae`), pipeline `src/lib/ingest/process.ts` with
      per-workout summaries on `ingest_events.summary` (migration 0002),
      per-user tokens (SHA-256, constant-time) + legacy env INGEST_TOKEN
      attributes to owner so Simon's phone keeps working. Streams stored
      per `tasks/hae-schema.md` "What Phase 3 actually stores" — incl.
      `splits` as a stream kind. Dedup on external_id verified byte-stable.)
- [x] 15. Manual-run reconciliation: synced run matching an existing manual
      run (same user, overlapping start±3h, similar distance) upgrades it in
      place (keeps effort/notes, adds streams) instead of duplicating
      (Two rules: same-day ±3h, and noon-convention ±1 day + <10% distance
      for v1 imports. REAL-DATA PROOF: Aug 15 workout upgraded the manual
      "Aug 16" long run (kept effort 8 + notes, gained 14:19 start, HR
      164/177, cadence, elevation, 4 streams); Aug 12 upgraded same-day.
      Run count stayed 62.)
- [x] 16. Auto-match synced runs to plan days (reuse `findMatchingWorkout`
      logic from legacy) → completion marked without manual logging
      (Same-transaction via DbExecutor; idempotent; verified marking `21-0`
      after revert + a synthetic Wed run marking `22-1`.)
- [x] 17. Settings: generate/rotate ingest token + step-by-step Health Auto
      Export setup instructions (family onboarding page); "last synced"
      indicator from `ingest_events`
      (Token shown once, hash-only storage, rotate/revoke verified;
      last-synced card + owner-only "Reprocess stored syncs" which claims
      NULL-user capture-phase events.)
- [x] 18. Run detail view: route map (Leaflet + OSM tiles), HR trace,
      splits, elevation profile — the payoff screen
      (`/runs/[id]` + `src/lib/run-detail.ts` (cache()d loader,
      downsampling: LTTB for charts, Douglas-Peucker for the route — 6,315
      → ~800 pts at 0.41 m worst deviation; raw never ships to client).
      Pace-coloured polyline w/ despeckle, SVG charts w/ crosshair, splits
      w/ per-km HR + climb. True 404 on foreign runs — deliberately NO
      loading.tsx (streaming turns notFound() into a 200; documented in the
      page). 110-assertion suite `pnpm check:run-detail`.)

### Phase 4 — Weather backfill
- [x] 19. On ingest: fetch Open-Meteo (forecast API + `past_days`) with
      started_at + first GPS point → store `runs.weather`; manual runs
      without GPS use owner-set home location
      (Done for synced runs in `src/lib/weather.ts`: forecast+past_days <5
      days, archive otherwise; apple temp/humidity win the merge
      (`source: "apple+open-meteo"`); fetch failure never blocks ingest.
      Home-location fallback for GPS-less manual runs NOT built — fold into
      item 20's sweep if wanted.)
- [x] 20. Nightly Railway cron route sweeps runs missing weather (also
      covers Open-Meteo downtime)

### Phase 5 — Coach upgrade & launch
- [x] 21. `buildCoachContext()` v2: pace, HR, cadence, elevation, weather per
      run so the coach reasons over real physiology ("your easy runs are at
      170bpm in 28°C heat…")
      (Simon 2026-08-17: "make sure Claude AI receives a lot of
      information" — be generous: per-run enrichment inline, splits for key
      runs, HR drift/trends where cheap. Balance against the ~7.5k-token
      system prompt already observed; consider summarizing older runs.)
- [x] 21b. (Simon, 2026-08-17) Surface synced stats in Log rows + Plan
      "✓ Logged" lines (HR/elevation/cadence/weather chips) — assigned to
      the item-18 agent as a scope addition.
      (`run-stat-chips.tsx` shared by Log rows + Plan logged lines; muted
      text style, synced runs only, no mobile overflow. Weather display
      helpers moved to `src/lib/weather.ts` (pure) for reuse incl. by the
      coach context.)
- [x] 11c. (Simon, 2026-08-17) Coach chat layout flip: composer at the TOP,
      newest messages first (reverse-chronological).
      (Reversed by EXCHANGE (question + its replies stay in reading order,
      newest pair on top) via pure `src/lib/chat-view.ts` — 10 unit checks.
      No scroll management during streaming needed: growth happens below
      the top anchor; scroll-to-top only on message-count change. Verified
      live: 27 samples over 4.1s of streaming, scrollTop never left 0.)
- [x] 21c. Tier 0 enrichment (Simon approved all tiers 2026-08-17): extract
      from ALREADY-STORED raw payloads — post-run heart-rate recovery
      (`heartRateRecovery`, ~24 samples → new stream kind), energy burn,
      max speed. Needs an enrichment pass in reprocess: existing runs with
      raw events but missing new stream kinds get them added (plain dedup
      would skip). Reprocess prod after deploy.
- [x] 21d. Tier 1 — daily recovery metrics (HRV, resting HR, sleep stages,
      VO2Max) via a SECOND Health Auto Export automation ("Health Metrics"
      data type, daily aggregation, same endpoint+token — raw lands in
      ingest_events today untouched). SPIKE FIRST like item 13: verify the
      real metrics payload shape from Simon's phone before freezing the
      parser. Then: `daily_metrics` table + parser + Settings instructions.
- [x] 21e. Tier 2 — computed training signals from existing streams:
      weekly load, aerobic decoupling (HR drift at steady pace),
      pace-at-HR efficiency trend. Pure lib (`src/lib/training-metrics.ts`),
      consumed by coach context (21) — optionally Log insights later.
- [x] 21g. (Simon, 2026-08-17: "doesn't add data to my logged runs — not
      front end") Surface the Tier-0/1 data in the UI: energy (kcal) + HR
      recovery (drop60) on the run detail page; a small recovery section
      (HRV/RHR/sleep trend, last 7-14 days) on the Log page. Historical
      workout backfill guidance given to Simon (monthly chunked manual
      exports from HAE) — after backfill, most of the 62 runs gain streams.
- [x] 21f. (Simon, 2026-08-17) Model-deprecation resilience: if the
      configured Claude model becomes unavailable, auto-recover.
      Design: `COACH_MODEL` env override > stored `app_config` override >
      code default; on a model-not-found API error, query `GET /v1/models`,
      pick the newest same-family (Sonnet) model, persist the override,
      log + surface an owner-visible notice in Settings ("coach model
      auto-updated from X to Y"). Nightly revalidation folds into item
      20's cron sweep so a user never hits the error first. Implementing
      agent must consult the claude-api skill for the models endpoint.
- [ ] 22. Import Simon's real data, onboard first family member end-to-end
      (invite → login → HAE setup → first synced run with weather on map)
      (MOSTLY DONE 2026-08-17/18: Simon's data fully in — after the
      historical backfill ALL 70 of his runs are apple_health-synced (60
      v1 entries upgraded in place, 8 never-logged March runs discovered),
      100% weather coverage. Cédric (cedricmyette@gmail.com) self-onboarded:
      invite → login → imported his own 55-run history. REMAINING: Cédric's
      HAE setup + his first synced run, and confirm member view hides
      owner-only UI (Invites tab, sweep card) with his real account.)
- [x] 23. Decommission plan for v1: legacy file kept read-only in repo

## Running costs

Railway ~$5–10/mo · Resend free tier · Open-Meteo free · Health Auto Export
$24.99 one-time per user · Claude API usage (capped per user).

## Verification (per phase, and end-to-end at 22)

- Playwright against the deployed Railway URL: magic-link login, v1 import
  round-trip, manual log, coach plan-change apply.
- Ingestion: replay captured real HAE payloads as fixtures (unit tests for
  parser + dedup + reconciliation); then a live watch-recorded run must
  appear with route, HR, elevation, weather within one sync cycle.
- Diff-check: v1 export re-imported into v2 must reproduce identical plan
  weeks, completion/skip maps, and run history totals.

## Review section

(to be filled as phases complete)
