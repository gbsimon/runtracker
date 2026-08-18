import { asc, count, desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { chatMessages } from "@/db/schema";

export type ChatRole = "user" | "assistant";

export type ChatMessageRecord = {
	id: string;
	role: ChatRole;
	content: string;
	createdAt: Date;
};

/** How much history rides along on each API call — v1's `chatHistory.slice(-20)`. */
export const CHAT_HISTORY_LIMIT = 20;

function toRecord(row: typeof chatMessages.$inferSelect): ChatMessageRecord {
	return {
		id: row.id,
		role: row.role === "user" ? "user" : "assistant",
		content: row.content,
		createdAt: row.createdAt,
	};
}

/**
 * How much of the thread the sidebar renders. The coach panel now loads on
 * every page, so shipping an unbounded history (Simon's import alone is 200+
 * messages) would ride along with each navigation. Older turns stay in the
 * database and in the export — only the visible scrollback is capped.
 */
export const CHAT_VIEW_LIMIT = 100;

/**
 * Oldest first, the order both the thread and the API want. With `limit`, the
 * *newest* `limit` messages are returned — still oldest-first.
 */
export async function listChatMessages(userId: string, limit?: number): Promise<ChatMessageRecord[]> {
	const query = getDb().select().from(chatMessages).where(eq(chatMessages.userId, userId));

	if (limit === undefined) {
		return (await query.orderBy(asc(chatMessages.createdAt), asc(chatMessages.id))).map(toRecord);
	}

	const rows = await query.orderBy(desc(chatMessages.createdAt), desc(chatMessages.id)).limit(limit);
	return rows.reverse().map(toRecord);
}

export async function countChatMessages(userId: string): Promise<number> {
	const [row] = await getDb()
		.select({ total: count() })
		.from(chatMessages)
		.where(eq(chatMessages.userId, userId));
	return row?.total ?? 0;
}

export async function appendChatMessage(userId: string, role: ChatRole, content: string): Promise<ChatMessageRecord> {
	const [row] = await getDb().insert(chatMessages).values({ userId, role, content }).returning();
	return toRecord(row);
}

export async function clearChatMessages(userId: string): Promise<void> {
	await getDb().delete(chatMessages).where(eq(chatMessages.userId, userId));
}

/**
 * The trailing slice sent to the API. The API rejects a conversation that
 * opens on an assistant turn, which a naive slice can produce — v1 never hit
 * it because it only ever sent 20 messages from a browser-local array that
 * always started on a user turn.
 */
export function toApiMessages(history: ChatMessageRecord[], limit = CHAT_HISTORY_LIMIT) {
	const recent = history.slice(-limit);
	const start = recent.findIndex((message) => message.role === "user");
	if (start === -1) return [];
	return recent.slice(start).map((message) => ({ role: message.role, content: message.content }));
}
