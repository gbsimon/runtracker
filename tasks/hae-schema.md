# Health Auto Export — verified REST payload schema

Verified 2026-08-17 against a real automation POST (2 outdoor runs, Aug 12 +
Aug 15) captured in prod `ingest_events` and saved to
`fixtures/hae/real-payload-2026-08-17.json` (**gitignored — real GPS, public
repo; never commit; precise coords redacted in this doc**).

HAE config that produced it: exportVersion v2, format JSON, data type
workouts, routes ON, workout metadata interval "seconds", period "since last
sync", batchRequests false.

## Envelope

```
{ "data": { "workouts": [ Workout, … ] } }
```

No other top-level keys. One POST can carry multiple workouts.

## Workout object (29 keys max; observed)

Scalars / objects — HAE quantity pattern is `{qty: number, units: string}`:

| field | example / units | notes |
|---|---|---|
| `id` | UUID string | HealthKit workout UUID → our `external_id` (dedup key) |
| `name` | `"Extérieur Course"` | **LOCALIZED** (French device). Never match on name for type — use `isIndoor` + presence of route; treat any workout arriving via this pipeline as a candidate run and filter conservatively |
| `start` / `end` | `"2026-08-15 14:19:19 -0400"` | NOT ISO-8601 — `YYYY-MM-DD HH:mm:ss ±HHMM`, needs explicit parse; offset gives local time of day + timezone |
| `duration` | `6304.06` | plain number, **seconds** |
| `distance` | `{qty, "km"}` | |
| `isIndoor` | bool | |
| `location` | `"Extérieur"` | localized |
| `heartRate` | `{avg:{qty,units}, max:…, min:…}` bpm | also flat `avgHeartRate`/`maxHeartRate` duplicates |
| `stepCadence` | `{qty, "count/min"}` | avg cadence ✓ (161.9, 165.9 observed — plausible spm) |
| `elevationUp` | `{qty, "m"}` | elevation gain ✓ |
| `temperature` / `humidity` | degC / % | **NULLABLE** — present Aug 15, null Aug 12. Open-Meteo backfill remains necessary |
| `speed`/`avgSpeed`/`maxSpeed` | km/hr | ⚠ `avgSpeed.units` mislabeled `"km"` (value is km/hr) — don't trust units strings |
| `activeEnergyBurned`/`totalEnergy` | kJ | energy in **kJ not kcal** |
| `intensity` | kcal/hr·kg | |
| `metadata` | `{}` observed | |

⚠ Units strings are localized AND sometimes wrong (`"pas"` = steps,
`avgSpeed.units: "km"`). Parse by FIELD NAME semantics, never by units string.

## Time-series arrays (per-second at our settings)

- `route` — 6,315 pts for a 105-min run:
  `{latitude, longitude, altitude, speed, course, timestamp,
  horizontalAccuracy, verticalAccuracy, speedAccuracy, courseAccuracy}`
  (lat/lng redacted here; altitude m, speed m/s at point level, timestamp same
  format as start/end)
- `heartRateData` — 1,263 entries: `{Avg, Max, Min, date, units, source}` —
  **capitalized** Avg/Max/Min; source e.g. `"Apple Watch de Simon"`
- `heartRateRecovery` — same shape, ~24 post-run entries
- `stepCount` — `{qty, date, units:"pas", source}` → cadence series derivable
- `walkingAndRunningDistance` — `{qty(km), date, …}` → splits/pace series
- `activeEnergy`, `basalEnergy` — `{qty(kJ), date, …}`

## Parser decisions locked by this verification

1. Dedup: `(user_id, source='apple_health', external_id=workout.id)` — already
   the partial unique index on `runs`.
2. `started_at` from `start` (custom parse), `timezone` from the offset.
3. `runs` columns: distance_m = qty*1000; duration_s = round(duration);
   avg_hr/max_hr from `heartRate.avg/max`; avg_cadence from `stepCadence`;
   elevation_gain_m from `elevationUp`; native temp/humidity → seed
   `weather` jsonb when non-null.
4. `run_streams`: kind `route` ← `route` (thin to
   {t, lat, lng, alt, v} — drop accuracy fields), kind `heart_rate` ←
   `heartRateData` ({t, bpm: Avg}), kind `cadence` ← derived per-minute from
   `stepCount`, kind `altitude` covered by route points (skip separate).
5. Run filter: accept when `route` non-empty OR `walkingAndRunningDistance`
   non-empty; skip obvious non-runs later if other workout types show up
   (config sends all types).
6. Pace series: derive from `walkingAndRunningDistance` cumulative.

## Corrections found while building the parser (Phase 3, item 14)

1. **`walkingAndRunningDistance` is per-sample *deltas*, not cumulative.** Each
   `qty` is the distance covered since the previous sample, in km; they sum to
   the workout total (Aug 15: Σ = 15.7186 km vs `distance` 15.7094 km, 0.06%
   apart). `stepCount` behaves the same way — per-sample step deltas summing to
   17,013 steps, which over 105 min gives 161.9 spm, matching `stepCadence`
   161.92. The parser runs both up itself.
