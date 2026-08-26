import type { Metadata } from "next";
import { headers } from "next/headers";
import { AppleHealthSync, type LastSyncView, type RecoveryItem, type TokenView } from "@/components/apple-health-sync";
import { ChatSendKeySetting } from "@/components/chat-send-key-setting";
import { DangerZone } from "@/components/danger-zone";
import { ImportV1Form } from "@/components/import-v1-form";
import { MaintenanceSweep, type SweepView } from "@/components/maintenance-sweep";
import { dataCounts } from "@/lib/backup";
import { coachModelNotice } from "@/lib/coach-model";
import { type DailyMetricsView, formatHours, getDailyMetrics } from "@/lib/daily-metrics";
import { lastIngestEvent, pendingIngestEventCount } from "@/lib/ingest/process";
import { listIngestTokens } from "@/lib/ingest/tokens";
import { formatMonthDay } from "@/lib/running";
import { requireUser } from "@/lib/session";
import { describeSweepRecord, readSweepStatus, type SweepRecord } from "@/lib/sweep";
import { isIosUserAgent } from "@/lib/sync-now";
import { userTimeZone } from "@/lib/today";
import { requestOrigin } from "@/lib/urls";
import { getUserPrefs } from "@/lib/user-prefs";

export const metadata: Metadata = { title: "Settings · RunTracker" };

