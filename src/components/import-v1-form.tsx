"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { importV1Action, type ImportState } from "@/app/settings/actions";
import { type ImportSummary, MAX_IMPORT_BYTES, readV1BackupText, summarizeBackup } from "@/lib/import-v1";
import { formatFullDate } from "@/lib/running";

type Staged = { name: string; text: string; summary: ImportSummary };

function Counts({ summary }: { summary: ImportSummary }) {
	const items: [string, string][] = [
		["Runs", String(summary.runs)],
		["Plan weeks", String(summary.planWeeks)],
		["Completed", String(summary.completed)],
		["Skipped", String(summary.skipped)],
		["Chat messages", String(summary.chatMessages)],
	];

	return (
		<dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-5">
			{items.map(([label, value]) => (
				<div key={label}>
					<dt className="text-[11px] uppercase tracking-wide text-gray-500">{label}</dt>
					<dd className="text-lg font-bold text-white">{value}</dd>
				</div>
			))}
		</dl>
	);
}

export function ImportV1Form() {
	const router = useRouter();
	const inputRef = useRef<HTMLInputElement>(null);
	const [staged, setStaged] = useState<Staged | null>(null);
	const [state, setState] = useState<ImportState>({ status: "idle" });
	const [pending, startTransition] = useTransition();

	function reset() {
		setStaged(null);
		if (inputRef.current) inputRef.current.value = "";
	}

	async function onPick(event: React.ChangeEvent<HTMLInputElement>) {
		const file = event.target.files?.[0];
		setState({ status: "idle" });
		setStaged(null);
		if (!file) return;

		if (file.size > MAX_IMPORT_BYTES) {
			setState({ status: "error", message: "That file is over 10 MB — it isn't a RunTracker backup." });
			return;
		}

		const text = await file.text();
		const backup = readV1BackupText(text);
		if (typeof backup === "string") {
			setState({ status: "error", message: backup });
			return;
		}

		setStaged({ name: file.name, text, summary: summarizeBackup(backup) });
	}

	function onConfirm() {
		if (!staged) return;
		startTransition(async () => {
			const result = await importV1Action(staged.text);
			setState(result);
			if (result.status === "imported") {
				reset();
				router.refresh();
			}
		});
	}

	return (
		<div className="space-y-4">
			<div>
				<h3 className="text-sm font-semibold text-white">Import a v1 backup</h3>
				<p className="mt-1 text-sm text-gray-400">
					The JSON file the old single-page RunTracker exported. You&apos;ll see what&apos;s in it before anything is written.
				</p>
			</div>

			<input
				ref={inputRef}
				type="file"
				accept="application/json,.json"
				onChange={onPick}
				aria-label="v1 backup file"
				className="block w-full text-sm text-gray-400 file:mr-3 file:cursor-pointer file:rounded-xl file:border-0 file:bg-brand-600 file:px-4 file:py-2.5 file:text-sm file:font-semibold file:text-white hover:file:bg-brand-500"
			/>

			{state.status === "error" ? <p className="text-xs text-red-400">{state.message}</p> : null}

			{staged ? (
				<div className="fade-in space-y-4 rounded-xl border border-amber-500/30 bg-amber-500/5 p-4">
					<div>
						<p className="text-sm font-semibold text-white">{staged.name}</p>
						<p className="mt-0.5 text-xs text-gray-400">
							{staged.summary.firstRun && staged.summary.lastRun
								? `Runs from ${formatFullDate(staged.summary.firstRun)} to ${formatFullDate(staged.summary.lastRun)}`
								: "No runs in this file"}
						</p>
					</div>

					<Counts summary={staged.summary} />

					{staged.summary.droppedRuns > 0 ? (
						<p className="text-xs text-amber-400">
							{staged.summary.droppedRuns} run {staged.summary.droppedRuns === 1 ? "entry" : "entries"} can&apos;t be read
							(missing date, distance or duration) and will be left out.
						</p>
					) : null}

					{staged.summary.syncedRuns > 0 ? (
						<p className="text-xs text-gray-400">
							{staged.summary.syncedRuns} run{staged.summary.syncedRuns === 1 ? "" : "s"} in this file came from a phone
							sync — those stay as they are, with their route and heart-rate data.
						</p>
					) : null}

					<p className="text-xs text-amber-300">
						This replaces your plan, your chat history and every manually logged run. Runs synced from your phone are kept.
					</p>

					<div className="flex flex-col gap-2 sm:flex-row">
						<button
							type="button"
							onClick={onConfirm}
							disabled={pending}
							className="glow-sm flex-1 rounded-xl bg-brand-600 py-2.5 text-sm font-semibold text-white transition hover:bg-brand-500 disabled:cursor-not-allowed disabled:opacity-60"
						>
							{pending ? "Importing…" : "Import and replace"}
						</button>
						<button
							type="button"
							onClick={reset}
							disabled={pending}
							className="flex-1 rounded-xl border border-white/10 py-2.5 text-sm text-gray-300 transition hover:border-white/20 hover:text-white disabled:opacity-60"
						>
							Cancel
						</button>
					</div>
				</div>
			) : null}

			{state.status === "imported" ? (
				<div className="fade-in space-y-3 rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-4">
					<p className="text-sm font-semibold text-emerald-300">Import complete</p>
					<Counts summary={state.summary} />
				</div>
			) : null}
		</div>
	);
}
