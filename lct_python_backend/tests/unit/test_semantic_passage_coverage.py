"""Complete-passage behavior; intent in tests/intent/semantic_authoring_consolidation.md.

Exercise the shared public entry points, replacing only the provider transport.
All source text is synthetic and all storage is assigned before imports by the
isolated test runner. Request JSON is the observable provider input contract.
"""

import copy
import asyncio
import json
import threading

import pytest

from lct_python_backend.services.edge_enrichment import run_edge_enrichment
from lct_python_backend.services import edge_enrichment
from lct_python_backend.services.threads_semantic_authoring import write_authored_experiment
from lct_python_backend.services.transcript import transcript_llm_callers


def passage_fixture():
    turns = [{"id": f"u{index:02d}", "text": f"Passage {index}: " +
              ('Exact synthetic speech with "quotation", a newline\n and café. ' * 18)}
             for index in range(40)]
    first = [turn["id"] for turn in turns[:24]]
    second = [turn["id"] for turn in turns[24:]]
    nodes = [
        {"id": "m1", "level": 1, "timestamp_start": 0, "parent_id": "i1",
         "memberships": [{"parent_id": "pB", "role": "secondary"}], "utterance_ids": first},
        {"id": "m2", "level": 1, "timestamp_start": 24, "parent_id": "i2", "utterance_ids": second},
        {"id": "i1", "level": 2, "timestamp_start": 0, "parent_id": "pA"},
        {"id": "i2", "level": 2, "timestamp_start": 24, "parent_id": "pA"},
        {"id": "pA", "level": 3, "parent_id": "h"},
        {"id": "pB", "level": 3, "parent_id": "h"},
        {"id": "h", "level": 4, "parent_id": "a"},
        {"id": "a", "level": 5},
    ]
    expected = {identifier: set(first) for identifier in ["m1", "i1", "pB"]}
    expected.update({identifier: set(second) for identifier in ["m2", "i2"]})
    expected.update({identifier: set(first + second) for identifier in ["pA", "h", "a"]})
    return nodes, turns, expected


def request_data(prompt):
    records = [json.loads(line) for line in prompt.splitlines() if line.startswith("{")]
    return ({item["id"]: item for item in records if "source_turn_ids" in item},
            {item["id"]: item["text"] for item in records if "text" in item})


async def scan(nodes, turns):
    return await run_edge_enrichment(nodes=nodes, utterances=turns, query_summary="",
                                     providers=[], skip_context_lookup=True)


@pytest.mark.asyncio
async def test_provider_sees_actual_grouping_and_cross_level_edges_remain_possible(monkeypatch):
    turns = [{"id": "u1", "text": "We need independent checks because one test can miss a defect."},
             {"id": "u2", "text": "The prototype is painted green."},
             {"id": "u3", "text": "We should verify results independently."}]
    nodes = [
        {"id": "m1", "level": 1, "utterance_ids": ["u1"], "parent_id": "p1",
         "memberships": [{"parent_id": "p2"}, {"parent_id": "p1"}, {"parent_id": "absent"}],
         "edges_out": [{"relationship_type": "member_of", "to": "p3"},
                       {"relationship_type": "supports", "to": "p5"}]},
        {"id": "m2", "level": 1, "utterance_ids": ["u2"]},
        {"id": "p1", "level": 3},
        {"id": "p2", "level": 3, "utterance_ids": ["u3"]},
        {"id": "p3", "level": 3, "utterance_ids": ["u3"]},
        {"id": "p4", "level": 3, "children_ids": ["m1", "m2"]},
        {"id": "p5", "level": 3, "utterance_ids": ["u3"]},
    ]
    before = copy.deepcopy((nodes, turns))
    seen = []

    def provider(**kwargs):
        shown, speech = request_data(kwargs["prompt"])
        seen.append(shown)
        assert speech == {turn["id"]: turn["text"] for turn in turns}
        assert shown["m1"]["parent_ids"] == ["p1", "p2", "p3", "p4"]
        assert shown["m2"]["parent_ids"] == ["p4"]
        assert all(not shown[identifier]["parent_ids"] for identifier in ("p1", "p2", "p3", "p4", "p5"))
        assert all(set(node["parent_ids"]) <= shown.keys() for node in shown.values())
        return {"edges": [{"from_node_id": "m1", "to_node_id": "p2",
                           "relation_type": "supports",
                           "explanation": "A single test missing defects is a reason for independent checks.",
                           "supporting_utterance_ids": ["u1", "u3"]}]}, None

    monkeypatch.setattr(transcript_llm_callers, "_call_local_chat_json_with_fallback", provider)
    edges, telemetry = await scan(nodes, turns)
    assert len(seen) == 1 and telemetry["llm_telemetry"]["parse_status"] == "valid"
    assert [(edge["from_node_id"], edge["to_node_id"], edge["relation_type"])
            for edge in edges] == [("m1", "p2", "supports")]
    assert edges[0]["supporting_utterance_ids"] == ["u1", "u3"]
    assert (nodes, turns) == before


