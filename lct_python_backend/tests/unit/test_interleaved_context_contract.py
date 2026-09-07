"""Behavioral contract for the user-requested conversational memory rework.

Test intent: an explicit callback must receive its earlier source evidence even
after more than 40 unrelated nodes. Exercise ingestion and inspect the public
LLM request boundary; no real model, network, database or private transcript.
The initial distant-callback assertion was observed failing on the legacy path
before wiring the experimental policy. No real-model quality is claimed here.
"""
import asyncio
import json
import pytest

from lct_python_backend.services.transcript import transcript_processing as mod
from lct_python_backend.services.transcript.conversation_context import ContextBudgetExceeded, PassageContextPolicy


@pytest.mark.asyncio
async def test_question_selection_preserves_original_whitespace_through_ingestion(monkeypatch):
    """Evidence selection must survive batching, normalization and memory folding."""
    source = "  Who funds this? \n"

    def generate(prompt, **kwargs):
        payload = json.loads(prompt)
        assert payload["current_source_lines"][0]["text"] == source
        return ([{"node_name": "Funding", "semantic_level": 1,
                  "question_updates": [{"question_id": "funding", "action": "open",
                      "wording": "Who funds this?", "rationale": "Explicit inquiry",
                      "evidence_line_ids": ["line-0"]}]}], "local_test")

    monkeypatch.setattr(mod, "generate_lct_json", generate)
    processor = mod.TranscriptProcessor(
        send_update=None, batch_size=1, initial_batch_size=1,
        graph_first_update_max_wait_ms=0, graph_steady_update_max_wait_ms=0,
        llm_config={"mode": "local"}, providers=[],
        passage_context_policy=PassageContextPolicy(8000))
    await processor.handle_final_text(source, utterance_id="question-source")
    assert list(processor.chunk_dict.values()) == [source]
    node = processor.existing_json[0]
    assert node["question_updates"][0]["evidence_quote"] == source
    from lct_python_backend.services.transcript.question_memory import fold_question_memory
    assert fold_question_memory(processor.existing_json, processor.chunk_dict)["funding"]["status"] == "open"


@pytest.mark.asyncio
async def test_semantic_retrieval_uses_committed_history_and_failure_keeps_pending_source(monkeypatch):
    requests, retrievals = [], []

    class Retriever:
        fail = False

        async def rank(self, current, chunks):
            retrievals.append((current, dict(chunks)))
            if self.fail:
                raise ValueError("Invalid embedding indexes")
            return {cid: .8 for cid in chunks}

    def generate(prompt, **kwargs):
        requests.append(json.loads(prompt))
        return ([{"node_name": "Moment", "semantic_level": 1}], "local_test")

    monkeypatch.setattr(mod, "generate_lct_json", generate)
    retriever = Retriever()
    processor = mod.TranscriptProcessor(
        send_update=None, batch_size=1, initial_batch_size=1,
        graph_first_update_max_wait_ms=0, graph_steady_update_max_wait_ms=0,
        llm_config={"mode": "local"}, providers=[],
        passage_context_policy=PassageContextPolicy(8000), semantic_candidates=retriever,
    )
    await processor.handle_final_text("Who funds this?", utterance_id="u-first")
    retriever.fail = True
    with pytest.raises(ValueError, match="indexes"):
        await processor.handle_final_text("Returning to the bill.", utterance_id="u-second")
    assert list(retrievals[-1][1].values()) == ["Who funds this?"]
    assert processor.accumulator == ["Returning to the bill."]
    assert len(requests) == 1
    retriever.fail = False
    await processor.flush()
    assert len(requests) == 2
    assert requests[-1]["earlier_passages"][0]["text"] == "Who funds this?"
    assert "semantic" in requests[-1]["coverage"]["retrieval"]


@pytest.mark.asyncio
async def test_distant_callback_receives_earlier_source_evidence(monkeypatch):
    requests = []
    evidence = "Consent must mean informed assent, not merely clicking a yes button."

    def boundary(_text, **_kwargs):
        raise AssertionError("Passage scheduling must not ask whether a semantic thread is complete")

    def generate(prompt, **_kwargs):
        requests.append(prompt)
        index = len(requests)
        return ([{
            "id": f"node-{index}",
            "node_name": "Consent question" if index == 1 else f"Independent subject {index}",
            "summary": "An unresolved question about consent." if index == 1 else f"Unrelated issue {index}.",
            "semantic_level": 1,
            "semantic_type": "chunk",
            "thread_id": "consent" if index == 1 else f"unrelated-{index}",
            "source_excerpt": evidence if index == 1 else "",
        }], "local_test")

    monkeypatch.setattr(mod, "accumulate_text_json_local_indexed", boundary)
    monkeypatch.setattr(mod, "generate_lct_json", generate)
    processor = mod.TranscriptProcessor(
        send_update=None, batch_size=1, initial_batch_size=1, max_batch_size=1,
        graph_first_update_max_wait_ms=0, graph_steady_update_max_wait_ms=0,
        llm_config={"mode": "local"}, providers=[],
        passage_context_policy=PassageContextPolicy(input_token_budget=8000),
    )
    await processor.handle_final_text(evidence, utterance_id="utterance-consent")
    for index in range(45):
        await processor.handle_final_text(f"An independent discussion {index}.", utterance_id=f"unrelated-{index}")
    await processor.handle_final_text("Back to our earlier consent question: this is what I meant.", utterance_id="callback")
    await processor.flush()

    assert len(requests) > 40, "Fixture must move the original issue outside the old recency window"
    assert evidence in requests[-1], "Explicit callback needs the actual earlier passage, not just recent unrelated summaries"


