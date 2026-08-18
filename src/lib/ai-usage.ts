import { and, eq, sql } from "drizzle-orm";
import type Anthropic from "@anthropic-ai/sdk";
import { getDb } from "@/db";
import { aiUsage } from "@/db/schema";

/**
 * Per-user, per-day token budget. v1 spent the runner's own key, so there was
 * nothing to cap; v2 spends one server-side key for everyone.
 */
export const DEFAULT_DAILY_TOKEN_LIMIT = 300_000;

export function dailyTokenLimit(): number {
	const raw = Number(process.env.AI_DAILY_TOKEN_LIMIT);
	return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_DAILY_TOKEN_LIMIT;
}

/** `day` is the runner's local calendar date, so the cap resets at their midnight. */
export async function tokensUsedToday(userId: string, day: string): Promise<number> {
	const [row] = await getDb()
		.select({ tokensIn: aiUsage.tokensIn, tokensOut: aiUsage.tokensOut })
		.from(aiUsage)
		.where(and(eq(aiUsage.userId, userId), eq(aiUsage.day, day)))
		.limit(1);
	return row ? row.tokensIn + row.tokensOut : 0;
}

export async function isOverDailyLimit(userId: string, day: string): Promise<boolean> {
	return (await tokensUsedToday(userId, day)) >= dailyTokenLimit();
}

/** Increments in one statement so concurrent replies can't clobber each other. */
export async function recordUsage(userId: string, day: string, tokensIn: number, tokensOut: number): Promise<void> {
	if (tokensIn <= 0 && tokensOut <= 0) return;
	await getDb()
		.insert(aiUsage)
		.values({ userId, day, tokensIn, tokensOut })
		.onConflictDoUpdate({
			target: [aiUsage.userId, aiUsage.day],
			set: {
				tokensIn: sql`${aiUsage.tokensIn} + ${tokensIn}`,
				tokensOut: sql`${aiUsage.tokensOut} + ${tokensOut}`,
			},
		});
}

/** Cache tokens are counted as input too — they're billed and they're spend. */
export async function recordMessageUsage(userId: string, day: string, usage: Anthropic.Usage): Promise<void> {
	const tokensIn =
		usage.input_tokens + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
	await recordUsage(userId, day, tokensIn, usage.output_tokens);
}

export function limitReachedMessage(): string {
	return `⚠️ You've used up today's coach budget (${dailyTokenLimit().toLocaleString("en-US")} tokens). It resets at midnight — the plan, log and history all still work in the meantime.`;
}
