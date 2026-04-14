"""Usage quota service for STT and LLM API limiting."""

import os
import time
from datetime import datetime, date
from typing import Optional, Dict, Any
from dataclasses import dataclass
from sqlalchemy import select, insert, update
from sqlalchemy.ext.asyncio import AsyncSession

from lct_python_backend.models.system import UsageQuota

# Configuration from environment
FREE_STT_DAILY_MINUTES = float(os.getenv("FREE_STT_DAILY_MINUTES", "10"))
FREE_LLM_DAILY_TOKENS = int(os.getenv("FREE_LLM_DAILY_TOKENS", "50000"))
QUOTA_WARNING_PERCENT = float(os.getenv("QUOTA_WARNING_PERCENT", "80"))
BYOK_REQUIRED_AFTER_FREE = os.getenv("BYOK_REQUIRED_AFTER_FREE", "true").lower() in {"1", "true", "yes"}

QUOTA_WARNING_MINUTES = 2.0  # Warn when 2 minutes left


@dataclass
class QuotaResult:
    allowed: bool
    remaining_minutes: float
    limit_minutes: float
    used_minutes: float
    percent_used: float
    warning: bool
    reset_at: str  # ISO date string
    message: str = ""


class QuotaService:
    def __init__(self, session: AsyncSession):
        self.session = session

    async def check_quota(
        self,
        owner_id: str,
        quota_type: str = "stt_live",
        is_byok: bool = False,
    ) -> QuotaResult:
        """Check if user has quota available for the given type."""
        today = date.today()
        
        # BYOK users have unlimited quota
        if is_byok:
            return QuotaResult(
                allowed=True,
                remaining_minutes=float('inf'),
                limit_minutes=float('inf'),
                used_minutes=0.0,
                percent_used=0.0,
                warning=False,
                reset_at=today.isoformat(),
                message="Using BYOK key - unlimited quota",
            )

        # Get limit for free tier
        limit_minutes = FREE_STT_DAILY_MINUTES if quota_type == "stt_live" else FREE_LLM_DAILY_TOKENS
        
        # Query today's usage
        stmt = select(UsageQuota).where(
            UsageQuota.owner_id == owner_id,
            UsageQuota.quota_type == quota_type,
            UsageQuota.date == today,
        )
        result = await self.session.execute(stmt)
        quota = result.scalar_one_or_none()

        used_minutes = quota.minutes_used if quota else 0.0
        remaining = max(0, limit_minutes - used_minutes)
        percent_used = (used_minutes / limit_minutes * 100) if limit_minutes > 0 else 100
        
        # Warning when 2 minutes left or 80% used
        warning = remaining <= QUOTA_WARNING_MINUTES or percent_used >= QUOTA_WARNING_PERCENT
        
        # Determine if allowed
        allowed = remaining > 0
        
        message = ""
        if not allowed:
            message = f"Daily quota exceeded ({limit_minutes} min limit). Add your own API key in settings to continue."
        elif warning and remaining <= QUOTA_WARNING_MINUTES:
            message = f"Only {remaining:.1f} min left today. Add your API key in settings to avoid interruption."
        elif warning:
            message = f"Approaching daily limit ({percent_used:.0f}% used)."

        return QuotaResult(
            allowed=allowed,
            remaining_minutes=remaining,
            limit_minutes=limit_minutes,
            used_minutes=used_minutes,
            percent_used=percent_used,
            warning=warning,
            reset_at=today.isoformat(),
            message=message,
        )

    async def record_usage(
        self,
        owner_id: str,
        quota_type: str,
        minutes: float,
        requests: int = 1,
    ) -> None:
        """Record usage for today."""
        today = date.today()
        today_datetime = datetime.combine(today, datetime.min.time())

        # Try to update existing record
        stmt = (
            update(UsageQuota)
            .where(
                UsageQuota.owner_id == owner_id,
                UsageQuota.quota_type == quota_type,
                UsageQuota.date == today_datetime,
            )
            .values(
                minutes_used=UsageQuota.minutes_used + minutes,
                requests_count=UsageQuota.requests_count + requests,
                updated_at=datetime.utcnow(),
            )
        )
        result = await self.session.execute(stmt)

        # If no rows updated, insert new record
        if result.rowcount == 0:
            stmt = insert(UsageQuota).values(
                owner_id=owner_id,
                quota_type=quota_type,
                date=today_datetime,
                minutes_used=minutes,
                requests_count=requests,
            )
            await self.session.execute(stmt)

        await self.session.commit()

    async def get_usage_summary(
        self,
        owner_id: str,
        quota_type: str = "stt_live",
    ) -> Dict[str, Any]:
        """Get usage summary for frontend display."""
        result = await self.check_quota(owner_id, quota_type)
        
        return {
            "allowed": result.allowed,
            "remaining_minutes": result.remaining_minutes,
            "limit_minutes": result.limit_minutes,
            "used_minutes": result.used_minutes,
            "percent_used": result.percent_used,
            "warning": result.warning,
            "reset_at": result.reset_at,
            "message": result.message,
            "warning_threshold_minutes": QUOTA_WARNING_MINUTES,
            "byok_required": BYOK_REQUIRED_AFTER_FREE and not result.allowed,
        }