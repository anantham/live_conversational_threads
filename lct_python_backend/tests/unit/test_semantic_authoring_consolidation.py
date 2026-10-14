"""Shared authoring intent: see tests/intent/semantic_authoring_consolidation.md.

Only the provider transport is replaced; source resolution, prompts, parsing,
scan aggregation and artifact serialization are real. All speech is synthetic.
"""

import copy
import json
import os
import stat
import subprocess

import pytest

from lct_python_backend.services.edge_enrichment import run_edge_enrichment
from lct_python_backend.services import edge_enrichment, threads_semantic_authoring
from lct_python_backend.services.transcript import transcript_llm_callers
from lct_python_backend.services.threads_semantic_authoring import (
    author_threads_artifact, write_authored_experiment,
)


def source_fixture():
    utterances = [
        {"id": "u1", "text": "We should keep access open so people can inspect the model."},
        {"id": "u2", "text": "Yeah."},
        {"id": "u3", "text": "Returning to open access: inspection can reveal unsafe behavior."},
    ]
    nodes = [{"id": f"m{index}", "level": 1, "semantic_level": 1, "semantic_type": "chunk",
              "node_name": f"Passage {index}", "utterance_ids": [turn["id"]]}
             for index, turn in enumerate(utterances, 1)]
    return nodes, utterances


def transport(monkeypatch, payload, seen):
    def provider(**kwargs):
        seen.append(kwargs)
        return payload, None
    monkeypatch.setattr(transcript_llm_callers, "_call_local_chat_json_with_fallback", provider)


def relation(**changes):
    return {"from_node_id": "m3", "to_node_id": "m1", "relation_type": "clarifies",
            "explanation": "The later passage explains how open inspection helps.",
            "supporting_utterance_ids": ["u1", "u3"], **changes}


LOCAL_PROVIDER = [{"id": "synthetic-local", "base_url": "http://127.0.0.1:9999",
                   "trust_scope": "owner_private"}]


def artifact_fixture():
    nodes, utterances = source_fixture()
    for index, node in enumerate(nodes):
        node["timestamp_start"] = index * 600
    return {"format": "lct.threads", "format_version": 2,
            "conversation_id": "synthetic-consolidation", "conversation_title": "Shared authoring fixture",
            "chunk_dict": {}, "graph_data": nodes, "utterances": utterances,
            "edge_schema": {"version": 1, "directed": True, "endpoint_space": "graph_data.id"},
            "edges": [{"id": "existing-context", "from_node_id": "m1", "to_node_id": "m3",
                       "edge_kind": "semantic", "relation_type": "contextual",
                       "explanation": "Existing authored context", "supporting_utterance_ids": ["u1"]}]}


def interpretation_fixture():
    return {"title": "Shared authoring fixture", "summary": "Synthetic source only",
            "threads": [{"id": "t1", "title": "Inspecting open models", "steps": [
                {"moment_id": "m1", "evidence_indices": [1]},
                {"moment_id": "m3", "evidence_indices": [3]},
            ], "returns": [{"from": "m3", "to": "m1", "kind": "explicit_callback",
                            "why": "The later passage returns to inspection", "evidence_indices": [1, 3]}]}],
            "groups": [
                {"id": "i1", "level": 2, "title": "Inspection", "children": [
                    {"id": f"m{index}", "why": "Source passage"} for index in range(1, 4)]},
                {"id": "p1", "level": 3, "title": "Access", "children": [{"id": "i1", "why": "Context"}]},
                {"id": "h1", "level": 4, "title": "Agency", "children": [{"id": "p1", "why": "Context"}]},
                {"id": "a1", "level": 5, "title": "Steering", "children": [{"id": "h1", "why": "Context"}]},
            ]}


@pytest.mark.asyncio
async def test_exact_speech_and_selected_citations_are_used_without_mutating_source(monkeypatch):
    nodes, utterances = source_fixture()
    original = copy.deepcopy((nodes, utterances))
    seen = []
    transport(monkeypatch, {"edges": [relation()]}, seen)
    edges, telemetry = await run_edge_enrichment(
        nodes=nodes, utterances=utterances, query_summary="", providers=[],
        skip_context_lookup=True,
    )
    assert len(seen) == 1
    for turn in utterances:
        assert turn["text"] in seen[0]["prompt"]
    assert len(edges) == 1
    assert edges[0]["from_node_id"] == "m3"
    assert edges[0]["to_node_id"] == "m1"
    assert edges[0]["supporting_utterance_ids"] == ["u1", "u3"]
    assert telemetry["llm_telemetry"]["parse_status"] == "valid"
    assert (nodes, utterances) == original


@pytest.mark.parametrize("payload", [
    {"edges": [relation(supporting_utterance_ids=[])]},
    {"edges": [{key: value for key, value in relation().items()
                if key != "supporting_utterance_ids"}]},
    {"edges": [relation(supporting_utterance_ids=["invented"])]},
    {"edges": [relation(supporting_utterance_ids=["u2"])]},
    {"edges": [relation(explanation="")]},
    {"summary": "Generic response, not an edge payload"},
])
@pytest.mark.asyncio
async def test_unsupported_response_is_failure_not_a_successful_empty_scan(monkeypatch, payload):
    nodes, utterances = source_fixture()
    transport(monkeypatch, payload, [])
    edges, telemetry = await run_edge_enrichment(
        nodes=nodes, utterances=utterances, query_summary="", providers=[],
        skip_context_lookup=True,
    )
    assert edges == []
    assert telemetry["llm_telemetry"]["parse_status"] == "invalid"
    assert telemetry["llm_telemetry"]["error"]


