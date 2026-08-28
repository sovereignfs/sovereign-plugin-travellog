CREATE TABLE `travellog_places` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`name` text NOT NULL,
	`category` text,
	`lat` real,
	`lng` real,
	`address` text,
	`city` text,
	`state` text,
	`country` text,
	`country_code` text,
	`postal_code` text,
	`source` text NOT NULL,
	`source_ref` text,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `travellog_places_tenant_name_idx` ON `travellog_places` (`tenant_id`,`name`);--> statement-breakpoint
CREATE TABLE `travellog_visit_photos` (
	`id` text PRIMARY KEY NOT NULL,
	`visit_id` text NOT NULL,
	`storage_key` text NOT NULL,
	`position` real NOT NULL,
	`source` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`visit_id`) REFERENCES `travellog_visits`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `travellog_visit_photos_visit_position_idx` ON `travellog_visit_photos` (`visit_id`,`position`);--> statement-breakpoint
CREATE TABLE `travellog_visits` (
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
	FOREIGN KEY (`place_id`) REFERENCES `travellog_places`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `travellog_visits_user_happened_idx` ON `travellog_visits` (`user_id`,`happened_at`);--> statement-breakpoint
CREATE INDEX `travellog_visits_place_idx` ON `travellog_visits` (`place_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `travellog_visits_tenant_source_external_ref_unique` ON `travellog_visits` (`tenant_id`,`source`,`external_ref`);