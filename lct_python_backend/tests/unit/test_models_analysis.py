"""Unit tests for lct_python_backend.models.analysis (no DB required).

Tests verify model structure: CheckConstraints, nullable settings,
and index definitions — all inspected at the Python class level without
a database connection.
"""

import uuid

import sqlalchemy as sa

from lct_python_backend.models.analysis import (
    ArgumentTree,
    BiasAnalysis,
    Claim,
    FrameAnalysis,
    IntentSignal,
    IntentSignalSighting,
    IsOughtConflation,
    SimulacraAnalysis,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _check_constraints(model) -> dict:
    return {
        c.name: str(c.sqltext)
        for c in model.__table__.constraints
        if isinstance(c, sa.CheckConstraint) and c.name
    }


def _index_names(model) -> set:
    return {idx.name for idx in model.__table__.indexes}


def _column(model, name) -> sa.Column:
    return model.__table__.c[name]


# ---------------------------------------------------------------------------
# Claim
# ---------------------------------------------------------------------------

class TestClaimModel:
    def test_tablename(self):
        assert Claim.__tablename__ == "claims"

    def test_required_columns_not_nullable(self):
        for col_name in ("conversation_id", "node_id", "claim_text", "claim_type",
                         "utterance_ids", "strength", "confidence"):
            col = _column(Claim, col_name)
            assert not col.nullable, f"{col_name} should be NOT NULL"

    def test_claim_type_check(self):
        checks = _check_constraints(Claim)
        assert "check_claim_type" in checks
        expr = checks["check_claim_type"]
        for allowed in ("factual", "normative", "worldview"):
            assert allowed in expr

    def test_strength_bounds_check(self):
        checks = _check_constraints(Claim)
        assert "check_claim_strength" in checks
        expr = checks["check_claim_strength"]
        assert "strength" in expr

    def test_confidence_bounds_check(self):
        checks = _check_constraints(Claim)
        assert "check_claim_confidence" in checks

    def test_verification_status_check(self):
        checks = _check_constraints(Claim)
        assert "check_verification_status" in checks
        expr = checks["check_verification_status"]
        for allowed in ("verified", "false", "misleading", "unverifiable", "pending"):
            assert allowed in expr
        assert "IS NULL" in expr

    def test_normative_type_check(self):
        checks = _check_constraints(Claim)
        assert "check_normative_type" in checks
        expr = checks["check_normative_type"]
        for allowed in ("prescription", "evaluation", "obligation", "preference"):
            assert allowed in expr
        assert "IS NULL" in expr

    def test_optional_columns_nullable(self):
        for col_name in ("embedding", "speaker_name", "is_verifiable", "verification_status",
                         "fact_check_result", "fact_checked_at", "normative_type",
                         "implicit_values", "worldview_category", "hidden_premises",
                         "ideological_markers", "supports_claim_ids", "contradicts_claim_ids",
                         "depends_on_claim_ids"):
            col = _column(Claim, col_name)
            assert col.nullable, f"{col_name} should be nullable"

    def test_indexes_defined(self):
        names = _index_names(Claim)
        assert "idx_claims_conversation" in names
        assert "idx_claims_node" in names
        assert "idx_claims_type" in names
        assert "idx_claims_speaker" in names


# ---------------------------------------------------------------------------
# ArgumentTree
# ---------------------------------------------------------------------------

class TestArgumentTreeModel:
    def test_tablename(self):
        assert ArgumentTree.__tablename__ == "argument_trees"

    def test_required_columns_not_nullable(self):
        for col_name in ("conversation_id", "node_id", "root_claim_id", "tree_structure"):
            col = _column(ArgumentTree, col_name)
            assert not col.nullable, f"{col_name} should be NOT NULL"

    def test_argument_type_check(self):
        checks = _check_constraints(ArgumentTree)
        assert "check_argument_type" in checks
        expr = checks["check_argument_type"]
        for allowed in ("deductive", "inductive", "abductive"):
            assert allowed in expr
        assert "IS NULL" in expr

    def test_confidence_check_allows_null(self):
        checks = _check_constraints(ArgumentTree)
        assert "check_argument_confidence" in checks
        expr = checks["check_argument_confidence"]
        assert "IS NULL" in expr

    def test_optional_columns_nullable(self):
        for col_name in ("title", "summary", "argument_type", "is_valid", "is_sound",
                         "confidence", "identified_fallacies", "circular_dependencies",
                         "premise_claim_ids", "conclusion_claim_ids", "visualization_data"):
            col = _column(ArgumentTree, col_name)
            assert col.nullable, f"{col_name} should be nullable"


# ---------------------------------------------------------------------------
# IsOughtConflation
# ---------------------------------------------------------------------------

class TestIsOughtConflationModel:
    def test_tablename(self):
        assert IsOughtConflation.__tablename__ == "is_ought_conflations"

    def test_required_columns_not_nullable(self):
        for col_name in ("conversation_id", "node_id", "descriptive_claim_id",
                         "normative_claim_id", "conflation_text", "explanation",
                         "utterance_ids", "strength", "confidence"):
            col = _column(IsOughtConflation, col_name)
            assert not col.nullable, f"{col_name} should be NOT NULL"

    def test_fallacy_type_check(self):
        checks = _check_constraints(IsOughtConflation)
        assert "check_fallacy_type" in checks
        expr = checks["check_fallacy_type"]
        for allowed in ("naturalistic_fallacy", "appeal_to_nature",
                        "appeal_to_tradition", "appeal_to_popularity"):
            assert allowed in expr
        assert "IS NULL" in expr

    def test_strength_and_confidence_checks(self):
        checks = _check_constraints(IsOughtConflation)
        assert "check_is_ought_strength" in checks
        assert "check_is_ought_confidence" in checks


# ---------------------------------------------------------------------------
# SimulacraAnalysis
# ---------------------------------------------------------------------------

class TestSimulacraAnalysisModel:
    def test_tablename(self):
        assert SimulacraAnalysis.__tablename__ == "simulacra_analysis"

    def test_required_columns_not_nullable(self):
        for col_name in ("node_id", "conversation_id", "level", "confidence"):
            col = _column(SimulacraAnalysis, col_name)
            assert not col.nullable, f"{col_name} should be NOT NULL"

    def test_level_check_1_to_4(self):
        checks = _check_constraints(SimulacraAnalysis)
        assert "check_simulacra_level" in checks
        expr = checks["check_simulacra_level"]
        # Bounds must reference both 1 and 4.
        assert "1" in expr
        assert "4" in expr

    def test_confidence_bounds_check(self):
        checks = _check_constraints(SimulacraAnalysis)
        assert "check_simulacra_confidence" in checks

    def test_optional_columns_nullable(self):
        for col_name in ("reasoning", "examples"):
            col = _column(SimulacraAnalysis, col_name)
            assert col.nullable, f"{col_name} should be nullable"

    def test_node_id_unique(self):
        # SimulacraAnalysis has unique=True on node_id — one analysis per node.
        col = _column(SimulacraAnalysis, "node_id")
        assert col.unique


# ---------------------------------------------------------------------------
# BiasAnalysis
# ---------------------------------------------------------------------------

class TestBiasAnalysisModel:
    def test_tablename(self):
        assert BiasAnalysis.__tablename__ == "bias_analysis"

    def test_required_columns_not_nullable(self):
        for col_name in ("node_id", "conversation_id", "bias_type", "category",
                         "severity", "confidence"):
            col = _column(BiasAnalysis, col_name)
            assert not col.nullable, f"{col_name} should be NOT NULL"

    def test_severity_and_confidence_checks(self):
        checks = _check_constraints(BiasAnalysis)
        assert "check_bias_severity" in checks
        assert "check_bias_confidence" in checks

    def test_optional_columns_nullable(self):
        for col_name in ("description", "evidence"):
            col = _column(BiasAnalysis, col_name)
            assert col.nullable, f"{col_name} should be nullable"


# ---------------------------------------------------------------------------
# FrameAnalysis
# ---------------------------------------------------------------------------

class TestFrameAnalysisModel:
    def test_tablename(self):
        assert FrameAnalysis.__tablename__ == "frame_analysis"

    def test_required_columns_not_nullable(self):
        for col_name in ("node_id", "conversation_id", "frame_type", "category",
                         "strength", "confidence"):
            col = _column(FrameAnalysis, col_name)
            assert not col.nullable, f"{col_name} should be NOT NULL"

    def test_strength_and_confidence_checks(self):
        checks = _check_constraints(FrameAnalysis)
        assert "check_frame_strength" in checks
        assert "check_frame_confidence" in checks

    def test_optional_columns_nullable(self):
        for col_name in ("description", "evidence", "assumptions", "implications"):
            col = _column(FrameAnalysis, col_name)
            assert col.nullable, f"{col_name} should be nullable"


# ---------------------------------------------------------------------------
# IntentSignal
# ---------------------------------------------------------------------------

class TestIntentSignalModel:
    def test_tablename(self):
        assert IntentSignal.__tablename__ == "intent_signals"

    def test_required_columns_not_nullable(self):
        for col_name in ("conversation_id", "raw_text", "context_window", "speaker_id",
                         "status", "sighting_count"):
            col = _column(IntentSignal, col_name)
            assert not col.nullable, f"{col_name} should be NOT NULL"

    def test_status_check_constraint(self):
        checks = _check_constraints(IntentSignal)
        assert "check_intent_signal_status" in checks
        expr = checks["check_intent_signal_status"]
        for status in ("active", "accumulating", "ready", "formalized", "abandoned"):
            assert status in expr, f"'{status}' missing from status constraint"

    def test_confidence_check_allows_null(self):
        checks = _check_constraints(IntentSignal)
        assert "check_intent_signal_confidence" in checks
        expr = checks["check_intent_signal_confidence"]
        assert "IS NULL" in expr

    def test_salience_check_allows_null(self):
        checks = _check_constraints(IntentSignal)
        assert "check_intent_signal_salience" in checks
        expr = checks["check_intent_signal_salience"]
        assert "IS NULL" in expr

    def test_optional_columns_nullable(self):
        for col_name in ("source_utterance_ids", "source_node_id", "last_sighted_at",
                         "last_sighted_conversation_id", "detection_confidence", "detection_model",
                         "candidate_formal_statement", "formalization_offered_at",
                         "human_review_note", "formalized_claim_id", "formalized_node_id", "tags"):
            col = _column(IntentSignal, col_name)
            assert col.nullable, f"{col_name} should be nullable"

    def test_sighting_count_default(self):
        col = _column(IntentSignal, "sighting_count")
        assert col.default is not None
        assert col.default.arg == 1

    def test_indexes_defined(self):
        names = _index_names(IntentSignal)
        assert "idx_intent_signals_conv_status" in names
        assert "idx_intent_signals_status_salience" in names


# ---------------------------------------------------------------------------
# IntentSignalSighting
# ---------------------------------------------------------------------------

class TestIntentSignalSightingModel:
    def test_tablename(self):
        assert IntentSignalSighting.__tablename__ == "intent_signal_sightings"

    def test_required_columns_not_nullable(self):
        for col_name in ("intent_signal_id", "conversation_id"):
            col = _column(IntentSignalSighting, col_name)
            assert not col.nullable, f"{col_name} should be NOT NULL"

    def test_sighting_confidence_check_allows_null(self):
        checks = _check_constraints(IntentSignalSighting)
        assert "check_sighting_confidence" in checks
        expr = checks["check_sighting_confidence"]
        assert "IS NULL" in expr

    def test_optional_columns_nullable(self):
        for col_name in ("utterance_ids", "context_note", "sighting_confidence"):
            col = _column(IntentSignalSighting, col_name)
            assert col.nullable, f"{col_name} should be nullable"

    def test_unique_index_on_signal_conversation(self):
        names = _index_names(IntentSignalSighting)
        assert "uq_intent_signal_sightings" in names

    def test_indexes_defined(self):
        names = _index_names(IntentSignalSighting)
        assert "idx_intent_signal_sightings_signal" in names
        assert "idx_intent_signal_sightings_conv" in names
