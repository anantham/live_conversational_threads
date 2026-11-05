-- One-time recovery explicitly approved on 2026-10-07; both providers must be
-- disabled and the exact two old failed synthetic attempts verified before
-- publication. Preserve every row and lifetime count. This does not introduce
-- an automatic unknown-lease expiry policy.
UPDATE lct_soniox_sessions
SET lease_until = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE lease_until IS NULL
  AND max_session_seconds = 300
  AND created_at <= CAST(strftime('%s', 'now') AS INTEGER) * 1000 - 900000
  AND (SELECT COUNT(*) FROM lct_soniox_sessions WHERE lease_until IS NULL) = 2
  AND (SELECT COUNT(*) FROM lct_soniox_sessions
       WHERE lease_until IS NULL AND max_session_seconds = 300
       AND created_at <= CAST(strftime('%s', 'now') AS INTEGER) * 1000 - 900000) = 2;
