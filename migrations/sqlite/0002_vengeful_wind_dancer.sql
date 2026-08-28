CREATE TABLE `travellog_attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`trip_id` text,
	`trip_day_id` text,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`storage_key` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`trip_id`) REFERENCES `travellog_trips`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`trip_day_id`) REFERENCES `travellog_trip_days`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `travellog_attachments_trip_idx` ON `travellog_attachments` (`trip_id`);--> statement-breakpoint
CREATE INDEX `travellog_attachments_trip_day_idx` ON `travellog_attachments` (`trip_day_id`);--> statement-breakpoint
CREATE TABLE `travellog_itinerary_items` (
	`id` text PRIMARY KEY NOT NULL,
	`trip_day_id` text NOT NULL,
	`trip_id` text NOT NULL,
	`place_id` text,
	`title` text,
	`planned_time` text,
	`is_fixed` integer DEFAULT 0 NOT NULL,
	`position` real NOT NULL,
	`notes` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`trip_day_id`) REFERENCES `travellog_trip_days`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`trip_id`) REFERENCES `travellog_trips`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`place_id`) REFERENCES `travellog_places`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `travellog_itinerary_items_day_position_idx` ON `travellog_itinerary_items` (`trip_day_id`,`position`);--> statement-breakpoint
CREATE TABLE `travellog_stops` (
	`id` text PRIMARY KEY NOT NULL,
	`trip_id` text NOT NULL,
	`place_id` text NOT NULL,
	`arrive_date` text NOT NULL,
	`depart_date` text NOT NULL,
	`position` real NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`trip_id`) REFERENCES `travellog_trips`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`place_id`) REFERENCES `travellog_places`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `travellog_stops_trip_position_idx` ON `travellog_stops` (`trip_id`,`position`);--> statement-breakpoint
CREATE TABLE `travellog_trip_days` (
	`id` text PRIMARY KEY NOT NULL,
	`stop_id` text NOT NULL,
	`trip_id` text NOT NULL,
	`date` text NOT NULL,
	`title` text,
	`notes` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`stop_id`) REFERENCES `travellog_stops`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`trip_id`) REFERENCES `travellog_trips`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `travellog_trip_days_stop_date_unique` ON `travellog_trip_days` (`stop_id`,`date`);--> statement-breakpoint
CREATE TABLE `travellog_trips` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`name` text NOT NULL,
	`start_date` text,
	`end_date` text,
	`timezone` text,
	`companions` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `travellog_trips_owner_start_idx` ON `travellog_trips` (`owner_id`,`start_date`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_travellog_visits` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`user_id` text NOT NULL,
	`place_id` text NOT NULL,
	`happened_at` integer NOT NULL,
	`tz_iana` text NOT NULL,
	`tz_offset_minutes` integer NOT NULL,
	`note` text,
	`companions` text,
	`trip_id` text,
	`link_source` text,
	`source` text NOT NULL,
	`external_ref` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`place_id`) REFERENCES `travellog_places`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`trip_id`) REFERENCES `travellog_trips`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_travellog_visits`("id", "tenant_id", "user_id", "place_id", "happened_at", "tz_iana", "tz_offset_minutes", "note", "companions", "trip_id", "link_source", "source", "external_ref", "created_at", "updated_at") SELECT "id", "tenant_id", "user_id", "place_id", "happened_at", "tz_iana", "tz_offset_minutes", "note", "companions", "trip_id", "link_source", "source", "external_ref", "created_at", "updated_at" FROM `travellog_visits`;--> statement-breakpoint
DROP TABLE `travellog_visits`;--> statement-breakpoint
ALTER TABLE `__new_travellog_visits` RENAME TO `travellog_visits`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `travellog_visits_user_happened_idx` ON `travellog_visits` (`user_id`,`happened_at`);--> statement-breakpoint
CREATE INDEX `travellog_visits_place_idx` ON `travellog_visits` (`place_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `travellog_visits_tenant_source_external_ref_unique` ON `travellog_visits` (`tenant_id`,`source`,`external_ref`);