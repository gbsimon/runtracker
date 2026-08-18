import type { Metadata } from "next";
import { DesktopCoachRedirect } from "@/components/desktop-coach-redirect";
import { requireUser } from "@/lib/session";

export const metadata: Metadata = { title: "Coach · RunTracker" };

/**
 * The chat itself is mounted once in the root layout (`CoachPanel`), which is
 * what keeps one live conversation across every view. On mobile this route is
 * simply where that column becomes visible; at `lg:` it hands over to the
 * sidebar and sends the browser back to the plan.
 */
export default async function CoachPage() {
	await requireUser();
	return <DesktopCoachRedirect />;
}
