import { eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { userPrefs } from "@/db/schema";
import { type ChatSendKey, normalizeChatSendKey } from "./chat-send-key";
import { normalizeRunFragments } from "./ingest/hae";

/**
 * The `user_prefs` table, read and written as typed values. Like the plan
 * shapes, the stored jsonb is normalized on the way out rather than trusted:
 * a row written by an older build is the normal case, not corruption.
 */
export type UserPrefs = {
	chatSendKey: ChatSendKey;
	/**
	 * Workout-name fragments this user has allowed as runs from the Sync tab,
	 * merged into the parser's built-in list for their payloads only.
	 */
	extraRunFragments: string[];
	/**
	 * When they last looked at the skipped-activity list, as an ISO instant.
	 * `null` — never looked — makes every stored skip unseen, which is what a
	 * first visit should show.
	 */
	skippedSeenAt: string | null;
};

/** Anything unparseable reads as "never", so a bad value can only over-notify. */
function normalizeSeenAt(raw: unknown): string | null {
	if (typeof raw !== "string") return null;
	const at = new Date(raw);
	return Number.isNaN(at.getTime()) ? null : at.toISOString();
}

function normalizeUserPrefs(raw: unknown): UserPrefs {
	const source = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
	return {
		chatSendKey: normalizeChatSendKey(source.chatSendKey),
		extraRunFragments: normalizeRunFragments(source.extraRunFragments),
		skippedSeenAt: normalizeSeenAt(source.skippedSeenAt),
	};
}

/** A user who has never saved a preference simply gets the defaults. */
export async function getUserPrefs(userId: string): Promise<UserPrefs> {
	const [row] = await getDb()
		.select({ prefs: userPrefs.prefs })
		.from(userPrefs)
		.where(eq(userPrefs.userId, userId))
		.limit(1);
	return normalizeUserPrefs(row?.prefs);
}

/**
 * Merges the given keys rather than writing the whole object, so saving a
 * preference in one tab can't revert another saved in a second — the reasoning
 * behind `setHidePastWeeks`, with an upsert on top because unlike a plan the
 * row may not exist yet. `excluded.prefs` is the patch itself, so siblings the
 * caller never mentioned survive untouched.
 */
async function mergeUserPrefs(userId: string, patch: Partial<UserPrefs>): Promise<void> {
	await getDb()
		.insert(userPrefs)
		.values({ userId, prefs: patch })
		.onConflictDoUpdate({
			target: userPrefs.userId,
			set: {
				prefs: sql`${userPrefs.prefs} || excluded.prefs`,
				updatedAt: new Date(),
			},
		});
}

export async function setChatSendKey(userId: string, mode: ChatSendKey): Promise<void> {
	await mergeUserPrefs(userId, { chatSendKey: mode });
}

/** What the ingest pipeline hands the parser. */
export async function getExtraRunFragments(userId: string): Promise<string[]> {
	return (await getUserPrefs(userId)).extraRunFragments;
}

/**
 * Adds a workout name to this user's run allowlist, folded to a fragment.
 * Read-modify-write on the array — jsonb's `||` merges objects, not the
 * elements of an array, so the merged list has to be assembled here. The race
 * it leaves is two allows landing in the same instant from one person's two
 * tabs, which costs a click to redo.
 *
 * Returns `null` when the name can't become a usable fragment; `added` is false
 * when it was already allowed, which the caller reports rather than reprocessing.
 */
export async function allowRunName(
	userId: string,
	name: string,
): Promise<{ fragment: string; fragments: string[]; added: boolean } | null> {
	const [fragment] = normalizeRunFragments([name]);
	if (!fragment) return null;

	const current = await getExtraRunFragments(userId);
	if (current.includes(fragment)) return { fragment, fragments: current, added: false };

	const fragments = normalizeRunFragments([...current, fragment]);
	// The cap can swallow the addition outright once the list is full.
	if (!fragments.includes(fragment)) return { fragment, fragments: current, added: false };

	await mergeUserPrefs(userId, { extraRunFragments: fragments });
	return { fragment, fragments, added: true };
}

/**
 * Stamps the skipped list as seen up to a given instant. Takes the instant
 * rather than reading the clock so the caller can stamp the newest event it
 * actually rendered — a sync that lands while the page is open stays unseen.
 */
export async function setSkippedSeenAt(userId: string, at: Date): Promise<void> {
	await mergeUserPrefs(userId, { skippedSeenAt: at.toISOString() });
}
