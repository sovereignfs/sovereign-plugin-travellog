ALTER TABLE "travellog_places" ALTER COLUMN "created_by" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "travellog_attachments" ADD COLUMN "tenant_id" text DEFAULT 'default' NOT NULL;--> statement-breakpoint
ALTER TABLE "travellog_itinerary_items" ADD COLUMN "tenant_id" text DEFAULT 'default' NOT NULL;--> statement-breakpoint
ALTER TABLE "travellog_stops" ADD COLUMN "tenant_id" text DEFAULT 'default' NOT NULL;--> statement-breakpoint
ALTER TABLE "travellog_trip_days" ADD COLUMN "tenant_id" text DEFAULT 'default' NOT NULL;--> statement-breakpoint
ALTER TABLE "travellog_visit_photos" ADD COLUMN "tenant_id" text DEFAULT 'default' NOT NULL;--> statement-breakpoint
CREATE INDEX "travellog_itinerary_items_trip_idx" ON "travellog_itinerary_items" USING btree ("trip_id");--> statement-breakpoint
CREATE INDEX "travellog_stops_dates_idx" ON "travellog_stops" USING btree ("arrive_date","depart_date");--> statement-breakpoint
CREATE INDEX "travellog_trip_days_trip_idx" ON "travellog_trip_days" USING btree ("trip_id");--> statement-breakpoint
CREATE INDEX "travellog_visits_trip_idx" ON "travellog_visits" USING btree ("trip_id");--> statement-breakpoint
UPDATE "travellog_stops" SET "tenant_id" = t."tenant_id" FROM "travellog_trips" t WHERE t."id" = "travellog_stops"."trip_id";--> statement-breakpoint
UPDATE "travellog_trip_days" SET "tenant_id" = t."tenant_id" FROM "travellog_trips" t WHERE t."id" = "travellog_trip_days"."trip_id";--> statement-breakpoint
UPDATE "travellog_itinerary_items" SET "tenant_id" = t."tenant_id" FROM "travellog_trips" t WHERE t."id" = "travellog_itinerary_items"."trip_id";--> statement-breakpoint
UPDATE "travellog_visit_photos" SET "tenant_id" = v."tenant_id" FROM "travellog_visits" v WHERE v."id" = "travellog_visit_photos"."visit_id";--> statement-breakpoint
UPDATE "travellog_attachments" SET "tenant_id" = t."tenant_id" FROM "travellog_trips" t WHERE t."id" = "travellog_attachments"."trip_id";--> statement-breakpoint
UPDATE "travellog_attachments" SET "tenant_id" = t."tenant_id" FROM "travellog_trip_days" d JOIN "travellog_trips" t ON t."id" = d."trip_id" WHERE d."id" = "travellog_attachments"."trip_day_id";
