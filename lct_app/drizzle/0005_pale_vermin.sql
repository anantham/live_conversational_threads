CREATE TABLE `lct_google_sessions` (
	`jti_hash` text PRIMARY KEY NOT NULL,
	`google_sub` text NOT NULL,
	`challenge_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`revoked_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `lct_google_sessions_challenge_unique` ON `lct_google_sessions` (`challenge_hash`);--> statement-breakpoint
CREATE INDEX `lct_google_sessions_sub_idx` ON `lct_google_sessions` (`google_sub`);--> statement-breakpoint
CREATE INDEX `lct_google_sessions_expiry_idx` ON `lct_google_sessions` (`expires_at`);--> statement-breakpoint
ALTER TABLE `lct_cloud_files` ADD `owner_provider` text DEFAULT 'chatgpt' NOT NULL;--> statement-breakpoint
CREATE INDEX `lct_cloud_files_provider_owner_idx` ON `lct_cloud_files` (`owner_provider`,`owner_user_id`);