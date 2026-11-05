CREATE TABLE `lct_soniox_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`max_session_seconds` integer NOT NULL,
	CONSTRAINT "lct_soniox_sessions_duration_check" CHECK("lct_soniox_sessions"."max_session_seconds" >= 15 and "lct_soniox_sessions"."max_session_seconds" <= 900)
);
--> statement-breakpoint
CREATE INDEX `lct_soniox_sessions_created_idx` ON `lct_soniox_sessions` (`created_at`);