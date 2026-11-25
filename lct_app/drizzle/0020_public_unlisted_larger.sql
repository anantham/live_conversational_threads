PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_lct_public_threads` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`payload` text,
	`byte_size` integer NOT NULL,
	`node_count` integer NOT NULL,
	`delete_hash` text NOT NULL,
	`payload_hash` text,
	`state` text NOT NULL,
	`created_at` integer NOT NULL,
	`listed` integer DEFAULT 1 NOT NULL,
	CONSTRAINT "lct_public_threads_state_check" CHECK("state" in ('ready', 'removed')),
	CONSTRAINT "lct_public_threads_listed_check" CHECK("listed" in (0, 1)),
	CONSTRAINT "lct_public_threads_payload_check" CHECK(("state" = 'ready' and "payload" is not null and "payload_hash" is not null and "byte_size" > 0 and "byte_size" <= 1572864) or ("state" = 'removed' and "payload" is null and "payload_hash" is null and "byte_size" = 0 and "node_count" = 0 and "title" = ''))
);
--> statement-breakpoint
INSERT INTO `__new_lct_public_threads`("id", "title", "payload", "byte_size", "node_count", "delete_hash", "payload_hash", "state", "created_at") SELECT "id", "title", "payload", "byte_size", "node_count", "delete_hash", "payload_hash", "state", "created_at" FROM `lct_public_threads`;--> statement-breakpoint
DROP TABLE `lct_public_threads`;--> statement-breakpoint
ALTER TABLE `__new_lct_public_threads` RENAME TO `lct_public_threads`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `lct_public_threads_state_created_id_idx` ON `lct_public_threads` (`state`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `lct_public_threads_listed_created_id_idx` ON `lct_public_threads` (`state`,`listed`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `lct_public_threads_created_idx` ON `lct_public_threads` (`created_at`);