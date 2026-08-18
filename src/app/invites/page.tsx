import { desc } from "drizzle-orm";
import type { Metadata } from "next";
import { InviteForm } from "@/components/invite-form";
import { getDb } from "@/db";
import { invites } from "@/db/schema";
import { inviteLink, inviteStatus, type InviteStatus } from "@/lib/invites";
import { requireOwner } from "@/lib/session";
import { requestOrigin } from "@/lib/urls";

export const metadata: Metadata = { title: "Invites · RunTracker" };

const STATUS_STYLES: Record<InviteStatus, string> = {
	pending: "border-brand-500/30 bg-brand-600/15 text-brand-300",
	used: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
	expired: "border-white/10 bg-white/5 text-gray-500",
};

const dateFormat = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" });

export default async function InvitesPage() {
	await requireOwner();

	const [rows, origin] = await Promise.all([
		getDb().select().from(invites).orderBy(desc(invites.createdAt)),
		requestOrigin(),
	]);

	return (
		<section className="fade-in space-y-5">
			<div>
				<h2 className="text-lg font-bold text-white">Invites</h2>
				<p className="mt-1 text-sm text-gray-400">
					RunTracker has no public sign-up. An address can only sign in once it holds an invite or an account.
				</p>
			</div>

			<div className="card p-5">
				<InviteForm />
			</div>

			<div className="card overflow-hidden">
				{rows.length === 0 ? (
					<p className="p-6 text-center text-sm text-gray-500">No invites yet.</p>
				) : (
					<ul className="divide-y divide-white/5">
						{rows.map((invite) => {
							const status = inviteStatus(invite);
							return (
								<li key={invite.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5">
									<div className="min-w-0">
										<p className="truncate text-sm text-gray-200">{invite.email}</p>
										<p className="mt-0.5 text-xs text-gray-500">
											{status === "used"
												? `Used ${dateFormat.format(invite.usedAt as Date)}`
												: `${status === "expired" ? "Expired" : "Expires"} ${dateFormat.format(invite.expiresAt)}`}
										</p>
										{status === "pending" ? (
											<code className="mt-1.5 block break-all text-[11px] text-gray-600">
												{inviteLink(origin, invite.token)}
											</code>
										) : null}
									</div>
									<span
										className={`shrink-0 rounded-full border px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${STATUS_STYLES[status]}`}
									>
										{status}
									</span>
								</li>
							);
						})}
					</ul>
				)}
			</div>
		</section>
	);
}
