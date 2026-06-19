"""CLI for grounded cross-conversation synthesis.

    python -m lct_python_backend.services.synthesis.cli --src <dir> [options]

Reads a directory of transcript ``.txt`` files (optionally with a ``manifest.json``
of ``[{"file","date","title"}]``) and produces a grounded synthesis markdown +
a machine-readable ``.synthesis.json`` (the grounded units, drop set, and citation
verdicts). Default engine is local; passing ``--contact`` fetches each contact's
policy and resolves the engine most-restrictively (and stays local while
LCT_LOCAL_ONLY is on).

This is an ENTRY POINT, so it loads ``.env`` itself (service modules don't).
"""

from __future__ import annotations

import argparse
import glob
import json
import logging
import os
import sys
from pathlib import Path
from typing import List

# Entry point: load env before importing modules that read it.
try:
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).resolve().parents[2] / ".env", override=False)
except Exception:  # noqa: BLE001 — dotenv optional
    pass

from lct_python_backend.services.synthesis.grounded_synthesis import (  # noqa: E402
    Conversation,
    render_report,
    synthesize,
)

logger = logging.getLogger(__name__)


def _load_conversations(src: str, min_chars: int) -> List[Conversation]:
    manifest = {}
    mpath = os.path.join(src, "manifest.json")
    if os.path.exists(mpath):
        try:
            with open(mpath, encoding="utf-8") as fh:
                manifest = {m["file"]: m for m in json.load(fh)}
        except Exception as exc:  # noqa: BLE001
            logger.warning("manifest.json unreadable (%s) — using filenames", exc)

    convos: List[Conversation] = []
    for fpath in sorted(glob.glob(os.path.join(src, "*.txt"))):
        with open(fpath, encoding="utf-8") as fh:
            text = fh.read()
        if len(text.strip()) < min_chars:
            continue
        base = os.path.basename(fpath)
        meta = manifest.get(base, {})
        convos.append(Conversation(
            text=text,
            date=str(meta.get("date") or base[:10]),
            title=str(meta.get("title") or base),
            conversation_id=str(meta.get("conversation_id") or base),
        ))
    return convos


def main(argv: List[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Grounded cross-conversation synthesis")
    parser.add_argument("--src", required=True, help="Directory of transcript .txt files")
    parser.add_argument("--out", default="synthesis", help="Output path prefix (.md + .synthesis.json)")
    parser.add_argument("--participants", default="the two participants",
                        help="How to describe the participants in prompts (e.g. 'Aditya and Vatsal')")
    parser.add_argument("--engine", default="local", choices=["local", "codex", "claude"],
                        help="Engine for all stages (default local; external is consent-gated)")
    parser.add_argument("--contact", action="append", default=[],
                        help="Contact id (repeatable) — fetches policy; external downgrades if any forbids")
    parser.add_argument("--min-chars", type=int, default=500, help="Skip transcripts shorter than this")
    parser.add_argument("--no-verify", action="store_true", help="Skip Stage-3b citation verification")
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(message)s")

    convos = _load_conversations(args.src, args.min_chars)
    if not convos:
        print(f"No usable transcripts in {args.src}", file=sys.stderr)
        return 2
    print(f"{len(convos)} conversations from {args.src}", flush=True)

    result = synthesize(
        convos,
        participants=args.participants,
        engine=args.engine,
        contact_ids=args.contact or None,
        verify=not args.no_verify,
    )

    report = render_report(result, participants=args.participants)
    md_path = f"{args.out}.md"
    json_path = f"{args.out}.synthesis.json"
    with open(md_path, "w", encoding="utf-8") as fh:
        fh.write(report)
    with open(json_path, "w", encoding="utf-8") as fh:
        json.dump(result.to_dict(), fh, ensure_ascii=False, indent=1)

    tally = result.citation_tally
    print(
        f"\nengine={result.engine}  grounded={len(result.grounded_units)}  "
        f"dropped={len(result.dropped_units)} ({result.quote_mismatch_rate:.0f}% quote-mismatch)  "
        f"citations: SUP {tally['SUPPORTED']}/OVER {tally['OVERSTATED']}/UNSUP {tally['UNSUPPORTED']}",
        flush=True,
    )
    print(f"WROTE {md_path} + {json_path}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
