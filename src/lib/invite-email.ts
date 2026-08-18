import { authEmailFrom } from "@/lib/auth-email";
import { INVITE_TTL_DAYS } from "@/lib/invites";

type InviteEmailInput = {
	email: string;
	link: string;
	invitedBy: string;
};

function textBody({ link, invitedBy }: InviteEmailInput): string {
	return `${invitedBy} invited you to RunTracker.\n\nAccept the invite:\n${link}\n\nThe invite expires in ${INVITE_TTL_DAYS} days. Sign-in is passwordless — use this email address and a login link will be sent to you.\n`;
}

function htmlBody({ link, invitedBy }: InviteEmailInput): string {
	return `<!doctype html>
<html><body style="margin:0;padding:32px 16px;background:#0a0a1a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
	<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;margin:0 auto;background:#0c0c18;border:1px solid rgba(255,255,255,0.08);border-radius:16px;">
		<tr><td style="padding:32px;">
			<h1 style="margin:0 0 8px;font-size:18px;color:#ffffff;">You're invited to RunTracker</h1>
			<p style="margin:0 0 24px;font-size:14px;line-height:1.6;color:#8a8a9a;"><strong style="color:#c0c0c0;">${invitedBy}</strong> invited you to RunTracker — training plans, run tracking and an AI coach. Sign-in is passwordless: use this email address and a login link is sent to you.</p>
			<a href="${link}" style="display:inline-block;padding:12px 20px;background:#1a6ff5;color:#ffffff;font-size:14px;font-weight:600;text-decoration:none;border-radius:12px;">Accept invite</a>
			<p style="margin:24px 0 0;font-size:12px;line-height:1.6;color:#4a4a5a;word-break:break-all;">Or paste this into your browser:<br>${link}</p>
			<p style="margin:16px 0 0;font-size:12px;color:#4a4a5a;">The invite expires in ${INVITE_TTL_DAYS} days. If you weren't expecting this, you can ignore it.</p>
		</td></tr>
	</table>
</body></html>`;
}

/**
 * Delivers the invite through Resend, mirroring `sendMagicLink`'s fallback:
 * with no `RESEND_API_KEY` the link is printed to the server log instead.
 * Throws on a Resend rejection so the caller can tell the owner the email
 * did not go out (the invite row itself is already valid either way).
 */
export async function sendInviteEmail(input: InviteEmailInput): Promise<void> {
	const apiKey = process.env.RESEND_API_KEY?.trim();

	if (!apiKey) {
		console.info(`[invite] invite for ${input.email}: ${input.link}`);
		return;
	}

	const response = await fetch("https://api.resend.com/emails", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			from: authEmailFrom(),
			to: input.email,
			subject: "You're invited to RunTracker",
			html: htmlBody(input),
			text: textBody(input),
		}),
	});

	if (!response.ok) {
		const detail = await response.text().catch(() => "");
		console.error(`[invite] resend rejected the invite for ${input.email}: ${response.status} ${detail}`);
		throw new Error(`Resend responded ${response.status}`);
	}
}
