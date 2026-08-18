/**
 * Unit checks for the nightly maintenance sweep.
 *
 *   pnpm check:sweep
 *
 * Two halves. The pure one — the twenty-hour gate, the stored record's shape,
 * the phrases Settings prints — runs on plain values. The wired one needs the
 * local Postgres (`docker compose up -d && pnpm db:migrate`): it seeds a
 * throwaway user with four runs that between them cover every way a run can or
 * cannot want weather, runs the real sweep against a fake Open-Meteo, and then
 * deletes the user again.
 *
 * The seeded runs are the only ones the sweep is allowed to touch here —
 * `selectCandidates` is wrapped to keep it off the real data in the dev
 * database, while still being the real selection query underneath.
 */

import { existsSync } from "node:fs";
import { eq as columnEq, inArray } from "drizzle-orm";
import { getDb, getSql } from "../src/db/index.ts";
import { runs, runStreams, users } from "../src/db/schema.ts";
import type { CoachModelCheck } from "../src/lib/coach-model.ts";
import {
	describeModelCheck,
	describeSweepRecord,
	parseSweepRecord,
	runMaintenanceSweep,
	SWEEP_INTERVAL_MS,
	type SweepRecord,
	selectWeatherCandidates,
	sweepIsDue,
} from "../src/lib/sweep.ts";
import type { RunWeather } from "../src/lib/weather.ts";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");

let passed = 0;
const failures: string[] = [];

