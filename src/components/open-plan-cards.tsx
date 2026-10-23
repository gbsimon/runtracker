"use client";

import { useRouter } from "next/navigation";
import { useActionState, useState, useTransition } from "react";
import { sendToCoach } from "@/lib/coach-kickoff";
import { extendPlanAction, type PlanFormState, startOpenTrainingAction } from "@/lib/plan-actions";
import { DESKTOP } from "./desktop-coach-redirect";
import { SubmitButton } from "./submit-button";

/**
 * Shown in race mode once race day is behind the runner. "Keep training"
 * switches the plan to open mode — history kept, nothing regenerated — then
 * opens the coach with the conversation already started, so setting the next
 * objective is a chat rather than a form.
 */
export function RaceDoneCard({ raceName }: { raceName: string }) {
	const router = useRouter();
	const [pending, startTransition] = useTransition();
	const [error, setError] = useState("");

	const keepTraining = () => {
		setError("");
		startTransition(async () => {
			const result = await startOpenTrainingAction();
			if (result.status === "error") {
				setError(result.message);
				return;
			}
			// On desktop the coach is already beside the plan; on mobile it lives
			// at /coach. Either way the chat is mounted in the layout and hears this.
			if (!window.matchMedia(DESKTOP).matches) router.push("/coach");
			sendToCoach(result.kickoff);
		});
	};

	return (
		<div className="card glow p-5 text-center">
			<h3 className="mb-1 font-bold text-white">Race done 🎉 What&apos;s next?</h3>
			<p className="mb-4 text-sm text-gray-400">
				Your {raceName} is in the books. Keep the plan going with no race on the calendar — the coach will help you
				pick the next objective.
			</p>
			<button
				type="button"
				onClick={keepTraining}
				disabled={pending}
				className="glow-sm rounded-xl bg-brand-600 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-brand-500 disabled:cursor-not-allowed disabled:opacity-60"
			>
				{pending ? "Setting up…" : "Keep training"}
			</button>
			{error ? <p className="mt-2 text-xs text-red-400">{error}</p> : null}
		</div>
	);
}

/** Open mode, current week is the last one (or later): add the next block. */
export function ExtendPlanCard() {
	const [state, formAction] = useActionState<PlanFormState, FormData>(extendPlanAction, { status: "idle" });

	return (
		<div className="card p-5">
			<h3 className="mb-1 font-bold text-white">Plan next 4 weeks</h3>
			<p className="mb-4 text-sm text-gray-400">
				You&apos;re at the end of your plan. Add the next block — three building weeks and a lighter one, sized from
				what you&apos;ve actually been running.
			</p>
			<form action={formAction} className="flex flex-col gap-2 sm:flex-row">
				<SubmitButton
					name="intent"
					value="ai"
					pendingLabel="Asking the coach…"
					title="Ask the AI coach to write the next block around your objective and recent runs"
					className="glow-sm flex-1 rounded-xl bg-brand-600 py-2.5 text-sm font-semibold text-white hover:bg-brand-500"
				>
					✨ Plan with AI
				</SubmitButton>
				<SubmitButton
					name="intent"
					value="standard"
					pendingLabel="Adding…"
					className="flex-1 rounded-xl border border-white/10 bg-white/5 py-2.5 text-sm font-semibold text-gray-300 hover:border-brand-400/40 hover:text-white"
				>
					Standard block
				</SubmitButton>
			</form>
			{state.status === "error" ? <p className="mt-2 text-xs text-red-400">{state.message}</p> : null}
			{state.status === "saved" ? <p className="mt-2 text-xs text-brand-400">{state.message}</p> : null}
		</div>
	);
}
