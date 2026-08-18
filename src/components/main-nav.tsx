"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
	{ href: "/", label: "Plan" },
	{ href: "/log", label: "Log" },
	// At `lg:` the coach is a permanent sidebar on every view, so the tab that
	// leads to it is mobile-only — v1 hid it on desktop for the same reason.
	{ href: "/coach", label: "Coach", mobileOnly: true },
	{ href: "/settings", label: "Settings" },
];

const OWNER_TABS = [{ href: "/invites", label: "Invites" }];

export function MainNav({ isOwner = false }: { isOwner?: boolean }) {
	const pathname = usePathname();
	const tabs = isOwner ? [...TABS, ...OWNER_TABS] : TABS;

	return (
		<nav className="mx-auto flex max-w-6xl gap-4 px-5">
			{tabs.map((tab) => {
				const active = pathname === tab.href;
				return (
					<Link
						key={tab.href}
						href={tab.href}
						aria-current={active ? "page" : undefined}
						className={`border-b-2 py-2 text-sm transition ${
							active
								? "border-brand-500 font-semibold text-brand-400"
								: "border-transparent text-gray-500 hover:text-gray-300"
						} ${"mobileOnly" in tab && tab.mobileOnly ? "lg:hidden" : ""}`}
					>
						{tab.label}
					</Link>
				);
			})}
		</nav>
	);
}
