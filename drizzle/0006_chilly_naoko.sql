CREATE TABLE "sign_in_codes" (
	"identifier" text PRIMARY KEY NOT NULL,
	"code_hash" text NOT NULL,
	"encrypted_url" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"expires" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
