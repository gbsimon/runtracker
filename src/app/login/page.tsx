import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { CheckEmailNotice } from "@/components/check-email";
import { LoginForm } from "@/components/login-form";
import { findOpenInviteByToken } from "@/lib/auth-access";
import { loginHref, safeCallbackUrl } from "@/lib/paths";
import { currentUser } from "@/lib/session";

export const metadata: Metadata = { title: "Sign in · RunTracker" };

type SearchParams = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined): string | undefined {
	return Array.isArray(value) ? value[0] : value;
}

function errorMessage(code: string | undefined): string | null {
	if (!code) return null;
	if (code === "Verification") return "That link has expired or was already used. Request a new one below.";
	return "That sign-in link didn't work. Request a new one below.";
}

export default async function LoginPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
	// Deliberately the database-backed user, not the token: a stale session must
	// land on the form rather than bounce back to a page that rejects it.
	if (await currentUser()) redirect("/");

	const params = await searchParams;
	const callbackUrl = safeCallbackUrl(first(params.callbackUrl));
	const inviteToken = first(params.invite);
	const invite = inviteToken ? await findOpenInviteByToken(inviteToken) : null;
	const message = errorMessage(first(params.error));
	// Auth.js's own verify-request page redirects here with `?provider=…` when
	// the form was posted without JavaScript.
	const sent = Boolean(first(params.provider));

	return (
		<section className="fade-in mx-auto max-w-sm py-10">
			<div className="card glow p-7">
				<div className="mb-6 text-center">
					<div className="glow-sm mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-2xl bg-brand-600 text-lg font-bold text-white">
						R
					</div>
					<h1 className="text-lg font-extrabold tracking-tight text-white">Sign in to RunTracker</h1>
					{sent ? null : invite ? (
						<p className="mt-1.5 text-sm text-gray-400">You&apos;ve been invited. Confirm your email to get started.</p>
					) : (
						<p className="mt-1.5 text-sm text-gray-400">We&apos;ll email you a one-time link.</p>
					)}
				</div>

				{message ? (
					<p className="mb-4 rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
						{message}
					</p>
				) : null}

				{sent ? (
					<CheckEmailNotice resetHref={loginHref(callbackUrl)} />
				) : (
					<LoginForm defaultEmail={invite?.email ?? ""} callbackUrl={callbackUrl} />
				)}
			</div>
		</section>
	);
}
