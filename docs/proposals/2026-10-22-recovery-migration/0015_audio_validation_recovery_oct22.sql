-- Proposed durable activation; do not install without the explicit migration-scope ruling.
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
