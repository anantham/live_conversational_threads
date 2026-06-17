"""Tier-3b: score the macro CLUSTERING (topics/themes/arcs) that LCT's post-flush
hierarchy-consolidation pass produces — Claude-backed.

The streaming engine authors L1 (chunks) + L2 (ideas) only; topics (L3) / themes (L4)
/ arcs (L5) come from ``hierarchy_consolidator``'s three passes, each of which sees its
whole input tier in one LLM call. The live-WS flush runs these after graph-gen; the
in-process Tier-3 driver skipped them, so the macro view stayed empty. This module runs
those exact passes (monkeypatching the consolidation LLM to the Claude subscription, since
the local qwen times out) over a node set — loaded from a saved harness result or streamed
fresh — and reports a structural clustering score: tier cardinality, compression, roll-up
coverage (orphans), the 1-5 arc UX target, and the generated title vs the conversation's.

There is no hand-authored ground-truth *clustering* in the fixtures, so this is a
structural + qualitative assessment (coverage / compression / coherence-by-inspection),
not a precision/recall score. Authoring ground-truth topic groupings would add P/R — a
follow-up. ``--judge`` adds an LLM-rated coherence score per topic.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Dict, List, Optional

from lct_python_backend.synthetic_eval.extract import _parse_json_bigstack, _resolve_claude_bin
from lct_python_backend.synthetic_eval.schema import SyntheticConversation, load_conversation

RESULTS_DIR = Path(__file__).resolve().parent / "results"


# ── Claude as the consolidation LLM (drop-in for chat_with_provider_fallback_sync) ──

def _claude_chat_json(messages, providers=None, temperature=0.3, max_tokens=6000,
                      require_json=True, prompt_name=None, prompt_version=None, **_kw):
    """Claude-backed drop-in for ``chat_with_provider_fallback_sync``.

    ``_run_consolidation_llm`` only reads ``.data`` (the parsed JSON payload) and
    ``.model`` off the result, so we return a SimpleNamespace with just those. Same
    system/user messages, same prompts — only the model changes (local qwen → Claude).
    """
    system = next((m.get("content", "") for m in messages if m.get("role") == "system"), "")
    user = next((m.get("content", "") for m in messages if m.get("role") == "user"), "")
    model = os.getenv("SYNTH_EVAL_CLAUDE_MODEL", "claude-opus-4-8")
    claude_bin = _resolve_claude_bin()
    if not claude_bin:
        raise RuntimeError("claude CLI not found")
    cmd = [
        claude_bin, "-p", "--model", model, "--system-prompt", system,
        "--allowed-tools", "--strict-mcp-config", "--mcp-config", '{"mcpServers": {}}',
        "--output-format", "json",
    ]
    with tempfile.TemporaryDirectory(prefix="synth_consol_") as td:
        proc = subprocess.run(
            cmd, input=user, capture_output=True, text=True, encoding="utf-8",
            cwd=td, timeout=int(os.getenv("SYNTH_EVAL_CLAUDE_TIMEOUT", "420")),
        )
    if proc.returncode != 0:
        raise RuntimeError(f"claude exit {proc.returncode}: {(proc.stderr or '')[:200]}")
    data = json.loads(proc.stdout)
    ro = data[-1] if isinstance(data, list) and data else data
    text = str(ro.get("result", "")) if isinstance(ro, dict) else ""
    # Parse in a large-stack thread: a long consolidation payload tripped Python 3.9's
    # recursive re/json at the default limit on the asyncio worker stack.
    parsed, err = _parse_json_bigstack(text)
    if err is not None:
        raise RuntimeError(f"parse error: {type(err).__name__}: {err}")
    return SimpleNamespace(data=parsed, model=f"claude_cli_{model}")


def _level(nodes: List[Dict[str, Any]], lvl: int) -> List[Dict[str, Any]]:
    return [
        n for n in nodes
        if isinstance(n, dict) and int(n.get("semantic_level") or n.get("level") or 0) == lvl
    ]


def run_consolidation(nodes: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Run the three Claude-backed consolidation passes over ``nodes`` (needs L2 ideas)."""
    import lct_python_backend.services.hierarchy_consolidator as hc
    from lct_python_backend.services.tuning_constants import (
        MIN_IDEAS_FOR_TOPIC_CONSOLIDATION,
        MIN_TOPICS_FOR_THEME_CONSOLIDATION,
        MIN_THEMES_FOR_ARC_CONSOLIDATION,
    )

    hc.chat_with_provider_fallback_sync = _claude_chat_json  # route consolidation to Claude

    async def _run() -> Dict[str, Any]:
        ideas = _level(nodes, 2)
        out: Dict[str, Any] = {"ideas": ideas, "topics": [], "themes": [], "arcs": [],
                               "title": None, "summary": None, "notes": []}
        if len(ideas) < MIN_IDEAS_FOR_TOPIC_CONSOLIDATION:
            out["notes"].append(f"only {len(ideas)} L2 ideas (<{MIN_IDEAS_FOR_TOPIC_CONSOLIDATION}); nothing to cluster")
            return out
        out["topics"] = await hc.consolidate_ideas_to_topics(ideas, providers=None) or []
        if len(out["topics"]) >= MIN_TOPICS_FOR_THEME_CONSOLIDATION:
            out["themes"] = await hc.consolidate_topics_to_themes(out["topics"], providers=None) or []
            if len(out["themes"]) >= MIN_THEMES_FOR_ARC_CONSOLIDATION:
                arcs, title, summary = await hc.consolidate_themes_to_arcs(out["themes"], providers=None)
                out["arcs"], out["title"], out["summary"] = arcs or [], title, summary
            else:
                out["notes"].append(f"{len(out['themes'])} themes (<{MIN_THEMES_FOR_ARC_CONSOLIDATION}); no arcs pass")
        else:
            out["notes"].append(f"{len(out['topics'])} topics (<{MIN_TOPICS_FOR_THEME_CONSOLIDATION}); no themes pass")
        return out

    return asyncio.run(_run())


