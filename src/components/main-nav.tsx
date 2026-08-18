"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
	{ href: "/", label: "Plan" },
	{ href: "/log", label: "Log" },
	// At `lg:` the coach is a permanent sidebar on every view, so the tab that
	// leads to it is mobile-only — v1 hid it on desktop for the same reason.
	{ href: "/coach", label: "Coach", mobileOnly: true },
	{ href: "/sync", label: "Sync" },
	{ href: "/settings", label: "Settings" },
];

const OWNER_TABS = [{ href: "/invites", label: "Invites" }];

/** Two digits is as wide as this is allowed to get next to a tab label. */
function badgeLabel(count: number): string {
	return count > 99 ? "99+" : String(count);
}

export function MainNav({ isOwner = false, syncBadge = 0 }: { isOwner?: boolean; syncBadge?: number }) {
	const pathname = usePathname();
	const tabs = isOwner ? [...TABS, ...OWNER_TABS] : TABS;

	return (
		// Six tabs don't fit a narrow phone; scrolling them beats wrapping the header.
		<nav className="mx-auto flex max-w-6xl gap-4 overflow-x-auto px-5">
			{tabs.map((tab) => {
				const active = pathname === tab.href;
				const badge = tab.href === "/sync" && syncBadge > 0 ? syncBadge : 0;
				return (
					<Link
						key={tab.href}
						href={tab.href}
						aria-current={active ? "page" : undefined}
						className={`flex shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 py-2 text-sm transition ${
							active
								? "border-brand-500 font-semibold text-brand-400"
								: "border-transparent text-gray-500 hover:text-gray-300"
						} ${"mobileOnly" in tab && tab.mobileOnly ? "lg:hidden" : ""}`}
					>
						{tab.label}
						{badge > 0 ? (
							<span
								aria-label={`${badge} ${badge === 1 ? "activity" : "activities"} to review`}
								className="rounded-full bg-brand-600 px-1.5 py-px text-[10px] font-bold leading-4 text-white"
							>
								{badgeLabel(badge)}
							</span>
						) : null}
					</Link>
				);
			})}
		</nav>
	);
}
