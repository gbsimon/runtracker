import { NextResponse } from "next/server";
import { collectBackup, exportFilename } from "@/lib/backup";
import { currentUser } from "@/lib/session";
import { userTimeZone } from "@/lib/today";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `proxy.ts` already turns away unauthenticated API requests; this re-checks
 * because the file it hands back is the user's entire history.
 */
export async function GET(request: Request) {
	const user = await currentUser();
	if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

	const includeStreams = new URL(request.url).searchParams.get("streams") === "1";
	const timeZone = await userTimeZone();
	const payload = await collectBackup(user.id, { timeZone, includeStreams });

	// Backups are meant to be readable; pretty-printing tens of thousands of
	// GPS samples is not, so the streams file goes out compact.
	const body = includeStreams ? JSON.stringify(payload) : JSON.stringify(payload, null, 2);

	return new NextResponse(body, {
		headers: {
			"Content-Type": "application/json; charset=utf-8",
			"Content-Disposition": `attachment; filename="${exportFilename(timeZone)}"`,
			"Cache-Control": "no-store",
		},
	});
}
