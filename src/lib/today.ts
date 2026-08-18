import { cookies } from "next/headers";
import { todayISOInZone } from "./running";
import { isValidTimeZone, TIMEZONE_COOKIE } from "./timezone";

/**
 * v1 read "today" from the browser. Pages render on the server now, so the
 * browser writes its timezone to a cookie (see `TimezoneSync`) and every
 * date-dependent view — current week, hide-past-weeks, the log form's default
 * date — reads it back. Falls back to the server's zone until it is set.
 */
export async function userTimeZone(): Promise<string> {
	const value = (await cookies()).get(TIMEZONE_COOKIE)?.value;
	if (value && isValidTimeZone(value)) return value;
	return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

export async function todayISO(): Promise<string> {
	return todayISOInZone(await userTimeZone());
}
