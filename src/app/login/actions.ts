"use server";

import { signIn } from "@/auth";
import { isValidEmail, normalizeEmail } from "@/lib/auth-access";
import { safeCallbackUrl } from "@/lib/paths";
import { redeemSignInCode } from "@/lib/sign-in-code-store";

export type LoginFormState = {
	status: "idle" | "sent" | "invalid";
	email: string;
};

function isNextRedirect(error: unknown): boolean {
	return typeof (error as { digest?: string })?.digest === "string" && (error as { digest: string }).digest.startsWith("NEXT_REDIRECT");
}

/**
 * Always answers "we sent it if we could": a refused address (not invited)
 * and a delivered link are indistinguishable from the outside.
 */
export async function requestMagicLink(_previous: LoginFormState, formData: FormData): Promise<LoginFormState> {
	const email = normalizeEmail(String(formData.get("email") ?? ""));
	const callbackUrl = safeCallbackUrl(String(formData.get("callbackUrl") ?? ""));

	if (!isValidEmail(email)) return { status: "invalid", email };

	try {
		await signIn("resend", { email, redirect: false, redirectTo: callbackUrl });
	} catch (error) {
		if (isNextRedirect(error)) throw error;
		// AccessDenied (no account, no invite) and delivery failures both land
		// here. Log it for the server, say nothing to the browser.
		console.info(`[auth] sign-in not completed for ${email}: ${error instanceof Error ? error.message : String(error)}`);
	}

	return { status: "sent", email };
}

export type CodeFormState = {
	status: "idle" | "invalid" | "verified";
	/** Same-origin Auth.js callback path, set only when `status` is "verified". */
	callbackPath?: string;
};

/**
 * Checks the emailed code. Every failure — unknown address, wrong, expired or
 * used-up code — returns the same "invalid", so this can't probe addresses.
 *
 * On success the browser is handed the magic link's own callback path rather
 * than `redirect()`ed to it: a redirect out of a server action is followed by
 * Next.js on the server (to stream the target's RSC payload), which would
 * spend the one-time token there and leave the session cookie behind. The
 * client navigates to it for real, so Auth.js's callback runs in this browser
 * exactly as a tapped link would — invite gating, invite claim, cookie and the
 * final redirect to `callbackUrl` all unchanged.
 */
export async function verifySignInCode(_previous: CodeFormState, formData: FormData): Promise<CodeFormState> {
	const email = normalizeEmail(String(formData.get("email") ?? ""));
	const code = String(formData.get("code") ?? "");
	if (!isValidEmail(email)) return { status: "invalid" };

	try {
		const callbackPath = await redeemSignInCode(email, code);
		if (callbackPath) return { status: "verified", callbackPath };
	} catch (error) {
		console.error(`[auth] sign-in code check failed for ${email}: ${error instanceof Error ? error.message : String(error)}`);
	}
	return { status: "invalid" };
}