2. **Series can outlast `duration`.** The Aug 15 samples span 6,311 s while
   `duration` reads 6,304.06 s — `duration` excludes auto-pauses. Splits are
   therefore timed off the samples, and `duration_s` still comes from
   `duration`.
3. `route` carries one more point than there are `walkingAndRunningDistance`
   samples (6,315 vs 6,304); neither array can be assumed to align by index.

## What Phase 3 actually stores

`run_streams.kind` per synced run, all sample times as **absolute epoch
seconds (UTC)**:

| kind | shape | Aug 15 count |
|---|---|---|
| `route` | `{t, lat, lng, alt, v}` — lat/lng to 6 dp, alt 1 dp, v 2 dp (m/s) | 6,315 |
| `heart_rate` | `{t, bpm}` from `heartRateData.Avg` | 1,263 |
| `cadence` | `{t, spm}`, one per whole minute from the run's start | 106 |
| `splits` | `{km, t, elapsedS, splitS, distanceM, paceSPerKm, partial?}` | 16 |

Splits live as a stream kind rather than a `runs` column — no migration, and
the run detail view reads all four series the same way. The last entry is
flagged `partial: true` and carries the leftover metres, so `Σ distanceM` ≈ the
run's distance.

`runs.timezone` holds the **UTC offset** (`-04:00`), not an IANA zone — the
payload never names the zone. Node's `Intl` accepts offset strings as time
zones, so `runLocalDateISO`/`runLocalTime` work on it unchanged.

## Health Metrics payload (item 21d spike — verified 2026-08-17)

Real payload from Simon's second HAE automation (Health Metrics, daily
aggregation, personal ingest token) saved gitignored at
`fixtures/hae/metrics-payload-2026-08-17.json`. Envelope:

```
{ "data": { "metrics": [ {name, units, data: [...]}, … ] } }
```

Same endpoint as workouts; the pipeline stores it raw with 0 workouts —
the metrics parser must branch on `data.metrics` presence.

| name | units | entry shape | notes |
|---|---|---|---|
| `vo2_max` | `ml/(kg·min)` | `{qty, date, source}` | SPARSE — only days with outdoor runs |
| `resting_heart_rate` | `count/min` | `{qty, date, source}` | daily |
| `heart_rate_variability` | `ms` | `{qty, date, source}` | daily (SDNN) |
| `sleep_analysis` | `hr` | `{date, totalSleep, rem, core, deep, awake, sleepStart, sleepEnd, inBedStart, inBedEnd, inBed, asleep, source}` | stage values in HOURS; `inBed`/`asleep` observed 0 (HAE quirk — use `totalSleep` + stages); `date` = wake-day midnight; nights can be MISSING entirely (no watch worn) |

Dates are `YYYY-MM-DD 00:00:00 ±HHMM` (same parse as workouts). `source`
is localized. Days can be absent per metric — never assume continuity.
Suggested storage: `daily_metrics(user_id, day date, kind text, value
jsonb)` unique on (user_id, day, kind) so re-exports upsert idempotently.

## What Phase 5 stores (items 21c/21d, built 2026-08-17)

**Workout additions** — `src/lib/ingest/hae.ts`:

| what | where | note |
|---|---|---|
| `heartRateRecovery` | `run_streams.kind = 'hr_recovery'`, `{t, bpm}` from `Avg` | same epoch-seconds convention as the other kinds; the 24 samples sit *after* the run window (Aug 15: starts 18 s past the finish, spans 111 s) |
| `activeEnergyBurned` | `runs.metrics.energyKj` | kJ as sent (Aug 15: 5808.82 kJ = 1388 kcal) |
| `maxSpeed` | `runs.metrics.maxSpeedMs` | payload is km/h behind a `"km"` units string; ÷3.6 to SI. Confirmed against the route's own m/s peak: 11.771 km/h → 3.27 m/s, and `max(route.speed)` = 3.2697 |

`runs.metrics jsonb` rather than two columns: it's the same bet `weather`
already makes, and the next Tier-0 field HAE exposes becomes a parser change
instead of a migration. Reader and merge live in `src/lib/run-metrics.ts`.

**Enrichment** — replaying a stored event no longer skips a workout we already
have: missing stream kinds are inserted and missing `metrics` fields filled,
never overwriting an existing stream, the weather, or the runner's effort and
notes. Outcome `enriched` when something was added, `duplicate` when not. Only
the Reprocess pass enriches; the live webhook keeps dedup a plain no-op. The
Reprocess button therefore replays `processed` events too — that is how prod
runs pick up a newer parser's fields.

**Daily metrics** — `daily_metrics(user_id, day date, kind text, value jsonb,
updated_at)`, primary key `(user_id, day, kind)` (the uniqueness the upsert
needs, without a surrogate id). `kind` is the metric's own name, so an
unmodelled metric still lands somewhere useful. Values: `{qty}` for
`vo2_max`/`resting_heart_rate`/`heart_rate_variability`; sleep as
`{totalSleep, rem, core, deep, awake, sleepStart, sleepEnd}` in hours, with
`inBed`/`asleep` dropped (the HAE 0 quirk) and the start/end kept as
offset-carrying ISO (`2026-08-16T23:19:33-04:00`) so a 23:19 bedtime doesn't
read as a 03:19 one. Read side: `src/lib/daily-metrics.ts`.
