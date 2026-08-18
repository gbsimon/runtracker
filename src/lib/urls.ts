import { headers } from "next/headers";
import { PATHNAME_HEADER } from "@/auth.config";

/** The path being rendered, as forwarded by `proxy.ts`. */
export async function currentPathname(): Promise<string> {
	return (await headers()).get(PATHNAME_HEADER) ?? "";
}

/** Origin of the current request, for links we put in emails and invites. */
export async function requestOrigin(): Promise<string> {
	const envUrl = process.env.AUTH_URL?.trim();
	if (envUrl) {
		try {
			return new URL(envUrl).origin;
		} catch {
			// fall through to the request headers
		}
	}

	const headerList = await headers();
	const host = headerList.get("x-forwarded-host") ?? headerList.get("host") ?? "localhost:3000";
	const protocol = headerList.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
	return `${protocol}://${host}`;
}
