"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { createInvite, type InviteFormState } from "@/app/invites/actions";
import { INVITE_TTL_DAYS } from "@/lib/invites";

function SubmitButton() {
	const { pending } = useFormStatus();
	return (
		<button
			type="submit"
			disabled={pending}
			className="glow-sm rounded-xl bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-brand-500 disabled:cursor-not-allowed disabled:opacity-60"
		>
			{pending ? "Creating…" : "Create invite"}
		</button>
	);
}

export function InviteForm() {
	const initialState: InviteFormState = { status: "idle" };
	const [state, formAction] = useActionState(createInvite, initialState);

	return (
		<div className="space-y-3">
			<form action={formAction} className="flex flex-col gap-2 sm:flex-row">
				<input
					name="email"
					type="email"
					required
					placeholder="family@example.com"
					aria-label="Email to invite"
					className="w-full rounded-xl border px-3 py-2.5 text-sm outline-none"
				/>
				<SubmitButton />
			</form>

			<p className="text-xs text-gray-500">Invites expire after {INVITE_TTL_DAYS} days and can be used once.</p>

			{state.status === "error" ? <p className="text-xs text-red-400">{state.message}</p> : null}

			{state.status === "created" && state.link ? (
				<div className="fade-in rounded-xl border border-brand-500/30 bg-brand-600/10 p-3">
					<p className="text-xs text-brand-300">
						{state.message ?? `Invite created for ${state.email}.`} Send them this link — or just tell them to sign in
						with that address.
					</p>
					<code className="mt-2 block break-all rounded-lg bg-black/30 px-2.5 py-2 text-xs text-gray-300">
						{state.link}
					</code>
				</div>
			) : null}
		</div>
	);
}
