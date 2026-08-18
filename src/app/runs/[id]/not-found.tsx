import Link from "next/link";

/**
 * One page for "no such run" and "not your run" alike — telling the two apart
 * would let one account confirm what another has logged.
 */
export default function RunNotFound() {
	return (
		<section className="fade-in card p-8 text-center">
			<h2 className="text-base font-bold text-white">Run not found</h2>
			<p className="mt-1 text-sm text-gray-400">This run doesn’t exist, or it isn’t yours.</p>
			<Link
				href="/log"
				className="mt-4 inline-block rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-sm font-medium text-gray-300 transition hover:bg-white/10"
			>
				Back to log
			</Link>
		</section>
	);
}
