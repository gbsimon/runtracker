"use client";

import { useActionState, useState, useTransition } from "react";
import {
	createIngestTokenAction,
	reprocessIngestAction,
	type ReprocessState,
	revokeIngestTokenAction,
	setSyncShortcutNameAction,
	type ShortcutNameState,
	type TokenState,
} from "@/app/settings/sync-actions";
import { DEFAULT_SYNC_SHORTCUT_NAME } from "@/lib/sync-now";
import { SubmitButton } from "./submit-button";
import { SyncNow } from "./sync-now";

export type TokenView = {
	id: string;
	label: string | null;
	created: string;
	lastUsed: string | null;
};

export type LastSyncView = {
	received: string;
	status: string;
	workouts: number;
	imported: number;
	reconciled: number;
	enriched: number;
	duplicate: number;
	skipped: number;
	failed: number;
	/** Daily readings the payload carried — one per metric per day, summed. */
	metricReadings: number;
};

/** One reading on the recovery line, formatted on the server. */
export type RecoveryItem = { label: string; value: string; day: string };

const STATUS_STYLES: Record<string, string> = {
	processed: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
	received: "border-brand-500/30 bg-brand-600/15 text-brand-300",
	captured: "border-brand-500/30 bg-brand-600/15 text-brand-300",
	failed: "border-red-500/30 bg-red-500/10 text-red-300",
};

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
	return (
		<li className="flex gap-3">
			<span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-brand-600/20 text-[11px] font-bold text-brand-300">
				{n}
			</span>
			<div className="min-w-0 space-y-1">
				<p className="text-sm font-medium text-gray-200">{title}</p>
				<div className="text-xs leading-relaxed text-gray-400">{children}</div>
			</div>
		</li>
	);
}

function Field({ label, value }: { label: string; value: string }) {
	return (
		<div className="flex flex-wrap items-baseline gap-x-2">
			<span className="text-[11px] uppercase tracking-wide text-gray-500">{label}</span>
			<code className="break-all text-[11px] text-gray-300">{value}</code>
		</div>
	);
}

