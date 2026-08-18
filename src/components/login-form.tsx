"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { type LoginFormState, requestMagicLink } from "@/app/login/actions";
import { CheckEmailNotice } from "@/components/check-email";
import { loginHref } from "@/lib/paths";

function SubmitButton() {
	const { pending } = useFormStatus();
	return (
		<button
			type="submit"
			disabled={pending}
			className="glow-sm w-full rounded-xl bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-brand-500 disabled:cursor-not-allowed disabled:opacity-60"
		>
			{pending ? "Sending…" : "Send me a login link"}
		</button>
	);
}

export function LoginForm({ defaultEmail = "", callbackUrl = "/" }: { defaultEmail?: string; callbackUrl?: string }) {
	const initialState: LoginFormState = { status: "idle", email: defaultEmail };
	const [state, formAction] = useActionState(requestMagicLink, initialState);

	if (state.status === "sent") {
		return <CheckEmailNotice email={state.email} resetHref={loginHref(callbackUrl)} />;
	}

	return (
		<form action={formAction} className="space-y-4">
			<input type="hidden" name="callbackUrl" value={callbackUrl} />
			<div className="space-y-1.5">
				<label htmlFor="email" className="block text-xs font-semibold uppercase tracking-wide text-gray-400">
					Email
				</label>
				<input
					id="email"
					name="email"
					type="email"
					autoComplete="email"
					autoFocus
					required
					defaultValue={state.email}
					placeholder="you@example.com"
					className="w-full rounded-xl border px-3 py-2.5 text-sm outline-none"
				/>
				{state.status === "invalid" ? (
					<p className="text-xs text-red-400">That doesn&apos;t look like an email address.</p>
				) : null}
			</div>
			<SubmitButton />
			<p className="text-center text-xs leading-relaxed text-gray-500">
				RunTracker is invite-only. No passwords — you get a one-time link by email.
			</p>
		</form>
	);
}
