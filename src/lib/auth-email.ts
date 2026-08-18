import type { EmailProviderSendVerificationRequestParams } from "next-auth/providers/email";

export const DEFAULT_AUTH_EMAIL_FROM = "RunTracker <login@resend.dev>";

export function authEmailFrom(): string {
	return process.env.AUTH_EMAIL_FROM?.trim() || DEFAULT_AUTH_EMAIL_FROM;
}

function subject(host: string): string {
	return `Your RunTracker sign-in link (${host})`;
}

function textBody(url: string, host: string): string {
	return `Sign in to RunTracker (${host})\n\n${url}\n\nThe link expires in 24 hours and can only be used once. If you didn't request it, ignore this email.\n`;
}

function htmlBody(url: string, host: string): string {
	return `<!doctype html>
<html><body style="margin:0;padding:32px 16px;background:#0a0a1a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
	<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;margin:0 auto;background:#0c0c18;border:1px solid rgba(255,255,255,0.08);border-radius:16px;">
		<tr><td style="padding:32px;">
			<h1 style="margin:0 0 8px;font-size:18px;color:#ffffff;">Sign in to RunTracker</h1>
			<p style="margin:0 0 24px;font-size:14px;line-height:1.6;color:#8a8a9a;">Tap the button below to sign in as <strong style="color:#c0c0c0;">${host}</strong> knows you. The link expires in 24&nbsp;hours and works once.</p>
			<a href="${url}" style="display:inline-block;padding:12px 20px;background:#1a6ff5;color:#ffffff;font-size:14px;font-weight:600;text-decoration:none;border-radius:12px;">Sign in</a>
			<p style="margin:24px 0 0;font-size:12px;line-height:1.6;color:#4a4a5a;word-break:break-all;">Or paste this into your browser:<br>${url}</p>
			<p style="margin:16px 0 0;font-size:12px;color:#4a4a5a;">If you didn't request this, you can ignore it.</p>
		</td></tr>
	</table>
</body></html>`;
}

/**
 * Delivers the magic link through Resend. With no `RESEND_API_KEY` the link is
 * printed to the server log instead — that is the local-dev path, and it also
 * keeps a misconfigured deployment from throwing on every sign-in attempt.
 */
export async function sendMagicLink({ identifier, url }: EmailProviderSendVerificationRequestParams): Promise<void> {
	const apiKey = process.env.RESEND_API_KEY?.trim();
	const { host } = new URL(url);

	if (!apiKey) {
		console.info(`[auth] magic link for ${identifier}: ${url}`);
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
			to: identifier,
			subject: subject(host),
			html: htmlBody(url, host),
			text: textBody(url, host),
		}),
	});

	if (!response.ok) {
		const detail = await response.text().catch(() => "");
		console.error(`[auth] resend rejected the magic link for ${identifier}: ${response.status} ${detail}`);
		throw new Error(`Resend responded ${response.status}`);
	}
}
