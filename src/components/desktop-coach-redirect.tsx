"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** Tailwind's `lg` breakpoint — where the coach becomes a permanent sidebar. */
const DESKTOP = "(min-width: 1024px)";

/**
 * `/coach` is the mobile way into the chat; at `lg:` the coach is already on
 * screen beside every view, so this route has nothing of its own left to show.
 * v1 did the same in `switchTab()`: picking the coach tab on a desktop-width
 * screen fell back to the plan view, coach sidebar and all.
 *
 * Listening for the media change (not just reading it once) covers resizing
 * the window while sitting on this route.
 */
export function DesktopCoachRedirect() {
	const router = useRouter();

	useEffect(() => {
		const media = window.matchMedia(DESKTOP);
		const settle = () => {
			if (media.matches) router.replace("/");
		};

		settle();
		media.addEventListener("change", settle);
		return () => media.removeEventListener("change", settle);
	}, [router]);

	return null;
}
