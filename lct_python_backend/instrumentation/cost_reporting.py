"""
Formatting and background-job helpers for cost reporting.
"""

from datetime import date, timedelta
import logging
from typing import Any, Optional, Type

logger = logging.getLogger(__name__)


class CostReporter:
    """Generate cost reports and summaries."""

    def __init__(self, aggregator: Any):
        self.aggregator = aggregator

    async def generate_daily_report(self, target_date: date) -> str:
        """
        Generate a human-readable daily cost report.
        """
        agg = await self.aggregator.aggregate_daily(target_date)

        report = f"""
# Daily Cost Report - {target_date.strftime('%Y-%m-%d')}

## Summary
- Total Cost: ${agg.total_cost:.2f}
- Total API Calls: {agg.total_calls:,}
- Total Tokens: {agg.total_tokens:,}
- Avg Cost/Call: ${agg.avg_cost_per_call:.4f}
- Avg Tokens/Call: {agg.avg_tokens_per_call:.0f}

## Cost by Model
"""
        for model, cost in sorted(agg.cost_by_model.items(), key=lambda x: x[1], reverse=True):
            calls = agg.calls_by_model.get(model, 0)
            tokens = agg.tokens_by_model.get(model, 0)
            report += f"- {model}: ${cost:.2f} ({calls} calls, {tokens:,} tokens)\n"

        report += "\n## Cost by Endpoint\n"
        for endpoint, cost in sorted(agg.cost_by_endpoint.items(), key=lambda x: x[1], reverse=True):
            calls = agg.calls_by_endpoint.get(endpoint, 0)
            report += f"- {endpoint}: ${cost:.2f} ({calls} calls)\n"

        return report

    async def generate_monthly_summary(self, year: int, month: int) -> str:
        """Generate monthly cost summary."""
        agg = await self.aggregator.aggregate_monthly(year, month)

        report = f"""
# Monthly Cost Summary - {year}-{month:02d}

## Overview
- Total Cost: ${agg.total_cost:.2f}
- Total API Calls: {agg.total_calls:,}
- Total Tokens: {agg.total_tokens:,}

## Top Models by Cost
"""
        for model, cost in sorted(agg.cost_by_model.items(), key=lambda x: x[1], reverse=True)[:5]:
            report += f"- {model}: ${cost:.2f}\n"

        report += "\n## Top Endpoints by Cost\n"
        for endpoint, cost in sorted(agg.cost_by_endpoint.items(), key=lambda x: x[1], reverse=True)[:5]:
            report += f"- {endpoint}: ${cost:.2f}\n"

        return report


async def run_daily_aggregation_job(
    db: Any,
    alert_manager: Any,
    aggregator_cls: Optional[Type[Any]] = None,
):
    """
    Background job that runs daily aggregation and checks alerts.
    """
    if aggregator_cls is None:
        from .aggregation import CostAggregator

        aggregator_cls = CostAggregator

    aggregator = aggregator_cls(db)

    yesterday = date.today() - timedelta(days=1)
    daily_agg = await aggregator.aggregate_daily(yesterday)

    today_agg = await aggregator.aggregate_daily(date.today())
    await alert_manager.check_alerts(current_daily_cost=today_agg.total_cost)

    logger.info("Daily aggregation complete for %s", yesterday)
    logger.info("Total cost: $%.2f", daily_agg.total_cost)
    logger.info("Total calls: %s", daily_agg.total_calls)

    return daily_agg
