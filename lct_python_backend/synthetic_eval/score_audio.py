"""Tier-2 audio scoring: WER + diarization accuracy against authored ground truth.

Two metrics, both graded against data we authored:
  * WER — word error rate of the WhisperX transcript vs the conversation text.
  * Diarization accuracy — using the TTS timing manifest (turn -> [start,end] +
    speaker) as ground truth, map each pyannote label to the GT speaker it most
    overlaps, then measure per-turn speaker-attribution accuracy. n_pred_labels vs
    n_gt_speakers exposes over/under-segmentation (the brittle content-vote remap's
    failure mode). End-to-end graph degradation (noisy transcript -> Tier-1 scorer)
    is orchestrated in run_audio.py since it needs an LLM provider.
"""

from __future__ import annotations

import re
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from lct_python_backend.synthetic_eval.schema import SyntheticConversation

_WORD = re.compile(r"[a-z0-9']+")


def _norm_words(text: str) -> List[str]:
    return _WORD.findall((text or "").lower())


# ── WER ──────────────────────────────────────────────────────────────────────

def word_error_rate(reference: str, hypothesis: str) -> Dict[str, Any]:
    ref = _norm_words(reference)
    hyp = _norm_words(hypothesis)
    n, m = len(ref), len(hyp)
    if n == 0:
        return {"wer": None, "edits": None, "ref_words": 0, "hyp_words": m}
    # Word-level Levenshtein (substitutions + deletions + insertions).
    prev = list(range(m + 1))
    for i in range(1, n + 1):
        cur = [i] + [0] * m
        ri = ref[i - 1]
        for j in range(1, m + 1):
            cost = 0 if ri == hyp[j - 1] else 1
            cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
        prev = cur
    dist = prev[m]
    return {"wer": dist / n, "edits": dist, "ref_words": n, "hyp_words": m}


# ── Diarization ──────────────────────────────────────────────────────────────

@dataclass
class DiarizationScore:
    turn_accuracy: Optional[float]
    correct: int
    total: int
    n_gt_speakers: int
    n_pred_labels: int
    label_to_speaker: Dict[str, str] = field(default_factory=dict)
    detail: List[Dict[str, Any]] = field(default_factory=list)

    def to_json(self) -> Dict[str, Any]:
        return {
            "turn_accuracy": self.turn_accuracy,
            "correct": self.correct,
            "total": self.total,
            "n_gt_speakers": self.n_gt_speakers,
            "n_pred_labels": self.n_pred_labels,
            "label_to_speaker": self.label_to_speaker,
            "detail": self.detail,
        }


def score_diarization(manifest: Dict[str, Any], stt_segments: List[Dict[str, Any]]) -> DiarizationScore:
    gt_turns: Dict[str, List[float]] = manifest.get("turns", {})
    gt_spk: Dict[str, str] = manifest.get("speakers", {})
    gt_intervals = [(v[0], v[1], gt_spk.get(tid)) for tid, v in gt_turns.items()]

    pred = [
        (s.get("start"), s.get("end"), s.get("speaker"))
        for s in stt_segments
        if s.get("start") is not None and s.get("end") is not None
    ]

    # 1) Map each predicted label -> the GT speaker it overlaps most (in seconds).
    overlap: Dict[str, Dict[str, float]] = defaultdict(lambda: defaultdict(float))
    for ps, pe, plabel in pred:
        if plabel is None:
            continue
        for gs, ge, gspk in gt_intervals:
            ov = max(0.0, min(pe, ge) - max(ps, gs))
            if ov > 0 and gspk is not None:
                overlap[plabel][gspk] += ov
    label_to_speaker = {
        lab: max(spks.items(), key=lambda kv: kv[1])[0]
        for lab, spks in overlap.items() if spks
    }
    n_pred_labels = len({p[2] for p in pred if p[2] is not None})

    # 2) Per-turn accuracy: the predicted label covering each turn (max overlap),
    #    mapped to a GT speaker, compared to the turn's true speaker.
    correct = 0
    total = 0
    detail: List[Dict[str, Any]] = []
    for tid, (gstart, gend) in gt_turns.items():
        gspk = gt_spk.get(tid)
        total += 1
        best_label, best_ov = None, 0.0
        for ps, pe, plabel in pred:
            ov = max(0.0, min(pe, gend) - max(ps, gstart))
            if ov > best_ov:
                best_ov, best_label = ov, plabel
        pred_spk = label_to_speaker.get(best_label) if best_label is not None else None
        ok = pred_spk == gspk
        correct += int(ok)
        detail.append({"turn": tid, "gt": gspk, "pred_label": best_label, "pred_speaker": pred_spk, "ok": ok})

    acc = correct / total if total else None
    return DiarizationScore(
        turn_accuracy=acc, correct=correct, total=total,
        n_gt_speakers=len(set(v for v in gt_spk.values() if v)),
        n_pred_labels=n_pred_labels,
        label_to_speaker=label_to_speaker, detail=detail,
    )


# ── Combined ─────────────────────────────────────────────────────────────────

@dataclass
class AudioScore:
    slug: str
    wer: Dict[str, Any]
    diarization: DiarizationScore
    notes: List[str] = field(default_factory=list)

    def to_json(self) -> Dict[str, Any]:
        return {
            "slug": self.slug,
            "wer": self.wer,
            "diarization": self.diarization.to_json(),
            "notes": self.notes,
        }


def score_audio(
    convo: SyntheticConversation,
    manifest: Dict[str, Any],
    stt_text: str,
    stt_segments: List[Dict[str, Any]],
) -> AudioScore:
    reference = " ".join(t.text for t in convo.turns)
    wer = word_error_rate(reference, stt_text)
    diar = score_diarization(manifest, stt_segments)
    notes = []
    if diar.n_pred_labels != diar.n_gt_speakers:
        notes.append(
            f"speaker-count mismatch: pyannote found {diar.n_pred_labels} vs {diar.n_gt_speakers} "
            f"ground-truth speakers ({'over' if diar.n_pred_labels > diar.n_gt_speakers else 'under'}-segmentation)."
        )
    return AudioScore(slug=convo.slug, wer=wer, diarization=diar, notes=notes)
