# ADR-029: Usage Quota and Rate Limiting for STT Services

## Status: Proposed

## Date: 2026-04-14

## Context

Currently, the backend has no per-user quota enforcement for STT services:
- No daily usage limits
- No BYOK quota enforcement after free tier
- No usage warnings or hard limits per session/token

This creates risk of:
1. Abuse by users running unlimited sessions
2. Unexpected cost overruns on shared API keys
3. No way to enforce "free tier then BYOK" model

## Decision

Implement a tiered quota system:
- **Anonymous/free users**: Limited minutes per day (e.g., 10 min/day)
- **BYOK users**: Use their own API key, no limits
- **Shared key users**: Configurable daily limit before forcing BYOK

## Implementation Plan

### Phase 1: Tracking (Database)

Create new table to track usage:

```sql
CREATE TABLE usage_quotas (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id VARCHAR NOT NULL,  -- user identifier (from session metadata)
    quota_type VARCHAR NOT NULL,  -- 'stt_live', 'stt_import', 'llm'
    date DATE NOT NULL,
    minutes_used DECIMAL(10,2) NOT NULL DEFAULT 0,
    requests_count INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(owner_id, quota_type, date)
);

CREATE INDEX idx_usage_quotas_owner_date ON usage_quotas(owner_id, date);
```

### Phase 2: Quota Service (`services/quota_service.py`)

```python
class QuotaService:
    def check_quota(owner_id: str, quota_type: str) -> QuotaResult:
        # Returns: {allowed: bool, remaining_minutes: float, reset_at: datetime}
        
    def record_usage(owner_id: str, quota_type: str, minutes: float, requests: int):
        # Increment usage for today
        
    def get_quota_limit(quota_type: str, user_tier: str) -> float:
        # Returns limit based on tier: 'free', 'byok', 'admin'
```

### Phase 3: Enforcement Points

**A. STT WebSocket session init** (`stt_ws_session.py`):
- Check quota before starting live session
- Reject with `quota_exceeded` if limit reached
- Include quota info in `session_ack` response

**B. STT HTTP transcriber** (`stt_http_transcriber.py`):
- Track minutes per transcription request
- Periodically record usage (every N seconds or on session end)

**C. LLM API middleware** (`middleware.py` or new):
- Track LLM token usage for BYOK enforcement
- Similar pattern to STT tracking

### Phase 4: Configuration

Environment variables:
```bash
# Free tier limits (per day)
FREE_STT_DAILY_MINUTES=10
FREE_LLM_DAILY_TOKENS=50000

# Warning thresholds (send notification before hard limit)
QUOTA_WARNING_PERCENT=80

# BYOK enforcement
BYOK_REQUIRED_AFTER_FREE=true
```

### Phase 5: Frontend Feedback

Add to STT settings UI:
- Current usage display: "Used 3.2/10 min today"
- Warning banner when approaching limit
- Prompt to add BYOK key when limit reached

## Trade-offs

| Aspect | Option A: Simple | Option B: Detailed (chosen) |
|--------|-----------------|---------------------------|
| Tracking | Per-session only | Per-day rolling window |
| Granularity | Minutes only | Minutes + requests + tokens |
| Storage | No new table | New `usage_quotas` table |
| Complexity | ~1 day | ~3 days |

## File Changes

1. **New file**: `services/quota_service.py` - Quota logic
2. **New migration**: Add `usage_quotas` table
3. **Modify**: `stt_ws_session.py` - Check quota on session start
4. **Modify**: `stt_http_transcriber.py` - Record usage on transcription
5. **Modify**: `stt_api.py` - Add quota status endpoint for frontend
6. **Modify**: Frontend `SttSettingsCard.jsx` - Show usage and warnings

## Future Extensions

- Per-conversation limits
- Rate limiting by IP
- Admin override for trusted users
- Usage dashboards (operator view)