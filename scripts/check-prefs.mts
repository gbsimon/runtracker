/**
 * Unit checks for the per-user preferences: the composer's send-key decision,
 * the "Sync now" deep link and its round trip, and the row they are stored in.
 *
 *   pnpm check:prefs
 *
 * Two halves, like `check:sweep`. The pure one walks every modifier combination
 * of Enter under both modes on plain values. The wired one needs the local
 * Postgres (`docker compose up -d && pnpm db:migrate`): it seeds a throwaway
 * user, writes the preference through the real upsert, reads it back through
 * the real loader, and deletes the user again — nothing else in the database is
 * touched.
 */

import { existsSync } from "node:fs";
import { eq } from "drizzle-orm";
import { getDb, getSql } from "../src/db/index.ts";
import { userPrefs, users } from "../src/db/schema.ts";
import {
	CHAT_SEND_KEYS,
	type ChatSendKey,
	chatKeyAction,
	DEFAULT_CHAT_SEND_KEY,
	isAppleUserAgent,
	normalizeChatSendKey,
	type SendKeyChord,
	sendKeyHint,
} from "../src/lib/chat-send-key.ts";
import type { IngestSummary } from "../src/lib/ingest/process.ts";
import { countUnseenSkipped, groupSkippedWorkouts, type SkippedItem } from "../src/lib/ingest/skipped.ts";
import {
	buildSyncShortcutUrl,
	clampSince,
	DEFAULT_SYNC_SHORTCUT_NAME,
	describeSyncOutcome,
	isIosUserAgent,
	normalizeSyncShortcutName,
	parseSyncReturn,
	SYNC_WINDOW_MS,
} from "../src/lib/sync-now.ts";
import { allowRunName, getUserPrefs, setChatSendKey, setSkippedSeenAt, setSyncShortcutName } from "../src/lib/user-prefs.ts";

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

