"""Single synthetic context-consumption probe against the existing local host.

No private source, downloads, config changes, or automatic retries. This tests
one request length, not a model's full context capacity or conversational skill.
"""
import hashlib
import json
import time

import httpx


def main():
    expected = {"amber": "a19e7d02", "violet": "b81c4f39", "silver": "c27d9e51"}
    lines = []
    for i in range(1400):
        if i in {0, 700, 1399}:
            key = {0: "amber", 700: "violet", 1399: "silver"}[i]
            lines.append(f"The checkpoint named {key} has the exact token {expected[key]}.")
        lines.append(f"Record {i:04d}: The synthetic workshop discussed schedules, chairs, windows, paper supplies, lunch arrangements and ordinary administrative details.")
    source = "\n".join(lines)
    payload = {"model": "qwen3.8:27b-mlx", "temperature": 0, "max_tokens": 256,
               "reasoning_effort": "none", "response_format": {"type": "json_object"},
               "messages": [{"role": "system", "content": "Find the exact tokens for the amber, violet and silver checkpoints in the supplied records. Return only a JSON object with those three keys and token values. Do not summarize."},
                            {"role": "user", "content": source}]}
    print(json.dumps({"phase": "requesting", "source_bytes": len(source.encode()),
                      "source_sha256": hashlib.sha256(source.encode()).hexdigest(),
                      "model": payload["model"]}), flush=True)
    started = time.monotonic()
    with httpx.Client(timeout=httpx.Timeout(600, connect=5)) as client:
        response = client.post("http://127.0.0.1:11434/v1/chat/completions", json=payload)
        response.raise_for_status()
        result = response.json()
    content = result["choices"][0]["message"].get("content") or ""
    try:
        parsed = json.loads(content)
    except ValueError:
        parsed = None
    print(json.dumps({"phase": "complete", "seconds": round(time.monotonic() - started, 2),
                      "served_model": result.get("model"), "usage": result.get("usage"),
                      "finish_reason": result["choices"][0].get("finish_reason"),
                      "all_checkpoints_match": parsed == expected, "answer": parsed,
                      "content_preview_if_invalid": content[:200] if parsed is None else None}), flush=True)


if __name__ == "__main__":
    main()
