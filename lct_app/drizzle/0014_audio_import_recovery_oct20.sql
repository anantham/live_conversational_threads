-- Owner approved exactly this one synthetic import-holder release on 20 October 2026.
-- Pause both generation backends, verify this exact failed synthetic import is
-- older than fifteen minutes and no longer running, then release only its holder.
-- Preserve every row, lifetime count, token cap and the older unresolved holder.
UPDATE lct_openrouter_attempts
SET recovery_released_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE id = '4351c065-e07f-40d0-ae24-b27440c369ca'
  AND created_at = 1792479785966
  AND max_output_tokens = 8192
  AND completed_at IS NULL AND recovery_released_at IS NULL
  AND created_at <= CAST(strftime('%s', 'now') AS INTEGER) * 1000 - 900000
  AND (SELECT COUNT(*) FROM lct_openrouter_attempts) = 12
  AND (SELECT COUNT(*) FROM lct_openrouter_attempts
       WHERE completed_at IS NULL AND recovery_released_at IS NULL) = 2
  AND EXISTS (SELECT 1 FROM lct_openrouter_attempts
       WHERE id = '23de48fb-9c8e-47dd-a41d-1a9552e7ec9b'
         AND created_at = 1792171889589 AND max_output_tokens = 8192
         AND completed_at IS NULL AND recovery_released_at IS NULL);
