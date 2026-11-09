/**
 * Unit checks for the numeric sign-in code that rides along with the magic link.
 *
 *   pnpm check:sign-in-code
 *
 * Two halves. The pure one needs nothing: code generation and input cleanup,
 * the HMAC, the AES-GCM round trip and its tamper checks, expiry and attempt
 * limits, the callback-path guard, and the email bodies. The wired one runs the
 * real issue/redeem queries against the local Postgres (`docker compose up -d
 * && pnpm db:migrate`) on a throwaway address; it is skipped, not failed, when
 * no database answers.
 */

import { existsSync } from "node:fs";
import { buildSignInEmail } from "../src/lib/auth-email.ts";
import {
	CODE_LENGTH,
	CODE_TTL_MS,
	callbackPathFromUrl,
	codeExpiry,
	decryptCallbackUrl,
	deriveSignInCodeKeys,
	encryptCallbackUrl,
	generateSignInCode,
	hashSignInCode,
	isCodeExhausted,
	isCodeRedeemable,
	MAX_CODE_ATTEMPTS,
	normalizeSignInCode,
	signInCodeMatches,
} from "../src/lib/sign-in-code.ts";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");

let passed = 0;
const failures: string[] = [];

function check(label: string, ok: boolean, detail = ""): void {
	if (ok) {
		passed += 1;
		console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ""}`);
	} else {
		failures.push(label);
		console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
	}
}

function eq_(label: string, actual: unknown, expected: unknown): void {
	check(label, Object.is(actual, expected), `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

function section(title: string): void {
	console.log(`\n${title}`);
}

const SECRET = "check-sign-in-code-secret-not-a-real-one";
const keys = deriveSignInCodeKeys(SECRET);
const otherKeys = deriveSignInCodeKeys(`${SECRET}-rotated`);
const EMAIL = "runner@example.com";
const LINK =
	"https://runtracker.example/api/auth/callback/resend?callbackUrl=https%3A%2F%2Fruntracker.example%2Fplan&token=abc123def456&email=runner%40example.com";

// ---------------------------------------------------------------------------
section("Keys");
// ---------------------------------------------------------------------------

check("derivation is deterministic", deriveSignInCodeKeys(SECRET).hmacKey.equals(keys.hmacKey));
check("the HMAC and encryption keys differ", !keys.hmacKey.equals(keys.encKey));
check("both keys are 32 bytes", keys.hmacKey.length === 32 && keys.encKey.length === 32);
check("a different secret gives different keys", !otherKeys.encKey.equals(keys.encKey));
{
	let threw = false;
	try {
		deriveSignInCodeKeys("");
	} catch {
		threw = true;
	}
	check("an empty secret is refused", threw);
}

// ---------------------------------------------------------------------------
section("Code generation and input cleanup");
// ---------------------------------------------------------------------------

{
	const codes = Array.from({ length: 2000 }, generateSignInCode);
	check("every code is exactly six digits", codes.every((code) => /^\d{6}$/.test(code)));
	check("codes vary", new Set(codes).size > 1900, `${new Set(codes).size} distinct of 2000`);
	check("leading zeros are kept", codes.some((code) => code.startsWith("0")));
}
eq_("CODE_LENGTH is 6", CODE_LENGTH, 6);
eq_("plain digits", normalizeSignInCode("123456"), "123456");
eq_("spaced like the email", normalizeSignInCode("123 456"), "123456");
eq_("dashed", normalizeSignInCode("123-456"), "123456");
eq_("padded with whitespace", normalizeSignInCode("  123456\n"), "123456");
eq_("full-width digits", normalizeSignInCode("１２３４５６"), "123456");
eq_("too short", normalizeSignInCode("12345"), null);
eq_("too long", normalizeSignInCode("1234567"), null);
eq_("letters", normalizeSignInCode("12a456"), null);
eq_("empty", normalizeSignInCode(""), null);

// ---------------------------------------------------------------------------
section("Code hashing");
// ---------------------------------------------------------------------------

{
	const hash = hashSignInCode(keys, EMAIL, "042917");
	check("the hash isn't the code", !hash.includes("042917"));
	check("the right code matches", signInCodeMatches(keys, EMAIL, "042917", hash));
	check("a wrong code doesn't", !signInCodeMatches(keys, EMAIL, "042918", hash));
	check("the right code for another address doesn't", !signInCodeMatches(keys, "someone@example.com", "042917", hash));
	check("the right code under another secret doesn't", !signInCodeMatches(otherKeys, EMAIL, "042917", hash));
	check("a truncated stored hash doesn't throw, just fails", !signInCodeMatches(keys, EMAIL, "042917", hash.slice(0, 10)));
	check("an empty stored hash fails", !signInCodeMatches(keys, EMAIL, "042917", ""));
}

// ---------------------------------------------------------------------------
section("Callback URL encryption");
// ---------------------------------------------------------------------------

{
	const sealed = encryptCallbackUrl(keys, EMAIL, LINK);
	eq_("round trip", decryptCallbackUrl(keys, EMAIL, sealed), LINK);
	check("the token isn't readable in the sealed value", !sealed.includes("abc123def456") && !sealed.includes("token"));
	check("two seals of the same URL differ (fresh IV)", encryptCallbackUrl(keys, EMAIL, LINK) !== sealed);
	eq_("another address can't open it", decryptCallbackUrl(keys, "someone@example.com", sealed), null);
	eq_("another secret can't open it", decryptCallbackUrl(otherKeys, EMAIL, sealed), null);

	const raw = Buffer.from(sealed, "base64url");
	raw[raw.length - 1] ^= 0x01;
	eq_("a flipped ciphertext bit is caught", decryptCallbackUrl(keys, EMAIL, raw.toString("base64url")), null);
	const tag = Buffer.from(sealed, "base64url");
	tag[14] ^= 0x01;
	eq_("a flipped tag bit is caught", decryptCallbackUrl(keys, EMAIL, tag.toString("base64url")), null);
	eq_("garbage is refused", decryptCallbackUrl(keys, EMAIL, "not-a-sealed-value"), null);
	eq_("empty is refused", decryptCallbackUrl(keys, EMAIL, ""), null);
}

// ---------------------------------------------------------------------------
section("Expiry and attempts");
// ---------------------------------------------------------------------------

{
	const now = new Date("2026-11-09T12:00:00Z");
	const expires = codeExpiry(now);
	eq_("a code lives 15 minutes", expires.getTime() - now.getTime(), 15 * 60 * 1000);
	eq_("CODE_TTL_MS agrees", CODE_TTL_MS, 15 * 60 * 1000);
	check("fresh: redeemable", isCodeRedeemable({ expires, attempts: 0 }, now));
	check("one second before expiry: redeemable", isCodeRedeemable({ expires, attempts: 0 }, new Date(expires.getTime() - 1000)));
	check("at expiry: not redeemable", !isCodeRedeemable({ expires, attempts: 0 }, expires));
	check("after expiry: not redeemable", !isCodeRedeemable({ expires, attempts: 0 }, new Date(expires.getTime() + 1)));
	eq_("MAX_CODE_ATTEMPTS is 5", MAX_CODE_ATTEMPTS, 5);
	check(
		`with ${MAX_CODE_ATTEMPTS - 1} guesses spent: redeemable`,
		isCodeRedeemable({ expires, attempts: MAX_CODE_ATTEMPTS - 1 }, now),
	);
	check(`with ${MAX_CODE_ATTEMPTS} guesses spent: not redeemable`, !isCodeRedeemable({ expires, attempts: MAX_CODE_ATTEMPTS }, now));
	check("a 4th miss leaves the code alive", !isCodeExhausted(4));
	check("the 5th miss burns it", isCodeExhausted(5));
}

// ---------------------------------------------------------------------------
section("Callback path guard");
// ---------------------------------------------------------------------------

eq_(
	"the resend callback becomes a same-origin path",
	callbackPathFromUrl(LINK),
	"/api/auth/callback/resend?callbackUrl=https%3A%2F%2Fruntracker.example%2Fplan&token=abc123def456&email=runner%40example.com",
);
eq_("another route is refused", callbackPathFromUrl("https://runtracker.example/settings"), null);
eq_("a protocol-relative path is refused", callbackPathFromUrl("https://runtracker.example//evil.example/callback/resend"), null);
eq_("garbage is refused", callbackPathFromUrl("not a url"), null);

// ---------------------------------------------------------------------------
section("Email bodies");
// ---------------------------------------------------------------------------

{
	const host = "runtracker.example";
	const withCode = buildSignInEmail({ url: LINK, host, code: "042917" });
	check("subject leads with the code", withCode.subject.startsWith("042917 "), withCode.subject);
	check("text carries the code", withCode.text.includes("Or enter this code in the app: 042917"));
	check("text says when the code expires", withCode.text.includes("expires in 15 minutes"));
	check("text still carries the link", withCode.text.includes(LINK));
	check("html carries the code", withCode.html.includes(">042917<"));
	check("html keeps the button", withCode.html.includes(`<a href="${LINK}"`) && withCode.html.includes(">Sign in</a>"));
	check("html keeps the paste-able link", withCode.html.includes(`Or paste this into your browser:<br>${LINK}`));

	const linkOnly = buildSignInEmail({ url: LINK, host, code: null });
	eq_("no code: the old subject", linkOnly.subject, `Your RunTracker sign-in link (${host})`);
	eq_(
		"no code: the old text body",
		linkOnly.text,
		`Sign in to RunTracker (${host})\n\n${LINK}\n\nThe link expires in 24 hours and can only be used once. If you didn't request it, ignore this email.\n`,
	);
	check("no code: nothing about a code in the html", !linkOnly.html.includes("code"));
}

// ---------------------------------------------------------------------------
section("Database (issue / redeem against the local Postgres)");
// ---------------------------------------------------------------------------

await (async () => {
	if (!process.env.DATABASE_URL) {
		console.log("  – skipped: DATABASE_URL is not set");
		return;
	}
	const { getDb, getSql } = await import("../src/db/index.ts");
	try {
		await getSql()`select 1 from sign_in_codes limit 1`;
	} catch (error) {
		console.log(`  – skipped: no migrated database answered (${error instanceof Error ? error.message : String(error)})`);
		await getSql()
			.end()
			.catch(() => {});
		return;
	}

	process.env.AUTH_SECRET ||= SECRET;
	const { eq } = await import("drizzle-orm");
	const { signInCodes } = await import("../src/db/schema.ts");
	const { clearSignInCodes, issueSignInCode, redeemSignInCode } = await import("../src/lib/sign-in-code-store.ts");
	const address = `check-sign-in-code-${Date.now()}@example.invalid`;
	const link = LINK.replace("runner%40example.com", encodeURIComponent(address));
	const wrong = (code: string) => (code === "000000" ? "000001" : "000000");

	try {
		const first = await issueSignInCode(address, link);
		const second = await issueSignInCode(address, link);
		const rows = await getDb().select().from(signInCodes).where(eq(signInCodes.identifier, address));
		eq_("a second request replaces the first: one row", rows.length, 1);
		check("the row holds neither the code nor the token", !JSON.stringify(rows[0]).includes(second) && !JSON.stringify(rows[0]).includes("abc123def456"));
		if (first !== second) eq_("the replaced code no longer works", await redeemSignInCode(address, first), null);

		eq_("unknown address", await redeemSignInCode("nobody@example.invalid", second), null);
		eq_("a malformed code doesn't spend a guess", await redeemSignInCode(address, "12"), null);
		const [afterMalformed] = await getDb().select().from(signInCodes).where(eq(signInCodes.identifier, address));
		eq_("…counter unchanged", afterMalformed?.attempts, first !== second ? 1 : 0);

		await issueSignInCode(address, link).then(async (code) => {
			eq_("a wrong guess fails", await redeemSignInCode(address, wrong(code)), null);
			const path = await redeemSignInCode(address, code.replace(/^(\d{3})/, "$1 "));
			check("the right code (typed with a space) gives the callback path", path?.startsWith("/api/auth/callback/resend?") ?? false, String(path));
			eq_("…and only once", await redeemSignInCode(address, code), null);
		});

		const burnt = await issueSignInCode(address, link);
		for (let i = 0; i < MAX_CODE_ATTEMPTS; i += 1) await redeemSignInCode(address, wrong(burnt));
		eq_(`after ${MAX_CODE_ATTEMPTS} misses the right code is refused`, await redeemSignInCode(address, burnt), null);
		eq_("…and the row is gone", (await getDb().select().from(signInCodes).where(eq(signInCodes.identifier, address))).length, 0);

		const racing = await issueSignInCode(address, link);
		const guesses = await Promise.all(Array.from({ length: 20 }, () => redeemSignInCode(address, wrong(racing))));
		check("20 parallel misses all fail", guesses.every((result) => result === null));
		eq_("…and the right code is refused after them", await redeemSignInCode(address, racing), null);

		const expired = await issueSignInCode(address, link);
		await getDb().update(signInCodes).set({ expires: new Date(Date.now() - 1000) }).where(eq(signInCodes.identifier, address));
		eq_("an expired code is refused", await redeemSignInCode(address, expired), null);

		await issueSignInCode(address, link);
		await clearSignInCodes(address);
		eq_("clearing removes the row", (await getDb().select().from(signInCodes).where(eq(signInCodes.identifier, address))).length, 0);
	} finally {
		await getDb().delete(signInCodes).where(eq(signInCodes.identifier, address));
		await getSql().end();
	}
})();

console.log(`\n${failures.length === 0 ? "PASS" : "FAIL"} — ${passed} checks passed, ${failures.length} failed`);
if (failures.length > 0) {
	for (const failure of failures) console.log(`  · ${failure}`);
	process.exit(1);
}
