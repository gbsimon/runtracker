import NextAuth from "next-auth";
import { NextResponse } from "next/server";
import { authConfig, isPublicPath, PATHNAME_HEADER } from "@/auth.config";

// Instantiated from the database-free config: this runs on every request and
// only needs to verify the session JWT.
const { auth } = NextAuth(authConfig);

/** Layouts can't see the request path, so forward it — the documented way to pass proxy state on. */
function forward(request: Request & { nextUrl: URL }) {
	const headers = new Headers(request.headers);
	headers.set(PATHNAME_HEADER, request.nextUrl.pathname);
	return NextResponse.next({ request: { headers } });
}

export const proxy = auth((request) => {
	const { pathname, search } = request.nextUrl;
	if (request.auth || isPublicPath(pathname)) return forward(request);

	if (pathname.startsWith("/api/")) {
		return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
	}

	const login = new URL("/login", request.nextUrl);
	login.searchParams.set("callbackUrl", `${pathname}${search}`);
	return NextResponse.redirect(login);
});

export const config = {
	matcher: [
		// Everything except Auth.js's own routes, the device-token ingest API,
		// and static assets.
		"/((?!api/auth|api/ingest|_next/static|_next/image|favicon.ico).*)",
	],
};
