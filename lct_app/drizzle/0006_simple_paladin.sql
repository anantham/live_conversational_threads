CREATE TABLE `lct_openrouter_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`max_output_tokens` integer NOT NULL,
	`completed_at` integer,
	CONSTRAINT "lct_openrouter_attempts_tokens_check" CHECK("lct_openrouter_attempts"."max_output_tokens" >= 1 and "lct_openrouter_attempts"."max_output_tokens" <= 8192)
);
--> statement-breakpoint
CREATE INDEX `lct_openrouter_attempts_created_idx` ON `lct_openrouter_attempts` (`created_at`);