@pytest.mark.asyncio
async def test_passage_budget_batches_new_speech_without_completion_classifier(monkeypatch):
    requests = []

    def generate(prompt, **kwargs):
        requests.append(json.loads(prompt))
        return ([{"node_name": "Open question", "summary": "Still developing", "semantic_level": 1}], "local_test")

    def boundary(*args, **kwargs):
        raise AssertionError("Processing cadence is not semantic closure")

    monkeypatch.setattr(mod, "generate_lct_json", generate)
    monkeypatch.setattr(mod, "accumulate_text_json_local_indexed", boundary)
    processor = mod.TranscriptProcessor(
        send_update=None, graph_first_update_max_wait_ms=0, graph_steady_update_max_wait_ms=0,
        llm_config={"mode": "local"}, providers=[],
        passage_context_policy=PassageContextPolicy(8000, passage_target_tokens=200),
    )
    for i in range(10):
        await processor.handle_final_text(f"Short turn {i}.", utterance_id=f"u-{i}")
    assert not requests, "Ten short turns should not mean ten inference requests"
    await processor.flush()
    assert len(requests) == 1
    assert "Short turn 0." in requests[0]["current_passage"]
    assert "Short turn 9." in requests[0]["current_passage"]
    assert requests[0]["earlier_passages"] == []
    assert list(processor.chunk_utterance_map.values()) == [[f"u-{i}" for i in range(10)]]


@pytest.mark.asyncio
async def test_current_evidence_not_duplicated_into_history_or_other_conversation(monkeypatch):
    requests = []

    def generate(prompt, **kwargs):
        payload = json.loads(prompt)
        requests.append(payload)
        return ([{"node_name": "Moment", "source_excerpt": payload["current_passage"], "semantic_level": 1}], "local_test")

    monkeypatch.setattr(mod, "generate_lct_json", generate)
    def make_processor():
        return mod.TranscriptProcessor(
            send_update=None, batch_size=1, initial_batch_size=1,
            graph_first_update_max_wait_ms=0, graph_steady_update_max_wait_ms=0,
            llm_config={"mode": "local"}, providers=[],
            passage_context_policy=PassageContextPolicy(8000),
        )
    first, second = make_processor(), make_processor()
    await first.handle_final_text("Original question.", utterance_id="u-first")
    await first.handle_final_text("Later clarification.", utterance_id="u-second")
    assert requests[0]["earlier_passages"] == []
    assert [p["text"] for p in requests[1]["earlier_passages"]] == ["Original question."]
    assert first.existing_json[0]["source_excerpt"] == "Original question."
    assert first.existing_json[0]["utterance_ids"] == ["u-first"]
    assert first.existing_json[1]["utterance_ids"] == ["u-second"]
    await second.handle_final_text("Another conversation.", utterance_id="other")
    assert requests[-1]["earlier_passages"] == []
    assert requests[-1]["thread_memory"] == []


@pytest.mark.asyncio
async def test_budget_failure_keeps_pending_source_and_does_not_call_provider(monkeypatch):
    def unexpected(*args, **kwargs):
        raise AssertionError("No model call may receive an over-budget request")

    monkeypatch.setattr(mod, "generate_lct_json", unexpected)
    monkeypatch.setattr(mod, "accumulate_text_json_local_indexed", unexpected)
    processor = mod.TranscriptProcessor(
        send_update=None, graph_first_update_max_wait_ms=0, graph_steady_update_max_wait_ms=0,
        llm_config={"mode": "local"}, providers=[],
        passage_context_policy=PassageContextPolicy(2000),
    )
    text = "Long original source. " * 1000
    with pytest.raises(ContextBudgetExceeded):
        await processor.handle_final_text(text, utterance_id="original")
    assert processor.accumulator == [text]
    assert processor.accumulator_utterance_ids == [["original"]]
    assert processor.existing_json == []
    assert processor.chunk_dict == {}


@pytest.mark.asyncio
@pytest.mark.parametrize("error_type", [RuntimeError, asyncio.CancelledError])
async def test_failed_publication_does_not_commit_memory_or_duplicate_retry(monkeypatch, error_type):
    """A rejected patch must not become context for its own retried passage."""
    requests = []
    fail = True

    def generate(prompt, **kwargs):
        payload = json.loads(prompt)
        requests.append(payload)
        return ([{"node_name": "Question", "semantic_level": 1,
                  "source_excerpt": payload["current_passage"]}], "local_test")

    async def publish(*args, **kwargs):
        if fail:
            raise error_type("synthetic publication failure")

    monkeypatch.setattr(mod, "generate_lct_json", generate)
    processor = mod.TranscriptProcessor(
        send_update=publish, graph_first_update_max_wait_ms=0, graph_steady_update_max_wait_ms=0,
        llm_config={"mode": "local"}, providers=[],
        passage_context_policy=PassageContextPolicy(8000),
    )
    with pytest.raises(error_type, match="synthetic publication failure"):
        await processor.handle_final_text("Still an open question.", utterance_id="source")
    assert processor.existing_json == []
    assert processor.chunk_dict == {}
    assert processor.chunk_utterance_map == {}
    assert processor.accumulator == ["Still an open question."]
    fail = False
    await processor.flush()
    assert len(processor.existing_json) == 1
    assert len(processor.chunk_dict) == 1
    assert requests[-1]["earlier_passages"] == []
    assert processor.existing_json[0]["utterance_ids"] == ["source"]
