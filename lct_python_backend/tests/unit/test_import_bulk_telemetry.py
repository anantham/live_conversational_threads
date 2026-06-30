"""Tests for import bulk telemetry — pure ETA/progress math functions."""

import pytest

from lct_python_backend.services.import_pipeline.import_bulk_telemetry import (
    estimate_transcription_eta_ms,
    estimate_analysis_eta_ms,
    calculate_segmented_progress,
    attach_bottleneck_stage,
)


class TestEstimateTranscriptionEta:
    def test_returns_positive_for_valid_input(self):
        eta_ms, total_ms = estimate_transcription_eta_ms(
            transcription_elapsed_ms=5000, chunk_idx=5, total_chunks=10
        )
        assert eta_ms is not None and eta_ms > 0
        assert total_ms is not None and total_ms > 0

    def test_zero_chunks_returns_none(self):
        eta_ms, total_ms = estimate_transcription_eta_ms(
            transcription_elapsed_ms=1000, chunk_idx=0, total_chunks=5
        )
        assert eta_ms is None
        assert total_ms is None

    def test_none_elapsed_returns_none(self):
        eta_ms, total_ms = estimate_transcription_eta_ms(
            transcription_elapsed_ms=None, chunk_idx=3, total_chunks=10
        )
        assert eta_ms is None
        assert total_ms is None

    def test_complete_returns_zero_eta(self):
        eta_ms, total_ms = estimate_transcription_eta_ms(
            transcription_elapsed_ms=10000, chunk_idx=10, total_chunks=10
        )
        assert eta_ms == 0


class TestEstimateAnalysisEta:
    def test_returns_positive_for_valid_input(self):
        eta_ms, total_ms = estimate_analysis_eta_ms(
            analysis_elapsed_ms=3000, chunk_idx=3, total_chunks=10
        )
        assert eta_ms is not None and eta_ms > 0

    def test_zero_chunks_returns_none(self):
        eta_ms, total_ms = estimate_analysis_eta_ms(
            analysis_elapsed_ms=1000, chunk_idx=0, total_chunks=5
        )
        assert eta_ms is None


class TestCalculateSegmentedProgress:
    def test_mid_progress_transcribing(self):
        progress = calculate_segmented_progress(
            segment_index=5, segment_total=10,
            stage="transcribing", stage_progress=0.5,
        )
        assert 0.0 < progress < 1.0

    def test_mid_progress_analyzing(self):
        progress = calculate_segmented_progress(
            segment_index=5, segment_total=10,
            stage="analyzing", stage_progress=0.5,
        )
        assert 0.0 < progress < 1.0

    def test_last_segment_complete(self):
        progress = calculate_segmented_progress(
            segment_index=10, segment_total=10,
            stage="analyzing", stage_progress=1.0,
        )
        assert progress == pytest.approx(1.0, abs=0.01)

    def test_zero_segments_returns_zero(self):
        progress = calculate_segmented_progress(
            segment_index=0, segment_total=0,
            stage="transcribing", stage_progress=0.0,
        )
        assert progress == 0.0

    def test_analyzing_further_than_transcribing(self):
        """At same segment and stage_progress, analyzing should be further along."""
        t = calculate_segmented_progress(5, 10, "transcribing", 0.5)
        a = calculate_segmented_progress(5, 10, "analyzing", 0.5)
        assert a > t


class TestAttachBottleneckStage:
    def test_adds_bottleneck_key(self):
        telemetry = {"transcription_ms": 5000, "graph_generation_ms": 3000}
        attach_bottleneck_stage(telemetry)
        assert "bottleneck_stage" in telemetry
        assert "bottleneck_ms" in telemetry

    def test_identifies_slowest_stage(self):
        telemetry = {"transcription_ms": 1000, "graph_generation_ms": 8000}
        attach_bottleneck_stage(telemetry)
        assert telemetry["bottleneck_stage"] == "graph_generation_ms"
        assert telemetry["bottleneck_ms"] == 8000

    def test_no_numeric_values_noop(self):
        telemetry = {"some_key": "not_a_number"}
        attach_bottleneck_stage(telemetry)
        assert "bottleneck_stage" not in telemetry

    def test_empty_telemetry_noop(self):
        telemetry = {}
        attach_bottleneck_stage(telemetry)
        assert "bottleneck_stage" not in telemetry
