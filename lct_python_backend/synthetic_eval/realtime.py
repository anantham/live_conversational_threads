"""Tier 3 — real-time streaming e2e: stream a conversation's audio transcript into
LCT's REAL streaming graph engine (production ``TranscriptProcessor``), paced to
wall-clock, and watch it build the graph incrementally.

Pipeline:
  Tier-2 audio (Kokoro) -> WhisperX segments (with timestamps)
    -> stream segment-by-segment, paced to wall-clock, into a real TranscriptProcessor
    -> graph nodes emit incrementally (the same accumulate->batch->generate engine the
       live /ws/transcripts path uses)
    -> score the final graph (Tier-1 dimensions) + report the emission timeline.

Why in-process instead of the live WS path: the WS path needs the backend AUTH_TOKEN
and a healthy graph-gen LLM (M5 asleep / LM Studio too slow / no Gemini key), and writes
to the real DB. Driving the production TranscriptProcessor directly lets us (a) use the
proven Claude subscription as the graph LLM, (b) avoid auth/DB, (c) still exercise the
real streaming engine. The accumulate (thread-boundary) step is stubbed to "complete
each batch" — the same pattern the integration tests use — so batching is predictable.

LATENCY NOTE: Claude is accurate but ~2 min/call, so this demonstrates the streaming
mechanics + graph quality, not sub-second real-time. With a fast LLM (M5 gemma4 awake,
or a cloud key) the SAME driver is truly real-time — that's the only knob that changes.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from lct_python_backend.synthetic_eval.extract import DIMENSION_ELICITATION, _resolve_claude_bin
from lct_python_backend.synthetic_eval.schema import (
    SyntheticConversation,
    load_all_conversations,
    load_conversation,
)
from lct_python_backend.synthetic_eval.score import score_extraction

AUDIO_DIR = Path(__file__).resolve().parent / "audio"
RESULTS_DIR = Path(__file__).resolve().parent / "results"

# Set by the CLI; appended to the system prompt when --elicit-dimensions is passed.
_ELICIT = ""


# ── Claude as the graph LLM (signature-compatible with generate_lct_json) ────

def _parse_claude_stdout(stdout: str):
    """Parse the ``claude -p`` JSON wrapper -> normalized LCT nodes.

    The wrapper decode is shallow/safe; the deep-nesting risk lives in the model's
    ``result`` string, which ``_parse_nodes_bigstack`` parses in a large-stack thread
    (the streaming engine calls generate via ``asyncio.to_thread`` — a ~1MB Windows
    worker stack — where a deep recurse segfaulted with 0xC0000005). Returns
    ``(nodes_or_None, error_or_None)``.
    """
    from lct_python_backend.synthetic_eval.extract import _parse_nodes_bigstack

    try:
        data = json.loads(stdout)
    except Exception as exc:  # noqa: BLE001
        return None, exc
    ro = data[-1] if isinstance(data, list) and data else data
    text = str(ro.get("result", "")) if isinstance(ro, dict) else ""
    return _parse_nodes_bigstack(text)


def claude_generate_lct_json(transcript, llm_config=None, providers=None, status_messages=None):
    """Drop-in for ``generate_lct_json`` that uses the Claude subscription (`claude -p`).

    Returns ``(nodes, backend_label)`` like the production function, reusing LCT's
    GENERATE prompt + ``_normalize_generated_output`` so output shape is identical.
    The JSON parse is delegated to ``_parse_claude_stdout`` (large-stack thread).
    """
    from lct_python_backend.services.transcript.transcript_prompts import (
        PROMPT_ID_GENERATE_CONVERSATION_HIERARCHY,
        get_transcript_prompt_text,
    )

    claude_bin = _resolve_claude_bin()
    if not claude_bin:
        if status_messages is not None:
            status_messages.append("claude CLI not found")
        return [], None

    system_prompt = get_transcript_prompt_text(PROMPT_ID_GENERATE_CONVERSATION_HIERARCHY)
    if _ELICIT:
        system_prompt = system_prompt + "\n\n" + _ELICIT
    model = os.getenv("SYNTH_EVAL_CLAUDE_MODEL", "claude-opus-4-8")
    cmd = [
        claude_bin, "-p", "--model", model,
        "--system-prompt", system_prompt,
        "--allowed-tools", "--strict-mcp-config", "--mcp-config", '{"mcpServers": {}}',
        "--output-format", "json",
    ]
    try:
        with tempfile.TemporaryDirectory(prefix="synth_rt_") as td:
            proc = subprocess.run(
                cmd, input=transcript, capture_output=True, text=True, encoding="utf-8",
                cwd=td, timeout=int(os.getenv("SYNTH_EVAL_CLAUDE_TIMEOUT", "420")),
            )
    except Exception as exc:  # noqa: BLE001
        if status_messages is not None:
            status_messages.append(f"claude error: {exc}")
        return [], None
    if proc.returncode != 0:
        if status_messages is not None:
            status_messages.append(f"claude exit {proc.returncode}: {(proc.stderr or '')[:200]}")
        return [], None
    # Parse in a large-stack thread (see _parse_claude_stdout): the streaming engine
    # calls this from a small-stack asyncio worker, where a deep JSON recurse + raised
    # recursion limit segfaulted (0xC0000005) instead of raising.
    nodes, err = _parse_claude_stdout(proc.stdout)
    if err is not None or nodes is None:
        if status_messages is not None:
            status_messages.append(f"claude parse error: {err}")
        return [], None
    return nodes, f"claude_cli_{model}"


# ── Accumulate stubs (complete each batch — the integration-test pattern) ─────

def _accumulate_complete_all(input_text, llm_config=None, providers=None, **_kw):
    return (
        {"decision": "stop_accumulating", "Completed_segment": input_text,
         "Incomplete_segment": "", "detected_threads": []},
        "stub",
    )


def _accumulate_idx_complete_all(numbered_input, providers=None, **_kw):
    return (
        {"decision": "stop_accumulating", "completed_through_index": 10 ** 9, "detected_threads": []},
        "stub",
    )


# ── Timed segments (Tier-2 audio -> WhisperX, cached) ────────────────────────

def get_timed_segments(convo: SyntheticConversation) -> Tuple[List[Dict[str, Any]], str]:
    """Return (segments, note). Reuses a cached STT json / wav if present, else
    renders (Kokoro) + transcribes (WhisperX) via Tier 2."""
    AUDIO_DIR.mkdir(parents=True, exist_ok=True)
    cache = AUDIO_DIR / f"{convo.slug}.stt.json"
    if cache.exists():
        with cache.open(encoding="utf-8") as fh:
            data = json.load(fh)
        return data.get("segments", []), "cached STT"

    from lct_python_backend.synthetic_eval.stt import transcribe
    from lct_python_backend.synthetic_eval.tts import RenderConfig, render_conversation

    wav = AUDIO_DIR / f"{convo.slug}.wav"
    if not wav.exists():
        r = render_conversation(convo, RenderConfig())
        if not r.ok:
            return [], f"render failed: {r.error}"
    n_spk = len(convo.personas or sorted({t.speaker for t in convo.turns}))
    st = transcribe(str(wav), diarize=True, min_speakers=n_spk, max_speakers=n_spk)
    if not st.ok:
        return [], f"stt failed: {st.error}"
    with cache.open("w", encoding="utf-8") as fh:
        json.dump({"segments": st.segments, "text": st.text}, fh)
    return st.segments, "rendered+transcribed"


def manifest_segments(convo: SyntheticConversation) -> Tuple[List[Dict[str, Any]], str]:
    """Build perfectly-timed segments from the Kokoro render manifest + authored turns.

    Transcript = the ground-truth turn text (what a *perfect* STT would emit); timing
    and speakers come from the REAL rendered audio (``<slug>.manifest.json``). This
    isolates the streaming + graph engine from STT quality — the right input when the
    WhisperX cache is unusable or when measuring the extraction ceiling directly. Use
    ``get_timed_segments`` for the realistic degraded-transcript (WhisperX) pipeline.
    """
    mf = AUDIO_DIR / f"{convo.slug}.manifest.json"
    if not mf.exists():
        return [], f"no manifest ({mf.name}); render Tier-2 audio first"
    with mf.open(encoding="utf-8") as fh:
        data = json.load(fh)
    turns = data.get("turns", {})
    speakers = data.get("speakers", {})
    segs: List[Dict[str, Any]] = []
    for t in convo.turns:
        ts = turns.get(t.id)
        if not ts:
            continue
        segs.append({
            "start": float(ts[0]), "end": float(ts[1]),
            "text": t.text, "speaker": speakers.get(t.id) or t.speaker,
        })
    segs.sort(key=lambda s: s["start"])
    return segs, "manifest (authored text + real render timing)"


# ── Stream into the real TranscriptProcessor ─────────────────────────────────

async def stream_into_processor(
    segments: List[Dict[str, Any]], *, batch_size: int, speed: float,
) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]], List[str]]:
    import lct_python_backend.services.transcript.transcript_processing as tp
    from lct_python_backend.services.transcript.transcript_processing import TranscriptProcessor

    # Inject Claude as the generate step; stub the accumulate (boundary) step.
    tp.generate_lct_json = claude_generate_lct_json
    tp.accumulate_text_json = _accumulate_complete_all
    tp.accumulate_text_json_local_indexed = _accumulate_idx_complete_all

    emissions: List[Dict[str, Any]] = []
    status: List[str] = []
    t0 = time.perf_counter()

    async def on_update(existing_json, chunk_dict, patch=None):
        emissions.append({
            "t_sec": round(time.perf_counter() - t0, 1),
            "total_nodes": len(existing_json),
            "node_delta": (patch or {}).get("node_delta") if patch else None,
        })

    async def on_status(level, message, ctx=None):
        if level in ("warning", "error"):
            status.append(f"{level}: {message}")

    proc = TranscriptProcessor(
        send_update=on_update, send_status=on_status,
        batch_size=batch_size, llm_config={"mode": "local"}, providers=None,
    )

    prev_start = None
    for seg in segments:
        start = seg.get("start") or 0.0
        if prev_start is not None:
            gap = max(0.0, (start - prev_start) / max(speed, 0.001))
            if gap > 0:
                await asyncio.sleep(min(gap, 30.0))
        prev_start = start
        txt = (seg.get("text") or "").strip()
        if not txt:
            continue
        await proc.handle_final_text(txt, speaker_segments=[{"speaker": seg.get("speaker") or "", "text": txt}])

    await proc.flush()
    return proc.existing_json, emissions, status


# ── Orchestration + CLI ──────────────────────────────────────────────────────

def _pct(v: Optional[float]) -> str:
    return "n/a" if v is None else f"{v * 100:.1f}%"


def run_one(convo: SyntheticConversation, *, batch_size: int, speed: float, save: bool, source: str = "manifest", consolidate: bool = False) -> Optional[dict]:
    print("=" * 78)
    print(f"  {convo.slug}  ({len(convo.turns)} turns)  | batch_size={batch_size} speed={speed}x source={source} | LLM=claude (subscription)")
    print("-" * 78)
    segments, note = manifest_segments(convo) if source == "manifest" else get_timed_segments(convo)
    if not segments:
        print(f"!! no segments ({note})")
        return None
    print(f"  segments: {len(segments)} ({note})")

    t0 = time.perf_counter()
    nodes, emissions, status = asyncio.run(stream_into_processor(segments, batch_size=batch_size, speed=speed))
    wall = time.perf_counter() - t0

    print(f"  streamed in {wall:.0f}s wall-clock | {len(emissions)} incremental graph emission(s):")
    for e in emissions:
        print(f"    t={e['t_sec']:>6}s  total_nodes={e['total_nodes']}  (+{e['node_delta']})")
    if not nodes:
        print("  !! no nodes produced")
        for s in status:
            print(f"     {s}")
        return None

    rep = score_extraction(convo, nodes, provider="claude", backend_label="claude_cli (realtime)")
    cf, tf, sf, af = (rep.flag_metrics.get(k) for k in ("is_crux", "is_tangent", "is_surprise", "is_action_item"))
    print(f"  final graph: {rep.node_count} nodes | "
          f"crux_F1={_pct(cf.f1 if cf else None)} tangent_F1={_pct(tf.f1 if tf else None)} "
          f"surprise_F1={_pct(sf.f1 if sf else None)} action_F1={_pct(af.f1 if af else None)} "
          f"edges_F1={_pct(rep.edge_overall.f1 if rep.edge_overall else None)} "
          f"claims_F1={_pct(rep.claim_factual.f1 if rep.claim_factual else None)}")
    for s in status:
        print(f"     {s}")
    print("=" * 78)
    print()

    result = {"emissions": emissions, "wall_sec": round(wall, 1), "report": rep.to_json(),
              "n_segments": len(segments), "extracted_nodes": nodes}

    # Optional: roll the streamed L1/L2 graph straight into the macro-clustering
    # passes (topics/themes/arcs) the live-WS flush runs post-graph, and score it.
    if consolidate:
        from lct_python_backend.synthetic_eval.consolidate import consolidate_and_report
        cscore, _cresult = consolidate_and_report(convo, nodes)
        result["clustering"] = cscore

    if save:
        RESULTS_DIR.mkdir(parents=True, exist_ok=True)
        path = RESULTS_DIR / f"{convo.slug}__realtime.json"
        with path.open("w", encoding="utf-8") as fh:
            json.dump(result, fh, indent=2, default=str)
        print(f"   wrote {path}")
    return result


def main(argv: Optional[List[str]] = None) -> int:
    global _ELICIT
    try:
        sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
    except Exception:
        pass
    ap = argparse.ArgumentParser(
        prog="synthetic_eval.realtime",
        description="Tier 3: stream a conversation's transcript into the real TranscriptProcessor, paced to wall-clock, build the graph incrementally via Claude, and score it.",
    )
    ap.add_argument("--conversation", "-c", help="conversation slug")
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--batch-size", type=int, default=12, help="finals per graph batch (fewer = fewer Claude calls)")
    ap.add_argument("--speed", type=float, default=6.0, help="wall-clock pacing factor (1=real-time, higher=compressed)")
    ap.add_argument("--source", choices=["manifest", "stt"], default="manifest",
                    help="manifest=authored text + real render timing (clean); stt=WhisperX output (degraded pipeline)")
    ap.add_argument("--elicit-dimensions", action="store_true", help="append dimension/edge elicitation to the prompt")
    ap.add_argument("--consolidate", action="store_true", help="after streaming, run the macro-clustering passes (topics/themes/arcs) and score them")
    ap.add_argument("--no-save", action="store_true")
    args = ap.parse_args(argv)
    if args.elicit_dimensions:
        _ELICIT = DIMENSION_ELICITATION

    if args.all:
        convos = load_all_conversations()
    elif args.conversation:
        convos = [load_conversation(args.conversation)]
    else:
        ap.error("specify --conversation <slug> or --all")
        return 2

    ran = 0
    for convo in convos:
        if run_one(convo, batch_size=args.batch_size, speed=args.speed, save=not args.no_save,
                   source=args.source, consolidate=args.consolidate) is not None:
            ran += 1
    return 0 if ran else 1


if __name__ == "__main__":
    sys.exit(main())
