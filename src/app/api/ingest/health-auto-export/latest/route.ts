import { desc, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { ingestEvents } from "@/db/schema";
import { isAuthorizedIngest } from "@/lib/ingest-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
	if (!isAuthorizedIngest(request)) {
		return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
	}

	try {
		const events = await getDb()
			.select({
				id: ingestEvents.id,
				receivedAt: ingestEvents.receivedAt,
				source: ingestEvents.source,
				status: ingestEvents.status,
				jsonType: sql<string>`jsonb_typeof(${ingestEvents.raw})`,
				sizeBytes: sql<number>`pg_column_size(${ingestEvents.raw})`,
				keys: sql<
					string[] | null
				>`case when jsonb_typeof(${ingestEvents.raw}) = 'object' then array(select jsonb_object_keys(${ingestEvents.raw})) end`,
			})
			.from(ingestEvents)
			.orderBy(desc(ingestEvents.receivedAt))
			.limit(5);

		return NextResponse.json({ ok: true, events });
	} catch (error) {
		console.error("[ingest] failed to read recent events", error);
		return NextResponse.json({ ok: false, error: "query_failed" }, { status: 500 });
	}
}
