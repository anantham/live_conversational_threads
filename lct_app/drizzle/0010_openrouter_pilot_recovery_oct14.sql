-- OFF preparation only: a new one-time recovery requires separate H1 approval.
-- The owner must verify the exact private held identities and disabled providers
-- before publication. No completion is claimed; all lifetime attempts remain.
UPDATE lct_openrouter_attempts
SET recovery_released_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE completed_at IS NULL
  AND recovery_released_at IS NULL
  AND max_output_tokens = 8192
  AND created_at <= CAST(strftime('%s', 'now') AS INTEGER) * 1000 - 900000
  AND (SELECT COUNT(*) FROM lct_openrouter_attempts) = 4
  AND (SELECT COUNT(*) FROM lct_openrouter_attempts
       WHERE completed_at IS NULL AND max_output_tokens = 8192) = 4
  AND (SELECT COUNT(*) FROM lct_openrouter_attempts
       WHERE completed_at IS NULL AND recovery_released_at IS NOT NULL
         AND recovery_released_at > 0
         AND recovery_released_at <= CAST(strftime('%s', 'now') AS INTEGER) * 1000) = 2
  AND (SELECT COUNT(*) FROM lct_openrouter_attempts
       WHERE completed_at IS NULL AND recovery_released_at IS NULL
         AND max_output_tokens = 8192
         AND created_at <= CAST(strftime('%s', 'now') AS INTEGER) * 1000 - 900000) = 2;
