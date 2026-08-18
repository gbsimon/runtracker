"use server";

import { signIn } from "@/auth";
import { isValidEmail, normalizeEmail } from "@/lib/auth-access";
import { safeCallbackUrl } from "@/lib/paths";

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