@pytest.mark.asyncio
async def test_every_endpoint_passage_reaches_bounded_deterministic_requests(monkeypatch):
    nodes, turns, expected = passage_fixture()
    before = copy.deepcopy((nodes, turns))
    seen = []

    def provider(**kwargs):
        seen.append(kwargs["prompt"])
        return {"edges": []}, None

    monkeypatch.setattr(transcript_llm_callers, "_call_local_chat_json_with_fallback", provider)
    edges, telemetry = await scan(nodes, turns)
    first_run = list(seen)
    assert len(seen) > 2 and not edges
    assert telemetry["llm_telemetry"]["parse_status"] == "valid"
    assert telemetry["llm_telemetry"]["completed_windows"] == len(seen)
    actual = {identifier: set() for identifier in expected}
    boundary_visible = False
    for prompt in seen:
        shown_nodes, shown_turns = request_data(prompt)
        assert len(prompt) <= 24000 and len(shown_nodes) <= 30
        for identifier, node in shown_nodes.items():
            actual[identifier].update(node["source_turn_ids"])
            assert set(node["source_turn_ids"]) <= expected[identifier]
            assert set(node["parent_ids"]) <= shown_nodes.keys()
            if identifier == "m1":
                assert node["parent_ids"] == ["i1", "pB"]
        for identifier, text in shown_turns.items():
            assert text == next(turn["text"] for turn in turns if turn["id"] == identifier)
        if "m1" in shown_nodes:
            assert {"i1", "pA", "pB", "h", "a"} <= shown_nodes.keys()
        boundary_visible |= ("u23" in shown_nodes.get("m1", {}).get("source_turn_ids", []) and
                             "u24" in shown_nodes.get("m2", {}).get("source_turn_ids", []))
    assert actual == expected
    assert boundary_visible
    assert (nodes, turns) == before
    await scan(nodes, turns)
    assert seen[len(first_run):] == first_run


@pytest.mark.asyncio
async def test_late_visible_citation_can_author_an_edge(monkeypatch):
    nodes, turns, _ = passage_fixture()
    authored = 0

    def provider(**kwargs):
        nonlocal authored
        shown_nodes, _ = request_data(kwargs["prompt"])
        if all("u20" in shown_nodes.get(identifier, {}).get("source_turn_ids", [])
               for identifier in ["m1", "pB"]):
            authored += 1
            return {"edges": [{"from_node_id": "m1", "to_node_id": "pB",
                               "relation_type": "clarifies", "explanation": "A late synthetic clarification.",
                               "supporting_utterance_ids": ["u20"]}]}, None
        return {"edges": []}, None

    monkeypatch.setattr(transcript_llm_callers, "_call_local_chat_json_with_fallback", provider)
    edges, telemetry = await scan(nodes, turns)
    assert authored >= 1
    assert telemetry["llm_telemetry"]["parse_status"] == "valid"
    assert len(edges) == 1 and edges[0]["supporting_utterance_ids"] == ["u20"]


