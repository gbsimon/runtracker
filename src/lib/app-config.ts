import { eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { appConfig } from "@/db/schema";

/**
 * The `app_config` table, read and written as typed values.
 *
 * Deliberately thin: callers own their key's shape and validate what comes
 * back, because a row written by an older build is the normal case rather than
 * corruption. `readAppConfig` therefore hands over `unknown` and never throws.
 */

export async function readAppConfig(key: string): Promise<{ value: unknown; updatedAt: Date } | null> {
	const [row] = await getDb()
		.select({ value: appConfig.value, updatedAt: appConfig.updatedAt })
		.from(appConfig)
		.where(eq(appConfig.key, key))
		.limit(1);
	return row ?? null;
}

/** Last write wins — these are single-operator settings, not a contended counter. */
export async function writeAppConfig(key: string, value: unknown): Promise<void> {
	await getDb()
		.insert(appConfig)
		.values({ key, value })
		.onConflictDoUpdate({
			target: appConfig.key,
			set: { value: sql`excluded.value`, updatedAt: new Date() },
		});
}

export async function clearAppConfig(key: string): Promise<void> {
	await getDb().delete(appConfig).where(eq(appConfig.key, key));
}
