-- PROPOSED ONLY. Requires explicit recovery and durable-method approval.
UPDATE lct_openrouter_attempts
SET recovery_released_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE id = 'd1445dc2-618c-4279-a207-33c401b369e0'
  AND created_at = 1792661065333
  AND max_output_tokens = 8192
  AND completed_at IS NULL AND recovery_released_at IS NULL
  AND created_at <= CAST(strftime('%s', 'now') AS INTEGER) * 1000 - 900000
  AND (SELECT COUNT(*) FROM lct_openrouter_attempts) = 14
  AND (SELECT COUNT(*) FROM lct_openrouter_attempts
       WHERE completed_at IS NULL AND recovery_released_at IS NULL) = 2
  AND EXISTS (SELECT 1 FROM lct_openrouter_attempts
       WHERE id = '23de48fb-9c8e-47dd-a41d-1a9552e7ec9b'
         AND created_at = 1792171889589 AND max_output_tokens = 8192
         AND completed_at IS NULL AND recovery_released_at IS NULL);
