-- One-time recovery approved on 2026-10-13. Publication requires owner
-- verification of the exact two private identities and disabled providers.
-- Preserve all four lifetime attempts, including the two already known leases.
-- An unknown lease never expires automatically outside this bounded migration.
UPDATE lct_soniox_sessions
SET lease_until = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE lease_until IS NULL
  AND max_session_seconds = 300
  AND created_at <= CAST(strftime('%s', 'now') AS INTEGER) * 1000 - 900000
  AND (SELECT COUNT(*) FROM lct_soniox_sessions) = 4
  AND (SELECT COUNT(*) FROM lct_soniox_sessions WHERE lease_until IS NULL) = 2
  AND (SELECT COUNT(*) FROM lct_soniox_sessions
       WHERE lease_until IS NULL AND max_session_seconds = 300
         AND created_at <= CAST(strftime('%s', 'now') AS INTEGER) * 1000 - 900000) = 2;