# ── Structural clustering score ──────────────────────────────────────────────

def _coverage(parents: List[Dict[str, Any]], child_nodes: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Fraction of child nodes referenced by some parent's children_ids."""
    child_ids = {str(c.get("id") or "") for c in child_nodes if isinstance(c, dict)}
    covered: set = set()
    for p in parents:
        for cid in (p.get("children_ids") or []):
            if str(cid) in child_ids:
                covered.add(str(cid))
    orphans = sorted(child_ids - covered)
    pct = (len(covered) / len(child_ids)) if child_ids else None
    return {"covered": len(covered), "total": len(child_ids), "pct": pct, "orphans": orphans}


def _tok(s: str) -> set:
    return {w for w in re.findall(r"[a-z0-9]+", str(s or "").lower()) if len(w) > 2}


def score_clustering(convo: SyntheticConversation, result: Dict[str, Any]) -> Dict[str, Any]:
    ideas, topics, themes, arcs = (result[k] for k in ("ideas", "topics", "themes", "arcs"))
    title = result.get("title")
    idea_cov = _coverage(topics, ideas) if topics else None
    topic_cov = _coverage(themes, topics) if themes else None
    theme_cov = _coverage(arcs, themes) if arcs else None

    title_overlap = None
    if title:
        gt, gen = _tok(convo.title), _tok(title)
        title_overlap = (len(gt & gen) / len(gt)) if gt else None

    return {
        "counts": {"ideas": len(ideas), "topics": len(topics), "themes": len(themes), "arcs": len(arcs)},
        "compression": {
            "ideas_per_topic": round(len(ideas) / len(topics), 2) if topics else None,
            "topics_per_theme": round(len(topics) / len(themes), 2) if themes else None,
            "themes_per_arc": round(len(themes) / len(arcs), 2) if arcs else None,
        },
        "coverage": {"ideas_to_topics": idea_cov, "topics_to_themes": topic_cov, "themes_to_arcs": theme_cov},
        "arc_count_in_ux_target": (1 <= len(arcs) <= 5) if arcs else None,
        "generated_title": title,
        "title_overlap_with_ground_truth": title_overlap,
        "notes": result.get("notes", []),
    }


def _pct(v: Optional[float]) -> str:
    return "n/a" if v is None else f"{v * 100:.0f}%"


def _print_report(convo: SyntheticConversation, result: Dict[str, Any], score: Dict[str, Any]) -> None:
    c = score["counts"]
    print("=" * 78)
    print(f"  {convo.slug}  | CLUSTERING (Claude-backed hierarchy consolidation)")
    print("-" * 78)
    print(f"  tiers:  ideas={c['ideas']} -> topics={c['topics']} -> themes={c['themes']} -> arcs={c['arcs']}")
    comp = score["compression"]
    print(f"  compression:  {comp['ideas_per_topic']} ideas/topic | {comp['topics_per_theme']} topics/theme | {comp['themes_per_arc']} themes/arc")
    cov = score["coverage"]
    for label, key in (("ideas->topics", "ideas_to_topics"), ("topics->themes", "topics_to_themes"), ("themes->arcs", "themes_to_arcs")):
        cc = cov.get(key)
        if cc:
            orph = f" | orphans={len(cc['orphans'])}" if cc["orphans"] else ""
            print(f"  rollup {label:<14}: {_pct(cc['pct'])} ({cc['covered']}/{cc['total']}){orph}")
    print(f"  arcs in 1-5 UX target: {score['arc_count_in_ux_target']}")
    print(f"  generated title: {score['generated_title']!r}")
    print(f"    vs ground-truth title {convo.title!r} | token-overlap={_pct(score['title_overlap_with_ground_truth'])}")
    if result.get("summary"):
        print(f"  executive summary: {str(result['summary'])[:200]}")
    for n in score["notes"]:
        print(f"    - {n}")

    # Hierarchy tree (names) for qualitative inspection.
    print("-" * 78)
    print("  hierarchy (names):")
    idea_by = {str(i.get("id")): i for i in result["ideas"]}
    topic_by = {str(t.get("id")): t for t in result["topics"]}
    theme_by = {str(h.get("id")): h for h in result["themes"]}
    if result["arcs"]:
        for arc in result["arcs"]:
            print(f"  ARC: {arc.get('node_name')}")
            for hid in (arc.get("children_ids") or []):
                h = theme_by.get(str(hid))
                if not h:
                    continue
                print(f"    THEME: {h.get('node_name')}")
                for tid in (h.get("children_ids") or []):
                    t = topic_by.get(str(tid))
                    if t:
                        print(f"      topic: {t.get('node_name')}  ({len(t.get('children_ids') or [])} ideas)")
    else:
        for t in result["topics"]:
            kids = [idea_by.get(str(c), {}).get("node_name") for c in (t.get("children_ids") or [])]
            print(f"  topic: {t.get('node_name')}  <- {[k for k in kids if k]}")
    print("=" * 78)


# ── Node loading + CLI ───────────────────────────────────────────────────────

def consolidate_and_report(convo: SyntheticConversation, nodes: List[Dict[str, Any]]):
    """Run the Claude-backed consolidation, print the report, return (score, result).

    Public entry point reused by realtime.py's ``--consolidate`` so the real-time
    streaming run can roll straight into the macro-clustering score.
    """
    result = run_consolidation(nodes)
    score = score_clustering(convo, result)
    _print_report(convo, result, score)
    return score, result


def _load_nodes(path: Path) -> List[Dict[str, Any]]:
    with path.open(encoding="utf-8") as fh:
        data = json.load(fh)
    if isinstance(data, list):
        return data
    return data.get("extracted_nodes") or data.get("nodes") or []


def main(argv: Optional[List[str]] = None) -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
    except Exception:
        pass
    ap = argparse.ArgumentParser(
        prog="synthetic_eval.consolidate",
        description="Run + score LCT's macro clustering (topics/themes/arcs) Claude-backed on a node set.",
    )
    ap.add_argument("--conversation", "-c", required=True, help="conversation slug (for title + ground truth)")
    ap.add_argument("--from-result", help="path to a harness result JSON with extracted_nodes/nodes "
                                          "(default: results/<slug>__claude.json)")
    ap.add_argument("--no-save", action="store_true")
    args = ap.parse_args(argv)

    convo = load_conversation(args.conversation)
    result_path = Path(args.from_result) if args.from_result else (RESULTS_DIR / f"{convo.slug}__claude.json")
    if not result_path.exists():
        ap.error(f"node source not found: {result_path} (run Tier-1 first, or pass --from-result)")
        return 2
    nodes = _load_nodes(result_path)
    print(f"  loaded {len(nodes)} nodes from {result_path.name} "
          f"(L2 ideas: {len(_level(nodes, 2))})")

    score, result = consolidate_and_report(convo, nodes)

    if not args.no_save:
        RESULTS_DIR.mkdir(parents=True, exist_ok=True)
        out_path = RESULTS_DIR / f"{convo.slug}__clustering.json"
        with out_path.open("w", encoding="utf-8") as fh:
            json.dump({"score": score, "result": result}, fh, indent=2, default=str)
        print(f"   wrote {out_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
