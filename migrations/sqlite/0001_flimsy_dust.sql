CREATE TABLE `travellog_import_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`user_id` text NOT NULL,
	`status` text NOT NULL,
	`storage_key` text NOT NULL,
	`platform_job_id` text,
	`total_checkins` integer,
	`processed_checkins` integer NOT NULL,
	`total_photos` integer,
	`processed_photos` integer NOT NULL,
	`failed_photos` integer NOT NULL,
	`cursor` integer NOT NULL,
	`error_message` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`completed_at` integer
);
--> statement-breakpoint
CREATE INDEX `travellog_import_jobs_user_created_idx` ON `travellog_import_jobs` (`user_id`,`created_at`);