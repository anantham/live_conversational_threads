"""Tier 3 (LIVE): stream a conversation's WhisperX transcript into the REAL backend
``/ws/transcripts`` in real-time, let LCT build the graph live, capture the streamed
graph, and score it against ground truth. The production-faithful path.

Flow:
  Tier-2 audio (Kokoro) -> WhisperX segments (timestamps)
    -> connect /ws/transcripts (AUTH_TOKEN from .env, valid-UUID session_id)
    -> stream each segment as `transcript_final`, paced to wall-clock
    -> backend builds graph nodes live (LM Studio :1234) + streams them back as
       `existing_json` / `graph_patch` messages
    -> score the captured graph (Tier-1 dimensions) vs ground truth.

This exercises the real WS transport, persistence, and graph engine. The graph LLM is
whatever the backend is configured for (currently local qwen3.5-9b) — so quality reflects
the local extraction ceiling; compare to the Claude in-process path (realtime.py).

NOTE: this creates a real conversation row in the backend DB (additive test data).
Hierarchy consolidation (topics/themes/arcs) runs post-flush and persists to the DB —
scoring that richer clustering means reading the persisted graph (a follow-up); here we
score the L1/L2 nodes streamed over the WS.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import time
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional

import websockets

from lct_python_backend.synthetic_eval.realtime import get_timed_segments, manifest_segments
from lct_python_backend.synthetic_eval.schema import (
    SyntheticConversation,
    load_all_conversations,
    load_conversation,
)
from lct_python_backend.synthetic_eval.score import score_extraction

WS_URL = os.getenv("SYNTH_EVAL_WS_URL", "ws://127.0.0.1:43181/ws/transcripts")
ENV_PATH = Path(__file__).resolve().parents[1] / ".env"   # lct_python_backend/.env
RESULTS_DIR = Path(__file__).resolve().parent / "results"


def load_token() -> Optional[str]:
    """AUTH_TOKEN from env, else parsed from lct_python_backend/.env (not printed)."""
    t = os.getenv("AUTH_TOKEN")
    if t:
        return t
    try:
        for line in ENV_PATH.open(encoding="utf-8"):
            m = re.match(r"\s*AUTH_TOKEN\s*=\s*(.*)", line)
            if m:
                return m.group(1).strip().strip('"').strip("'")
    except FileNotFoundError:
        pass
    return None


async def stream_live(convo, segments, *, speed: float, drain_grace: float, quiet_period: float = 25.0):
    """Stream finals into the live WS, then DRAIN for the post-flush graph.

    Critical timing (stt_ws_session.py ~2425): the backend sends ``flush_complete``
    BEFORE it runs graph generation — "the client can safely stop waiting for more
    *transcript* events", but the qwen graph-gen + hierarchy consolidation + persist
    all run *after* and emit ``existing_json`` over this same socket. So we wait for
    flush_complete (transcript done), then keep draining until the graph goes quiet
    (no new ``existing_json`` for ``quiet_period`` s) or ``drain_grace`` elapses.
    """
    token = load_token()
    cid, sid = str(uuid.uuid4()), str(uuid.uuid4())   # valid UUIDs (a non-UUID sid crashes the backend)
    nodes_latest: List[Dict[str, Any]] = []
    emissions: List[Dict[str, Any]] = []
    statuses: List[str] = []
    msg_types: Dict[str, int] = {}
    ack = asyncio.Event()
    flush_done = asyncio.Event()
    closed = asyncio.Event()
    last_rx = {"t": 0.0}   # perf_counter of the last existing_json emission
    t0 = time.perf_counter()

    ws = await websockets.connect(WS_URL, max_size=None, open_timeout=10)
    async with ws:
        if token:
            await ws.send(json.dumps({"type": "auth", "token": token}))
        await ws.send(json.dumps({
            "type": "session_meta", "conversation_id": cid, "session_id": sid,
            "provider": "whisper", "store_audio": False,
        }))

        async def receiver():
            nonlocal nodes_latest
            try:
                while True:
                    m = json.loads(await ws.recv())
                    t = m.get("type")
                    msg_types[t] = msg_types.get(t, 0) + 1
                    if t == "session_ack":
                        ack.set()
                    elif t == "existing_json" and isinstance(m.get("data"), list):
                        nodes_latest = m["data"]
                        last_rx["t"] = time.perf_counter()
                        emissions.append({"t_sec": round(time.perf_counter() - t0, 1), "total_nodes": len(nodes_latest)})
                    elif t == "error":
                        statuses.append(f"error: {m.get('detail')}")
                    elif t == "processing_status" and str(m.get("level")) in ("warning", "error"):
                        statuses.append(f"{m.get('level')}: {str(m.get('message'))[:160]}")
                    elif t == "flush_complete":
                        flush_done.set()
            except Exception:
                pass
            finally:
                closed.set()

        rx = asyncio.create_task(receiver())
        try:
            await asyncio.wait_for(ack.wait(), timeout=12)
        except asyncio.TimeoutError:
            statuses.append("no session_ack within 12s")

        prev = None
        for seg in segments:
            start = seg.get("start") or 0.0
            if prev is not None:
                gap = max(0.0, (start - prev) / max(speed, 0.001))
                if gap > 0:
                    await asyncio.sleep(min(gap, 30.0))
            prev = start
            txt = (seg.get("text") or "").strip()
            if not txt:
                continue
            await ws.send(json.dumps({
                "type": "transcript_final", "text": txt,
                "timestamps": {"start": start, "end": seg.get("end") or start},
            }))

        await ws.send(json.dumps({"type": "final_flush"}))
        # flush_complete = transcript delivery done (graph-gen has NOT run yet).
        try:
            await asyncio.wait_for(flush_done.wait(), timeout=60.0)
        except asyncio.TimeoutError:
            statuses.append("flush_complete not received within 60s")
        flush_at = time.perf_counter()
        statuses.append(f"flush_complete at {flush_at - t0:.0f}s; draining up to {drain_grace:.0f}s for post-flush graph")

        # DRAIN: post-flush qwen graph-gen emits existing_json over this same socket.
        deadline = flush_at + drain_grace
        while time.perf_counter() < deadline:
            if closed.is_set():
                statuses.append("server closed the socket during drain")
                break
            await asyncio.sleep(2.0)
            if emissions and (time.perf_counter() - last_rx["t"]) > quiet_period:
                statuses.append(f"graph quiet for {quiet_period:.0f}s after {len(emissions)} emission(s); done")
                break
        else:
            statuses.append(f"drain_grace {drain_grace:.0f}s elapsed (emissions={len(emissions)})")
        rx.cancel()

    statuses.append("msg histogram: " + ", ".join(f"{k}={v}" for k, v in sorted(msg_types.items())))
    return nodes_latest, emissions, statuses, cid


def _pct(v: Optional[float]) -> str:
    return "n/a" if v is None else f"{v * 100:.1f}%"


def run_one(convo: SyntheticConversation, *, source: str, speed: float, drain_grace: float, save: bool, quiet_period: float = 25.0) -> Optional[dict]:
    print("=" * 78)
    print(f"  {convo.slug}  ({len(convo.turns)} turns) | LIVE /ws/transcripts | backend graph LLM | source={source} speed={speed}x")
    print("-" * 78)
    segments, note = manifest_segments(convo) if source == "manifest" else get_timed_segments(convo)
    if not segments:
        print(f"!! no segments ({note})")
        return None
    print(f"  segments: {len(segments)} ({note})")

    t0 = time.perf_counter()
    nodes, emissions, statuses, cid = asyncio.run(stream_live(convo, segments, speed=speed, drain_grace=drain_grace, quiet_period=quiet_period))
    wall = time.perf_counter() - t0

    print(f"  streamed in {wall:.0f}s wall-clock | conversation_id={cid}")
    print(f"  {len(emissions)} incremental graph emission(s):")
    for e in emissions[-8:]:
        print(f"    t={e['t_sec']:>6}s  total_nodes={e['total_nodes']}")
    for s in statuses:
        print(f"     {s}")
    if not nodes:
        print("  !! no graph nodes captured over the WS")
        return None

    rep = score_extraction(convo, nodes, provider="live_ws", backend_label="ws backend-llm")
    cf, tf, sf, af = (rep.flag_metrics.get(k) for k in ("is_crux", "is_tangent", "is_surprise", "is_action_item"))
    print(f"  captured graph: {rep.node_count} nodes | "
          f"crux_F1={_pct(cf.f1 if cf else None)} tangent_F1={_pct(tf.f1 if tf else None)} "
          f"surprise_F1={_pct(sf.f1 if sf else None)} action_F1={_pct(af.f1 if af else None)} "
          f"edges_F1={_pct(rep.edge_overall.f1 if rep.edge_overall else None)} "
          f"claims_F1={_pct(rep.claim_factual.f1 if rep.claim_factual else None)}")
    for n in rep.notes:
        print(f"    - {n}")
    print("=" * 78)
    print()

    result = {"emissions": emissions, "wall_sec": round(wall, 1), "conversation_id": cid,
              "source": source, "report": rep.to_json(), "n_segments": len(segments)}
    if save:
        RESULTS_DIR.mkdir(parents=True, exist_ok=True)
        path = RESULTS_DIR / f"{convo.slug}__live_realtime.json"
        with path.open("w", encoding="utf-8") as fh:
            json.dump(result, fh, indent=2, default=str)
        print(f"   wrote {path}")
    return result


def main(argv: Optional[List[str]] = None) -> int:
    try:
        import sys
        sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
    except Exception:
        pass
    ap = argparse.ArgumentParser(
        prog="synthetic_eval.live_realtime",
        description="Tier 3 (live): stream a conversation into the real /ws/transcripts, graph it live in the backend, and score the captured graph.",
    )
    ap.add_argument("--conversation", "-c")
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--source", choices=["manifest", "stt"], default="manifest",
                    help="manifest=authored text + real render timing (clean transport test); stt=WhisperX output (degraded pipeline)")
    ap.add_argument("--speed", type=float, default=8.0, help="wall-clock pacing factor (1=real-time)")
    ap.add_argument("--drain-grace", type=float, default=240.0, help="seconds to wait for flush_complete after the last segment")
    ap.add_argument("--quiet-period", type=float, default=25.0,
                    help="post-flush: exit drain after this many seconds with no new node emission. "
                         "Must exceed the backend LLM's per-batch latency (e.g. M5 qwen2.5-coder:32b ~25s/call) "
                         "or the driver disconnects mid-graph; use 70+ for slow remote models.")
    ap.add_argument("--no-save", action="store_true")
    args = ap.parse_args(argv)

    if args.all:
        convos = load_all_conversations()
    elif args.conversation:
        convos = [load_conversation(args.conversation)]
    else:
        ap.error("specify --conversation <slug> or --all")
        return 2

    ran = 0
    for convo in convos:
        if run_one(convo, source=args.source, speed=args.speed, drain_grace=args.drain_grace, save=not args.no_save, quiet_period=args.quiet_period) is not None:
            ran += 1
    return 0 if ran else 1


if __name__ == "__main__":
    import sys
    sys.exit(main())
