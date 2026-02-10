"""Speaker-turn synthesis helpers for conversations without analyzed nodes."""

from typing import Dict, List


def _create_node_label(speaker_name: str, text: str, max_length: int = 60) -> str:
    """Create a concise, meaningful label for a graph node."""
    cleaned_text = text.strip()

    sentence_endings = [". ", "? ", "! ", ".\n", "?\n", "!\n"]
    first_sentence_end = len(cleaned_text)
    for ending in sentence_endings:
        pos = cleaned_text.find(ending)
        if pos != -1 and pos < first_sentence_end:
            first_sentence_end = pos + 1

    if first_sentence_end < max_length:
        summary = cleaned_text[:first_sentence_end].strip()
    elif len(cleaned_text) > max_length:
        summary = cleaned_text[:max_length].rsplit(" ", 1)[0] + "..."
    else:
        summary = cleaned_text

    speaker_parts = speaker_name.split()
    if len(speaker_parts) >= 2:
        initials = "".join([part[0].upper() for part in speaker_parts[:2]])
    else:
        initials = speaker_name[:2].upper()

    return f"[{initials}] {summary}"


def _build_turn_node(current_speaker, current_turn, turn_number: int) -> Dict[str, object]:
    combined_text = "\n".join([utterance.text for utterance in current_turn])
    first_utterance = current_turn[0]
    last_utterance = current_turn[-1]

    return {
        "id": f"turn_{turn_number}",
        "node_name": _create_node_label(current_speaker, combined_text),
        "summary": combined_text[:150] + "..." if len(combined_text) > 150 else combined_text,
        "full_text": combined_text,
        "speaker_id": current_speaker,
        "utterance_count": len(current_turn),
        "sequence_number": first_utterance.sequence_number,
        "timestamp_start": first_utterance.timestamp_start,
        "timestamp_end": last_utterance.timestamp_end,
        "claims": [],
        "key_points": [],
        "predecessor": f"turn_{turn_number - 1}" if turn_number > 1 else None,
        "successor": None,
        "contextual_relation": {},
        "linked_nodes": [],
        "is_bookmark": False,
        "is_contextual_progress": False,
        "chunk_id": "default_chunk",
        "utterance_ids": [str(utterance.id) for utterance in current_turn],
        "is_utterance_node": True,
    }


def build_turn_graph_from_utterances(utterances) -> List[Dict[str, object]]:
    """Group utterances by consecutive speaker turns and emit graph nodes."""
    if not utterances:
        return []

    current_speaker = None
    current_turn = []
    turn_nodes: List[Dict[str, object]] = []
    turn_number = 0

    for utterance in utterances:
        if utterance.speaker_id != current_speaker:
            if current_turn:
                turn_number += 1
                turn_node = _build_turn_node(current_speaker, current_turn, turn_number)
                if turn_nodes:
                    turn_nodes[-1]["successor"] = turn_node["id"]
                turn_nodes.append(turn_node)

            current_speaker = utterance.speaker_id
            current_turn = [utterance]
        else:
            current_turn.append(utterance)

    if current_turn:
        turn_number += 1
        turn_node = _build_turn_node(current_speaker, current_turn, turn_number)
        if turn_nodes:
            turn_nodes[-1]["successor"] = turn_node["id"]
        turn_nodes.append(turn_node)

    return turn_nodes
