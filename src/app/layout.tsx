import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { redirect } from "next/navigation";
import { isPublicPath } from "@/auth.config";
import { CoachColumn } from "@/components/coach-column";
import { CoachPanel } from "@/components/coach-panel";
import { MainNav } from "@/components/main-nav";
import { TimezoneSync } from "@/components/timezone-sync";
import { UserMenu } from "@/components/user-menu";
import { unseenSkippedCount } from "@/lib/ingest/skipped";
import { resolveUser } from "@/lib/session";
import { userTimeZone } from "@/lib/today";
import { currentPathname } from "@/lib/urls";
import "./globals.css";

const inter = Inter({
	subsets: ["latin"],
	variable: "--font-inter",
	display: "swap",
});

export const metadata: Metadata = {
	title: "RunTracker",
	description: "Race training plans, run logging, and an AI coach.",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
	const { hasSession, user } = await resolveUser();
	const pathname = await currentPathname();

	// `proxy.ts` only verifies the token's signature. Every page renders through
	// this layout, so it is the one place that can turn a token whose account no
	// longer exists back into a signed-out request.
	if (hasSession && !user && !isPublicPath(pathname)) redirect("/login");

	// The Sync tab's badge. Suppressed while that page is the one being rendered:
	// the visit clears it, but the page and this layout render side by side, so
	// reading the count here would still show the stamp it is about to overwrite.
	const syncBadge = user && pathname !== "/sync" ? await unseenSkippedCount(user.id) : 0;

	return (
		<html lang="en" className={inter.variable}>
			<body className="min-h-screen font-sans text-gray-200 antialiased">
				<header className="glass sticky top-0 z-50 rounded-none border-x-0 border-t-0">
					<div className="mx-auto flex max-w-6xl items-center justify-between px-5 py-3.5">
						<div className="flex items-center gap-2.5">
							<div className="glow-sm flex h-8 w-8 items-center justify-center rounded-lg bg-brand-600 text-sm font-bold text-white">
								R
							</div>
							<h1 className="text-base font-extrabold leading-tight tracking-tight text-white">RunTracker</h1>
						</div>
						{user?.email ? <UserMenu email={user.email} /> : null}
					</div>
					{user ? <MainNav isOwner={user.role === "owner"} syncBadge={syncBadge} /> : null}
				</header>
				<main className="relative z-10 mx-auto max-w-6xl px-5 py-5 pb-24">
					{user ? (
						<div className="lg:flex lg:gap-6">
							<div className="lg:min-w-0 lg:flex-1">{children}</div>
							<CoachColumn>
								<CoachPanel userId={user.id} />
							</CoachColumn>
						</div>
					) : (
						children
					)}
				</main>
				{user ? <TimezoneSync serverZone={await userTimeZone()} /> : null}
			</body>
		</html>
	);
}