function plural(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * Dates are formatted here rather than in the client component: the token card
 * is interactive, and a browser re-formatting them in its own zone would
 * disagree with the server's first render.
 */
function stamp(timeZone: string) {
	const format = new Intl.DateTimeFormat("en-GB", {
		timeZone,
		day: "numeric",
		month: "short",
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	});
	return (value: Date | null) => (value ? format.format(value) : null);
}

/** The auto-update stamp is an ISO string the coach wrote, not a typed column. */
function parseStamp(iso: string): Date | null {
	const date = new Date(iso);
	return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * The most recent reading of each recovery metric, each carrying its own day —
 * VO₂max only lands on days with an outdoor run, so they rarely share one.
 */
function recoveryItems(metrics: DailyMetricsView): RecoveryItem[] {
	const { restingHrBpm, hrvMs, sleep, vo2Max } = metrics.latest;
	const items: RecoveryItem[] = [];

	if (restingHrBpm) items.push({ label: "Resting HR", value: `${Math.round(restingHrBpm.value)} bpm`, day: formatMonthDay(restingHrBpm.day) });
	if (hrvMs) items.push({ label: "HRV", value: `${Math.round(hrvMs.value)} ms`, day: formatMonthDay(hrvMs.day) });

	const slept = formatHours(sleep?.value.totalSleep ?? null);
	if (sleep && slept) items.push({ label: "Sleep", value: slept, day: formatMonthDay(sleep.day) });
	if (vo2Max) items.push({ label: "VO₂max", value: vo2Max.value.toFixed(1), day: formatMonthDay(vo2Max.day) });

	return items;
}

/** `ranAt` is an ISO string the sweep wrote, not a typed column. */
function sweepView(record: SweepRecord | null, at: (value: Date | null) => string | null): SweepView | null {
	if (!record) return null;
	const seconds = Math.max(1, Math.round(record.durationMs / 1000));
	return {
		ranAt: at(parseStamp(record.ranAt)) ?? record.ranAt,
		summary: describeSweepRecord(record),
		trigger: record.trigger === "manual" ? "run by hand" : "scheduled",
		durationS: seconds < 60 ? `${seconds}s` : `${Math.round(seconds / 60)} min`,
	};
}

export default async function SettingsPage() {
	const user = await requireUser();
	const isOwner = user.role === "owner";

	const [counts, timeZone, origin, tokens, lastSync, pendingEvents, metrics, prefs, modelNotice, sweep, headerList] =
		await Promise.all([
			dataCounts(user.id),
			userTimeZone(),
			requestOrigin(),
			listIngestTokens(user.id),
			lastIngestEvent(user.id),
			pendingIngestEventCount(user.id, isOwner),
			getDailyMetrics(user.id, { days: 30 }),
			getUserPrefs(user.id),
			// Only the owner can act on this, and only they pay for it.
			isOwner ? coachModelNotice().catch(() => null) : null,
			isOwner ? readSweepStatus().catch(() => null) : null,
			headers(),
		]);

	const at = stamp(timeZone);
	const tokenViews: TokenView[] = tokens.map((token) => ({
		id: token.id,
		label: token.label,
		created: at(token.createdAt) as string,
		lastUsed: at(token.lastUsedAt),
	}));

	// Summaries written before a field existed simply don't carry it.
	const lastSyncView: LastSyncView | null = lastSync
		? {
				received: at(lastSync.receivedAt) as string,
				status: lastSync.status,
				workouts: lastSync.summary?.workouts ?? 0,
				imported: lastSync.summary?.imported ?? 0,
				reconciled: lastSync.summary?.reconciled ?? 0,
				enriched: lastSync.summary?.enriched ?? 0,
				duplicate: lastSync.summary?.duplicate ?? 0,
				skipped: lastSync.summary?.skipped ?? 0,
				failed: lastSync.summary?.failed ?? 0,
				metricReadings: Object.values(lastSync.summary?.metrics?.days ?? {}).reduce((total, days) => total + days, 0),
			}
		: null;

	return (
		<section className="fade-in space-y-5">
			<div>
				<h2 className="text-lg font-bold text-white">Settings</h2>
				<p className="mt-1 text-sm text-gray-400">
					{plural(counts.manualRuns, "logged run")}
					{counts.syncedRuns > 0 ? ` · ${plural(counts.syncedRuns, "synced run")}` : ""} ·{" "}
					{counts.planWeeks > 0 ? plural(counts.planWeeks, "plan week") : "no plan yet"} ·{" "}
					{plural(counts.chatMessages, "chat message")}
				</p>
			</div>

			{modelNotice ? (
				<p className="rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3 text-xs text-gray-400">
					<span className="text-gray-300">Coach model auto-updated</span> to{" "}
					<code className="text-gray-200">{modelNotice.model}</code>
					{modelNotice.previous ? (
						<>
							{" "}
							from <code className="text-gray-200">{modelNotice.previous}</code>
						</>
					) : null}
					{at(parseStamp(modelNotice.updatedAt)) ? ` on ${at(parseStamp(modelNotice.updatedAt))}` : ""} — the previous model stopped
					being served. Set <code className="text-gray-200">COACH_MODEL</code> to pin a specific one.
				</p>
			) : null}

			<div className="card p-5">
				<AppleHealthSync
					endpoint={`${origin}/api/ingest/health-auto-export`}
					origin={origin}
					tokens={tokenViews}
					lastSync={lastSyncView}
					recovery={recoveryItems(metrics)}
					isOwner={isOwner}
					pendingEvents={pendingEvents}
					shortcutName={prefs.syncShortcutName}
					ios={isIosUserAgent(headerList.get("user-agent") ?? "")}
				/>
			</div>

			{isOwner ? (
				<div className="card p-5">
					<MaintenanceSweep sweep={sweepView(sweep?.record ?? null, at)} />
				</div>
			) : null}

			<div className="card space-y-4 p-5">
				<h3 className="text-sm font-semibold text-white">Preferences</h3>
				<ChatSendKeySetting value={prefs.chatSendKey} />
			</div>

			<div className="card p-5">
				<ImportV1Form />
			</div>

			<div className="card space-y-4 p-5">
				<div>
					<h3 className="text-sm font-semibold text-white">Export my data</h3>
					<p className="mt-1 text-sm text-gray-400">
						One JSON file with your plan, every run and the coach chat. The plan, the chat and your manually logged runs
						read straight back into the importer above.
					</p>
				</div>

				<div className="flex flex-col gap-2 sm:flex-row">
					<a
						href="/api/export"
						download
						className="glow-sm flex-1 rounded-xl bg-brand-600 py-2.5 text-center text-sm font-semibold text-white transition hover:bg-brand-500"
					>
						Download backup
					</a>
					<a
						href="/api/export?streams=1"
						download
						className="flex-1 rounded-xl border border-white/10 py-2.5 text-center text-sm text-gray-300 transition hover:border-white/20 hover:text-white"
					>
						Include GPS &amp; heart-rate data
					</a>
				</div>

				<p className="text-xs text-gray-500">
					The second file carries every recorded sample of every synced run — accurate, but it can run to megabytes.
				</p>
			</div>

			<DangerZone email={user.email} />
		</section>
	);
}
