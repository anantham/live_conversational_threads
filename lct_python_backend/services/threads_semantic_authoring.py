"""File adapter for the same relationship stage used by conversation imports.

Compilation never infers relationships. This adapter supplies the exact source
to shared extraction and commits an artifact only after the required scan passes.
"""

from __future__ import annotations

import copy
import json
import os
from pathlib import Path
import subprocess
import tempfile
from typing import Any
import uuid

from lct_python_backend.services.edge_contract import (
    canonical_relation_type, relationship_edge_kind, validate_serialized_edge_contract,
)
from lct_python_backend.services.edge_enrichment import run_edge_enrichment
from lct_python_backend.services.deployment_privacy_policy import (
    OWNER_PRIVATE, normalize_provider_trust_scope,
)
from lct_python_backend.services.egress_guard import is_local_url


async def author_threads_artifact(
    artifact: dict[str, Any], *, providers: list[dict], llm_config: dict | None = None,
) -> dict[str, Any]:
    """Return a new artifact; failures leave the caller's previous graph intact."""
    nodes = artifact.get("graph_data") or []
    validate_serialized_edge_contract(artifact.get("edge_schema"), artifact.get("edges"), nodes)
    eligible = [provider for provider in providers
                if provider.get("enabled", True) is not False
                and normalize_provider_trust_scope(provider.get("trust_scope")) == OWNER_PRIVATE
                and is_local_url(str(provider.get("base_url") or ""))]
    if not eligible:
        raise ValueError("No explicitly configured owner-private local relationship provider")
    edges, telemetry = await run_edge_enrichment(
        nodes=nodes, utterances=artifact.get("utterances") or [], query_summary="",
        providers=eligible, llm_config=llm_config, skip_context_lookup=True,
    )
    scan = telemetry.get("llm_telemetry") or {}
    if scan.get("error") or scan.get("parse_status") != "valid":
        raise ValueError(f"Relationship extraction failed; previous artifact retained: {scan.get('error') or 'invalid_edge_payload'}")

    result = copy.deepcopy(artifact)
    known = {(edge["from_node_id"], edge["to_node_id"], canonical_relation_type(edge["relation_type"]))
             for edge in result["edges"]}
    for edge in edges:
        key = (edge["from_node_id"], edge["to_node_id"], edge["relation_type"])
        if key in known:
            continue
        identifier = str(uuid.uuid5(uuid.NAMESPACE_URL, json.dumps([
            artifact.get("conversation_id"), *key,
        ])))
        result["edges"].append({"id": identifier, "edge_kind": "semantic",
                                "relation_subtype": "argument_topology:v1", **edge})
        known.add(key)
    validate_serialized_edge_contract(result["edge_schema"], result["edges"], nodes)
    counts = {}
    for edge in result["edges"]:
        if (edge.get("edge_kind") or relationship_edge_kind(edge["relation_type"])) == "semantic":
            relation = canonical_relation_type(edge["relation_type"])
            counts[relation] = counts.get(relation, 0) + 1
    result["argument_topology"] = {
        "version": "1.0", "status": "complete", "exhaustive": False,
        "method": "Shared transcript-grounded bounded relationship scan",
        "semantic_edge_count": sum(counts.values()), "relation_type_counts": counts,
        "window_count": scan.get("window_count"),
        "completed_windows": scan.get("completed_windows"),
    }
    return result


def compile_experiment(base: dict, interpretation: dict) -> dict:
    """Run the existing deterministic JS compiler, with JSON as data over stdin."""
    compiler = Path(__file__).resolve().parents[2] / "scripts" / "compile_thread_experiment.mjs"
    completed = subprocess.run(
        ["node", str(compiler), "--stdin"],
        input=json.dumps({"base": base, "interpretation": interpretation}),
        text=True, encoding="utf-8", capture_output=True, check=False,
    )
    if completed.returncode:
        raise ValueError("Experiment compilation failed; previous artifact retained")
    return json.loads(completed.stdout)


async def write_authored_experiment(
    base: dict, *, output_path: Path, providers: list[dict],
    interpretation: dict | None = None, llm_config: dict | None = None,
) -> dict:
    """Compile optionally, scan, then atomically replace only the requested file."""
    staged = compile_experiment(base, interpretation) if interpretation is not None else base
    result = await author_threads_artifact(staged, providers=providers, llm_config=llm_config)
    temporary_path = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8", dir=output_path.parent,
            prefix=f".{output_path.name}.", suffix=".tmp", delete=False,
        ) as stream:
            temporary_path = Path(stream.name)
            json.dump(result, stream, ensure_ascii=False, indent=2)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary_path, output_path)
    finally:
        if temporary_path is not None and temporary_path.exists():
            temporary_path.unlink()
    return result
