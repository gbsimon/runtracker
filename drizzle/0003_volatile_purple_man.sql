CREATE TABLE "daily_metrics" (
	"user_id" uuid NOT NULL,
	"day" date NOT NULL,
	"kind" text NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "daily_metrics_user_id_day_kind_pk" PRIMARY KEY("user_id","day","kind")
);
--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "metrics" jsonb;--> statement-breakpoint
ALTER TABLE "daily_metrics" ADD CONSTRAINT "daily_metrics_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;