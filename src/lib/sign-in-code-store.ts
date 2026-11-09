import { and, eq, lt, or, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { signInCodes } from "@/db/schema";
import {
	authSecret,
	callbackPathFromUrl,
	codeExpiry,
	decryptCallbackUrl,
	deriveSignInCodeKeys,
	encryptCallbackUrl,
	generateSignInCode,
	hashSignInCode,
	isCodeExhausted,
	MAX_CODE_ATTEMPTS,
	normalizeSignInCode,
	signInCodeMatches,
} from "@/lib/sign-in-code";

/**
 * Stores a fresh code for `identifier`, replacing any earlier one, and returns
 * it for the email. The raw magic-link token never reaches the table in clear:
 * only the code's HMAC and the encrypted callback URL are kept.
 */
export async function issueSignInCode(identifier: string, url: string): Promise<string> {
	const keys = deriveSignInCodeKeys(authSecret());
	const code = generateSignInCode();
	const db = getDb();

	// Housekeeping: nothing reads an expired row, so drop them as we go.
	await db.delete(signInCodes).where(lt(signInCodes.expires, new Date()));

	const values = {
		codeHash: hashSignInCode(keys, identifier, code),
		encryptedUrl: encryptCallbackUrl(keys, identifier, url),
		attempts: 0,
		expires: codeExpiry(),
		createdAt: new Date(),
	};
	await db
		.insert(signInCodes)
		.values({ identifier, ...values })
		.onConflictDoUpdate({ target: signInCodes.identifier, set: values });

	return code;
}

/**
 * Spends one guess on `identifier`'s code. Returns the same-origin callback
 * path to send the browser to, or null for every failure — unknown address,
 * expired, exhausted, wrong — so the caller can't tell them apart.
 *
 * The guess is counted *before* the comparison, in one atomic UPDATE guarded
 * by `attempts < MAX`, so parallel requests can't get more than MAX tries
 * between them. A match is redeemed by a DELETE that must find the row, so a
 * code also works only once under concurrency.
 */
export async function redeemSignInCode(identifier: string, input: string): Promise<string | null> {
	const code = normalizeSignInCode(input);
	if (!code) return null;

	const keys = deriveSignInCodeKeys(authSecret());
	const db = getDb();

	const [row] = await db
		.update(signInCodes)
		.set({ attempts: sql`${signInCodes.attempts} + 1` })
		.where(
			and(
				eq(signInCodes.identifier, identifier),
				sql`${signInCodes.expires} > now()`,
				lt(signInCodes.attempts, MAX_CODE_ATTEMPTS),
			),
		)
		.returning({ codeHash: signInCodes.codeHash, encryptedUrl: signInCodes.encryptedUrl, attempts: signInCodes.attempts });

	if (!row) {
		// Expired or exhausted rows have nothing left to give.
		await db
			.delete(signInCodes)
			.where(
				and(
					eq(signInCodes.identifier, identifier),
					or(sql`${signInCodes.expires} <= now()`, sql`${signInCodes.attempts} >= ${MAX_CODE_ATTEMPTS}`),
				),
			);
		return null;
	}

	if (!signInCodeMatches(keys, identifier, code, row.codeHash)) {
		if (isCodeExhausted(row.attempts)) {
			await db.delete(signInCodes).where(and(eq(signInCodes.identifier, identifier), eq(signInCodes.codeHash, row.codeHash)));
		}
		return null;
	}

	const [redeemed] = await db
		.delete(signInCodes)
		.where(and(eq(signInCodes.identifier, identifier), eq(signInCodes.codeHash, row.codeHash)))
		.returning({ identifier: signInCodes.identifier });
	if (!redeemed) return null;

	const url = decryptCallbackUrl(keys, identifier, row.encryptedUrl);
	return url ? callbackPathFromUrl(url) : null;
}

/** Once the link has been followed, its code has no reason to live on. */
export async function clearSignInCodes(identifier: string): Promise<void> {
	await getDb().delete(signInCodes).where(eq(signInCodes.identifier, identifier));
}
