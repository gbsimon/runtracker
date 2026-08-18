"use client";

import { usePathname } from "next/navigation";

/**
 * Visibility wrapper for the coach column: always on at `lg:`, and on mobile
 * only while `/coach` is the open route.
 *
 * This has to be a client component. The panel is mounted in the root layout
 * so the conversation survives navigation, but that also means the layout is
 * not re-rendered when you move between routes — a server-computed pathname
 * would still say "/" after a client-side navigation to /coach, and the column
 * would stay hidden. `usePathname()` re-renders on navigation; the server
 * component passed in as `children` is untouched, so the chat keeps its state.
 */
export function CoachColumn({ children }: { children: React.ReactNode }) {
	const onCoachRoute = usePathname() === "/coach";

	return (
		<div className={`${onCoachRoute ? "" : "hidden"} fade-in lg:block lg:w-[420px] lg:flex-shrink-0`}>
			<div className="lg:sticky lg:top-24">{children}</div>
		</div>
	);
}
