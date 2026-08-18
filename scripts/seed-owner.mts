/**
 * Idempotent upsert of the OWNER_EMAIL account with role `owner`.
 * Run with `pnpm db:seed-owner` (locally) or against any DATABASE_URL.
 */
import { existsSync } from "node:fs";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { users } from "../src/db/schema.ts";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");

const email = process.env.OWNER_EMAIL?.trim().toLowerCase();
const databaseUrl = process.env.DATABASE_URL;

if (!email) {
	console.error("OWNER_EMAIL is not set. Add it to .env.local (or the deploy environment) and retry.");
	process.exit(1);
}
if (!databaseUrl) {
	console.error("DATABASE_URL is not set.");
	process.exit(1);
}

const client = postgres(databaseUrl, { max: 1 });
const db = drizzle(client, { schema: { users } });

const [owner] = await db
	.insert(users)
	.values({ email, role: "owner" })
	.onConflictDoUpdate({ target: users.email, set: { role: "owner" } })
	.returning({ id: users.id, email: users.email, role: users.role });

console.log(`[seed] owner ready: ${owner.email} (${owner.role}, ${owner.id})`);

await client.end();
