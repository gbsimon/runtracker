import { sql } from "drizzle-orm";
import {
	date,
	doublePrecision,
	index,
	integer,
	jsonb,
	pgTable,
	primaryKey,
	text,
	timestamp,
	uniqueIndex,
	uuid,
} from "drizzle-orm/pg-core";
import type { AdapterAccountType } from "next-auth/adapters";

export type RunSource = "manual" | "apple_health";
/**
 * `splits` is the derived per-kilometre series; `altitude` rides along in
 * `route`; `hr_recovery` is the post-run heart-rate decay the watch keeps
 * recording for about two minutes after the workout ends.
 */
export type StreamKind = "route" | "heart_rate" | "altitude" | "cadence" | "splits" | "hr_recovery";
export type UserRole = "owner" | "member";

const id = () => uuid("id").primaryKey().defaultRandom();
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const users = pgTable("users", {
	id: id(),
	email: text("email").notNull().unique(),
	name: text("name"),
	/** Set by Auth.js when a magic link is followed. */
	emailVerified: timestamp("email_verified", { withTimezone: true, mode: "date" }),
	image: text("image"),
	role: text("role").$type<UserRole>().notNull().default("member"),
	createdAt: createdAt(),
});

/*
 * Auth.js (@auth/drizzle-adapter) tables. The magic-link flow only touches
 * `users` and `verification_tokens`; `accounts` and `sessions` are unused
 * while sessions are JWTs and no OAuth provider is configured, but the
 * adapter is wired to them so switching either on is a config change.
 */

export const accounts = pgTable(
	"accounts",
	{
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		type: text("type").$type<AdapterAccountType>().notNull(),
		provider: text("provider").notNull(),
		providerAccountId: text("provider_account_id").notNull(),
		refresh_token: text("refresh_token"),
		access_token: text("access_token"),
		expires_at: integer("expires_at"),
		token_type: text("token_type"),
		scope: text("scope"),
		id_token: text("id_token"),
		session_state: text("session_state"),
	},
	(table) => [primaryKey({ columns: [table.provider, table.providerAccountId] })],
);

export const sessions = pgTable("sessions", {
	sessionToken: text("session_token").primaryKey(),
	userId: uuid("user_id")
		.notNull()
		.references(() => users.id, { onDelete: "cascade" }),
	expires: timestamp("expires", { withTimezone: true, mode: "date" }).notNull(),
});

export const verificationTokens = pgTable(
	"verification_tokens",
	{
		identifier: text("identifier").notNull(),
		token: text("token").notNull(),
		expires: timestamp("expires", { withTimezone: true, mode: "date" }).notNull(),
	},
	(table) => [primaryKey({ columns: [table.identifier, table.token] })],
);

export const invites = pgTable("invites", {
	id: id(),
	token: text("token").notNull().unique(),
	email: text("email").notNull(),
	invitedBy: uuid("invited_by").references(() => users.id, { onDelete: "set null" }),
	expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
	usedAt: timestamp("used_at", { withTimezone: true }),
	createdAt: createdAt(),
});

export const ingestTokens = pgTable("ingest_tokens", {
	id: id(),
	userId: uuid("user_id")
		.notNull()
		.references(() => users.id, { onDelete: "cascade" }),
	tokenHash: text("token_hash").notNull().unique(),
	label: text("label"),
	lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
	createdAt: createdAt(),
});

