"""DEPRECATED — re-export shim per ADR-030 §D3.

The canonical persistence module is now
``lct_python_backend.services.graph_persistence`` which handles both live
and import paths uniformly. This file remains as a re-export so existing
callers keep working during the grace window. New code MUST import from
``graph_persistence`` directly.
"""

from lct_python_backend.services.graph_persistence import (  # noqa: F401
    extract_conversation_name,
    persist_live_graph_snapshot,
)
