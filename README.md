# RunTracker

A race training app: build a plan for any distance (5K, 10K, half, marathon, or
custom), log your runs, and chat with an AI coach that adjusts the schedule on
the fly.

v2 is a rewrite onto Next.js + Postgres with multiple users, invite-only
accounts, and automatic run sync from Apple Health. The v1 single-file app is
kept in `legacy/` as the reference implementation.

## v2 development

Requires Node 22+, pnpm, and Docker.

```bash
pnpm install
cp .env.example .env.local          # then fill in INGEST_TOKEN: openssl rand -hex 24
docker compose up -d                # Postgres 18 on host port 5433
pnpm db:migrate                     # apply migrations in drizzle/
pnpm dev                            # http://localhost:3000
```

Other scripts:

| Command            | What it does                                        |
| ------------------ | --------------------------------------------------- |
| `pnpm build`       | Production build                                     |
| `pnpm lint`        | ESLint                                               |
| `pnpm db:generate` | Write a new migration from changes to `src/db/schema.ts` |
| `pnpm db:migrate`  | Apply pending migrations                             |
| `pnpm db:push`     | Push the schema straight to the DB (dev only)        |
| `pnpm db:studio`   | Drizzle Studio                                       |

Docker publishes the container's 5432 on host port **5433** so it does not
collide with any other local Postgres.

### Health Auto Export capture

`POST /api/ingest/health-auto-export` stores whatever the Health Auto Export iOS
app sends as a raw `ingest_events` row, authenticated with an `x-ingest-token`
header matching `INGEST_TOKEN`. `GET /api/ingest/health-auto-export/latest`
(same header) lists the five most recent payloads with their top-level JSON keys
and sizes. This is the schema-verification spike: real payloads get captured
before the parser is written.

### Layout

```
src/app          routes — Plan (/), Log (/log), Coach (/coach), API handlers
src/components   shared UI
src/db           Drizzle schema and client
drizzle/         generated SQL migrations
legacy/          the v1 single-file app
```

## Legacy (v1)

**v1 is decommissioned.** The live product is v2, this app, at
<https://runtracker.up.railway.app>. `legacy/index.html` stays in the repo
read-only — a reference implementation and an escape hatch for anyone who still
has v1 data in a browser profile, not something that receives changes. Nothing
in `src/` imports from it, and fixes belong in v2.

It is the original app: one HTML file, vanilla JS, Tailwind via CDN, no build
step and no server. Open it in a browser, set your start date, race date and
distance in Settings, then generate a plan. Adding a Claude API key enables AI
plan generation and the coach.

All v1 data lives in the browser (localStorage + IndexedDB). To move it across,
open the legacy file, export the JSON, and feed that file to **Settings → Import
v1 backup** in v2 — runs, plan, completions, skips and chat history all come
over. That importer is the reason the file is kept.
