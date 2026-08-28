CREATE TABLE "travellog_attachments" (
	"id" text PRIMARY KEY NOT NULL,
	"trip_id" text,
	"trip_day_id" text,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"storage_key" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "travellog_itinerary_items" (
	"id" text PRIMARY KEY NOT NULL,
	"trip_day_id" text NOT NULL,
	"trip_id" text NOT NULL,
	"place_id" text,
	"title" text,
	"planned_time" text,
	"is_fixed" integer DEFAULT 0 NOT NULL,
	"position" double precision NOT NULL,
	"notes" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "travellog_stops" (
	"id" text PRIMARY KEY NOT NULL,
	"trip_id" text NOT NULL,
	"place_id" text NOT NULL,
	"arrive_date" text NOT NULL,
	"depart_date" text NOT NULL,
	"position" double precision NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "travellog_trip_days" (
	"id" text PRIMARY KEY NOT NULL,
	"stop_id" text NOT NULL,
	"trip_id" text NOT NULL,
	"date" text NOT NULL,
	"title" text,
	"notes" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "travellog_trip_days_stop_date_unique" UNIQUE("stop_id","date")
);
--> statement-breakpoint
CREATE TABLE "travellog_trips" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"owner_id" text NOT NULL,
	"name" text NOT NULL,
	"start_date" text,
	"end_date" text,
	"timezone" text,
	"companions" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "travellog_attachments" ADD CONSTRAINT "travellog_attachments_trip_id_travellog_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "travellog_trips"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "travellog_attachments" ADD CONSTRAINT "travellog_attachments_trip_day_id_travellog_trip_days_id_fk" FOREIGN KEY ("trip_day_id") REFERENCES "travellog_trip_days"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "travellog_itinerary_items" ADD CONSTRAINT "travellog_itinerary_items_trip_day_id_travellog_trip_days_id_fk" FOREIGN KEY ("trip_day_id") REFERENCES "travellog_trip_days"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "travellog_itinerary_items" ADD CONSTRAINT "travellog_itinerary_items_trip_id_travellog_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "travellog_trips"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "travellog_itinerary_items" ADD CONSTRAINT "travellog_itinerary_items_place_id_travellog_places_id_fk" FOREIGN KEY ("place_id") REFERENCES "travellog_places"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "travellog_stops" ADD CONSTRAINT "travellog_stops_trip_id_travellog_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "travellog_trips"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "travellog_stops" ADD CONSTRAINT "travellog_stops_place_id_travellog_places_id_fk" FOREIGN KEY ("place_id") REFERENCES "travellog_places"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "travellog_trip_days" ADD CONSTRAINT "travellog_trip_days_stop_id_travellog_stops_id_fk" FOREIGN KEY ("stop_id") REFERENCES "travellog_stops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "travellog_trip_days" ADD CONSTRAINT "travellog_trip_days_trip_id_travellog_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "travellog_trips"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "travellog_attachments_trip_idx" ON "travellog_attachments" USING btree ("trip_id");--> statement-breakpoint
CREATE INDEX "travellog_attachments_trip_day_idx" ON "travellog_attachments" USING btree ("trip_day_id");--> statement-breakpoint
CREATE INDEX "travellog_itinerary_items_day_position_idx" ON "travellog_itinerary_items" USING btree ("trip_day_id","position");--> statement-breakpoint
CREATE INDEX "travellog_stops_trip_position_idx" ON "travellog_stops" USING btree ("trip_id","position");--> statement-breakpoint
CREATE INDEX "travellog_trips_owner_start_idx" ON "travellog_trips" USING btree ("owner_id","start_date");--> statement-breakpoint
ALTER TABLE "travellog_visits" ADD CONSTRAINT "travellog_visits_trip_id_travellog_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "travellog_trips"("id") ON DELETE set null ON UPDATE no action;