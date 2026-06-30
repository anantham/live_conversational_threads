import pytest

from lct_python_backend.services.import_pipeline import import_graph_refinement as refinement_module


def _make_utterances(count: int) -> list[dict]:
    utterances = []
    for index in range(count):
        utterances.append(
            {
                "text": f"utterance {index} about monastery visa meta conversation travel plans",
                "speaker_id": "SPEAKER_00" if index % 2 == 0 else "SPEAKER_01",
                "timestamp_start": float(index * 5),
                "timestamp_end": float(index * 5 + 4),
            }
        )
    return utterances


def _make_nodes(count: int) -> list[dict]:
    nodes = []
    previous = None
    for index in range(count):
        node_name = f"Node {index}"
        nodes.append(
            {
                "node_name": node_name,
                "summary": f"Summary {index}",
                "source_excerpt": f"Excerpt {index}",
                "predecessor": previous,
                "successor": None,
                "thread_id": f"thread-{index}",
                "thread_state": "new_thread" if index == 0 else "continue_thread",
                "contextual_relation": {},
                "edge_relations": [],
                "linked_nodes": [],
                "speaker_id": "SPEAKER_00",
                "claims": [],
                "is_bookmark": False,
                "is_contextual_progress": False,
            }
        )
        if previous is not None:
            nodes[index - 1]["successor"] = node_name
        previous = node_name
    return nodes


def _make_contextual_nodes(count: int) -> list[dict]:
    nodes = _make_nodes(count)
    for index in range(1, len(nodes)):
        previous_name = nodes[index - 1]["node_name"]
        nodes[index]["contextual_relation"] = {
            previous_name: f"{nodes[index]['node_name']} builds on {previous_name}."
        }
        nodes[index]["edge_relations"] = [
            {
                "related_node": previous_name,
                "relation_type": "contextual",
                "relation_text": f"{nodes[index]['node_name']} builds on {previous_name}.",
            }
        ]
        nodes[index]["linked_nodes"] = [previous_name]
    return nodes


@pytest.mark.asyncio
async def test_refine_import_graph_nodes_skips_small_inputs():
    result = await refinement_module.refine_import_graph_nodes(
        transcript_text="too small",
        utterances=[{"text": "short", "speaker_id": "SPEAKER_00"}],
        existing_nodes=_make_nodes(3),
        llm_config={"mode": "local"},
        providers=[],
    )

    assert result["applied"] is False
    assert result["reason"] == "node_count_below_threshold"


@pytest.mark.asyncio
async def test_refine_import_graph_nodes_applies_richer_structure(monkeypatch):
    async def _should_not_call_online(*args, **kwargs):
        raise AssertionError("online refinement should not run in local mode")

    monkeypatch.setattr(refinement_module, "_refine_graph_nodes_gemini", _should_not_call_online)

    refined_nodes = _make_nodes(6)
    refined_nodes[3]["thread_state"] = "return_to_thread"
    refined_nodes[3]["thread_id"] = refined_nodes[1]["thread_id"]
    refined_nodes[3]["edge_relations"] = [
        {
            "related_node": refined_nodes[1]["node_name"],
            "relation_type": "return_to_thread",
            "relation_text": "Conversation returns to the earlier visa thread.",
        }
    ]

    monkeypatch.setattr(
        refinement_module,
        "_refine_graph_nodes_local",
        lambda prompt, providers=None: (refined_nodes, "local_test_backend", None),
    )

    result = await refinement_module.refine_import_graph_nodes(
        transcript_text=" ".join("topic pivot" for _ in range(800)),
        utterances=_make_utterances(22),
        existing_nodes=_make_nodes(4),
        llm_config={"mode": "local"},
        providers=[],
    )

    assert result["applied"] is True
    assert result["backend"] == "local_test_backend"
    assert result["original_node_count"] == 4
    assert result["refined_node_count"] == 6
    assert result["refined_metrics"]["return_count"] >= 1
    assert len(result["nodes"]) == 6


@pytest.mark.asyncio
async def test_refine_import_graph_nodes_rejects_duplicate_names(monkeypatch):
    duplicate_nodes = _make_nodes(5)
    duplicate_nodes[4]["node_name"] = duplicate_nodes[0]["node_name"]

    monkeypatch.setattr(
        refinement_module,
        "_refine_graph_nodes_local",
        lambda prompt, providers=None: (duplicate_nodes, "local_test_backend", None),
    )

    result = await refinement_module.refine_import_graph_nodes(
        transcript_text=" ".join("topic pivot" for _ in range(800)),
        utterances=_make_utterances(20),
        existing_nodes=_make_nodes(4),
        llm_config={"mode": "local"},
        providers=[],
    )

    assert result["applied"] is False
    assert result["reason"] == "duplicate_node_names"


@pytest.mark.asyncio
async def test_refine_import_graph_nodes_rejects_semantics_collapse(monkeypatch):
    refined_nodes = _make_nodes(6)
    refined_nodes[3]["thread_state"] = "return_to_thread"
    refined_nodes[3]["thread_id"] = refined_nodes[1]["thread_id"]

    monkeypatch.setattr(
        refinement_module,
        "_refine_graph_nodes_local",
        lambda prompt, providers=None: (refined_nodes, "local_test_backend", None),
    )

    result = await refinement_module.refine_import_graph_nodes(
        transcript_text=" ".join("topic pivot" for _ in range(800)),
        utterances=_make_utterances(22),
        existing_nodes=_make_contextual_nodes(4),
        llm_config={"mode": "local"},
        providers=[],
    )

    assert result["applied"] is False
    assert result["reason"] == "refinement_semantics_degraded"
    assert result["original_metrics"]["edge_count"] > 0
    assert result["refined_metrics"]["edge_count"] == 0