@pytest.mark.asyncio
async def test_valid_empty_response_has_distinct_success_status(monkeypatch):
    nodes, utterances = source_fixture()
    transport(monkeypatch, {"edges": []}, [])
    edges, telemetry = await run_edge_enrichment(
        nodes=nodes, utterances=utterances, query_summary="", providers=[],
        skip_context_lookup=True,
    )
    assert edges == []
    assert telemetry["llm_telemetry"]["parse_status"] == "valid"
    assert telemetry["llm_telemetry"]["error"] is None


@pytest.mark.asyncio
async def test_provider_following_demonstrated_output_shape_can_author_cited_edge(monkeypatch):
    def provider(**kwargs):
        example = kwargs["system_prompt"].split("OUTPUT JSON SHAPE:\n", 1)[1].split("\n\nReturn only JSON", 1)[0]
        keys = json.loads(example)["edges"][0]
        return {"edges": [{key: relation()[key] for key in keys}]}, None

    monkeypatch.setattr(transcript_llm_callers, "_call_local_chat_json_with_fallback", provider)
    nodes, utterances = source_fixture()
    edges, telemetry = await run_edge_enrichment(nodes=nodes, utterances=utterances,
        query_summary="", providers=[], skip_context_lookup=True)
    assert telemetry["llm_telemetry"]["parse_status"] == "valid"
    assert len(edges) == 1 and edges[0]["supporting_utterance_ids"] == ["u1", "u3"]


@pytest.mark.asyncio
async def test_unknown_source_id_refuses_before_provider(monkeypatch):
    nodes, utterances = source_fixture()
    nodes[0]["utterance_ids"] = ["missing"]
    seen = []
    transport(monkeypatch, {"edges": [relation()]}, seen)
    edges, telemetry = await run_edge_enrichment(
        nodes=nodes, utterances=utterances, query_summary="", providers=[],
        skip_context_lookup=True,
    )
    assert not seen and not edges
    assert telemetry["llm_telemetry"]["error"].endswith("edge_source_unknown_utterance")


@pytest.mark.asyncio
async def test_large_exact_source_refuses_without_truncating_or_calling_provider(monkeypatch):
    nodes, utterances = source_fixture()
    utterances[0]["text"] = "Exact source " * 3000
    seen = []
    transport(monkeypatch, {"edges": [relation()]}, seen)
    edges, telemetry = await run_edge_enrichment(
        nodes=nodes, utterances=utterances, query_summary="", providers=[],
        skip_context_lookup=True,
    )
    assert not seen and not edges
    assert "budget" in telemetry["llm_telemetry"]["error"] or "too_large" in telemetry["llm_telemetry"]["error"]


@pytest.mark.asyncio
async def test_source_text_budget_splits_existing_windows_without_dropping_turns(monkeypatch):
    utterances = [{"id": f"u{index}", "text": (f"Exact synthetic speech {index}. " * 80)}
                  for index in range(35)]
    nodes = [{"id": f"m{index}", "level": 1, "utterance_ids": [turn["id"]]}
             for index, turn in enumerate(utterances)]
    seen = []
    transport(monkeypatch, {"edges": []}, seen)
    edges, telemetry = await run_edge_enrichment(
        nodes=nodes, utterances=utterances, query_summary="", providers=[],
        skip_context_lookup=True,
    )
    assert len(seen) > 2
    assert telemetry["llm_telemetry"]["parse_status"] == "valid"
    assert all(len(request["prompt"]) <= 24000 for request in seen)
    assert all(any(turn["text"] in request["prompt"] for request in seen) for turn in utterances)
    assert edges == []


@pytest.mark.parametrize("context_size,retained", [(20, True), (4000, False)])
@pytest.mark.asyncio
async def test_optional_retrieval_cannot_crowd_out_exact_source(monkeypatch, context_size, retained):
    nodes, utterances = source_fixture()
    utterances[0]["text"] = "Exact synthetic speech. " * 750
    context_title = "Supplementary context " + "x" * context_size

    async def retrieval(**_kwargs):
        return {"items": [{"title": context_title, "text": "Optional reference"} for _ in range(8)]}

    monkeypatch.setattr(edge_enrichment, "retrieval_search", retrieval)
    seen = []
    transport(monkeypatch, {"edges": [relation()]}, seen)
    edges, telemetry = await run_edge_enrichment(
        nodes=nodes, utterances=utterances, query_summary="synthetic access",
        providers=[], participant_external_llm_ok_set=set(),
    )
    assert len(seen) == 1 and len(edges) == 1
    assert telemetry["llm_telemetry"]["parse_status"] == "valid"
    prompt = seen[0]["prompt"]
    assert len(prompt) <= 24000
    assert all(turn["text"] in prompt for turn in utterances)
    assert (context_title in prompt) is retained


