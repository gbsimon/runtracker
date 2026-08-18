/**
 * Per-user ingest tokens: the secret the Health Auto Export app carries in its
 * `x-ingest-token` header. Only the SHA-256 digest is stored, so a database
 * dump can't be pointed at anyone's account — the plaintext is shown once, at
 * creation, and never again.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { ingestTokens } from "@/db/schema";

export type IngestTokenRecord = typeof ingestTokens.$inferSelect;

/** Recognisable in a phone's header field, and impossible to confuse with a session. */
const PREFIX = "rt_";

export function generateIngestToken(): string {
	return PREFIX + randomBytes(32).toString("base64url");
}

export function hashIngestToken(token: string): string {
	return createHash("sha256").update(token.trim()).digest("hex");
}

export async function createIngestToken(userId: string, label: string | null): Promise<{ token: string; id: string }> {
	const token = generateIngestToken();
	const [row] = await getDb()
		.insert(ingestTokens)
		.values({ userId, tokenHash: hashIngestToken(token), label: label?.trim() || null })
		.returning({ id: ingestTokens.id });
	return { token, id: row.id };
}

export async function listIngestTokens(userId: string): Promise<IngestTokenRecord[]> {
	return getDb().select().from(ingestTokens).where(eq(ingestTokens.userId, userId)).orderBy(desc(ingestTokens.createdAt));
}

export async function revokeIngestToken(userId: string, id: string): Promise<boolean> {
	const deleted = await getDb()
		.delete(ingestTokens)
		.where(and(eq(ingestTokens.userId, userId), eq(ingestTokens.id, id)))
		.returning({ id: ingestTokens.id });
	return deleted.length > 0;
}

/**
 * The lookup is by digest, which is why it can use the unique index: the row
 * is found by what the caller proved they know, not by an id they supplied.
 * The digests are then compared in constant time as well — the index probe is
 * the only part that isn't, and a timing leak there reveals a SHA-256 output,
 * not the token behind it.
 */
export async function resolveIngestToken(raw: string): Promise<{ userId: string; tokenId: string } | null> {
	const digest = hashIngestToken(raw);
	const [row] = await getDb()
		.select({ id: ingestTokens.id, userId: ingestTokens.userId, tokenHash: ingestTokens.tokenHash })
		.from(ingestTokens)
		.where(eq(ingestTokens.tokenHash, digest))
		.limit(1);

	if (!row) return null;

	const expected = Buffer.from(row.tokenHash, "hex");
	const provided = Buffer.from(digest, "hex");
	if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) return null;

	return { userId: row.userId, tokenId: row.id };
}

export async function stampTokenUse(tokenId: string): Promise<void> {
	await getDb().update(ingestTokens).set({ lastUsedAt: new Date() }).where(eq(ingestTokens.id, tokenId));
}
