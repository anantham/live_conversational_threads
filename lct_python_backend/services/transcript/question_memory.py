"""Rebuild provisional question state from immutable, source-backed events.

This validates provenance and records transition conflicts, not whether an answer is
true or adequate. The event history remains on its original nodes; this compact
projection never rewrites earlier evidence or infers resolution from silence.
"""
import copy

_ACTIONS = {"open", "clarify", "partial_answer", "answer", "withdraw", "reopen"}
_FIELDS = {"question_id", "action", "wording", "evidence_quote", "rationale"}


class UnknownQuestionUpdate(ValueError):
    """A source-backed update has no preceding opening event."""

    def __init__(self, question_id):
        super().__init__("Question update refers to an unknown question")
        self.question_id = question_id


def fold_question_memory(nodes, source_chunks):
    memory = {}
    for node in nodes:
        updates = node.get("question_updates", [])
        if not isinstance(updates, list):
            raise ValueError("question_updates must be a list")
        for update in updates:
            if not isinstance(update, dict) or set(update) != _FIELDS:
                raise ValueError("Invalid question update fields")
            if any(not isinstance(value, str) or not value.strip() for value in update.values()):
                raise ValueError("Question update fields require nonempty text")
            identity, action = update["question_id"], update["action"]
            if action not in _ACTIONS:
                raise ValueError("Unsupported question action")
            chunk_id = node.get("chunk_id")
            if not node.get("id") or chunk_id not in source_chunks or update["evidence_quote"] not in source_chunks[chunk_id]:
                raise ValueError("Question update lacks exact source evidence")
            event = {**copy.deepcopy(update), "node_id": node["id"], "chunk_id": chunk_id,
                     "thread_id": node.get("thread_id")}
            if node.get("attribution_review_required"):
                event["attribution_review_required"] = True
                event["source_attributions"] = copy.deepcopy(node.get("source_attributions", []))
            previous = memory.get(identity)
            if action == "open":
                if previous is not None:
                    raise ValueError("Question identity already exists; use an explicit update")
                memory[identity] = {"question_id": identity, "status": "open",
                                    "original": event, "latest": event, "intermediate": [], "update_count": 1}
                continue
            if previous is None:
                raise UnknownQuestionUpdate(identity)
            if action == "partial_answer" and previous["status"] != "open":
                event['transition_issue'] = 'partial_answer_after_non_open_state'
                event['prior_provisional_status'] = previous['status']
                previous['status'] = 'uncertain'
            if action == "reopen" and previous["status"] == "open":
                event['transition_issue'] = 'reopening_already_open_question'
            status = {"answer": "answered", "withdraw": "withdrawn", "reopen": "open"}.get(action)
            if status:
                previous["status"] = status
            if previous['update_count'] > 1:
                previous['intermediate'].append(previous['latest'])
            previous["latest"] = event
            previous["update_count"] += 1
    return memory
