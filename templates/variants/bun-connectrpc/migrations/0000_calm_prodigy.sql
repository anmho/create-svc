CREATE TABLE "waitlist_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"name" text,
	"company" text,
	"source" text,
	"status" text DEFAULT 'joined' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "waitlist_triggers" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"entry_id" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"payload_json" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"external_event_id" text NOT NULL,
	"payload_json" text NOT NULL,
	"headers_json" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "waitlist_triggers" ADD CONSTRAINT "waitlist_triggers_entry_id_waitlist_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."waitlist_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "waitlist_entries_email_key" ON "waitlist_entries" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_events_provider_external_event_id_key" ON "webhook_events" USING btree ("provider","external_event_id");