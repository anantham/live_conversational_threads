"""DEPRECATED — re-export shim per ADR-030 §D3.

The canonical mode-agnostic persistence module is
``lct_python_backend.services.graph_persistence``. This file remains as a
thin re-export so existing callers (and unit tests) keep working during the
grace window. New code MUST import from ``graph_persistence`` directly.

To migrate, replace::

    from lct_python_backend.services.import_persistence import persist_import_graph

with::

    from lct_python_backend.services.graph_persistence import persist_graph

(``persist_import_graph`` is kept as an alias for ``persist_graph`` in the
canonical module.)
"""

from lct_python_backend.services.graph_persistence import (  # noqa: F401
    _extract_contextual_relation_pair,
    _iter_contextual_relations,
    _looks_like_single_contextual_relation_object,
    build_participant_summaries,
    calculate_speaker_turns,
    persist_graph,
    persist_import_graph,
    persist_transcript,
)
