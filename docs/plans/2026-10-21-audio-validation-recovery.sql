-- PREPARED ONLY / NOT A MIGRATION. Fresh owner ruling required by PILOT-RECOVERY-A1.
-- This releases only the terminal failed synthetic import from 20 October.
-- Do not copy into drizzle or publish this SQL before the ruling and exact preflight.
-- Pause both generation backends, verify this exact failed synthetic import is
-- older than fifteen minutes and no longer running, then release only its holder.
-- Preserve every row, lifetime count, token cap and the older unresolved holder.
UPDATE lct_openrouter_attempts
SET recovery_released_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE id = '819a33a2-cfac-482d-98cf-cf7beaec617b'
  AND created_at = 1792481117816
  AND max_output_tokens = 8192
  AND completed_at IS NULL AND recovery_released_at IS NULL
  AND created_at <= CAST(strftime('%s', 'now') AS INTEGER) * 1000 - 900000
  AND (SELECT COUNT(*) FROM lct_openrouter_attempts) = 13
  AND (SELECT COUNT(*) FROM lct_openrouter_attempts
       WHERE completed_at IS NULL AND recovery_released_at IS NULL) = 2
  AND EXISTS (SELECT 1 FROM lct_openrouter_attempts
       WHERE id = '23de48fb-9c8e-47dd-a41d-1a9552e7ec9b'
         AND created_at = 1792171889589 AND max_output_tokens = 8192
         AND completed_at IS NULL AND recovery_released_at IS NULL);
