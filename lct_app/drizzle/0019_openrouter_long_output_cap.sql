PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_lct_openrouter_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`max_output_tokens` integer NOT NULL,
	`completed_at` integer,
	`recovery_released_at` integer,
	CONSTRAINT "lct_openrouter_attempts_tokens_check" CHECK("max_output_tokens" >= 1 and "max_output_tokens" <= 16384)
);
--> statement-breakpoint
INSERT INTO `__new_lct_openrouter_attempts`("id", "created_at", "max_output_tokens", "completed_at", "recovery_released_at") SELECT "id", "created_at", "max_output_tokens", "completed_at", "recovery_released_at" FROM `lct_openrouter_attempts`;--> statement-breakpoint
DROP TABLE `lct_openrouter_attempts`;--> statement-breakpoint
ALTER TABLE `__new_lct_openrouter_attempts` RENAME TO `lct_openrouter_attempts`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `lct_openrouter_attempts_created_idx` ON `lct_openrouter_attempts` (`created_at`);