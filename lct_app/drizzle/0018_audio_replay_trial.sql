CREATE TABLE `lct_audio_replay_attempts` (
	`request_id` text PRIMARY KEY NOT NULL,
	`trial_id` integer NOT NULL,
	`kind` text NOT NULL,
	`sequence` integer NOT NULL,
	`phase` text NOT NULL,
	`state` text NOT NULL,
	`created_at` integer NOT NULL,
	`completed_at` integer,
	`lease_until` integer,
	`input_bytes` integer NOT NULL,
	`source_end_ms` integer NOT NULL,
	CONSTRAINT "audio_replay_kind" CHECK("lct_audio_replay_attempts"."trial_id" = 1 and "lct_audio_replay_attempts"."kind" in ('stt','map')),
	CONSTRAINT "audio_replay_sequence_bound" CHECK(("lct_audio_replay_attempts"."kind" = 'stt' and "lct_audio_replay_attempts"."sequence" = 0 and "lct_audio_replay_attempts"."phase" = 'start') or ("lct_audio_replay_attempts"."kind" = 'map' and "lct_audio_replay_attempts"."sequence" >= 1 and "lct_audio_replay_attempts"."sequence" <= 28 and "lct_audio_replay_attempts"."phase" in ('periodic','final'))),
	CONSTRAINT "audio_replay_attempt_state" CHECK("lct_audio_replay_attempts"."state" in ('reserved','dispatching','completed','uncertain')),
	CONSTRAINT "audio_replay_input" CHECK("lct_audio_replay_attempts"."input_bytes" >= 0 and "lct_audio_replay_attempts"."input_bytes" <= 131072 and "lct_audio_replay_attempts"."source_end_ms" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `audio_replay_sequence` ON `lct_audio_replay_attempts` (`trial_id`,`kind`,`sequence`);--> statement-breakpoint
CREATE UNIQUE INDEX `audio_replay_stt_once` ON `lct_audio_replay_attempts` (`trial_id`) WHERE "lct_audio_replay_attempts"."kind" = 'stt';--> statement-breakpoint
CREATE UNIQUE INDEX `audio_replay_one_active` ON `lct_audio_replay_attempts` (`trial_id`) WHERE "lct_audio_replay_attempts"."state" in ('reserved','dispatching','uncertain');--> statement-breakpoint
CREATE TABLE `lct_audio_replay_trial` (
	`id` integer PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`recording_id` text NOT NULL,
	`start_request_id` text NOT NULL,
	`state` text NOT NULL,
	`created_at` integer NOT NULL,
	`ends_at` integer NOT NULL,
	`closed_at` integer,
	CONSTRAINT "audio_replay_singleton" CHECK("lct_audio_replay_trial"."id" = 1),
	CONSTRAINT "audio_replay_state" CHECK("lct_audio_replay_trial"."state" in ('active','failed','completed')),
	CONSTRAINT "audio_replay_lifetime" CHECK("lct_audio_replay_trial"."ends_at" > "lct_audio_replay_trial"."created_at" and "lct_audio_replay_trial"."ends_at" <= "lct_audio_replay_trial"."created_at" + 1500000)
);