@pytest.mark.asyncio
async def test_compile_shared_extract_export_and_reload_keep_direction_citations_and_returns(monkeypatch, tmp_path):
    base = artifact_fixture()
    before = copy.deepcopy(base)
    seen = []
    transport(monkeypatch, {"edges": [relation()]}, seen)
    destination = tmp_path / "example.threads"
    result = await write_authored_experiment(
        base, interpretation=interpretation_fixture(), output_path=destination,
        providers=LOCAL_PROVIDER,
    )
    loaded = json.loads(destination.read_text(encoding="utf-8"))
    assert loaded == result
    assert base == before
    assert loaded["edges"][0] == before["edges"][0]
    assert len(loaded["edges"]) == 2
    assert loaded["edges"][1]["from_node_id"] == "m3"
    assert loaded["edges"][1]["to_node_id"] == "m1"
    assert loaded["edges"][1]["supporting_utterance_ids"] == ["u1", "u3"]
    assert loaded["conversation_threads"][0]["returns"][0]["evidence_utterance_ids"] == ["u1", "u3"]
    assert all(edge["relation_type"] != "return_to_thread" for edge in loaded["edges"])
    assert loaded["utterances"] == before["utterances"]
    assert loaded["argument_topology"]["status"] == "complete"
    assert loaded["argument_topology"]["exhaustive"] is False
    assert len(seen) == 1
    repeated = await author_threads_artifact(loaded, providers=LOCAL_PROVIDER)
    assert repeated["edges"] == loaded["edges"]


@pytest.mark.asyncio
async def test_failed_scan_retains_previous_output_bytes_and_reports_failure(monkeypatch, tmp_path):
    destination = tmp_path / "previous.threads"
    previous = json.dumps(artifact_fixture()).encode()
    destination.write_bytes(previous)
    transport(monkeypatch, {"edges": [relation(supporting_utterance_ids=[])]}, [])
    with pytest.raises(ValueError, match="previous artifact retained"):
        await write_authored_experiment(artifact_fixture(), output_path=destination,
                                       providers=LOCAL_PROVIDER)
    assert destination.read_bytes() == previous
    assert list(tmp_path.iterdir()) == [destination]


@pytest.mark.asyncio
async def test_compiler_failure_reports_reason_and_preserves_previous_output(monkeypatch, tmp_path):
    destination = tmp_path / "previous.threads"
    previous = b"previous reviewed artifact"
    destination.write_bytes(previous)
    base = artifact_fixture()
    base["edges"][0]["to_node_id"] = "missing-node"
    seen = []
    transport(monkeypatch, {"edges": []}, seen)
    with pytest.raises(ValueError, match="previous artifact retained:.*missing-node"):
        await write_authored_experiment(base, interpretation=interpretation_fixture(),
                                       output_path=destination, providers=LOCAL_PROVIDER)
    assert destination.read_bytes() == previous
    assert not seen


@pytest.mark.asyncio
async def test_compiler_timeout_reports_failure_and_preserves_previous_output(monkeypatch, tmp_path):
    destination = tmp_path / "previous.threads"
    previous = b"previous reviewed artifact"
    destination.write_bytes(previous)

    def expired(command, **kwargs):
        assert kwargs["timeout"] == 30
        raise subprocess.TimeoutExpired(command, kwargs["timeout"])

    monkeypatch.setattr(threads_semantic_authoring.subprocess, "run", expired)
    with pytest.raises(ValueError, match="timed out after 30s; previous artifact retained"):
        await write_authored_experiment(artifact_fixture(), interpretation=interpretation_fixture(),
                                       output_path=destination, providers=LOCAL_PROVIDER)
    assert destination.read_bytes() == previous


@pytest.mark.skipif(os.name == "nt", reason="POSIX permission mode contract")
@pytest.mark.asyncio
async def test_replacement_preserves_existing_artifact_permissions(monkeypatch, tmp_path):
    destination = tmp_path / "previous.threads"
    destination.write_text(json.dumps(artifact_fixture()), encoding="utf-8")
    destination.chmod(0o640)
    transport(monkeypatch, {"edges": []}, [])
    await write_authored_experiment(artifact_fixture(), output_path=destination,
                                   providers=LOCAL_PROVIDER)
    assert stat.S_IMODE(destination.stat().st_mode) == 0o640
    assert json.loads(destination.read_text(encoding="utf-8"))["argument_topology"]["status"] == "complete"


@pytest.mark.parametrize("providers", [[], [{"base_url": "https://remote.example", "trust_scope": "owner_private"}],
                                       [{"base_url": "http://localhost:9999"}],
                                       [{"base_url": "http://localhost:9999", "trust_scope": "external"}]])
@pytest.mark.asyncio
async def test_experiment_refuses_unapproved_provider_without_call(monkeypatch, providers):
    seen = []
    transport(monkeypatch, {"edges": [relation()]}, seen)
    with pytest.raises(ValueError, match="owner-private local"):
        await author_threads_artifact(artifact_fixture(), providers=providers)
    assert not seen