@pytest.mark.asyncio
async def test_real_but_undisclosed_citation_fails_and_retains_previous_artifact(monkeypatch, tmp_path):
    nodes, turns, _ = passage_fixture()
    destination = tmp_path / "previous.threads"
    previous = b"previous reviewed artifact"
    destination.write_bytes(previous)
    calls = 0

    def provider(**kwargs):
        nonlocal calls
        calls += 1
        if calls == 1:
            return {"edges": []}, None
        shown_nodes, shown_turns = request_data(kwargs["prompt"])
        assert {"pA", "a"} <= shown_nodes.keys()
        missing = next(turn["id"] for turn in turns if turn["id"] not in shown_turns)
        return {"edges": [{"from_node_id": "pA", "to_node_id": "a", "relation_type": "supports",
                           "explanation": "A citation that this page never disclosed.",
                           "supporting_utterance_ids": [missing]}]}, None

    monkeypatch.setattr(transcript_llm_callers, "_call_local_chat_json_with_fallback", provider)
    with pytest.raises(ValueError, match="previous artifact retained"):
        await write_authored_experiment({"format": "lct.threads", "format_version": 2,
            "conversation_id": "synthetic-passage-coverage", "graph_data": nodes,
            "utterances": turns, "edges": [],
            "edge_schema": {"version": 1, "directed": True, "endpoint_space": "graph_data.id"}},
            output_path=destination, providers=[{"id": "synthetic-local", "base_url": "http://localhost:9999",
                                                "trust_scope": "owner_private"}])
    assert calls == 2
    assert destination.read_bytes() == previous
    assert list(tmp_path.iterdir()) == [destination]


@pytest.mark.asyncio
async def test_oversized_indivisible_turn_refuses_all_requests_even_after_usable_pages(monkeypatch):
    nodes, turns, _ = passage_fixture()
    turns[-1]["text"] = "Indivisible exact late turn. " * 2000
    calls = []

    def provider(**kwargs):
        calls.append(kwargs)
        return {"edges": []}, None

    monkeypatch.setattr(transcript_llm_callers, "_call_local_chat_json_with_fallback", provider)
    edges, telemetry = await scan(nodes, turns)
    assert not edges and not calls
    assert telemetry["llm_telemetry"]["parse_status"] == "invalid"
    assert "budget" in telemetry["llm_telemetry"]["error"]


@pytest.mark.asyncio
async def test_cancel_during_slow_preparation_makes_no_model_call_or_file_write(monkeypatch, tmp_path):
    nodes, turns, _ = passage_fixture()
    destination = tmp_path / "previous.threads"
    destination.write_bytes(b"previous reviewed artifact")
    started, release, finished = threading.Event(), threading.Event(), threading.Event()
    real_planner = edge_enrichment.plan_edge_windows

    def slow_planner(*args, **kwargs):
        started.set()
        try:
            if not release.wait(2):
                raise ValueError("Preparation blocked the cancellation event loop")
            return real_planner(*args, **kwargs)
        finally:
            finished.set()

    calls = []

    def provider(**kwargs):
        calls.append(kwargs)
        return {"edges": []}, None

    monkeypatch.setattr(edge_enrichment, "plan_edge_windows", slow_planner)
    monkeypatch.setattr(transcript_llm_callers, "_call_local_chat_json_with_fallback", provider)
    operation = asyncio.create_task(write_authored_experiment({
        "graph_data": nodes, "utterances": turns, "edges": [],
        "edge_schema": {"version": 1, "directed": True, "endpoint_space": "graph_data.id"}},
        output_path=destination, providers=[{"base_url": "http://localhost:9999", "trust_scope": "owner_private"}]))
    try:
        assert await asyncio.to_thread(started.wait, 2)
        operation.cancel()
        with pytest.raises(asyncio.CancelledError):
            await operation
    finally:
        release.set()
        assert await asyncio.to_thread(finished.wait, 2)
    assert not calls
    assert destination.read_bytes() == b"previous reviewed artifact"
    assert list(tmp_path.iterdir()) == [destination]
