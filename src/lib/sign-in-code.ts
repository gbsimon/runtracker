import { CODE_LENGTH, CODE_TTL_MS, MAX_CODE_ATTEMPTS } from "@/lib/sign-in-code-limits";
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

/**
 * Pure helpers for the numeric sign-in code that rides along with the magic
 * link. No database here, so `pnpm check:sign-in-code` can exercise all of it.
 *
 * The code is a second way to follow the same Auth.js magic link: the link's
 * callback URL is stored encrypted next to a hash of the code, and a correct
 * code hands the browser that URL. Typing it keeps an iOS home-screen web app
 * in its own cookie jar, where tapping the link in Mail would open Safari.
 */

export { CODE_LENGTH, CODE_TTL_MINUTES, CODE_TTL_MS, MAX_CODE_ATTEMPTS } from "@/lib/sign-in-code-limits";

const IV_BYTES = 12;
const TAG_BYTES = 16;

export type SignInCodeKeys = { hmacKey: Buffer; encKey: Buffer };

/** Both keys come from `AUTH_SECRET`, each under its own HKDF label. */
export function deriveSignInCodeKeys(secret: string): SignInCodeKeys {
	if (!secret) throw new Error("AUTH_SECRET is not set");
	const derive = (info: string) => Buffer.from(hkdfSync("sha256", secret, "runtracker-sign-in-code", info, 32));
	return { hmacKey: derive("code-hmac"), encKey: derive("callback-url-aes-256-gcm") };
}

/** The secret Auth.js itself signs with. */
export function authSecret(): string {
	return process.env.AUTH_SECRET?.trim() || process.env.NEXTAUTH_SECRET?.trim() || "";
}

export function generateSignInCode(): string {
	return randomInt(0, 10 ** CODE_LENGTH)
		.toString()
		.padStart(CODE_LENGTH, "0");
}

/**
 * Accepts what people actually type or paste: spaces, dashes, full-width
 * digits. Returns null unless exactly six digits remain.
 */
export function normalizeSignInCode(input: string): string | null {
	const digits = input.normalize("NFKC").replace(/[\s\-–—.]/g, "");
	return new RegExp(`^\\d{${CODE_LENGTH}}$`).test(digits) ? digits : null;
}

/** Bound to the address, so a stored hash is useless for any other row. */
export function hashSignInCode(keys: SignInCodeKeys, identifier: string, code: string): string {
	return createHmac("sha256", keys.hmacKey).update(`${identifier}\n${code}`).digest("base64url");
}

export function signInCodeMatches(keys: SignInCodeKeys, identifier: string, code: string, storedHash: string): boolean {
	const candidate = Buffer.from(hashSignInCode(keys, identifier, code));
	const stored = Buffer.from(storedHash);
	return candidate.length === stored.length && timingSafeEqual(candidate, stored);
}

/**
 * AES-256-GCM, with the address as associated data so a ciphertext can't be
 * moved to another row. Output: base64url(iv | tag | ciphertext).
 */
export function encryptCallbackUrl(keys: SignInCodeKeys, identifier: string, url: string): string {
	const iv = randomBytes(IV_BYTES);
	const cipher = createCipheriv("aes-256-gcm", keys.encKey, iv);
	cipher.setAAD(Buffer.from(identifier));
	const ciphertext = Buffer.concat([cipher.update(url, "utf8"), cipher.final()]);
	return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64url");
}

/** Null on any tampering, a wrong key, or a mismatched address. */
export function decryptCallbackUrl(keys: SignInCodeKeys, identifier: string, sealed: string): string | null {
	try {
		const raw = Buffer.from(sealed, "base64url");
		if (raw.length <= IV_BYTES + TAG_BYTES) return null;
		const decipher = createDecipheriv("aes-256-gcm", keys.encKey, raw.subarray(0, IV_BYTES));
		decipher.setAAD(Buffer.from(identifier));
		decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
		return Buffer.concat([decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString("utf8");
	} catch {
		return null;
	}
}

export function codeExpiry(now: Date = new Date()): Date {
	return new Date(now.getTime() + CODE_TTL_MS);
}

/** A code can still be tried while it is unexpired and has guesses left. */
export function isCodeRedeemable(row: { expires: Date; attempts: number }, now: Date = new Date()): boolean {
	return row.expires.getTime() > now.getTime() && row.attempts < MAX_CODE_ATTEMPTS;
}

/** After a miss that brought the counter to `attempts`, is the code spent? */
export function isCodeExhausted(attempts: number): boolean {
	return attempts >= MAX_CODE_ATTEMPTS;
}

/**
 * The browser is sent to the path only, never the absolute URL Auth.js built:
 * a standalone web app must stay on its own origin to keep its cookie jar, and
 * the stored URL could carry a host the app isn't served from. Anything that
 * isn't the resend callback is refused.
 */
export function callbackPathFromUrl(url: string): string | null {
	try {
		const parsed = new URL(url);
		if (!parsed.pathname.endsWith("/callback/resend") || parsed.pathname.startsWith("//")) return null;
		return `${parsed.pathname}${parsed.search}`;
	} catch {
		return null;
	}
}