function check(label: string, ok: boolean, detail = ""): void {
	if (ok) {
		passed += 1;
		console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ""}`);
	} else {
		failures.push(label);
		console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
	}
}

function eq(label: string, actual: unknown, expected: unknown): void {
	check(label, Object.is(actual, expected), `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

function section(title: string): void {
	console.log(`\n${title}`);
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

section("The twenty-hour gate");

const NOW = new Date("2026-08-17T03:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const HOUR = 60 * 60 * 1000;

eq("never swept is due", sweepIsDue(null, NOW), true);
eq("one hour ago is not", sweepIsDue(ago(HOUR), NOW), false);
eq("nineteen hours ago is not", sweepIsDue(ago(19 * HOUR), NOW), false);
eq("exactly twenty hours is", sweepIsDue(ago(SWEEP_INTERVAL_MS), NOW), true);
eq("a second short is not", sweepIsDue(ago(SWEEP_INTERVAL_MS - 1000), NOW), false);
eq("a day ago is", sweepIsDue(ago(24 * HOUR), NOW), true);
eq(
	"a stamp a minute in the future still waits",
	sweepIsDue(new Date(NOW.getTime() + 60_000), NOW),
	false,
);
eq(
	"a stamp a week in the future is a broken clock, so sweep",
	sweepIsDue(new Date(NOW.getTime() + 7 * 24 * HOUR), NOW),
	true,
);
eq("the interval is overridable", sweepIsDue(ago(2 * HOUR), NOW, HOUR), true);

// ---------------------------------------------------------------------------
// The stored record
// ---------------------------------------------------------------------------

section("The stored record");

const RECORD: SweepRecord = {
	ranAt: "2026-08-17T03:00:12.000Z",
	durationMs: 12_000,
	trigger: "scheduled",
	weatherCandidates: 4,
	weatherFilled: 3,
	weatherFailed: 1,
	modelStatus: "ok (claude-sonnet-5)",
	model: "claude-sonnet-5",
};

const roundTripped = parseSweepRecord(JSON.parse(JSON.stringify(RECORD)));
eq("a record survives jsonb", JSON.stringify(roundTripped), JSON.stringify(RECORD));
eq("garbage is not a record", parseSweepRecord("nope"), null);
eq("an array is not a record", parseSweepRecord([RECORD]), null);
eq("null is not a record", parseSweepRecord(null), null);
eq("a record with no stamp is not one", parseSweepRecord({ ...RECORD, ranAt: "" }), null);

const partial = parseSweepRecord({ ranAt: RECORD.ranAt });
check("an older build's row still reads", partial !== null);
eq("…with counts at zero", partial?.weatherFilled, 0);
eq("…an unknown model status", partial?.modelStatus, "unknown");
eq("…no model", partial?.model, null);
eq("…and a scheduled trigger", partial?.trigger, "scheduled");
eq("an unknown trigger falls back to scheduled", parseSweepRecord({ ...RECORD, trigger: "cron" })?.trigger, "scheduled");
eq("a manual trigger is kept", parseSweepRecord({ ...RECORD, trigger: "manual" })?.trigger, "manual");
eq("a NaN count is zero", parseSweepRecord({ ...RECORD, weatherFilled: "three" })?.weatherFilled, 0);

section("What Settings reads");

eq(
	"a working sweep",
	describeSweepRecord(RECORD),
	"3 of 4 runs given weather (1 unavailable) · coach model ok (claude-sonnet-5)",
);
eq(
	"nothing to do",
	describeSweepRecord({ ...RECORD, weatherCandidates: 0, weatherFilled: 0, weatherFailed: 0 }),
	"no runs were missing weather · coach model ok (claude-sonnet-5)",
);
eq(
	"no failures, no parenthesis",
	describeSweepRecord({ ...RECORD, weatherCandidates: 3, weatherFilled: 3, weatherFailed: 0 }),
	"3 of 3 runs given weather · coach model ok (claude-sonnet-5)",
);

const modelCheck = (over: Partial<CoachModelCheck>): CoachModelCheck =>
	({ model: "claude-sonnet-5", source: "default", present: true, ...over }) as CoachModelCheck;

eq("a live model", describeModelCheck(modelCheck({})), "ok (claude-sonnet-5)");
eq(
	"an unreachable listing",
	describeModelCheck(modelCheck({ present: null, reason: "could not list models (timeout)" })),
	"unverified — could not list models (timeout)",
);
eq(
	"a repaired model",
	describeModelCheck(
		modelCheck({ present: false, model: "claude-sonnet-6", recovery: { from: "claude-sonnet-5", to: "claude-sonnet-6" } }),
	),
	"auto-updated claude-sonnet-5 → claude-sonnet-6",
);
eq(
	"a pinned model that no longer exists",
	describeModelCheck(
		modelCheck({ present: false, source: "env", reason: "COACH_MODEL is pinned to a model that no longer exists" }),
	),
	"missing — COACH_MODEL is pinned to a model that no longer exists",
);

// ---------------------------------------------------------------------------
// Against the database
// ---------------------------------------------------------------------------

if (!process.env.DATABASE_URL) {
	console.error("\nDATABASE_URL is not set — start the local database (docker compose up -d) and retry.");
	process.exit(1);
}

section("Weather backfill, against the local database");

const db = getDb();
const EMAIL = `check-sweep+${Date.now()}@example.invalid`;
const STARTED = new Date("2026-08-05T13:00:00Z");
const POINT = { t: Math.floor(STARTED.getTime() / 1000), lat: 45.5017, lng: -73.5673, alt: 32, v: 3.1 };

/** What the fake Open-Meteo answers with, for our seeded coordinates only. */
const REMOTE: RunWeather = {
	tempC: 21.4,
	humidityPct: 63,
	windKmh: 9.2,
	precipMm: 0,
	weatherCode: 1,
	source: "open-meteo",
};

const APPLE_ONLY: RunWeather = { tempC: 19.5, humidityPct: 71, source: "apple" };
const COMPLETE: RunWeather = { ...REMOTE, tempC: 18, source: "apple+open-meteo" };

let userId = "";
const logs: string[] = [];

try {
	const [user] = await db.insert(users).values({ email: EMAIL, role: "member" }).returning({ id: users.id });
	userId = user.id;

	const seed = async (label: string, weather: unknown, withRoute: boolean): Promise<string> => {
		const [row] = await db
			.insert(runs)
			.values({
				userId,
				source: "apple_health",
				externalId: `${EMAIL}:${label}`,
				startedAt: STARTED,
				timezone: "America/Toronto",
				distanceM: 10_000,
				durationS: 3_000,
				weather,
			})
			.returning({ id: runs.id });
		if (withRoute) {
			await db.insert(runStreams).values({ runId: row.id, kind: "route", data: [POINT, { ...POINT, t: POINT.t + 1 }] });
		}
		return row.id;
	};

	const missing = await seed("missing", null, true);
	const appleOnly = await seed("apple-only", APPLE_ONLY, true);
	const complete = await seed("complete", COMPLETE, true);
	const noRoute = await seed("no-route", null, false);
	const seeded = new Set([missing, appleOnly, complete, noRoute]);

	const selected = (await selectWeatherCandidates(500)).filter((candidate) => seeded.has(candidate.id));
	const selectedIds = new Set(selected.map((candidate) => candidate.id));

	eq("a run with no weather is a candidate", selectedIds.has(missing), true);
	eq("so is one the watch only half-answered", selectedIds.has(appleOnly), true);
	eq("a run that already has full weather is not", selectedIds.has(complete), false);
	eq("nor is one without a GPS trace", selectedIds.has(noRoute), false);
	eq("and that is all of them", selected.length, 2);

	const point = selected.find((candidate) => candidate.id === missing);
	eq("the first fix comes back out of the route", `${point?.lat},${point?.lng}`, `${POINT.lat},${POINT.lng}`);
	eq("with the run's start time", point?.startedAt.toISOString(), STARTED.toISOString());

	let asked = 0;
	const outcome = await runMaintenanceSweep("manual", {
		now: () => NOW,
		// The real query, narrowed to this test's own runs: the dev database holds
		// real training data, and a fake forecast has no business on it.
		selectCandidates: async (limit) => (await selectWeatherCandidates(limit)).filter((candidate) => seeded.has(candidate.id)),
		fetchWeather: async (_startedAt, lat, lng) => {
			asked += 1;
			return lat === POINT.lat && lng === POINT.lng ? REMOTE : null;
		},
		revalidateModel: async () => modelCheck({}),
		writeRecord: async () => {},
		log: (message) => logs.push(message),
		weatherLimit: 50,
	});

	eq("the sweep ran", outcome.status, "done");
	const record = outcome.status === "done" ? outcome.record : null;
	eq("both candidates were asked about", asked, 2);
	eq("…and counted", record?.weatherCandidates, 2);
	eq("…and both filled", record?.weatherFilled, 2);
	eq("nothing failed", record?.weatherFailed, 0);
	eq("the trigger is recorded", record?.trigger, "manual");
	eq("the model check rides along", record?.modelStatus, "ok (claude-sonnet-5)");
	eq("as does the model itself", record?.model, "claude-sonnet-5");
	eq("the stamp is the injected clock", record?.ranAt, NOW.toISOString());
	check(
		"the sweep logs its start and finish",
		logs.some((line) => line.startsWith("[sweep] started")) && logs.some((line) => line.startsWith("[sweep] finished")),
		logs.join(" | "),
	);

	const after = new Map(
		(await db.select({ id: runs.id, weather: runs.weather }).from(runs).where(inArray(runs.id, [...seeded]))).map((row) => [
			row.id,
			row.weather as RunWeather | null,
		]),
	);

	eq("the empty run got the forecast", after.get(missing)?.source, "open-meteo");
	eq("…with its temperature", after.get(missing)?.tempC, REMOTE.tempC);
	eq("…and its wind", after.get(missing)?.windKmh, REMOTE.windKmh);
	eq("the apple-only run is merged, not replaced", after.get(appleOnly)?.source, "apple+open-meteo");
	eq("…the wrist temperature wins", after.get(appleOnly)?.tempC, APPLE_ONLY.tempC);
	eq("…and it gains the wind it never had", after.get(appleOnly)?.windKmh, REMOTE.windKmh);
	// Field by field: Postgres stores jsonb keys in its own order, so the two
	// objects are equal without their serialisations being.
	const untouched = after.get(complete);
	eq(
		"the complete run is untouched",
		(Object.keys(COMPLETE) as (keyof RunWeather)[]).every((key) => untouched?.[key] === COMPLETE[key]),
		true,
	);
	eq("…and gained no keys", Object.keys(untouched ?? {}).length, Object.keys(COMPLETE).length);
	eq("the GPS-less run is untouched", after.get(noRoute), null);

	section("Failure is per run, and never fatal");

	await db.update(runs).set({ weather: null }).where(columnEq(runs.id, missing));

	const failing = await runMaintenanceSweep("scheduled", {
		now: () => NOW,
		selectCandidates: async (limit) => (await selectWeatherCandidates(limit)).filter((candidate) => candidate.id === missing),
		fetchWeather: async () => null,
		revalidateModel: async () => {
			throw new Error("no API key");
		},
		writeRecord: async () => {},
		log: () => {},
		weatherLimit: 50,
	});

	const failed = failing.status === "done" ? failing.record : null;
	eq("a sweep whose every job failed still finishes", failing.status, "done");
	eq("the unavailable forecast is counted", failed?.weatherFailed, 1);
	eq("…and nothing is claimed as filled", failed?.weatherFilled, 0);
	eq("a thrown model check is reported, not raised", failed?.modelStatus, "check failed — no API key");

	const [stillEmpty] = await db.select({ weather: runs.weather }).from(runs).where(columnEq(runs.id, missing));
	eq("a failed lookup leaves the run alone", stillEmpty.weather, null);

	section("One sweep at a time");

	const holder = await getSql().reserve();
	try {
		// Another instance's session, holding the lock the sweep wants.
		const [held] = await holder<{ locked: boolean }[]>`select pg_try_advisory_lock(4113907) as locked`;
		eq("the test grabbed the lock first", held.locked, true);

		let ran = false;
		const blocked = await runMaintenanceSweep("scheduled", {
			selectCandidates: async () => {
				ran = true;
				return [];
			},
			revalidateModel: async () => modelCheck({}),
			writeRecord: async () => {},
			log: () => {},
		});
		eq("a second sweep backs off", blocked.status, "busy");
		eq("…without doing any of the work", ran, false);
	} finally {
		await holder`select pg_advisory_unlock(4113907)`;
		holder.release();
	}

	const free = await runMaintenanceSweep("scheduled", {
		selectCandidates: async () => [],
		revalidateModel: async () => modelCheck({}),
		writeRecord: async () => {},
		log: () => {},
	});
	eq("and runs again once the lock is released", free.status, "done");
} finally {
	if (userId) await db.delete(users).where(columnEq(users.id, userId));
	await getSql().end();
}

console.log(`\n${failures.length === 0 ? "PASS" : "FAIL"} — ${passed} checks passed, ${failures.length} failed`);
if (failures.length > 0) {
	for (const failure of failures) console.log(`  · ${failure}`);
	process.exit(1);
}
