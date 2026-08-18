import Link from "next/link";

/**
 * Shown for every accepted sign-in request, whether or not a link was actually
 * sent — the wording must stay true in both cases.
 */
export function CheckEmailNotice({ email, resetHref }: { email?: string; resetHref: string }) {
	return (
		<div className="fade-in space-y-3 text-center">
			<div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-600/20 text-2xl">✉️</div>
			<h2 className="text-base font-bold text-white">Check your email</h2>
			<p className="text-sm leading-relaxed text-gray-400">
				If {email ? <span className="text-gray-200">{email}</span> : "that address"} can access RunTracker, a sign-in
				link is on its way. It expires in 24 hours.
			</p>
			<Link
				href={resetHref}
				className="inline-block text-xs text-gray-500 underline underline-offset-4 transition hover:text-gray-300"
			>
				Use a different address
			</Link>
		</div>
	);
}