export const runs = pgTable(
	"runs",
	{
		id: id(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		source: text("source").$type<RunSource>().notNull(),
		externalId: text("external_id"),
		startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
		timezone: text("timezone"),
		distanceM: doublePrecision("distance_m").notNull(),
		durationS: integer("duration_s").notNull(),
		effort: integer("effort"),
		notes: text("notes"),
		avgHr: integer("avg_hr"),
		maxHr: integer("max_hr"),
		avgCadence: doublePrecision("avg_cadence"),
		elevationGainM: doublePrecision("elevation_gain_m"),
		weather: jsonb("weather"),
		/**
		 * The watch measurements that don't each deserve a column —
		 * `{energyKj, maxSpeedMs}` today. One jsonb keeps the next Tier-0 field
		 * a parser change rather than a migration, the same bet `weather` makes.
		 */
		metrics: jsonb("metrics"),
		createdAt: createdAt(),
	},
	(table) => [
		index("runs_user_started_at_idx").on(table.userId, table.startedAt),
		uniqueIndex("runs_user_source_external_id_key")
			.on(table.userId, table.source, table.externalId)
			.where(sql`${table.externalId} is not null`),
	],
);

export const runStreams = pgTable(
	"run_streams",
	{
		id: id(),
		runId: uuid("run_id")
			.notNull()
			.references(() => runs.id, { onDelete: "cascade" }),
		kind: text("kind").$type<StreamKind>().notNull(),
		data: jsonb("data").notNull(),
		createdAt: createdAt(),
	},
	(table) => [uniqueIndex("run_streams_run_id_kind_key").on(table.runId, table.kind)],
);

/**
 * One row per day per metric from the Health Metrics automation — resting heart
 * rate, HRV, VO₂max, sleep. `kind` is the metric's own name rather than an enum
 * so a metric we haven't modelled yet still lands somewhere useful, and `value`
 * is jsonb because a sleep night is six numbers where a resting heart rate is
 * one. Days are missing whenever the watch was off, so nothing may assume the
 * series is continuous.
 */
export const dailyMetrics = pgTable(
	"daily_metrics",
	{
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		/** The local calendar day the metric describes. */
		day: date("day").notNull(),
		kind: text("kind").notNull(),
		value: jsonb("value").notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(table) => [primaryKey({ columns: [table.userId, table.day, table.kind] })],
);

export const ingestEvents = pgTable(
	"ingest_events",
	{
		id: id(),
		userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
		source: text("source").notNull(),
		/** `received` → `processed` | `failed`; `captured` is the Phase 0 spike's. */
		status: text("status").notNull(),
		raw: jsonb("raw").notNull(),
		/** Per-workout outcomes of the last processing pass, and its error if it failed. */
		summary: jsonb("summary"),
		receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(table) => [index("ingest_events_user_received_at_idx").on(table.userId, table.receivedAt)],
);

export const plans = pgTable("plans", {
	id: id(),
	userId: uuid("user_id")
		.notNull()
		.unique()
		.references(() => users.id, { onDelete: "cascade" }),
	settings: jsonb("settings").notNull(),
	weeks: jsonb("weeks").notNull(),
	completed: jsonb("completed").notNull().default({}),
	skipped: jsonb("skipped").notNull().default({}),
	createdAt: createdAt(),
	updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const chatMessages = pgTable(
	"chat_messages",
	{
		id: id(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		role: text("role").notNull(),
		content: text("content").notNull(),
		createdAt: createdAt(),
	},
	(table) => [index("chat_messages_user_created_at_idx").on(table.userId, table.createdAt)],
);

export const aiUsage = pgTable(
	"ai_usage",
	{
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		day: date("day").notNull(),
		tokensIn: integer("tokens_in").notNull().default(0),
		tokensOut: integer("tokens_out").notNull().default(0),
	},
	(table) => [primaryKey({ columns: [table.userId, table.day] })],
);

/**
 * Installation-wide settings that outlive a deploy — not a user's, and not the
 * environment's. One row per key, value in jsonb.
 *
 * Its first tenant is `coach_model`: when Anthropic retires the model this
 * build was written against, the coach picks a live one and records it here so
 * the next boot starts on the working model instead of rediscovering the
 * failure. A `COACH_MODEL` env var still outranks whatever is stored.
 */
export const appConfig = pgTable("app_config", {
	key: text("key").primaryKey(),
	value: jsonb("value").notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
