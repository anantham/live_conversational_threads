"""Ground-truth schema for synthetic conversations.

A synthetic conversation is a small, fully-authored dialogue whose rhetorical
moves are LABELLED. The labels are the answer key the scorer grades the
extractor against.

On-disk shape (one JSON file per conversation, in ``conversations/``)::

    {
      "slug": "ai-safety-debate",
      "title": "Should we pause frontier AI training?",
      "personas": ["Mara", "Dev"],
      "provenance": {"author": "hand", "license": "synthetic-fixture", ...},
      "turns": [
        {"id": "t0", "speaker": "Mara", "text": "..."},
        ...
      ],
      "ground_truth": {
        "cruxes":       ["t3", "t9"],
        "tangents":     ["t5"],
        "surprises":    ["t11"],
        "action_items": ["t14"],
        "claims": [
          {"turn": "t1", "text": "GPT-4 shipped March 2023", "type": "factual"}
        ],
        "edges": [
          {"type": "rebuts",   "from": "t4", "to": "t2", "note": "..."},
          {"type": "supports", "from": "t6", "to": "t1"}
        ]
      }
    }

Turn ids are the stable anchors: every flag / claim / edge references turn ids,
never free text, so alignment is unambiguous on the authoring side. (The fuzzy
part lives only on the *extraction* side, where the scorer maps extracted nodes
back onto turns — see ``score.py``.)
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List

CONVERSATIONS_DIR = Path(__file__).resolve().parent / "conversations"

# Edge relation types we score. Mirrors the subset of
# ``transcript_normalizer._RELATION_TYPES`` that the generation prompt actually
# asks the model to author (supports / rebuts / clarifies / asks / tangent).
SCORED_EDGE_TYPES = ("supports", "rebuts", "clarifies", "asks", "tangent")

# Node-flag dimensions we score. These map 1:1 onto normalized node booleans.
SCORED_FLAGS = ("is_crux", "is_tangent", "is_surprise", "is_action_item")

CLAIM_TYPES = ("factual", "normative", "worldview")


@dataclass
class Turn:
    id: str
    speaker: str
    text: str

    @staticmethod
    def from_json(raw: Dict[str, Any]) -> "Turn":
        return Turn(id=str(raw["id"]), speaker=str(raw["speaker"]), text=str(raw["text"]))

    def to_json(self) -> Dict[str, Any]:
        return {"id": self.id, "speaker": self.speaker, "text": self.text}


@dataclass
class Claim:
    turn: str
    text: str
    type: str = "factual"  # factual | normative | worldview

    @staticmethod
    def from_json(raw: Dict[str, Any]) -> "Claim":
        return Claim(
            turn=str(raw["turn"]),
            text=str(raw["text"]),
            type=str(raw.get("type", "factual")),
        )

    def to_json(self) -> Dict[str, Any]:
        return {"turn": self.turn, "text": self.text, "type": self.type}


@dataclass
class Edge:
    type: str  # supports | rebuts | clarifies | asks | tangent
    from_turn: str
    to_turn: str
    note: str = ""

    @staticmethod
    def from_json(raw: Dict[str, Any]) -> "Edge":
        # Accept both "from"/"to" (on-disk, terse) and from_turn/to_turn.
        return Edge(
            type=str(raw["type"]),
            from_turn=str(raw.get("from", raw.get("from_turn"))),
            to_turn=str(raw.get("to", raw.get("to_turn"))),
            note=str(raw.get("note", "")),
        )

    def to_json(self) -> Dict[str, Any]:
        out = {"type": self.type, "from": self.from_turn, "to": self.to_turn}
        if self.note:
            out["note"] = self.note
        return out


@dataclass
class GroundTruth:
    cruxes: List[str] = field(default_factory=list)
    tangents: List[str] = field(default_factory=list)
    surprises: List[str] = field(default_factory=list)
    action_items: List[str] = field(default_factory=list)
    claims: List[Claim] = field(default_factory=list)
    edges: List[Edge] = field(default_factory=list)

    # Map our flag-name -> the ground-truth turn-id list for that flag.
    def turns_for_flag(self, flag: str) -> List[str]:
        return {
            "is_crux": self.cruxes,
            "is_tangent": self.tangents,
            "is_surprise": self.surprises,
            "is_action_item": self.action_items,
        }[flag]

    @staticmethod
    def from_json(raw: Dict[str, Any]) -> "GroundTruth":
        return GroundTruth(
            cruxes=[str(x) for x in raw.get("cruxes", [])],
            tangents=[str(x) for x in raw.get("tangents", [])],
            surprises=[str(x) for x in raw.get("surprises", [])],
            action_items=[str(x) for x in raw.get("action_items", [])],
            claims=[Claim.from_json(c) for c in raw.get("claims", [])],
            edges=[Edge.from_json(e) for e in raw.get("edges", [])],
        )

    def to_json(self) -> Dict[str, Any]:
        return {
            "cruxes": self.cruxes,
            "tangents": self.tangents,
            "surprises": self.surprises,
            "action_items": self.action_items,
            "claims": [c.to_json() for c in self.claims],
            "edges": [e.to_json() for e in self.edges],
        }


@dataclass
class SyntheticConversation:
    slug: str
    title: str
    personas: List[str]
    turns: List[Turn]
    ground_truth: GroundTruth
    provenance: Dict[str, Any] = field(default_factory=dict)

    # ── Lookups ────────────────────────────────────────────────────────────
    def turn_by_id(self, turn_id: str) -> Turn:
        for turn in self.turns:
            if turn.id == turn_id:
                return turn
        raise KeyError(f"{self.slug}: no turn with id {turn_id!r}")

    def text_for_turn(self, turn_id: str) -> str:
        return self.turn_by_id(turn_id).text

    # ── Rendering ──────────────────────────────────────────────────────────
    def render_transcript(self, *, bracketed_speakers: bool = True) -> str:
        """Render the dialogue as a flat transcript.

        ``bracketed_speakers=True`` produces ``[Name]: text`` lines, which is the
        format the GENERATE_LCT prompt recognizes for speaker attribution
        (see LOCAL_GENERATE_LCT_PROMPT: "If the transcript includes speaker
        labels like [SPEAKER_00]:, assign the corresponding speaker_id").
        """
        lines = []
        for turn in self.turns:
            speaker = f"[{turn.speaker}]" if bracketed_speakers else turn.speaker
            lines.append(f"{speaker}: {turn.text}")
        return "\n".join(lines)

    # ── Serialization ──────────────────────────────────────────────────────
    @staticmethod
    def from_json(raw: Dict[str, Any]) -> "SyntheticConversation":
        convo = SyntheticConversation(
            slug=str(raw["slug"]),
            title=str(raw.get("title", raw["slug"])),
            personas=[str(p) for p in raw.get("personas", [])],
            turns=[Turn.from_json(t) for t in raw.get("turns", [])],
            ground_truth=GroundTruth.from_json(raw.get("ground_truth", {})),
            provenance=dict(raw.get("provenance", {})),
        )
        convo.validate()
        return convo

    def to_json(self) -> Dict[str, Any]:
        return {
            "slug": self.slug,
            "title": self.title,
            "personas": self.personas,
            "provenance": self.provenance,
            "turns": [t.to_json() for t in self.turns],
            "ground_truth": self.ground_truth.to_json(),
        }

    # ── Validation ─────────────────────────────────────────────────────────
    def validate(self) -> None:
        """Fail loudly if the answer key references turns that don't exist."""
        ids = [t.id for t in self.turns]
        if len(ids) != len(set(ids)):
            dupes = sorted({i for i in ids if ids.count(i) > 1})
            raise ValueError(f"{self.slug}: duplicate turn ids {dupes}")
        idset = set(ids)

        def _check(label: str, refs: List[str]) -> None:
            missing = [r for r in refs if r not in idset]
            if missing:
                raise ValueError(f"{self.slug}: {label} references unknown turn ids {missing}")

        gt = self.ground_truth
        _check("cruxes", gt.cruxes)
        _check("tangents", gt.tangents)
        _check("surprises", gt.surprises)
        _check("action_items", gt.action_items)
        _check("claim.turn", [c.turn for c in gt.claims])
        _check("edge.from", [e.from_turn for e in gt.edges])
        _check("edge.to", [e.to_turn for e in gt.edges])

        for edge in gt.edges:
            if edge.type not in SCORED_EDGE_TYPES:
                raise ValueError(
                    f"{self.slug}: edge type {edge.type!r} not in scored types {SCORED_EDGE_TYPES}"
                )
        for claim in gt.claims:
            if claim.type not in CLAIM_TYPES:
                raise ValueError(
                    f"{self.slug}: claim type {claim.type!r} not in {CLAIM_TYPES}"
                )


# ── Loaders ─────────────────────────────────────────────────────────────────

def load_conversation(slug_or_path: str) -> SyntheticConversation:
    """Load a single conversation by slug (looked up in ``conversations/``) or path."""
    path = Path(slug_or_path)
    if not path.exists():
        candidate = CONVERSATIONS_DIR / f"{slug_or_path}.json"
        if not candidate.exists():
            raise FileNotFoundError(
                f"No conversation {slug_or_path!r}; looked at {path} and {candidate}"
            )
        path = candidate
    with path.open("r", encoding="utf-8") as fh:
        return SyntheticConversation.from_json(json.load(fh))


def load_all_conversations() -> List[SyntheticConversation]:
    """Load every ``*.json`` in ``conversations/``, sorted by slug."""
    convos = []
    for path in sorted(CONVERSATIONS_DIR.glob("*.json")):
        with path.open("r", encoding="utf-8") as fh:
            convos.append(SyntheticConversation.from_json(json.load(fh)))
    return convos
