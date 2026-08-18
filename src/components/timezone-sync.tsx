"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { TIMEZONE_COOKIE } from "@/lib/timezone";

/**
 * Server-rendered views need the runner's timezone to know what "today" is.
 * The browser publishes it once per change; the refresh re-renders the pages
 * that guessed with the server's zone before the cookie existed.
 */
export function TimezoneSync({ serverZone }: { serverZone: string }) {
	const router = useRouter();

	useEffect(() => {
		const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
		if (!zone) return;

		const current = document.cookie
			.split("; ")
			.find((entry) => entry.startsWith(`${TIMEZONE_COOKIE}=`))
			?.slice(TIMEZONE_COOKIE.length + 1);
		if (current === zone) return;

		// IANA zone names are already cookie-safe, so they round-trip unencoded.
		document.cookie = `${TIMEZONE_COOKIE}=${zone}; path=/; max-age=31536000; samesite=lax`;
		if (zone !== serverZone) router.refresh();
	}, [router, serverZone]);

	return null;
}
