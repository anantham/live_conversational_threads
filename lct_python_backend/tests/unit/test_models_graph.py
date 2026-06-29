"""Unit tests for lct_python_backend.models.graph (no DB required).

Tests verify model structure: column nullability, CheckConstraints,
index definitions, and default values — inspected at the Python class
level without any database connection.
"""

import uuid

import sqlalchemy as sa

from lct_python_backend.models.graph import Cluster, Node, Relationship


# ---------------------------------------------------------------------------
# Helpers (same approach as test_models_core.py)
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
# Node
# ---------------------------------------------------------------------------

class TestNodeModel:
    def test_tablename(self):
        assert Node.__tablename__ == "nodes"

    def test_primary_key_has_uuid_default(self):
        col = _column(Node, "id")
        assert col.primary_key
        assert col.default is not None
        assert callable(col.default.arg)
        assert col.default.arg.__name__ == "uuid4"
        assert col.default.arg.__module__ == "uuid"

    def test_required_columns_not_nullable(self):
        for col_name in ("conversation_id", "node_name", "summary", "chunk_ids"):
            col = _column(Node, col_name)
            assert not col.nullable, f"{col_name} should be NOT NULL"

    def test_dialogue_type_check_constraint(self):
        checks = _check_constraints(Node)
        assert "valid_dialogue_type" in checks
        expr = checks["valid_dialogue_type"]
        for allowed in ("monologue", "dialogue", "multi-party", "consensus"):
            assert allowed in expr, f"'{allowed}' missing from valid_dialogue_type"
        # NULL must be explicitly allowed (it's an optional classification).
        assert "IS NULL" in expr

    def test_boolean_flags_have_defaults(self):
        for col_name in ("is_bookmark", "is_contextual_progress", "is_tangent",
                         "is_crux", "is_action_item", "is_surprise"):
            col = _column(Node, col_name)
            assert col.default is not None, f"{col_name} should have a Python-side default"
            assert col.default.arg is False, f"{col_name} default should be False"

    def test_optional_columns_nullable(self):
        for col_name in ("source_excerpt", "source_ref", "parent_id", "predecessor_id",
                         "successor_id", "utterance_ids", "speaker_info", "speaker_transitions",
                         "dialogue_type", "timestamp_start", "timestamp_end", "duration_seconds",
                         "cluster_info", "display_preferences", "zoom_level_visible",
                         "confidence_score", "thread_id", "thread_state"):
            col = _column(Node, col_name)
            assert col.nullable, f"{col_name} should be nullable"

    def test_level_default(self):
        col = _column(Node, "level")
        assert col.default is not None
        assert col.default.arg == 1

    def test_indexes_defined(self):
        names = _index_names(Node)
        assert "idx_nodes_conversation" in names
        assert "idx_nodes_temporal" in names
        assert "idx_nodes_level" in names
        assert "idx_nodes_bookmarks" in names
        assert "idx_nodes_tangents" in names


# ---------------------------------------------------------------------------
# Relationship
# ---------------------------------------------------------------------------

class TestRelationshipModel:
    def test_tablename(self):
        assert Relationship.__tablename__ == "relationships"

    def test_required_columns_not_nullable(self):
        for col_name in ("conversation_id", "from_node_id", "to_node_id", "relationship_type"):
            col = _column(Relationship, col_name)
            assert not col.nullable, f"{col_name} should be NOT NULL"

    def test_no_self_reference_constraint(self):
        checks = _check_constraints(Relationship)
        assert "no_self_reference" in checks
        expr = checks["no_self_reference"]
        assert "from_node_id" in expr
        assert "to_node_id" in expr

    def test_strength_bounds_constraint(self):
        checks = _check_constraints(Relationship)
        assert "valid_strength" in checks
        expr = checks["valid_strength"]
        assert "strength" in expr

    def test_confidence_bounds_constraint(self):
        checks = _check_constraints(Relationship)
        assert "valid_confidence" in checks
        expr = checks["valid_confidence"]
        assert "confidence" in expr

    def test_strength_default(self):
        col = _column(Relationship, "strength")
        assert col.default is not None
        assert col.default.arg == 1.0

    def test_confidence_default(self):
        col = _column(Relationship, "confidence")
        assert col.default is not None
        assert col.default.arg == 1.0

    def test_is_bidirectional_default_false(self):
        col = _column(Relationship, "is_bidirectional")
        assert col.default is not None
        assert col.default.arg is False

    def test_optional_columns_nullable(self):
        for col_name in ("relationship_subtype", "explanation", "supporting_utterance_ids"):
            col = _column(Relationship, col_name)
            assert col.nullable, f"{col_name} should be nullable"

    def test_indexes_defined(self):
        names = _index_names(Relationship)
        assert "idx_relationships_from" in names
        assert "idx_relationships_to" in names
        assert "idx_relationships_type" in names


# ---------------------------------------------------------------------------
# Cluster
# ---------------------------------------------------------------------------

class TestClusterModel:
    def test_tablename(self):
        assert Cluster.__tablename__ == "clusters"

    def test_required_columns_not_nullable(self):
        for col_name in ("conversation_id", "cluster_name", "level", "node_ids"):
            col = _column(Cluster, col_name)
            assert not col.nullable, f"{col_name} should be NOT NULL"

    def test_optional_columns_nullable(self):
        for col_name in ("parent_cluster_id", "child_cluster_ids", "summary",
                         "key_themes", "clustering_algorithm", "clustering_confidence",
                         "color", "icon"):
            col = _column(Cluster, col_name)
            assert col.nullable, f"{col_name} should be nullable"

    def test_auto_generated_default_true(self):
        col = _column(Cluster, "auto_generated")
        assert col.default is not None
        assert col.default.arg is True

    def test_indexes_defined(self):
        names = _index_names(Cluster)
        assert "idx_clusters_conversation" in names
        assert "idx_clusters_level" in names
