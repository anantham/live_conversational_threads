"""Query-aware empty artifact store for legacy persistence unit fixtures."""
from unittest.mock import MagicMock


def is_artifact_query(statement):
    return bool(getattr(statement, 'is_select', False) and any(
        table.name == 'pipeline_artifacts' for table in statement.get_final_froms()))


def with_empty_artifact_store(db):
    empty = MagicMock()
    empty.scalar_one_or_none.return_value = None
    db.execute.side_effect = lambda statement: empty if is_artifact_query(statement) else db.execute.return_value
