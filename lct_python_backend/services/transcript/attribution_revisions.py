"""Source attribution receipts, separate from unchanged spoken-text evidence.

Receipts are stored with canonical utterance metadata in the same transaction
as speaker materialization. Segment IDs refer to its immutable diarization
evidence. They document an applied inference, not a verified human identity.
"""
import copy

KEY = "lct_attribution_revisions_v1"


def attribution_snapshot(utterance):
    return {"speaker_id": utterance.speaker_id,
            "speaker_revision": int(utterance.speaker_revision or 0),
            "speaker_source": utterance.speaker_source,
            "speaker_confidence": utterance.speaker_confidence}


def record_attribution_change(metadata, before, after, evidence_segment_ids):
    if (type(before.get("speaker_revision")) is not int
            or type(after.get("speaker_revision")) is not int
            or after["speaker_revision"] != before["speaker_revision"] + 1):
        raise ValueError("Attribution revisions must advance by one")
    if not evidence_segment_ids or not all(isinstance(value, str) and value for value in evidence_segment_ids):
        raise ValueError("Attribution revision requires speaker-segment evidence")
    result = copy.deepcopy(metadata or {})
    history = result.setdefault(KEY, [])
    if not isinstance(history, list):
        raise ValueError("Invalid attribution history")
    if history and history[-1]["after"] != before:
        raise ValueError("Attribution receipt does not extend the recorded history")
    history.append({"before": copy.deepcopy(before), "after": copy.deepcopy(after),
                    "evidence_segment_ids": list(dict.fromkeys(evidence_segment_ids))})
    return result


def validate_attribution_history(original_speaker, original_revision, current_speaker, current_revision, metadata):
    if original_revision == current_revision and original_speaker == current_speaker:
        return []
    if current_revision <= original_revision:
        raise ValueError("Attribution changed without an advancing revision")
    history = (metadata or {}).get(KEY, [])
    if not isinstance(history, list):
        raise ValueError("Invalid attribution history")
    revision, speaker, selected = original_revision, original_speaker, []
    for receipt in history:
        before, after = receipt.get("before", {}), receipt.get("after", {})
        if after.get("speaker_revision", -1) <= original_revision:
            continue
        if (before.get("speaker_revision") != revision or before.get("speaker_id") != speaker
                or after.get("speaker_revision") != revision + 1
                or not receipt.get("evidence_segment_ids")):
            raise ValueError("Attribution history is not a contiguous evidenced transition")
        revision, speaker = after["speaker_revision"], after.get("speaker_id")
        selected.append(copy.deepcopy(receipt))
    if revision != current_revision or speaker != current_speaker:
        raise ValueError("Current attribution is not explained by the receipt history")
    return selected