function eq_(label: string, actual: unknown, expected: unknown): void {
	check(label, Object.is(actual, expected), `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

function section(title: string): void {
	console.log(`\n${title}`);
}

// ---------------------------------------------------------------------------
// The keyboard decision — every combination, both modes
// ---------------------------------------------------------------------------

function describe(chord: SendKeyChord): string {
	const parts = [chord.metaKey ? "Cmd" : "", chord.ctrlKey ? "Ctrl" : "", chord.shiftKey ? "Shift" : "", chord.key];
	return parts.filter(Boolean).join("+");
}

/** All eight modifier combinations of Enter, in a stable order. */
const ENTER_CHORDS: SendKeyChord[] = [];
for (const metaKey of [false, true]) {
	for (const ctrlKey of [false, true]) {
		for (const shiftKey of [false, true]) {
			ENTER_CHORDS.push({ key: "Enter", metaKey, ctrlKey, shiftKey });
		}
	}
}

/**
 * The rule, restated independently of the implementation: an accelerator sends
 * under either mode, and without one only "enter" mode sends a bare Enter.
 */
function expected(mode: ChatSendKey, chord: SendKeyChord): "send" | "newline" {
	if (chord.metaKey || chord.ctrlKey) return "send";
	if (mode === "cmd-enter") return "newline";
	return chord.shiftKey ? "newline" : "send";
}

section("Enter chords — mode 'enter'");
for (const chord of ENTER_CHORDS) {
	eq_(`${describe(chord)} → ${expected("enter", chord)}`, chatKeyAction("enter", chord), expected("enter", chord));
}

section("Enter chords — mode 'cmd-enter'");
for (const chord of ENTER_CHORDS) {
	eq_(
		`${describe(chord)} → ${expected("cmd-enter", chord)}`,
		chatKeyAction("cmd-enter", chord),
		expected("cmd-enter", chord),
	);
}

section("The two headline behaviours, spelled out");
eq_("enter mode: a bare Enter sends", chatKeyAction("enter", { key: "Enter" }), "send");
eq_("enter mode: Shift+Enter writes a newline", chatKeyAction("enter", { key: "Enter", shiftKey: true }), "newline");
eq_("cmd-enter mode: a bare Enter writes a newline", chatKeyAction("cmd-enter", { key: "Enter" }), "newline");
eq_(
	"cmd-enter mode: Shift+Enter writes a newline too",
	chatKeyAction("cmd-enter", { key: "Enter", shiftKey: true }),
	"newline",
);
eq_("cmd-enter mode: Cmd+Enter sends (mac)", chatKeyAction("cmd-enter", { key: "Enter", metaKey: true }), "send");
eq_(
	"cmd-enter mode: Ctrl+Enter sends (no mac key in sight)",
	chatKeyAction("cmd-enter", { key: "Enter", ctrlKey: true }),
	"send",
);
eq_("enter mode: Cmd+Enter still sends", chatKeyAction("enter", { key: "Enter", metaKey: true }), "send");
eq_("enter mode: Ctrl+Enter still sends", chatKeyAction("enter", { key: "Enter", ctrlKey: true }), "send");

section("Everything that isn't Enter is left to the textarea");
for (const mode of CHAT_SEND_KEYS) {
	for (const key of ["a", " ", "Escape", "Tab", "Backspace", "ArrowUp", "enter", "NumpadEnter"]) {
		eq_(`${mode}: ${JSON.stringify(key)}`, chatKeyAction(mode, { key }), "newline");
	}
	eq_(`${mode}: Cmd+K is not a send`, chatKeyAction(mode, { key: "k", metaKey: true }), "newline");
	// A chord object straight off a React event carries the flags as booleans;
	// omitting them entirely must read the same as false.
	eq_(`${mode}: omitted modifiers read as false`, chatKeyAction(mode, { key: "Enter" }), chatKeyAction(mode, { key: "Enter", shiftKey: false, metaKey: false, ctrlKey: false }));
}

// ---------------------------------------------------------------------------
// Normalizing what is stored
// ---------------------------------------------------------------------------

section("Stored values normalize safely");
eq_("the default is Enter-sends", DEFAULT_CHAT_SEND_KEY, "enter");
eq_("'enter' survives", normalizeChatSendKey("enter"), "enter");
eq_("'cmd-enter' survives", normalizeChatSendKey("cmd-enter"), "cmd-enter");
for (const raw of [undefined, null, "", "ENTER", "cmdEnter", 1, true, {}, [], "shift-enter"]) {
	eq_(`${JSON.stringify(raw) ?? "undefined"} falls back to the default`, normalizeChatSendKey(raw), DEFAULT_CHAT_SEND_KEY);
}

section("The composer hint names the key that sends");
eq_("enter mode, mac", sendKeyHint("enter", true), "↵ to send");
eq_("enter mode, elsewhere", sendKeyHint("enter", false), "↵ to send");
eq_("cmd-enter mode, mac", sendKeyHint("cmd-enter", true), "⌘↵ to send");
eq_("cmd-enter mode, elsewhere", sendKeyHint("cmd-enter", false), "Ctrl ↵ to send");

section("Platform sniffing (hint wording only — never the key handling)");
check("a Mac browser", isAppleUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"));
check("an iPhone", isAppleUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)"));
check("an iPad", isAppleUserAgent("Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)"));
check("Windows is not Apple", !isAppleUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64)"));
check("Linux is not Apple", !isAppleUserAgent("Mozilla/5.0 (X11; Linux x86_64)"));
check("Android is not Apple", !isAppleUserAgent("Mozilla/5.0 (Linux; Android 14; Pixel 8)"));

// ---------------------------------------------------------------------------
// The Sync tab: what the badge counts, and how the list reads
// ---------------------------------------------------------------------------

const at = (iso: string) => new Date(iso);

section("The nav badge counts skips the user hasn't seen");
{
	const events = [
		{ receivedAt: at("2026-08-17T12:00:00Z"), skipped: 3 },
		{ receivedAt: at("2026-08-16T12:00:00Z"), skipped: 2 },
		{ receivedAt: at("2026-08-15T12:00:00Z"), skipped: 1 },
	];

	eq_("a user who has never looked sees all of them", countUnseenSkipped(events, null), 6);
	eq_("a stamp from yesterday counts only newer syncs", countUnseenSkipped(events, at("2026-08-16T12:00:00Z")), 3);
	eq_("…and the stamp includes the event it names", countUnseenSkipped(events, at("2026-08-17T12:00:00Z")), 0);
	eq_("a stamp between two syncs splits them", countUnseenSkipped(events, at("2026-08-16T18:00:00Z")), 3);
	eq_("a stamp from the future clears everything", countUnseenSkipped(events, at("2027-01-01T00:00:00Z")), 0);
	eq_("no syncs, no badge", countUnseenSkipped([], null), 0);
	eq_("a nonsense count can't drag the total down", countUnseenSkipped([{ receivedAt: at("2026-08-17T12:00:00Z"), skipped: -5 }], null), 0);
}

section("Skipped activities collapse into one row per type");
{
	const item = (name: string | null, localDate: string | null, reason: string, receivedAt: string): SkippedItem => ({
		name,
		localDate,
		reason,
		receivedAt: at(receivedAt),
	});

	const notARun = (name: string) => `workout type "${name}" is not a run`;
	const items: SkippedItem[] = [
		item("Marche", "2026-08-16", notARun("Marche"), "2026-08-17T12:00:00Z"),
		item("Marche", "2026-08-14", notARun("Marche"), "2026-08-17T12:00:00Z"),
		item("marché", "2026-08-12", notARun("marché"), "2026-08-11T12:00:00Z"),
		item("Vélo", "2026-08-15", notARun("Vélo"), "2026-08-16T12:00:00Z"),
		item(null, "2026-08-13", "unnamed workout — cannot verify it is a run", "2026-08-16T12:00:00Z"),
		item("Outdoor Run", "2026-08-10", "no distance recorded", "2026-08-11T12:00:00Z"),
	];

	const groups = groupSkippedWorkouts(items, []);
	eq_("one row per distinct type", groups.length, 4);
	eq_("the newest sync leads", groups[0]?.name, "Marche");
	eq_("…carrying its repeats", groups[0]?.count, 3);
	eq_("…and the newest date among them", groups[0]?.latestDate, "2026-08-16");
	eq_("accents and case fold into one group", groups[0]?.key, "marche");
	eq_("a walk can be allowed", groups[0]?.allowable, true);

	const unnamed = groups.find((group) => group.name === null);
	eq_("an unnamed workout gets its own row", unnamed?.count, 1);
	eq_("…keyed apart from the named ones", unnamed?.key, "");
	eq_("…and offers no button, since there is no type to allow", unnamed?.allowable, false);

	const gated = groups.find((group) => group.name === "Outdoor Run");
	eq_("a run skipped for its data is listed", gated?.count, 1);
	eq_("…but allowing its type would change nothing", gated?.allowable, false);

	const withMarcheAllowed = groupSkippedWorkouts(items, ["marche"]);
	eq_("a type already allowed loses its button", withMarcheAllowed.find((group) => group.key === "marche")?.allowable, false);
	eq_("…and the others keep theirs", withMarcheAllowed.find((group) => group.key === "velo")?.allowable, true);

	eq_("nothing skipped, nothing to group", groupSkippedWorkouts([], []).length, 0);

	// Summaries written before names were recorded: still listed, still counted.
	const legacy = groupSkippedWorkouts([item(null, null, "workout type is not a run", "2026-08-17T12:00:00Z")], []);
	eq_("a nameless legacy summary still lists", legacy[0]?.count, 1);
	eq_("…with no date to show", legacy[0]?.latestDate, null);
	eq_("…and no action to take", legacy[0]?.allowable, false);
}

// ---------------------------------------------------------------------------
// "Sync now": the deep link out, and the callback back in
// ---------------------------------------------------------------------------

section("The shortcut name survives a text input");

eq_("the default is what the instructions say to type", normalizeSyncShortcutName(undefined), DEFAULT_SYNC_SHORTCUT_NAME);
eq_("an empty field falls back to it", normalizeSyncShortcutName("   "), DEFAULT_SYNC_SHORTCUT_NAME);
eq_("the wrong type falls back to it", normalizeSyncShortcutName(7), DEFAULT_SYNC_SHORTCUT_NAME);
eq_("a pasted double space is collapsed, not rejected", normalizeSyncShortcutName("  Run  Export\t"), "Run Export");
eq_("an over-long name is cut, without a trailing space", normalizeSyncShortcutName(`${"a".repeat(59)} b`).length, 59);
eq_("a normal name is left alone", normalizeSyncShortcutName("Sync RunTracker"), "Sync RunTracker");

section("The deep link Shortcuts opens");

const tapped = new Date("2026-08-26T14:05:00.000Z");
const link = buildSyncShortcutUrl({ name: "RunTracker Sync", origin: "https://runtracker.up.railway.app/", at: tapped });
check("it is a run-shortcut x-callback-url", link.startsWith("shortcuts://x-callback-url/run-shortcut?"), link);
check("the name is percent-encoded, never form-encoded", link.includes("name=RunTracker%20Sync") && !link.includes("+"), link);

const params = new URLSearchParams(link.slice(link.indexOf("?") + 1));
for (const [key, outcome] of [
	["x-success", "done"],
	["x-error", "error"],
	["x-cancel", "cancel"],
] as const) {
	const back = new URL(params.get(key) ?? "");
	eq_(`${key} comes back to the Sync tab`, `${back.origin}${back.pathname}`, "https://runtracker.up.railway.app/sync");
	eq_(`…marked "${outcome}"`, back.searchParams.get("synced"), outcome);
	eq_("…carrying the moment of the tap", back.searchParams.get("since"), tapped.toISOString());
}
check("a trailing slash on the origin doesn't double up", !link.includes("app%2F%2Fsync"), link);

const plain = buildSyncShortcutUrl({ name: "RunTracker Sync", origin: "https://runtracker.up.railway.app", at: tapped, callbacks: false });
eq_("from the home screen, the shortcut runs without a callback", plain, "shortcuts://run-shortcut?name=RunTracker%20Sync");

section("The query string that comes back is parsed, not trusted");

eq_("done is a known outcome", parseSyncReturn("done"), "done");
eq_("cancel is a known outcome", parseSyncReturn("cancel"), "cancel");
eq_("anything else is nothing", parseSyncReturn("success"), null);
eq_("an absent key is nothing", parseSyncReturn(undefined), null);

const now = new Date("2026-08-26T14:10:00.000Z");
eq_("a tap five minutes ago is still live", clampSince("2026-08-26T14:05:00.000Z", now)?.toISOString(), "2026-08-26T14:05:00.000Z");
eq_("a tap on the window's edge is still live", clampSince(new Date(now.getTime() - SYNC_WINDOW_MS).toISOString(), now)?.getTime(), now.getTime() - SYNC_WINDOW_MS);
eq_("a tap from an hour ago has expired", clampSince("2026-08-26T13:10:00.000Z", now), null);
eq_("a fast phone clock is pulled back to now", clampSince("2026-08-26T14:11:00.000Z", now)?.getTime(), now.getTime());
eq_("garbage is nothing", clampSince("just now", now), null);
eq_("the wrong type is nothing", clampSince(["2026-08-26T14:05:00.000Z"], now), null);

section("What arrived, in one line");

const summary = (patch: Partial<IngestSummary>): IngestSummary => ({
	workouts: 0,
	imported: 0,
	reconciled: 0,
	enriched: 0,
	duplicate: 0,
	skipped: 0,
	failed: 0,
	outcomes: [],
	...patch,
});
check("no summary at all is said plainly", describeSyncOutcome(null).includes("nothing this build could read"));
check("a broken pass points at reprocessing", describeSyncOutcome(summary({ error: "boom" })).includes("reprocessed"));
eq_("an empty export is not a failure", describeSyncOutcome(summary({})), "Nothing new — your phone had no workouts waiting.");
eq_("a run that imported is the headline", describeSyncOutcome(summary({ workouts: 1, imported: 1 })), "1 run imported");
eq_(
	"the parts read like the Settings card",
	describeSyncOutcome(summary({ workouts: 3, imported: 1, reconciled: 1, duplicate: 1 })),
	"1 run imported · 1 matched to a run you logged · 1 already had",
);
eq_(
	"a metrics-only payload says so instead of '0 workouts'",
	describeSyncOutcome(summary({ metrics: { entries: 4, days: { resting_heart_rate: 2, sleep_analysis: 2 } } })),
	"4 health-metric readings — sleep and recovery are up to date.",
);

section("Where the button makes sense");

check("an iPhone", isIosUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15"));
check("an iPad", isIosUserAgent("Mozilla/5.0 (iPad; CPU OS 19_0 like Mac OS X)"));
check("not a Mac, even though it has Shortcuts", !isIosUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0)"));
check("not Android", !isIosUserAgent("Mozilla/5.0 (Linux; Android 16; Pixel 10)"));
check("not an empty agent", !isIosUserAgent(""));

// ---------------------------------------------------------------------------
// The row it lives in — against the real database
// ---------------------------------------------------------------------------

const EMAIL = `check-prefs+${Date.now()}@example.invalid`;
const db = getDb();
let userId = "";

try {
	section("user_prefs, wired");

	const [user] = await db.insert(users).values({ email: EMAIL, role: "member" }).returning({ id: users.id });
	userId = user.id;

	// The hole that kept this off the plan's `settings`: a user has a coach
	// composer from their first sign-in, and no plan row at all.
	const fresh = await getUserPrefs(userId);
	eq_("a user with no row reads the default", fresh.chatSendKey, "enter");

	await setChatSendKey(userId, "cmd-enter");
	eq_("the first save inserts the row", (await getUserPrefs(userId)).chatSendKey, "cmd-enter");

	await setChatSendKey(userId, "enter");
	eq_("a second save updates it in place", (await getUserPrefs(userId)).chatSendKey, "enter");

	const rows = await db.select().from(userPrefs).where(eq(userPrefs.userId, userId));
	eq_("…without ever making a second row", rows.length, 1);

	// A preference this build doesn't know about stands in for one a later
	// build adds: saving the send key must not take it with it.
	await db
		.update(userPrefs)
		.set({ prefs: { chatSendKey: "enter", unitsKm: false } })
		.where(eq(userPrefs.userId, userId));
	await setChatSendKey(userId, "cmd-enter");
	const [merged] = await db.select({ prefs: userPrefs.prefs }).from(userPrefs).where(eq(userPrefs.userId, userId));
	const stored = merged.prefs as Record<string, unknown>;
	eq_("the save merges rather than replaces", stored.chatSendKey, "cmd-enter");
	eq_("…so a neighbouring preference survives", stored.unitsKm, false);

	section("The run allowlist and the seen stamp, wired");

	const fresh2 = await getUserPrefs(userId);
	eq_("a user allows nothing extra to begin with", fresh2.extraRunFragments.length, 0);
	eq_("…and has never looked at the skipped list", fresh2.skippedSeenAt, null);

	const first = await allowRunName(userId, "  Marche  ");
	eq_("allowing folds the name into a fragment", first?.fragment, "marche");
	eq_("…and reports it as newly added", first?.added, true);
	eq_("…and it reads straight back", (await getUserPrefs(userId)).extraRunFragments.join(","), "marche");

	const repeat = await allowRunName(userId, "MARCHÉ");
	eq_("the same name a second way is already allowed", repeat?.added, false);
	eq_("…and doesn't duplicate the fragment", (await getUserPrefs(userId)).extraRunFragments.length, 1);
	eq_("a name too short to be a fragment is refused", await allowRunName(userId, "a"), null);
	eq_("…and a blank one too", await allowRunName(userId, "   "), null);

	const second = await allowRunName(userId, "Randonnée");
	eq_("a second type joins the list", second?.fragments.join(","), "marche,randonnee");

	const afterAllow = await getUserPrefs(userId);
	eq_("the send key survives an allow", afterAllow.chatSendKey, "cmd-enter");
	const [neighbour] = await db.select({ prefs: userPrefs.prefs }).from(userPrefs).where(eq(userPrefs.userId, userId));
	eq_("…and so does a preference this build knows nothing about", (neighbour.prefs as Record<string, unknown>).unitsKm, false);

	const seen = new Date("2026-08-17T18:30:00.000Z");
	await setSkippedSeenAt(userId, seen);
	eq_("the seen stamp round-trips as an instant", (await getUserPrefs(userId)).skippedSeenAt, seen.toISOString());
	eq_("…without disturbing the allowlist", (await getUserPrefs(userId)).extraRunFragments.length, 2);

	eq_("a user who never named a shortcut gets the default", (await getUserPrefs(userId)).syncShortcutName, DEFAULT_SYNC_SHORTCUT_NAME);
	eq_("saving a name returns it normalized", await setSyncShortcutName(userId, "  My  Sync "), "My Sync");
	eq_("…and it reads back", (await getUserPrefs(userId)).syncShortcutName, "My Sync");
	eq_("clearing the field goes back to the default", await setSyncShortcutName(userId, ""), DEFAULT_SYNC_SHORTCUT_NAME);
	eq_("…without disturbing the seen stamp", (await getUserPrefs(userId)).skippedSeenAt, seen.toISOString());

	// A row written by hand, by an older build, or by a future one.
	await db
		.update(userPrefs)
		.set({ prefs: { extraRunFragments: ["Marche", "a", 7, "marche"], skippedSeenAt: "whenever" } })
		.where(eq(userPrefs.userId, userId));
	const salvaged = await getUserPrefs(userId);
	eq_("a messy allowlist is normalized on the way out", salvaged.extraRunFragments.join(","), "marche");
	eq_("an unparseable stamp reads as never looked", salvaged.skippedSeenAt, null);
	eq_("a row from before the button existed reads the default name", salvaged.syncShortcutName, DEFAULT_SYNC_SHORTCUT_NAME);

	await db.update(userPrefs).set({ prefs: { extraRunFragments: "marche" } }).where(eq(userPrefs.userId, userId));
	eq_("an allowlist of the wrong type reads as empty", (await getUserPrefs(userId)).extraRunFragments.length, 0);

	// Rows written by hand, by an older build, or by a bad migration.
	for (const [label, raw] of [
		["an empty object", {}],
		["a stale value", { chatSendKey: "shift-enter" }],
		["the wrong type", { chatSendKey: 7 }],
		["a null", { chatSendKey: null }],
	] as const) {
		await db.update(userPrefs).set({ prefs: raw }).where(eq(userPrefs.userId, userId));
		eq_(`${label} reads back as the default`, (await getUserPrefs(userId)).chatSendKey, DEFAULT_CHAT_SEND_KEY);
	}

	await db.delete(users).where(eq(users.id, userId));
	userId = "";
	const orphans = await db.select().from(userPrefs).where(eq(userPrefs.userId, user.id));
	eq_("deleting the user takes the row with it", orphans.length, 0);
} finally {
	if (userId) await db.delete(users).where(eq(users.id, userId));
	await getSql().end();
}

console.log(`\n${failures.length === 0 ? "PASS" : "FAIL"} — ${passed} checks passed, ${failures.length} failed`);
if (failures.length > 0) {
	for (const failure of failures) console.log(`  · ${failure}`);
	process.exit(1);
}
