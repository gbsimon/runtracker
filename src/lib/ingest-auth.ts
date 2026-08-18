import { createHash, timingSafeEqual } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { users } from "@/db/schema";
import { resolveIngestToken, stampTokenUse } from "./ingest/tokens";

const HEADER = "x-ingest-token";

const sha256 = (value: string) => createHash("sha256").update(value).digest();

/**
 * The Phase 0 capture secret: one shared `INGEST_TOKEN` in the environment.
 * Still honoured because it is what Simon's phone has been posting since the
 * schema spike — the `/latest` debug route authenticates with it too.
 */
export function isAuthorizedIngest(request: Request): boolean {
	const expected = process.env.INGEST_TOKEN;
	if (!expected) return false;

	const provided = request.headers.get(HEADER);
	if (!provided) return false;

	return timingSafeEqual(sha256(provided), sha256(expected));
}

export type IngestPrincipal = {
	userId: string;
	/** `legacy-env` means the shared secret, which is attributed to the owner. */
	via: "token" | "legacy-env";
};

/** The oldest owner account — who the shared secret's payloads belong to. */
async function ownerUserId(): Promise<string | null> {
	const [owner] = await getDb()
		.select({ id: users.id })
		.from(users)
		.where(eq(users.role, "owner"))
		.orderBy(asc(users.createdAt))
		.limit(1);
	return owner?.id ?? null;
}

/**
 * Who a Health Auto Export POST belongs to. Per-user tokens are checked first;
 * the shared secret is the fallback so an already-configured phone keeps
 * syncing until its owner swaps in a personal token.
 */
export async function authenticateIngest(request: Request): Promise<IngestPrincipal | null> {
	const provided = request.headers.get(HEADER)?.trim();
	if (!provided) return null;

	const resolved = await resolveIngestToken(provided);
	if (resolved) {
		// Best-effort: a stale "last used" must not cost us the payload.
		await stampTokenUse(resolved.tokenId).catch((error) => {
			console.error("[ingest] failed to stamp token use", error);
		});
		return { userId: resolved.userId, via: "token" };
	}

	if (!isAuthorizedIngest(request)) return null;

	const userId = await ownerUserId();
	return userId ? { userId, via: "legacy-env" } : null;
}
