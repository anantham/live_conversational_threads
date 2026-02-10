"""
Cost aggregation and reporting facade.

This module keeps the public API stable while delegating:
- DB reads to `cost_queries.py`
- rollup math to `cost_rollups.py`
- report rendering/background jobs to `cost_reporting.py`
"""

from datetime import date, datetime, timedelta
from typing import List, Optional, Tuple

from .cost_queries import (
    fetch_logs_for_conversation,
    fetch_logs_for_period,
    fetch_top_conversations_by_cost,
)
from .cost_reporting import CostReporter, run_daily_aggregation_job
from .cost_rollups import (
    ConversationCost,
    CostAggregation,
    empty_cost_aggregation,
    rollup_conversation_cost,
    rollup_cost_logs,
)


class CostAggregator:
    """
    Aggregates and analyzes API cost data.

    Usage:
        aggregator = CostAggregator(db_connection)

        # Get daily aggregation
        daily = await aggregator.aggregate_daily(date.today())

        # Get cost by conversation
        conv_cost = await aggregator.get_conversation_cost("conv-123")
    """

    def __init__(self, db=None):
        """
        Initialize aggregator with database connection.

        Args:
            db: Database connection/session
        """
        self.db = db

    async def aggregate_daily(
        self,
        target_date: date,
    ) -> CostAggregation:
        """
        Aggregate costs for a specific day.

        Args:
            target_date: Date to aggregate

        Returns:
            CostAggregation object with daily totals
        """
        period_start = datetime.combine(target_date, datetime.min.time())
        period_end = datetime.combine(target_date, datetime.max.time())
        return await self._aggregate_period(period_start, period_end)

    async def aggregate_weekly(
        self,
        week_start: date,
    ) -> CostAggregation:
        """
        Aggregate costs for a week.

        Args:
            week_start: Start date of week (Monday)

        Returns:
            CostAggregation object with weekly totals
        """
        period_start = datetime.combine(week_start, datetime.min.time())
        period_end = period_start + timedelta(days=7)
        return await self._aggregate_period(period_start, period_end)

    async def aggregate_monthly(
        self,
        year: int,
        month: int,
    ) -> CostAggregation:
        """
        Aggregate costs for a month.

        Args:
            year: Year (e.g., 2025)
            month: Month (1-12)

        Returns:
            CostAggregation object with monthly totals
        """
        period_start = datetime(year, month, 1)
        if month == 12:
            period_end = datetime(year + 1, 1, 1)
        else:
            period_end = datetime(year, month + 1, 1)

        return await self._aggregate_period(period_start, period_end)

    async def _aggregate_period(
        self,
        period_start: datetime,
        period_end: datetime,
    ) -> CostAggregation:
        """
        Aggregate costs for an arbitrary time period.

        Args:
            period_start: Start of period
            period_end: End of period

        Returns:
            CostAggregation object
        """
        if self.db is None:
            return empty_cost_aggregation(period_start, period_end)

        logs = await fetch_logs_for_period(
            db=self.db,
            period_start=period_start,
            period_end=period_end,
        )
        if not logs:
            return empty_cost_aggregation(period_start, period_end)

        return rollup_cost_logs(
            period_start=period_start,
            period_end=period_end,
            logs=logs,
        )

    async def get_conversation_cost(
        self,
        conversation_id: str,
    ) -> ConversationCost:
        """
        Get cost breakdown for a specific conversation.

        Args:
            conversation_id: Conversation UUID

        Returns:
            ConversationCost object
        """
        if self.db is None:
            raise ValueError("Database connection required for conversation cost lookup")

        logs = await fetch_logs_for_conversation(
            db=self.db,
            conversation_id=conversation_id,
        )
        return rollup_conversation_cost(
            conversation_id=conversation_id,
            logs=logs,
        )

    async def get_top_conversations_by_cost(
        self,
        limit: int = 10,
        period_start: Optional[datetime] = None,
        period_end: Optional[datetime] = None,
    ) -> List[Tuple[str, float]]:
        """
        Get most expensive conversations.

        Args:
            limit: Number of conversations to return
            period_start: Optional start date filter
            period_end: Optional end date filter

        Returns:
            List of (conversation_id, total_cost) tuples
        """
        if self.db is None:
            return []

        return await fetch_top_conversations_by_cost(
            db=self.db,
            limit=limit,
            period_start=period_start,
            period_end=period_end,
        )

    async def get_cost_trend(
        self,
        days: int = 30,
    ) -> List[Tuple[date, float]]:
        """
        Get daily cost trend for the past N days.

        Args:
            days: Number of days to look back

        Returns:
            List of (date, cost) tuples
        """
        trend = []

        for i in range(days):
            target_date = date.today() - timedelta(days=i)
            daily_agg = await self.aggregate_daily(target_date)
            trend.append((target_date, daily_agg.total_cost))

        trend.reverse()
        return trend
