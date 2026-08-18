import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export type Database = PostgresJsDatabase<typeof schema>;

/** The pool or an open transaction, so a write can join a caller's transaction. */
export type DbExecutor = Database | Parameters<Parameters<Database["transaction"]>[0]>[0];

const globalForDb = globalThis as typeof globalThis & {
	__runtrackerDb?: Database;
	__runtrackerSql?: postgres.Sql;
};

/**
 * The raw postgres-js client under the ORM.
 *
 * Needed for the one thing a pooled query can't express: a session-level
 * advisory lock, which lives on a single connection and would otherwise be
 * unlocked on whichever other connection the pool handed out next.
 * `sql.reserve()` pins one for the duration. Everything else should go through
 * `getDb()`.
 */
export function getSql(): postgres.Sql {
	if (!globalForDb.__runtrackerSql) {
		const url = process.env.DATABASE_URL;
		if (!url) throw new Error("DATABASE_URL is not set");
		globalForDb.__runtrackerSql = postgres(url, { max: 10 });
	}
	return globalForDb.__runtrackerSql;
}

export function getDb(): Database {
	if (!globalForDb.__runtrackerDb) {
		globalForDb.__runtrackerDb = drizzle(getSql(), { schema });
	}
	return globalForDb.__runtrackerDb;
}