function LastSync({ sync }: { sync: LastSyncView | null }) {
	if (!sync) {
		return <p className="text-sm text-gray-500">Nothing received yet — finish the setup below and run a manual export.</p>;
	}

	const parts = [
		sync.imported > 0 ? `${sync.imported} imported` : null,
		sync.reconciled > 0 ? `${sync.reconciled} matched to a logged run` : null,
		sync.enriched > 0 ? `${sync.enriched} filled in` : null,
		sync.duplicate > 0 ? `${sync.duplicate} already had` : null,
		sync.skipped > 0 ? `${sync.skipped} not a run` : null,
		sync.failed > 0 ? `${sync.failed} failed` : null,
	].filter(Boolean);

	// A Health Metrics export carries days rather than workouts, so it gets its
	// own sentence instead of reading as "0 workouts".
	const headline =
		sync.workouts === 0 && sync.metricReadings > 0
			? `${sync.metricReadings} health-metric reading${sync.metricReadings === 1 ? "" : "s"}`
			: `${sync.workouts} workout${sync.workouts === 1 ? "" : "s"}${parts.length > 0 ? ` · ${parts.join(" · ")}` : ""}`;

	return (
		<div className="space-y-1.5">
			<div className="flex flex-wrap items-center gap-2">
				<p className="text-sm text-gray-200">Last sync {sync.received}</p>
				<span
					className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${STATUS_STYLES[sync.status] ?? STATUS_STYLES.received}`}
				>
					{sync.status}
				</span>
			</div>
			<p className="text-xs text-gray-400">{headline}</p>
		</div>
	);
}

function Recovery({ items }: { items: RecoveryItem[] }) {
	return (
		<div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
			<p className="text-[11px] uppercase tracking-wide text-gray-500">Latest recovery data</p>
			{items.length === 0 ? (
				<p className="mt-1.5 text-sm text-gray-500">
					Nothing yet — the second automation below sends resting heart rate, HRV, sleep and VO₂max.
				</p>
			) : (
				<div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1">
					{items.map((item) => (
						<p key={item.label} className="text-xs text-gray-500">
							{item.label} <span className="font-medium text-gray-200">{item.value}</span>{" "}
							<span className="text-gray-600">{item.day}</span>
						</p>
					))}
				</div>
			)}
		</div>
	);
}

export function AppleHealthSync({
	endpoint,
	origin,
	tokens,
	lastSync,
	recovery,
	isOwner,
	pendingEvents,
	shortcutName,
	ios,
}: {
	endpoint: string;
	origin: string;
	tokens: TokenView[];
	lastSync: LastSyncView | null;
	recovery: RecoveryItem[];
	isOwner: boolean;
	pendingEvents: number;
	shortcutName: string;
	ios: boolean;
}) {
	const [tokenState, createToken] = useActionState<TokenState, FormData>(createIngestTokenAction, { status: "idle" });
	const [shortcutState, saveShortcutName] = useActionState<ShortcutNameState, FormData>(setSyncShortcutNameAction, {
		status: "idle",
	});
	// The saved name wins over the prop until the page re-renders with it.
	const currentShortcutName = shortcutState.status === "saved" && shortcutState.name ? shortcutState.name : shortcutName;
	const [reprocess, setReprocess] = useState<ReprocessState>({ status: "idle" });
	const [reprocessing, startReprocess] = useTransition();

	return (
		<div className="space-y-5">
			<div>
				<h3 className="text-sm font-semibold text-white">Apple Health sync</h3>
				<p className="mt-1 text-sm text-gray-400">
					Health Auto Export posts each finished workout straight to RunTracker — route, heart rate, cadence and elevation,
					with the plan day ticked off for you. A run you already logged by hand is upgraded in place, keeping your effort
					and notes. A second automation adds how you slept and recovered, so the coach can tell a hard day from a tired one.
				</p>
			</div>

			<div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
				<LastSync sync={lastSync} />
			</div>

			<Recovery items={recovery} />

			<div className="space-y-3">
				<p className="text-sm font-medium text-gray-200">Your sync tokens</p>

				{tokens.length === 0 ? (
					<p className="text-xs text-gray-500">No token yet. Generate one below, then paste it into the app.</p>
				) : (
					<ul className="divide-y divide-white/5 rounded-xl border border-white/10">
						{tokens.map((token) => (
							<li key={token.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
								<div className="min-w-0">
									<p className="truncate text-sm text-gray-200">{token.label ?? "Untitled device"}</p>
									<p className="mt-0.5 text-xs text-gray-500">
										Added {token.created} · {token.lastUsed ? `last used ${token.lastUsed}` : "never used"}
									</p>
								</div>
								<form action={revokeIngestTokenAction}>
									<input type="hidden" name="id" value={token.id} />
									<SubmitButton
										pendingLabel="Revoking…"
										onClick={(event) => {
											if (!confirm("Revoke this token? The device using it stops syncing.")) event.preventDefault();
										}}
										className="rounded-lg border border-red-500/30 px-3 py-1.5 text-xs text-red-400 hover:bg-red-500/10"
									>
										Revoke
									</SubmitButton>
								</form>
							</li>
						))}
					</ul>
				)}

				<form action={createToken} className="flex flex-col gap-2 sm:flex-row">
					<input
						name="label"
						type="text"
						placeholder="iPhone"
						aria-label="Token label"
						className="flex-1 rounded-xl border px-3 py-2.5 text-sm outline-none"
					/>
					<SubmitButton
						pendingLabel="Generating…"
						className="glow-sm rounded-xl bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-500"
					>
						Generate token
					</SubmitButton>
				</form>

				{tokenState.status === "error" ? <p className="text-xs text-red-400">{tokenState.message}</p> : null}

				{tokenState.status === "created" && tokenState.token ? (
					<div className="fade-in space-y-2 rounded-xl border border-amber-500/30 bg-amber-500/5 p-4">
						<p className="text-sm font-semibold text-amber-200">Copy this now — it is never shown again</p>
						<code className="block break-all rounded-lg bg-black/40 px-3 py-2 text-xs text-amber-100">{tokenState.token}</code>
						<p className="text-xs text-gray-400">
							RunTracker only keeps a hash of it. Lose it and you generate a new one; nothing else breaks.
						</p>
					</div>
				) : null}
			</div>

			<details className="group rounded-xl border border-white/10">
				<summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-sm text-gray-300 transition hover:text-white">
					<span className="text-xs text-gray-600 group-open:hidden">▸</span>
					<span className="hidden text-xs text-gray-600 group-open:inline">▾</span>
					Set up Health Auto Export on your iPhone
				</summary>

				<ol className="space-y-3.5 border-t border-white/5 px-4 py-4">
					<Step n={1} title="Install Health Auto Export">
						App Store, $24.99 once. Open it and allow it to read Apple Health when asked — workouts and routes included.
					</Step>
					<Step n={2} title="Automations → add a REST API automation">
						Set it to run on <span className="text-gray-300">Automatic Export</span>, so every finished workout is sent
						without you touching the phone.
					</Step>
					<Step n={3} title="Point it at RunTracker">
						<div className="mt-1.5 space-y-1.5 rounded-lg bg-black/30 p-3">
							<Field label="URL" value={endpoint} />
							<Field label="Method" value="POST" />
							<Field label="Header" value="x-ingest-token: <your token above>" />
							<Field label="Format" value="JSON" />
						</div>
					</Step>
					<Step n={4} title="Choose the data">
						Data type <span className="text-gray-300">Workouts</span>, period{" "}
						<span className="text-gray-300">Since last sync</span>, aggregation{" "}
						<span className="text-gray-300">Seconds</span>. Turn <span className="text-gray-300">Routes</span> on and leave
						batching off — that combination is what carries GPS, per-second heart rate and cadence.
					</Step>
					<Step n={5} title="Run it once by hand">
						Hit Export now. The card at the top of this section fills in within a few seconds, and your run appears with its
						map.
					</Step>
				</ol>
			</details>

			<details className="group rounded-xl border border-white/10">
				<summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-sm text-gray-300 transition hover:text-white">
					<span className="text-xs text-gray-600 group-open:hidden">▸</span>
					<span className="hidden text-xs text-gray-600 group-open:inline">▾</span>
					Add sleep and recovery (second automation)
				</summary>

				<ol className="space-y-3.5 border-t border-white/5 px-4 py-4">
					<Step n={1} title="Add a second REST API automation">
						Same app, alongside the workouts one. Workouts arrive when you finish a run; these arrive once a day, so they
						need an automation of their own.
					</Step>
					<Step n={2} title="Point it at the same place">
						<div className="mt-1.5 space-y-1.5 rounded-lg bg-black/30 p-3">
							<Field label="URL" value={endpoint} />
							<Field label="Method" value="POST" />
							<Field label="Header" value="x-ingest-token: <the same token>" />
							<Field label="Format" value="JSON" />
						</div>
					</Step>
					<Step n={3} title="Choose the data">
						Data type <span className="text-gray-300">Health Metrics</span>, aggregation{" "}
						<span className="text-gray-300">Daily</span>, period <span className="text-gray-300">Since last sync</span>.
						Daily is what makes one row per day instead of thousands of raw samples.
					</Step>
					<Step n={4} title="Pick four metrics">
						<span className="text-gray-300">Resting Heart Rate</span>,{" "}
						<span className="text-gray-300">Heart Rate Variability</span>,{" "}
						<span className="text-gray-300">Sleep Analysis</span> and <span className="text-gray-300">VO₂ Max</span>. Leave
						the rest off — anything else you do send is stored, but only these four are read back.
					</Step>
					<Step n={5} title="Run it each morning">
						Set it to export automatically after you wake, then hit Export now once. The recovery line above fills in.
						Re-sending a day you already sent is harmless: it overwrites that day rather than duplicating it.
					</Step>
				</ol>
			</details>

			<div className="space-y-3 border-t border-white/5 pt-4">
				<div>
					<p className="text-sm font-medium text-gray-200">Sync from a tap</p>
					<p className="mt-1 text-xs leading-relaxed text-gray-400">
						The automations above only run when iOS lets them — a locked phone, Low Power Mode or a busy morning can each
						skip one. The Sync tab has a button that runs the same export on demand, through a Shortcut you build once.
						The automations keep running on the days they do get a turn; the button is for the days they don&rsquo;t.
					</p>
				</div>

				<SyncNow
					origin={origin}
					shortcutName={currentShortcutName}
					ios={ios}
					initial={null}
					initialSince={null}
					initialError={null}
				/>

				<form action={saveShortcutName} className="flex flex-col gap-2 sm:flex-row">
					<input
						name="name"
						type="text"
						key={currentShortcutName}
						defaultValue={currentShortcutName}
						placeholder={DEFAULT_SYNC_SHORTCUT_NAME}
						aria-label="Shortcut name"
						autoCapitalize="words"
						autoCorrect="off"
						className="flex-1 rounded-xl border px-3 py-2.5 text-sm outline-none"
					/>
					<SubmitButton
						pendingLabel="Saving…"
						className="rounded-xl border border-white/10 px-4 py-2.5 text-sm text-gray-300 transition hover:border-white/20 hover:text-white"
					>
						Save shortcut name
					</SubmitButton>
				</form>
				{shortcutState.status === "saved" ? (
					<p className="fade-in text-xs text-emerald-400">The button now runs &ldquo;{shortcutState.name}&rdquo;.</p>
				) : (
					<p className="text-xs text-gray-500">
						Must match the shortcut&rsquo;s name on your phone exactly — that is how iOS finds it.
					</p>
				)}

				<details className="group rounded-xl border border-white/10">
					<summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-sm text-gray-300 transition hover:text-white">
						<span className="text-xs text-gray-600 group-open:hidden">▸</span>
						<span className="hidden text-xs text-gray-600 group-open:inline">▾</span>
						Build the shortcut (once, about a minute)
					</summary>

					<ol className="space-y-3.5 border-t border-white/5 px-4 py-4">
						<Step n={1} title="Open Shortcuts and add a new shortcut">
							The Shortcuts app is already on your iPhone. Tap <span className="text-gray-300">+</span> in the top corner.
						</Step>
						<Step n={2} title="Add Health Auto Export’s “Run Automation” action">
							Search the actions for <span className="text-gray-300">Run Automation</span> and pick the one from Health
							Auto Export. Tap its selection field and choose your <span className="text-gray-300">Workouts</span>{" "}
							automation.
						</Step>
						<Step n={3} title="Add it again for the recovery data">
							A second <span className="text-gray-300">Run Automation</span> action underneath, pointed at the{" "}
							<span className="text-gray-300">Health Metrics</span> automation. One tap then sends both.
						</Step>
						<Step n={4} title="Name it">
							Tap the title at the top and call it{" "}
							<code className="text-[11px] text-gray-300">{currentShortcutName}</code> — the name saved above. Tap Done.
						</Step>
						<Step n={5} title="Try it">
							Go to the Sync tab and press <span className="text-gray-300">Sync now</span>. iOS asks once whether
							RunTracker may open Shortcuts; allow it. The card fills in as soon as the export lands.
						</Step>
					</ol>
				</details>
			</div>

			{isOwner ? (
				<div className="space-y-2 border-t border-white/5 pt-4">
					<div className="flex flex-wrap items-center justify-between gap-3">
						<div className="min-w-0">
							<p className="text-sm text-gray-200">Reprocess stored syncs</p>
							<p className="mt-0.5 text-xs text-gray-500">
								{pendingEvents === 0
									? "Every stored payload has been processed."
									: `${pendingEvents} stored payload${pendingEvents === 1 ? "" : "s"} waiting.`}{" "}
								Replays every raw payload — safe to press twice, and how older runs pick up data a newer version knows
								how to read.
							</p>
						</div>
						<button
							type="button"
							disabled={reprocessing}
							onClick={() => startReprocess(async () => setReprocess(await reprocessIngestAction()))}
							className="rounded-xl border border-white/10 px-4 py-2 text-sm text-gray-300 transition hover:border-white/20 hover:text-white disabled:cursor-not-allowed disabled:opacity-60"
						>
							{reprocessing ? "Reprocessing…" : "Reprocess"}
						</button>
					</div>

					{reprocess.status === "error" ? <p className="text-xs text-red-400">{reprocess.message}</p> : null}
					{reprocess.status === "done" ? (
						<p className="fade-in text-xs text-emerald-400">
							{reprocess.message}
							{reprocess.summary && reprocess.summary.workouts > 0
								? ` ${reprocess.summary.imported} imported, ${reprocess.summary.reconciled} matched, ${reprocess.summary.enriched} filled in, ${reprocess.summary.duplicate} already had, ${reprocess.summary.skipped} skipped.`
								: ""}
							{reprocess.summary?.metrics
								? ` ${Object.values(reprocess.summary.metrics.days).reduce((total, days) => total + days, 0)} days of health metrics.`
								: ""}
						</p>
					) : null}
				</div>
			) : null}
		</div>
	);
}
