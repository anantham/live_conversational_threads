CREATE TABLE `lct_public_threads` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`payload` text,
	`byte_size` integer NOT NULL,
	`node_count` integer NOT NULL,
	`delete_hash` text NOT NULL,
	`payload_hash` text,
	`state` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT "lct_public_threads_state_check" CHECK("lct_public_threads"."state" in ('ready', 'removed')),
	CONSTRAINT "lct_public_threads_payload_check" CHECK(("lct_public_threads"."state" = 'ready' and "lct_public_threads"."payload" is not null and "lct_public_threads"."payload_hash" is not null and "lct_public_threads"."byte_size" > 0 and "lct_public_threads"."byte_size" <= 524288) or ("lct_public_threads"."state" = 'removed' and "lct_public_threads"."payload" is null and "lct_public_threads"."payload_hash" is null and "lct_public_threads"."byte_size" = 0 and "lct_public_threads"."node_count" = 0 and "lct_public_threads"."title" = ''))
);
--> statement-breakpoint
CREATE INDEX `lct_public_threads_state_created_id_idx` ON `lct_public_threads` (`state`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `lct_public_threads_created_idx` ON `lct_public_threads` (`created_at`);