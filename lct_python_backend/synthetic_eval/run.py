"""CLI: run LCT graph extraction on synthetic conversations and score it.

Examples
--------
List what's available::

    python -m lct_python_backend.synthetic_eval.run --list

Validate the harness + scorer with zero network / zero credits::

    python -m lct_python_backend.synthetic_eval.run --all --provider mock

Baseline against the local model (free; needs LM Studio reachable)::

    python -m lct_python_backend.synthetic_eval.run --all --provider local

Push it at a frontier provider (synthetic data only — see the banner)::

    OPENROUTER_API_KEY=... python -m lct_python_backend.synthetic_eval.run \
        --conversation ai-safety-pause --provider openrouter

Compare several backends on the same conversation::

    python -m lct_python_backend.synthetic_eval.run --all --providers mock,local,openrouter
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import List, Optional

from lct_python_backend.synthetic_eval.extract import DIMENSION_ELICITATION, ExtractionResult, extract_graph
from lct_python_backend.synthetic_eval.providers import (
    PRESET_NAMES,
    ProviderSpec,
    build_provider,
    enable_cloud_egress_for_synthetic,
)
from lct_python_backend.synthetic_eval.schema import (
    SyntheticConversation,
    load_all_conversations,
    load_conversation,
)
from lct_python_backend.synthetic_eval.score import DimMetric, ScoreReport, score_extraction

DEFAULT_OUT_DIR = Path(__file__).resolve().parent / "results"


# ── Formatting helpers ───────────────────────────────────────────────────────

def _pct(value: Optional[float]) -> str:
    if value is None:
        return "  n/a "
    return f"{value * 100:5.1f}%"


def _fmt_metric_row(m: DimMetric) -> str:
    return (
        f"  {m.label:<26} "
        f"P={_pct(m.precision)} ({m.precision_hit}/{m.precision_total})  "
        f"R={_pct(m.recall)} ({m.recall_hit}/{m.recall_total})  "
        f"F1={_pct(m.f1)}"
    )


def print_report(report: ScoreReport, *, verbose: bool = False) -> None:
    print("=" * 78)
    print(f"  {report.slug}   provider={report.provider}   backend={report.backend_label or '-'}")
    print(f"  nodes extracted: {report.node_count}")
    print("-" * 78)
    print("  NODE FLAGS")
    for flag in ("is_crux", "is_tangent", "is_surprise", "is_action_item"):
        if flag in report.flag_metrics:
            print(_fmt_metric_row(report.flag_metrics[flag]))
    print("  EDGES")
    for etype in ("rebuts", "supports", "clarifies", "asks", "tangent"):
        if etype in report.edge_metrics and report.edge_metrics[etype].recall_total:
            print(_fmt_metric_row(report.edge_metrics[etype]))
    if report.edge_overall:
        print(_fmt_metric_row(report.edge_overall))
    if report.edge_overall_directed:
        print(_fmt_metric_row(report.edge_overall_directed))
    print("  CLAIMS")
    if report.claim_factual:
        print(_fmt_metric_row(report.claim_factual))
    if report.notes:
        print("  NOTES")
        for note in report.notes:
            print(f"    - {note}")
    if verbose:
        print("  DETAIL")
        for flag, m in report.flag_metrics.items():
            if m.missed:
                print(f"    {flag} missed turns: {m.missed}")
            if m.false_positives:
                print(f"    {flag} false-positive nodes: {m.false_positives}")
        if report.edge_overall and report.edge_overall.missed:
            print(f"    edges missed: {report.edge_overall.missed}")
        if report.claim_factual and report.claim_factual.missed:
            print(f"    factual claims missed: {report.claim_factual.missed}")
    print("=" * 78)
    print()


# ── Core run ─────────────────────────────────────────────────────────────────

def run_one(
    convo: SyntheticConversation,
    spec: ProviderSpec,
    *,
    out_dir: Optional[Path],
    verbose: bool,
    elicit: bool = False,
) -> Optional[ScoreReport]:
    result: ExtractionResult = extract_graph(
        convo, spec, extra_system=DIMENSION_ELICITATION if elicit else None,
    )
    if not result.ok:
        print(f"!! {convo.slug} [{spec.name}] extraction FAILED: {result.error}")
        for msg in result.status_messages:
            print(f"     status: {msg}")
        return None

    report = score_extraction(
        convo,
        result.nodes,
        provider=spec.name,
        backend_label=result.backend_label,
    )
    if result.elapsed_ms:
        report.notes.append(f"extraction took {result.elapsed_ms:.0f} ms")
    for msg in result.status_messages:
        report.notes.append(f"status: {msg}")
    print_report(report, verbose=verbose)

    if out_dir is not None:
        out_dir.mkdir(parents=True, exist_ok=True)
        out_path = out_dir / f"{convo.slug}__{spec.name}.json"
        payload = {
            "report": report.to_json(),
            "extracted_nodes": result.nodes,
        }
        with out_path.open("w", encoding="utf-8") as fh:
            json.dump(payload, fh, indent=2, ensure_ascii=False, default=str)
        print(f"   wrote {out_path}")
    return report


def print_summary(reports: List[ScoreReport]) -> None:
    if len(reports) <= 1:
        return
    print("\nSUMMARY (F1 by dimension)")
    print("-" * 78)
    header = f"{'conversation':<26}{'provider':<12}{'crux':>7}{'tang':>7}{'surp':>7}{'edges':>7}{'claim':>7}"
    print(header)
    for r in reports:
        def f1(m: Optional[DimMetric]) -> str:
            return _pct(m.f1).strip() if m else "—"
        crux = r.flag_metrics.get("is_crux")
        tang = r.flag_metrics.get("is_tangent")
        surp = r.flag_metrics.get("is_surprise")
        print(
            f"{r.slug:<26}{r.provider:<12}"
            f"{f1(crux):>7}{f1(tang):>7}{f1(surp):>7}"
            f"{f1(r.edge_overall):>7}{f1(r.claim_factual):>7}"
        )


def main(argv: Optional[List[str]] = None) -> int:
    # Windows consoles default stdout to cp1252, which mojibakes any non-ASCII
    # in conversation data (node names / claims). Force UTF-8 where supported.
    try:
        sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
    except Exception:
        pass

    parser = argparse.ArgumentParser(
        prog="synthetic_eval",
        description="Run LCT graph extraction on synthetic conversations and score it against authored ground truth.",
    )
    parser.add_argument("--conversation", "-c", help="conversation slug or path")
    parser.add_argument("--all", action="store_true", help="run every conversation in conversations/")
    parser.add_argument("--provider", "-p", default="mock", help=f"single provider preset {PRESET_NAMES}")
    parser.add_argument("--providers", help="comma-separated provider presets (overrides --provider)")
    parser.add_argument("--list", action="store_true", help="list conversations + provider presets and exit")
    parser.add_argument("--verbose", "-v", action="store_true", help="print per-item missed / false-positive detail")
    parser.add_argument("--elicit-dimensions", action="store_true", help="append explicit is_crux/is_tangent/edge-typing instructions to the prompt (prompt-ceiling experiment)")
    parser.add_argument("--no-save", action="store_true", help="don't write JSON result files")
    parser.add_argument("--out", help=f"results directory (default: {DEFAULT_OUT_DIR})")
    args = parser.parse_args(argv)

    if args.list:
        print("Conversations:")
        for convo in load_all_conversations():
            gt = convo.ground_truth
            print(
                f"  {convo.slug:<28} {len(convo.turns):>2} turns, "
                f"{len(gt.cruxes)} crux / {len(gt.tangents)} tangent / "
                f"{len(gt.surprises)} surprise / {len(gt.edges)} edges"
            )
        print("\nProvider presets:")
        for name in PRESET_NAMES:
            spec = build_provider(name)
            status = "ready" if spec.ready else f"MISSING ${spec.missing_key_env}"
            cloud = " [cloud]" if spec.requires_cloud else ""
            print(f"  {name:<12} {spec.label}{cloud}  ({status})")
        return 0

    # Resolve conversations.
    if args.all:
        convos = load_all_conversations()
    elif args.conversation:
        convos = [load_conversation(args.conversation)]
    else:
        parser.error("specify --conversation <slug> or --all (or --list)")
        return 2

    # Resolve providers.
    names = (
        [n.strip() for n in args.providers.split(",") if n.strip()]
        if args.providers
        else [args.provider]
    )
    specs: List[ProviderSpec] = []
    for name in names:
        try:
            specs.append(build_provider(name))
        except ValueError as exc:
            print(f"!! {exc}")
            return 2

    # Skip presets whose API key is absent, with a clear message.
    runnable_specs = []
    for spec in specs:
        if not spec.ready:
            print(f"-- skipping provider {spec.name!r}: set ${spec.missing_key_env} to enable ({spec.label})")
            continue
        runnable_specs.append(spec)
    if not runnable_specs:
        print("No runnable providers. (mock and local need no key; cloud presets need an API key.)")
        return 1

    if any(spec.requires_cloud for spec in runnable_specs):
        enable_cloud_egress_for_synthetic()

    out_dir = None if args.no_save else Path(args.out) if args.out else DEFAULT_OUT_DIR

    reports: List[ScoreReport] = []
    for convo in convos:
        for spec in runnable_specs:
            report = run_one(convo, spec, out_dir=out_dir, verbose=args.verbose, elicit=args.elicit_dimensions)
            if report is not None:
                reports.append(report)

    print_summary(reports)
    return 0 if reports else 1


if __name__ == "__main__":
    sys.exit(main())
