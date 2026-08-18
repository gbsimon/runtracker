"use client";

import { useActionState } from "react";
import { deleteAllDataAction, type DeleteState } from "@/app/settings/actions";
import { SubmitButton } from "./submit-button";

export function DangerZone({ email }: { email: string }) {
	const [state, formAction] = useActionState<DeleteState, FormData>(deleteAllDataAction, { status: "idle" });

	return (
		<details className="card group border-red-500/20 p-0">
			<summary className="flex cursor-pointer list-none items-center gap-2 px-5 py-3.5 text-sm text-red-400 transition hover:bg-red-500/5">
				<span className="text-xs text-red-500/70 group-open:hidden">▸</span>
				<span className="hidden text-xs text-red-500/70 group-open:inline">▾</span>
				Danger zone
			</summary>

			<form action={formAction} className="space-y-3 border-t border-white/5 px-5 py-4">
				<p className="text-sm text-gray-400">
					Deletes every run, its route and heart-rate data, your training plan and your coach chat. Your account and your
					invites stay. There is no undo — export first.
				</p>

				<label htmlFor="confirm-delete" className="block text-xs text-gray-500">
					Type <span className="font-semibold text-gray-300">{email}</span> to confirm
				</label>
				<input
					id="confirm-delete"
					name="confirm"
					type="text"
					autoComplete="off"
					placeholder={email}
					className="w-full rounded-xl border px-3 py-2.5 text-sm outline-none"
				/>

				{state.status === "error" ? <p className="text-xs text-red-400">{state.message}</p> : null}
				{state.status === "deleted" && state.counts ? (
					<p className="text-xs text-emerald-400">
						Deleted {state.counts.runs} runs, {state.counts.streams} data streams, {state.counts.chatMessages} chat
						messages and {state.counts.plans === 0 ? "no plan" : "your plan"}.
					</p>
				) : null}

				<SubmitButton
					pendingLabel="Deleting…"
					onClick={(event) => {
						if (!confirm("Delete all of your RunTracker data? This cannot be undone.")) event.preventDefault();
					}}
					className="w-full rounded-xl border border-red-500/40 py-2.5 text-sm font-semibold text-red-400 hover:bg-red-500/10"
				>
					Delete all my data
				</SubmitButton>
			</form>
		</details>
	);
}
