"""Compile and author .threads through the existing shared local extractor.

Run from repo root: python -m scripts.author_thread_experiment --help.
Provider configuration must be an explicit JSON list of owner_private local
provider records. No database settings, remote defaults or retrieval are used.
"""

import argparse
import asyncio
import json
from pathlib import Path
import sys
import time

from lct_python_backend.services.threads_semantic_authoring import write_authored_experiment


async def run_with_status(operation):
    """Keep an unmeasured provider wait visible without inventing an estimate."""
    started = time.monotonic()
    print("Preparing graph and extracting relationships; time remaining unknown", file=sys.stderr, flush=True)
    task = asyncio.create_task(operation)
    outcome = "failed"
    try:
        while not task.done():
            done, _ = await asyncio.wait({task}, timeout=5)
            if not done:
                print(f"Extracting relationships; elapsed {int(time.monotonic() - started)}s; time remaining unknown",
                      file=sys.stderr, flush=True)
        result = await task
        outcome = "completed"
        return result
    except asyncio.CancelledError:
        outcome = "cancelled"
        raise
    finally:
        if not task.done():
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
        print(f"Relationship extraction {outcome}; elapsed {int(time.monotonic() - started)}s",
              file=sys.stderr, flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", type=Path, required=True)
    parser.add_argument("--interpretation", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--providers", type=Path, required=True)
    args = parser.parse_args()
    providers = json.loads(args.providers.read_text(encoding="utf-8"))
    if not isinstance(providers, list) or not all(isinstance(item, dict) for item in providers):
        parser.error("--providers must contain a JSON list of provider records")
    try:
        result = asyncio.run(run_with_status(write_authored_experiment(
            json.loads(args.base.read_text(encoding="utf-8")),
            interpretation=json.loads(args.interpretation.read_text(encoding="utf-8")) if args.interpretation else None,
            output_path=args.output, providers=providers,
        )))
    except ValueError as exc:
        parser.exit(1, f"{exc}\n")
    print(json.dumps({"status": result["argument_topology"]["status"],
                      "semantic_edge_count": result["argument_topology"]["semantic_edge_count"]}))


if __name__ == "__main__":
    main()
