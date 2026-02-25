import os

os.environ.setdefault("DATABASE_URL", "postgresql://lct_user:lct_password@localhost:5432/lct_dev")

from lct_python_backend.canvas_api import (
    CanvasEdge,
    CanvasNode,
    ObsidianCanvas,
    convert_canvas_to_conversation,
    convert_conversation_to_canvas,
)


def test_convert_conversation_to_canvas_normalizes_single_contextual_relation_object():
    graph_data = [[
        {
            "id": "node-a-id",
            "node_name": "Node A",
            "summary": "Start",
            "successor": "Node B",
            "contextual_relation": {},
        },
        {
            "id": "node-b-id",
            "node_name": "Node B",
            "summary": "Follow up",
            "predecessor": "Node A",
            "contextual_relation": {
                "related_node_name": "Node A",
                "relation_text": "Builds on A",
            },
        },
    ]]

    canvas = convert_conversation_to_canvas(graph_data, {}, "demo")

    node_ids = {node.id for node in canvas.nodes}
    assert {"node-a-id", "node-b-id"}.issubset(node_ids)

    contextual_edges = [edge for edge in canvas.edges if edge.fromNode == "node-a-id" and edge.toNode == "node-b-id"]
    assert any(edge.label in {"Builds on A", "Builds on A..."} for edge in contextual_edges)


def test_convert_canvas_to_conversation_resolves_titles_from_canvas_ids():
    canvas = ObsidianCanvas(
        nodes=[
            CanvasNode(
                id="3b3a2df5-93c2-4f4a-a8d0-3d4f6b8bb11a",
                type="text",
                x=100,
                y=100,
                width=320,
                height=200,
                text="# Alpha\n\nAlpha summary",
            ),
            CanvasNode(
                id="9a6438e8-a6ff-4425-a7ac-997ce39da7bc",
                type="text",
                x=700,
                y=100,
                width=320,
                height=200,
                text="# Beta\n\nBeta summary",
            ),
        ],
        edges=[
            CanvasEdge(
                id="e1",
                fromNode="3b3a2df5-93c2-4f4a-a8d0-3d4f6b8bb11a",
                toNode="9a6438e8-a6ff-4425-a7ac-997ce39da7bc",
                label="next",
                color="1",
            ),
            CanvasEdge(
                id="e2",
                fromNode="9a6438e8-a6ff-4425-a7ac-997ce39da7bc",
                toNode="3b3a2df5-93c2-4f4a-a8d0-3d4f6b8bb11a",
                label="supports",
                color="4",
            ),
        ],
    )

    graph_data, _chunk_dict = convert_canvas_to_conversation(canvas, preserve_positions=True)
    assert len(graph_data) == 1
    assert len(graph_data[0]) == 2

    alpha = next(node for node in graph_data[0] if node["node_name"] == "Alpha")
    beta = next(node for node in graph_data[0] if node["node_name"] == "Beta")

    assert alpha["successor"] == "Beta"
    assert beta["predecessor"] == "Alpha"
    assert alpha["contextual_relation"].get("Beta") == "supports"
