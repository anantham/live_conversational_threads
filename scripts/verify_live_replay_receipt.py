#!/usr/bin/env python3
"""Read local UI exports; emit aggregate replay facts without transcript content.

Test intent: distinguish utterance counts from explicit thread-step counts;
reject future or changed source tokens and non-growing live snapshots.
"""
import argparse
import json
from pathlib import Path


def receipt(maps, transcript):
    tokens = transcript["source_tokens"]
    if transcript["transcription_complete"] is not True or not tokens:
        raise ValueError("Final transcript is incomplete or empty")
    counts = []
    previous = 0
    for graph in maps:
        source = graph["source_tokens"]
        if not previous < len(source) < len(tokens) or source != tokens[:len(source)]:
            raise ValueError("Live source is not a growing strict prefix of final words")
        if graph["transcription_complete"] is not False:
            raise ValueError("Live snapshot must remain explicitly partial")
        threads = graph.get("conversation_threads", [])
        counts.append({"tokens": len(source), "utterances": len(graph["utterances"]),
                       "nodes": len(graph["graph_data"]), "edges": len(graph["edges"]),
                       "threads": len(threads),
                       "thread_steps": [len(thread["steps"]) for thread in threads],
                       "last_audio_ms": source[-1]["end_ms"]})
        previous = len(source)
    if len(counts) < 2:
        raise ValueError("At least two live snapshots are required")
    return {"maps": counts, "final_tokens": len(tokens),
            "final_utterances": len(transcript["utterances"]),
            "prefixes_match_final": True}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--map", action="append", required=True)
    parser.add_argument("--transcript", required=True)
    args = parser.parse_args()
    graphs = [json.loads(Path(path).read_text()) for path in args.map]
    final = json.loads(Path(args.transcript).read_text())
    print(json.dumps(receipt(graphs, final), indent=2))
