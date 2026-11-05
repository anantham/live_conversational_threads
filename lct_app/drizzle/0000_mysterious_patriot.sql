CREATE TABLE `lct_cloud_files` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_user_id` text NOT NULL,
	`object_key` text NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`filename` text NOT NULL,
	`content_type` text NOT NULL,
	`byte_size` integer NOT NULL,
	`state` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "lct_cloud_files_kind_check" CHECK("lct_cloud_files"."kind" in ('file', 'threads', 'audio')),
	CONSTRAINT "lct_cloud_files_state_check" CHECK("lct_cloud_files"."state" in ('staging', 'ready', 'deleting')),
	CONSTRAINT "lct_cloud_files_byte_size_check" CHECK("lct_cloud_files"."byte_size" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `lct_cloud_files_object_key_unique` ON `lct_cloud_files` (`object_key`);--> statement-breakpoint
CREATE INDEX `lct_cloud_files_owner_state_created_id_idx` ON `lct_cloud_files` (`owner_user_id`,`state`,`created_at`,`id`);