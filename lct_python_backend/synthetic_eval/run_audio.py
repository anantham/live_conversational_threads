"""CLI (Tier 2): render synthetic conversations to multi-speaker audio, transcribe +
diarize with WhisperX, and score WER + diarization accuracy against the authored
ground truth — plus an optional end-to-end graph-degradation pass.

Examples
--------
  # Clean baseline (render -> WhisperX -> WER + diarization), both seeds:
  python -m lct_python_backend.synthetic_eval.run_audio --all

  # Stress the diarizer: overlap speakers + room noise + no speaker-count hint:
  python -m lct_python_backend.synthetic_eval.run_audio -c ai-safety-pause \
      --overlap-ms 400 --noise-db -30 --no-speaker-hint

  # Add end-to-end graph degradation (feeds the NOISY transcript to a provider,
  # so you can compare dimension F1 vs the clean-text Tier-1 baseline):
  python -m lct_python_backend.synthetic_eval.run_audio -c ai-safety-pause -p claude
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import List, Optional

from lct_python_backend.synthetic_eval.schema import (
    SyntheticConversation,
    load_all_conversations,
    load_conversation,
)
from lct_python_backend.synthetic_eval.score_audio import score_audio
from lct_python_backend.synthetic_eval.stt import transcribe
from lct_python_backend.synthetic_eval.tts import RenderConfig, render_conversation

DEFAULT_OUT = Path(__file__).resolve().parent / "results"


def _pct(v: Optional[float]) -> str:
    return "n/a" if v is None else f"{v * 100:.1f}%"


def _speaker_count(convo: SyntheticConversation) -> int:
    return len(convo.personas or sorted({t.speaker for t in convo.turns}))


def format_diarized_transcript(segments: List[dict]) -> str:
    """Render WhisperX segments as ``[SPEAKER_xx]: text`` (consecutive same-label
    merged) — mirrors what the real LCT pipeline feeds the extractor."""
    lines, cur, buf = [], None, []
    for s in segments:
        lab = s.get("speaker") or "SPEAKER_?"
        txt = (s.get("text") or "").strip()
        if not txt:
            continue
        if lab == cur:
            buf.append(txt)
        else:
            if cur is not None and buf:
                lines.append(f"[{cur}]: {' '.join(buf)}")
            cur, buf = lab, [txt]
    if cur is not None and buf:
        lines.append(f"[{cur}]: {' '.join(buf)}")
    return "\n".join(lines)


def run_one(convo: SyntheticConversation, cfg: RenderConfig, args) -> Optional[dict]:
    n_spk = _speaker_count(convo)
    print("=" * 78)
    print(f"  {convo.slug}  ({n_spk} speakers, {len(convo.turns)} turns)")
    print(f"  render: pause={cfg.pause_ms}ms overlap={cfg.overlap_ms}ms noise_db={cfg.noise_db} "
          f"speed={cfg.speed} | speaker_hint={not args.no_speaker_hint}")
    print("-" * 78)

    # 1) TTS
    r = render_conversation(convo, cfg)
    if not r.ok:
        print(f"!! render FAILED: {r.error}")
        return None
    audio_dur = max((v[1] for v in r.manifest.get("turns", {}).values()), default=0.0)
    print(f"  TTS: {len(convo.turns)} turns -> {audio_dur:.1f}s audio | voices={r.voices} | {r.elapsed_ms/1000:.0f}s")

    # 2) STT + diarize
    hint = None if args.no_speaker_hint else n_spk
    st = transcribe(
        r.wav_path, diarize=not args.no_diarize,
        min_speakers=hint, max_speakers=hint,
        model=args.model, compute_type=args.compute_type,
    )
    if not st.ok:
        print(f"!! STT FAILED: {st.error}")
        return None
    for w in st.warnings:
        print(f"     stt warning: {w}")

    # 3) Score audio
    sc = score_audio(convo, r.manifest, st.text, st.segments)
    d = sc.diarization
    print(f"  WER: {_pct(sc.wer['wer'])}  ({sc.wer['edits']}/{sc.wer['ref_words']} words)")
    print(f"  Diarization: {_pct(d.turn_accuracy)} turn-accuracy ({d.correct}/{d.total}) | "
          f"speakers gt={d.n_gt_speakers} pred={d.n_pred_labels}")
    print(f"    label->speaker: {d.label_to_speaker}")
    for note in sc.notes:
        print(f"    - {note}")
    print(f"  STT: {st.elapsed_ms/1000:.0f}s, {len(st.segments)} segments")

    result = {
        "audio": sc.to_json(),
        "render_elapsed_ms": r.elapsed_ms,
        "stt_elapsed_ms": st.elapsed_ms,
        "voices": r.voices,
        "stt_text": st.text,
    }

    # 4) Optional end-to-end graph degradation
    if args.provider:
        from lct_python_backend.synthetic_eval.extract import extract_graph
        from lct_python_backend.synthetic_eval.providers import build_provider, enable_cloud_egress_for_synthetic
        from lct_python_backend.synthetic_eval.score import score_extraction

        try:
            spec = build_provider(args.provider)
        except ValueError as exc:
            print(f"  e2e graph: {exc}")
            spec = None
        if spec is not None and not spec.ready:
            print(f"  e2e graph: skipped ({args.provider} needs ${spec.missing_key_env})")
        elif spec is not None:
            if spec.requires_cloud:
                enable_cloud_egress_for_synthetic()
            noisy = format_diarized_transcript(st.segments)
            er = extract_graph(convo, spec, transcript_override=noisy)
            if not er.ok:
                print(f"  e2e graph: extraction FAILED ({er.error})")
            else:
                gs = score_extraction(convo, er.nodes, provider=args.provider, backend_label=er.backend_label)
                cf, tf = gs.flag_metrics.get("is_crux"), gs.flag_metrics.get("is_tangent")
                print(f"  e2e graph (STT-degraded transcript, {er.backend_label}): nodes={gs.node_count} "
                      f"crux_F1={_pct(cf.f1 if cf else None)} tangent_F1={_pct(tf.f1 if tf else None)} "
                      f"edges_F1={_pct(gs.edge_overall.f1 if gs.edge_overall else None)} "
                      f"claims_F1={_pct(gs.claim_factual.f1 if gs.claim_factual else None)}")
                print("    (compare to the clean-text Tier-1 run for the same provider to read STT degradation)")
                result["e2e_graph"] = {"report": gs.to_json(), "backend": er.backend_label}

    print("=" * 78)
    print()

    if not args.no_save:
        out = Path(args.out) if args.out else DEFAULT_OUT
        out.mkdir(parents=True, exist_ok=True)
        path = out / f"{convo.slug}__audio.json"
        with path.open("w", encoding="utf-8") as fh:
            json.dump(result, fh, indent=2, default=str)
        print(f"   wrote {path}")
    return result


def main(argv: Optional[List[str]] = None) -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
    except Exception:
        pass

    ap = argparse.ArgumentParser(
        prog="synthetic_eval.run_audio",
        description="Tier 2: TTS -> WhisperX STT+diarization -> WER/diarization scoring (+ optional e2e graph).",
    )
    ap.add_argument("--conversation", "-c", help="conversation slug or path")
    ap.add_argument("--all", action="store_true", help="run every conversation")
    ap.add_argument("--provider", "-p", help="provider for the optional e2e graph-degradation pass")
    ap.add_argument("--pause-ms", type=int, default=300, help="gap between turns")
    ap.add_argument("--overlap-ms", type=int, default=0, help="overlap consecutive turns (diarizer stress)")
    ap.add_argument("--noise-db", type=float, default=None, help="add room noise at this dBFS (e.g. -30)")
    ap.add_argument("--speed", type=float, default=1.0, help="speaking rate")
    ap.add_argument("--no-speaker-hint", action="store_true", help="don't tell WhisperX the speaker count")
    ap.add_argument("--no-diarize", action="store_true", help="transcribe only, skip pyannote")
    ap.add_argument("--model", default=None, help="whisper model (default large-v3)")
    ap.add_argument("--compute-type", default=None, help="int8 (default) | float16")
    ap.add_argument("--out", default=None)
    ap.add_argument("--no-save", action="store_true")
    args = ap.parse_args(argv)

    if args.all:
        convos = load_all_conversations()
    elif args.conversation:
        convos = [load_conversation(args.conversation)]
    else:
        ap.error("specify --conversation <slug> or --all")
        return 2

    cfg = RenderConfig(
        pause_ms=args.pause_ms, overlap_ms=args.overlap_ms,
        noise_db=args.noise_db, speed=args.speed,
    )
    ran = 0
    for convo in convos:
        if run_one(convo, cfg, args) is not None:
            ran += 1
    return 0 if ran else 1


if __name__ == "__main__":
    sys.exit(main())
