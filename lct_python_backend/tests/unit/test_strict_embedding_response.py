"""Embedding transport must preserve the input-to-vector bijection."""
import pytest

from lct_python_backend.services.llm_gateway import _strict_embedding_vectors


def test_reordered_transport_is_restored_to_input_order():
    body = {"model": "m", "data": [{"index": 1, "embedding": [0., 1.]},
                                    {"index": 0, "embedding": [1., 0.]}]}
    assert _strict_embedding_vectors(body, "m", 2) == [[1., 0.], [0., 1.]]


@pytest.mark.parametrize("body", [
    {"data": [{"index": 0, "embedding": [1.]}]},
    {"model": "other", "data": [{"index": 0, "embedding": [1.]}]},
    {"model": "m", "data": [{"embedding": [1.]}]},
    {"model": "m", "data": [{"index": True, "embedding": [1.]}]},
    {"model": "m", "data": [{"index": 1, "embedding": [1.]}]},
    {"model": "m", "data": [{"index": 0, "embedding": [float("inf")]}]},
    {"model": "m", "data": [{"index": 0, "embedding": [0.]}]},
])
def test_unverifiable_source_alignment_or_vector_is_rejected(body):
    with pytest.raises(ValueError):
        _strict_embedding_vectors(body, "m", 1)


def test_duplicate_indexes_are_rejected():
    body = {"model": "m", "data": [{"index": 0, "embedding": [1.]},
                                    {"index": 0, "embedding": [1.]}]}
    with pytest.raises(ValueError):
        _strict_embedding_vectors(body, "m", 2)
