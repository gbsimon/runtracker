/** Pure path helpers — safe to import from client components. */

/**
 * Keeps a `callbackUrl` pointing at this site — a bare `/path`, never a
 * protocol-relative `//host` or an absolute URL.
 */
export function safeCallbackUrl(value: string | undefined | null, fallback = "/"): string {
	if (!value || !value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return fallback;
	return value;
}

export function loginHref(callbackUrl: string): string {
	return callbackUrl === "/" ? "/login" : `/login?callbackUrl=${encodeURIComponent(callbackUrl)}`;
}
