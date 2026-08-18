/**
 * Unit checks for the per-user preferences: the composer's send-key decision
 * and the row it is stored in.
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
import { countUnseenSkipped, groupSkippedWorkouts, type SkippedItem } from "../src/lib/ingest/skipped.ts";
import { allowRunName, getUserPrefs, setChatSendKey, setSkippedSeenAt } from "../src/lib/user-prefs.ts";

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

	// A row written by hand, by an older build, or by a future one.
	await db
		.update(userPrefs)
		.set({ prefs: { extraRunFragments: ["Marche", "a", 7, "marche"], skippedSeenAt: "whenever" } })
		.where(eq(userPrefs.userId, userId));
	const salvaged = await getUserPrefs(userId);
	eq_("a messy allowlist is normalized on the way out", salvaged.extraRunFragments.join(","), "marche");
	eq_("an unparseable stamp reads as never looked", salvaged.skippedSeenAt, null);

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
