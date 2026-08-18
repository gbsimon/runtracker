/** Timezone plumbing with no server dependency, so `TimezoneSync` can use it. */

export const TIMEZONE_COOKIE = "tz";

export function isValidTimeZone(value: string): boolean {
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: value });
		return true;
	} catch {
		return false;
	}
}
