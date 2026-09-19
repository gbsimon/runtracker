/**
 * Postgres error classification, kept dependency-free so it can be checked
 * without a database.
 *
 * `postgres.js` throws plain errors carrying the server's `code`; drizzle
 * wraps that in a `DrizzleQueryError` and re-parents it onto `.cause`. Both
 * shapes are checked here so a caller doesn't need to know which layer threw.
 */

const UNIQUE_VIOLATION = "23505";

function errorCode(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null) return undefined;
	const code = (error as { code?: unknown }).code;
	return typeof code === "string" ? code : undefined;
}

/** True for a Postgres unique-constraint violation, unwrapped or drizzle-wrapped. */
export function isUniqueViolation(error: unknown): boolean {
	if (errorCode(error) === UNIQUE_VIOLATION) return true;
	if (typeof error !== "object" || error === null) return false;
	return errorCode((error as { cause?: unknown }).cause) === UNIQUE_VIOLATION;
}
