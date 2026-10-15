-- Owner explicitly approved these two diagnostic-holder releases on 15 October 2026.
-- Release only the two diagnostic-test holders from 18:33 and 18:34 IST after both backends are OFF.
-- The owner must verify the exact private held identities and disabled providers
-- before publication. No completion is claimed; all lifetime attempts remain.
UPDATE lct_openrouter_attempts
SET recovery_released_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE completed_at IS NULL
  AND recovery_released_at IS NULL
  AND max_output_tokens = 8192
  AND created_at <= CAST(strftime('%s', 'now') AS INTEGER) * 1000 - 900000
  AND (SELECT COUNT(*) FROM lct_openrouter_attempts) = 8
  AND (SELECT COUNT(*) FROM lct_openrouter_attempts
       WHERE completed_at IS NULL AND max_output_tokens = 8192) = 8
  AND (SELECT COUNT(*) FROM lct_openrouter_attempts
       WHERE completed_at IS NULL AND recovery_released_at IS NOT NULL
         AND recovery_released_at > 0
         AND recovery_released_at <= CAST(strftime('%s', 'now') AS INTEGER) * 1000) = 6
  AND (SELECT COUNT(*) FROM lct_openrouter_attempts
       WHERE completed_at IS NULL AND recovery_released_at IS NULL
         AND max_output_tokens = 8192
         AND created_at BETWEEN 1792069401739 AND 1792069443366
         AND created_at <= CAST(strftime('%s', 'now') AS INTEGER) * 1000 - 900000) = 2;
