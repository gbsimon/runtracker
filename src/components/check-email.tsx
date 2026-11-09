"use client";

import Link from "next/link";
import { useActionState, useEffect, useState } from "react";
import { useFormStatus } from "react-dom";
import { type CodeFormState, verifySignInCode } from "@/app/login/actions";
import { CODE_LENGTH, CODE_TTL_MINUTES } from "@/lib/sign-in-code-limits";

/** Digits only, whatever was typed or pasted ("123 456", full-width, …). */
function cleanCode(value: string): string {
	return value.normalize("NFKC").replace(/\D/g, "").slice(0, CODE_LENGTH);
}

function VerifyButton({ verified, ready }: { verified: boolean; ready: boolean }) {
	const { pending } = useFormStatus();
	const busy = pending || verified;
	return (
		<button
			type="submit"
			disabled={busy || !ready}
			className="glow-sm w-full rounded-xl bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-brand-500 disabled:cursor-not-allowed disabled:opacity-60"
		>
			{busy ? "Signing in…" : "Sign in with code"}
		</button>
	);
}

/**
 * Typing the emailed code keeps the sign-in inside this window — the point for
 * an iOS home-screen app, where the link in Mail would open Safari instead.
 */
function CodeForm({ email }: { email?: string }) {
	const [state, formAction] = useActionState<CodeFormState, FormData>(verifySignInCode, { status: "idle" });
	const [code, setCode] = useState("");

	useEffect(() => {
		// A real navigation, not a router push: the Auth.js callback has to set
		// its cookie in this browser and then redirect to `callbackUrl`.
		if (state.status === "verified" && state.callbackPath) window.location.assign(state.callbackPath);
	}, [state]);

	return (
		<form action={formAction} className="space-y-3 text-left">
			{email ? (
				<input type="hidden" name="email" value={email} />
			) : (
				<div className="space-y-1.5">
					<label htmlFor="code-email" className="block text-xs font-semibold uppercase tracking-wide text-gray-400">
						Email
					</label>
					<input
						id="code-email"
						name="email"
						type="email"
						autoComplete="email"
						required
						placeholder="you@example.com"
						className="w-full rounded-xl border px-3 py-2.5 text-sm outline-none"
					/>
				</div>
			)}
			<div className="space-y-1.5">
				<label htmlFor="code" className="block text-xs font-semibold uppercase tracking-wide text-gray-400">
					Code from the email
				</label>
				<input
					id="code"
					name="code"
					type="text"
					inputMode="numeric"
					autoComplete="one-time-code"
					autoFocus={Boolean(email)}
					required
					value={code}
					onChange={(event) => setCode(cleanCode(event.target.value))}
					placeholder={"0".repeat(CODE_LENGTH)}
					aria-invalid={state.status === "invalid"}
					className="w-full rounded-xl border px-3 py-2.5 text-center font-mono text-lg tracking-[0.4em] outline-none"
				/>
				{state.status === "invalid" ? (
					<p role="alert" className="text-xs text-red-400">
						That code didn&apos;t work. It may be mistyped, expired or already used — check the email or request a new one.
					</p>
				) : null}
			</div>
			<VerifyButton verified={state.status === "verified"} ready={code.length === CODE_LENGTH} />
		</form>
	);
}

/**
 * Shown for every accepted sign-in request, whether or not a link was actually
 * sent — the wording must stay true in both cases.
 */
export function CheckEmailNotice({ email, resetHref }: { email?: string; resetHref: string }) {
	return (
		<div className="fade-in space-y-3 text-center">
			<div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-600/20 text-2xl">✉️</div>
			<h2 className="text-base font-bold text-white">Check your email</h2>
			<p className="text-sm leading-relaxed text-gray-400">
				If {email ? <span className="text-gray-200">{email}</span> : "that address"} can access RunTracker, a sign-in
				link and a {CODE_LENGTH}-digit code are on their way. Enter the code here, or tap the link in the email.
			</p>
			<CodeForm email={email} />
			<p className="text-xs text-gray-500">
				The code expires in {CODE_TTL_MINUTES} minutes, the link in 24 hours.
			</p>
			<Link
				href={resetHref}
				className="inline-block text-xs text-gray-500 underline underline-offset-4 transition hover:text-gray-300"
			>
				Use a different address
			</Link>
		</div>
	);
}
