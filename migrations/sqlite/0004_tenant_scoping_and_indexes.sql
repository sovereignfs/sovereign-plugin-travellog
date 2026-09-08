-- Hand-edited after `drizzle-kit generate`. drizzle-kit expresses "make
-- `travellog_places.created_by` nullable" as its usual table rebuild
-- (`PRAGMA foreign_keys=OFF` → `__new_…` → `DROP TABLE` → rename). That
-- rebuild cannot run here: the platform migrator applies every migration
-- inside one transaction, where `PRAGMA foreign_keys` is a documented
-- no-op, and sqld enforces foreign keys by default — so the `DROP TABLE`
-- performs an implicit `DELETE FROM travellog_places`, which
-- `travellog_visits.place_id`'s `ON DELETE RESTRICT` rejects immediately
-- (RESTRICT fires even for deferred constraints) the moment any visit
-- exists. The column is made nullable in place instead: add a nullable
-- twin, copy, drop the original, rename — all plain ALTERs SQLite ≥ 3.35
-- supports inside a transaction. The column's ordinal position moves to
-- the end; nothing here depends on column order.
ALTER TABLE `travellog_places` ADD `created_by_nullable` text;--> statement-breakpoint
UPDATE `travellog_places` SET `created_by_nullable` = `created_by`;--> statement-breakpoint
ALTER TABLE `travellog_places` DROP COLUMN `created_by`;--> statement-breakpoint
ALTER TABLE `travellog_places` RENAME COLUMN `created_by_nullable` TO `created_by`;--> statement-breakpoint
ALTER TABLE `travellog_attachments` ADD `tenant_id` text DEFAULT 'default' NOT NULL;--> statement-breakpoint
ALTER TABLE `travellog_itinerary_items` ADD `tenant_id` text DEFAULT 'default' NOT NULL;--> statement-breakpoint
CREATE INDEX `travellog_itinerary_items_trip_idx` ON `travellog_itinerary_items` (`trip_id`);--> statement-breakpoint
ALTER TABLE `travellog_stops` ADD `tenant_id` text DEFAULT 'default' NOT NULL;--> statement-breakpoint
CREATE INDEX `travellog_stops_dates_idx` ON `travellog_stops` (`arrive_date`,`depart_date`);--> statement-breakpoint
ALTER TABLE `travellog_trip_days` ADD `tenant_id` text DEFAULT 'default' NOT NULL;--> statement-breakpoint
CREATE INDEX `travellog_trip_days_trip_idx` ON `travellog_trip_days` (`trip_id`);--> statement-breakpoint
ALTER TABLE `travellog_visit_photos` ADD `tenant_id` text DEFAULT 'default' NOT NULL;--> statement-breakpoint
CREATE INDEX `travellog_visits_trip_idx` ON `travellog_visits` (`trip_id`);--> statement-breakpoint
-- Backfill every new tenant_id from the parent row it hangs off, so existing
-- rows carry their real tenant rather than the column default.
UPDATE `travellog_stops` SET `tenant_id` = (SELECT `tenant_id` FROM `travellog_trips` WHERE `travellog_trips`.`id` = `travellog_stops`.`trip_id`) WHERE EXISTS (SELECT 1 FROM `travellog_trips` WHERE `travellog_trips`.`id` = `travellog_stops`.`trip_id`);--> statement-breakpoint
UPDATE `travellog_trip_days` SET `tenant_id` = (SELECT `tenant_id` FROM `travellog_trips` WHERE `travellog_trips`.`id` = `travellog_trip_days`.`trip_id`) WHERE EXISTS (SELECT 1 FROM `travellog_trips` WHERE `travellog_trips`.`id` = `travellog_trip_days`.`trip_id`);--> statement-breakpoint
UPDATE `travellog_itinerary_items` SET `tenant_id` = (SELECT `tenant_id` FROM `travellog_trips` WHERE `travellog_trips`.`id` = `travellog_itinerary_items`.`trip_id`) WHERE EXISTS (SELECT 1 FROM `travellog_trips` WHERE `travellog_trips`.`id` = `travellog_itinerary_items`.`trip_id`);--> statement-breakpoint
UPDATE `travellog_visit_photos` SET `tenant_id` = (SELECT `tenant_id` FROM `travellog_visits` WHERE `travellog_visits`.`id` = `travellog_visit_photos`.`visit_id`) WHERE EXISTS (SELECT 1 FROM `travellog_visits` WHERE `travellog_visits`.`id` = `travellog_visit_photos`.`visit_id`);--> statement-breakpoint
UPDATE `travellog_attachments` SET `tenant_id` = (SELECT `tenant_id` FROM `travellog_trips` WHERE `travellog_trips`.`id` = `travellog_attachments`.`trip_id`) WHERE `trip_id` IS NOT NULL AND EXISTS (SELECT 1 FROM `travellog_trips` WHERE `travellog_trips`.`id` = `travellog_attachments`.`trip_id`);--> statement-breakpoint
UPDATE `travellog_attachments` SET `tenant_id` = (SELECT `travellog_trips`.`tenant_id` FROM `travellog_trip_days` JOIN `travellog_trips` ON `travellog_trips`.`id` = `travellog_trip_days`.`trip_id` WHERE `travellog_trip_days`.`id` = `travellog_attachments`.`trip_day_id`) WHERE `trip_day_id` IS NOT NULL AND EXISTS (SELECT 1 FROM `travellog_trip_days` WHERE `travellog_trip_days`.`id` = `travellog_attachments`.`trip_day_id`);
