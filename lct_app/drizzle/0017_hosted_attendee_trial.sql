CREATE TABLE `lct_hosted_attendee_trials` (
	`id` integer PRIMARY KEY NOT NULL,
	`request_id` text NOT NULL,
	`owner` text NOT NULL,
	`url_hash` text NOT NULL,
	`bot_id` text,
	`state` text NOT NULL,
	`created_at` integer NOT NULL,
	`ends_at` integer NOT NULL,
	`leave_attempted_at` integer,
	CONSTRAINT "lct_hosted_attendee_singleton" CHECK("lct_hosted_attendee_trials"."id" = 1),
	CONSTRAINT "lct_hosted_attendee_state" CHECK("lct_hosted_attendee_trials"."state" in ('starting', 'uncertain', 'active', 'ended')),
	CONSTRAINT "lct_hosted_attendee_duration" CHECK("lct_hosted_attendee_trials"."ends_at" = "lct_hosted_attendee_trials"."created_at" + 180000)
);
