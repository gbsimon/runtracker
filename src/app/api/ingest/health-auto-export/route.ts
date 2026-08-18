import { NextResponse } from "next/server";
import { authenticateIngest } from "@/lib/ingest-auth";
import { processIngestEvent, storeIngestEvent } from "@/lib/ingest/process";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_RAW_TEXT = 1_000_000;

/**
 * The Health Auto Export webhook. Storing the raw payload is the only step
 * that can fail the request: once it's on disk the workouts can always be
 * replayed, so a processing error still answers 200 and leaves the event
 * marked `failed` for the Reprocess button.
 */
export async function POST(request: Request) {
	const principal = await authenticateIngest(request);
	if (!principal) {
		return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
	}

	const text = await request.text();
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (error) {
		raw = {
			parseError: error instanceof Error ? error.message : String(error),
			rawText: text.slice(0, MAX_RAW_TEXT),
			truncated: text.length > MAX_RAW_TEXT,
		};
	}

	let eventId: string;
	try {
		eventId = await storeIngestEvent(principal.userId, raw);
	} catch (error) {
		console.error("[ingest] failed to store health-auto-export payload", error);
		return NextResponse.json({ ok: false, error: "storage_failed" }, { status: 500 });
	}

	// `processIngestEvent` records its own failures; this catches the ones that
	// happen while recording them, so a stored payload never answers 500 and
	// gets re-sent.
	const summary = await processIngestEvent(eventId, principal.userId, raw).catch((error) => {
		console.error("[ingest] could not record the processing result", eventId, error);
		return { workouts: 0, imported: 0, reconciled: 0, enriched: 0, duplicate: 0, skipped: 0, failed: 0, outcomes: [] };
	});

	return NextResponse.json({
		ok: true,
		eventId,
		auth: principal.via,
		workouts: summary.workouts,
		imported: summary.imported,
		reconciled: summary.reconciled,
		enriched: summary.enriched,
		duplicate: summary.duplicate,
		skipped: summary.skipped,
		failed: summary.failed,
		// Present only when the payload came from the Health Metrics automation.
		metrics: "metrics" in summary ? summary.metrics : undefined,
		outcomes: summary.outcomes.map((outcome) => ({
			externalId: outcome.externalId,
			status: outcome.status,
			reason: outcome.reason,
		})),
	});
}

export function GET() {
	return NextResponse.json(
		{
			ok: false,
			error: "method_not_allowed",
			hint: "POST your Health Auto Export payload here with an `x-ingest-token` header.",
		},
		{ status: 405, headers: { Allow: "POST" } },
	);
}
