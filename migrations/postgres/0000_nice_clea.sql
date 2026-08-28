CREATE TABLE "travellog_places" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"name" text NOT NULL,
	"category" text,
	"lat" double precision,
	"lng" double precision,
	"address" text,
	"city" text,
	"state" text,
	"country" text,
	"country_code" text,
	"postal_code" text,
	"source" text NOT NULL,
	"source_ref" text,
	"created_by" text NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "travellog_visit_photos" (
	"id" text PRIMARY KEY NOT NULL,
	"visit_id" text NOT NULL,
	"storage_key" text NOT NULL,
	"position" double precision NOT NULL,
	"source" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "travellog_visits" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"user_id" text NOT NULL,
	"place_id" text NOT NULL,
	"happened_at" bigint NOT NULL,
	"tz_iana" text NOT NULL,
	"tz_offset_minutes" integer NOT NULL,
	"note" text,
	"companions" text,
	"trip_id" text,
	"link_source" text,
	"source" text NOT NULL,
	"external_ref" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "travellog_visits_tenant_source_external_ref_unique" UNIQUE("tenant_id","source","external_ref")
);
--> statement-breakpoint
ALTER TABLE "travellog_visit_photos" ADD CONSTRAINT "travellog_visit_photos_visit_id_travellog_visits_id_fk" FOREIGN KEY ("visit_id") REFERENCES "travellog_visits"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "travellog_visits" ADD CONSTRAINT "travellog_visits_place_id_travellog_places_id_fk" FOREIGN KEY ("place_id") REFERENCES "travellog_places"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "travellog_places_tenant_name_idx" ON "travellog_places" USING btree ("tenant_id","name");--> statement-breakpoint
CREATE INDEX "travellog_visit_photos_visit_position_idx" ON "travellog_visit_photos" USING btree ("visit_id","position");--> statement-breakpoint
CREATE INDEX "travellog_visits_user_happened_idx" ON "travellog_visits" USING btree ("user_id","happened_at");--> statement-breakpoint
CREATE INDEX "travellog_visits_place_idx" ON "travellog_visits" USING btree ("place_id");