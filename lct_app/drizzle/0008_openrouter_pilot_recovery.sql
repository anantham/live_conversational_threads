ALTER TABLE `lct_openrouter_attempts` ADD `recovery_released_at` integer;
--> statement-breakpoint
-- One-time owner recovery candidate only. Confirm the exact two private attempt
-- identities and disabled providers before publication. No completion is claimed;
-- both attempts and their lifetime count remain. This is not automatic expiry.
UPDATE lct_openrouter_attempts
SET recovery_released_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE completed_at IS NULL
  AND recovery_released_at IS NULL
  AND max_output_tokens = 8192
  AND created_at <= CAST(strftime('%s', 'now') AS INTEGER) * 1000 - 900000
  AND (SELECT COUNT(*) FROM lct_openrouter_attempts) = 2
  AND (SELECT COUNT(*) FROM lct_openrouter_attempts
       WHERE completed_at IS NULL AND recovery_released_at IS NULL
         AND max_output_tokens = 8192
         AND created_at <= CAST(strftime('%s', 'now') AS INTEGER) * 1000 - 900000) = 2;
