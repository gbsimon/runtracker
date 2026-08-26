import type { IngestSummary } from "./ingest/process";

/**
 * "Sync now" — the tap that replaces waiting on a background automation.
 *
 * Health Auto Export's own documentation is blunt about why the automatic
 * export misses runs: health data is unreadable while the phone is locked, and
 * Background App Refresh, Low Power Mode and iOS's memory pressure can each
 * skip a scheduled run outright. A tap can hit none of those — the phone is
 * unlocked and the app is in the foreground by definition. That is the whole
 * reliability argument for this path.
 *
 * The chain: button → `shortcuts://` deep link → a Shortcut whose steps are
 * Health Auto Export's own "Run Automation" action → the existing webhook at
 * `/api/ingest/health-auto-export`. Nothing server-side changes and nothing is
 * taken away: this is a second way to pull the same trigger, and the phone's
 * automations stay exactly where they are for the days they do fire.
 */

export const DEFAULT_SYNC_SHORTCUT_NAME = "RunTracker Sync";

/**
 * Whether `shortcuts://` leads to the Shortcuts app that has Health Auto
 * Export's action in it. The app is iPhone-only, so a Mac — which does have
 * Shortcuts — is still the wrong place to press the button. Sniffed on the
 * server like the coach composer's send key, so the first render already
 * knows; an iPad asking for desktop sites calls itself a Mac and gets the hint
 * it doesn't need, which costs a sentence, not the button.
 */
export function isIosUserAgent(userAgent: string): boolean {
	return /iPhone|iPad|iPod/i.test(userAgent);
}

/** Longer than any name Shortcuts shows without truncating it anyway. */
const MAX_SHORTCUT_NAME = 60;

/**
 * A shortcut is matched by name, so the stored value has to survive a round
 * trip through a text input. Whitespace is collapsed rather than rejected —
 * a pasted name with a stray double space is the common case, not an attack —
 * and anything left empty falls back to the name the instructions tell people
 * to use.
 */
export function normalizeSyncShortcutName(raw: unknown): string {
	if (typeof raw !== "string") return DEFAULT_SYNC_SHORTCUT_NAME;
	const name = raw.replace(/\s+/g, " ").trim().slice(0, MAX_SHORTCUT_NAME).trim();
	return name || DEFAULT_SYNC_SHORTCUT_NAME;
}

/** Where Shortcuts sends the phone once the export has been kicked off. */
export const SYNC_RETURN_PATH = "/sync";

/** How the round trip ended, as it comes back on the query string. */
export type SyncReturn = "done" | "error" | "cancel";

const RETURNS: readonly SyncReturn[] = ["done", "error", "cancel"];

export function parseSyncReturn(raw: unknown): SyncReturn | null {
	return typeof raw === "string" && (RETURNS as readonly string[]).includes(raw) ? (raw as SyncReturn) : null;
}

/**
 * `encodeURIComponent`, not `URLSearchParams`: the latter writes a space as
 * `+`, and Shortcuts percent-decodes the name rather than form-decoding it —
 * so "RunTracker Sync" would arrive as "RunTracker+Sync" and match nothing.
 */
function query(pairs: [string, string][]): string {
	return pairs.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join("&");
}

/**
 * The deep link the button navigates to.
 *
 * `at` is the moment of the tap, not of the render — it is what the page later
 * compares arriving payloads against, so a tab left open for an hour can't
 * mistake an old sync for this one. It rides in the callback URLs so the answer
 * survives even when iOS discards the page while Shortcuts is in front.
 *
 * `callbacks: false` drops the x-callback half and runs the shortcut plainly.
 * That is for RunTracker on the home screen: iOS opens a callback URL in
 * Safari rather than in the web app that asked, which lands the runner in a
 * second copy of the page — logged out, if Safari never was. Staying in
 * Shortcuts and swiping back costs one gesture and lands in the right place,
 * where the page has been polling since the tap.
 */
export function buildSyncShortcutUrl({
	name,
	origin,
	at,
	callbacks = true,
}: {
	name: string;
	origin: string;
	at: Date;
	callbacks?: boolean;
}): string {
	const shortcut: [string, string][] = [["name", normalizeSyncShortcutName(name)]];
	if (!callbacks) return `shortcuts://run-shortcut?${query(shortcut)}`;

	const base = origin.replace(/\/+$/, "");
	const back = (outcome: SyncReturn) =>
		`${base}${SYNC_RETURN_PATH}?${query([
			["synced", outcome],
			["since", at.toISOString()],
		])}`;

	return `shortcuts://x-callback-url/run-shortcut?${query([
		...shortcut,
		["x-success", back("done")],
		["x-error", back("error")],
		["x-cancel", back("cancel")],
	])}`;
}

/**
 * How far back a returned `since` may point. It rides in the URL, so it is the
 * user's to edit; the cap stops a stale tab — or a hand-typed value — from
 * making last week's sync read as the one that just happened. Nothing but the
 * wording of one card depends on it, which is why a cap is enough.
 */
export const SYNC_WINDOW_MS = 15 * 60_000;

export function clampSince(raw: unknown, now: Date): Date | null {
	if (typeof raw !== "string") return null;
	const at = new Date(raw);
	if (Number.isNaN(at.getTime())) return null;
	if (at.getTime() < now.getTime() - SYNC_WINDOW_MS) return null;
	// A phone clock that runs fast would otherwise wait for a payload stamped
	// after a moment that hasn't happened yet.
	return at.getTime() > now.getTime() ? now : at;
}

function plural(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * What landed, in one line. Deliberately the same vocabulary as the Settings
 * card's last-sync headline — the two describe the same event, and reading
 * differently would make them look like different facts.
 */
export function describeSyncOutcome(summary: IngestSummary | null): string {
	if (!summary) return "Your phone checked in, but sent nothing this build could read.";
	if (summary.error) return "Your phone's payload arrived but could not be processed — it is stored and can be reprocessed.";

	// One reading per metric per day, so four metrics over a week is 28.
	const readings = Object.values(summary.metrics?.days ?? {}).reduce((total, days) => total + days, 0);
	if (summary.workouts === 0 && readings > 0) {
		return `${plural(readings, "health-metric reading")} — sleep and recovery are up to date.`;
	}

	const parts = [
		summary.imported > 0 ? `${plural(summary.imported, "run")} imported` : null,
		summary.reconciled > 0 ? `${summary.reconciled} matched to a run you logged` : null,
		summary.enriched > 0 ? `${summary.enriched} filled in` : null,
		summary.duplicate > 0 ? `${summary.duplicate} already had` : null,
		summary.skipped > 0 ? `${summary.skipped} not a run` : null,
		summary.failed > 0 ? `${summary.failed} failed` : null,
	].filter(Boolean);

	if (parts.length > 0) return parts.join(" · ");
	return summary.workouts === 0
		? "Nothing new — your phone had no workouts waiting."
		: `${plural(summary.workouts, "workout")} arrived.`;
}
