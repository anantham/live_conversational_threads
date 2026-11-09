CREATE TABLE `lct_meetings` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`url_hash` text NOT NULL,
	`bot_id` text,
	`state` text NOT NULL,
	`created_at` integer NOT NULL,
	`ends_at` integer NOT NULL,
	CONSTRAINT "lct_meetings_state_check" CHECK("lct_meetings"."state" in ('starting', 'uncertain', 'active', 'ended')),
	CONSTRAINT "lct_meetings_duration_check" CHECK("lct_meetings"."ends_at" > "lct_meetings"."created_at" and "lct_meetings"."ends_at" <= "lct_meetings"."created_at" + 300000)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `lct_meetings_bot_unique` ON `lct_meetings` (`bot_id`);--> statement-breakpoint
CREATE INDEX `lct_meetings_owner_created_idx` ON `lct_meetings` (`owner`,`created_at`);