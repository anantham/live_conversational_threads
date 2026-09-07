"""Synthetic semantic retrieval probe; local-only, no downloads or retries.

Retrieval proposes evidence for the interpreter. A high score must never create
a thread merge or callback edge by itself. No private transcript is used here.
"""
import json
import math
import time

import httpx


PASSAGES = [
    "We should not ship meeting recordings to an outside AI service unless every participant explicitly agrees. Keep processing on the owner's machine by default.",
    "We have not settled who covers the monthly hosting bill once the grant runs out. Mira offered to ask the foundation, but there is no answer yet.",
    "The map freezes when the renderer rebuilds every point on each scroll event. Batch those updates once per animation frame.",
    "I said pause the launch, not cancel the project. We are waiting for the accessibility review before inviting people.",
    "The shipping company records every package leaving its outside warehouse. The owner agreed to pay the delivery service.",
    "The grant announcement includes a photograph of Mira. The foundation's monthly newsletter will cover the launch.",
    "We cancelled the old map project because nobody wanted to maintain its rendering engine.",
]
QUERIES = [
    ("Returning to the consent issue: a single attendee opting out should keep their conversation off hosted inference.", 0),
    ("That unanswered question about paying for the server after funding ends is still hanging over us.", 1),
    ("The jitter while moving down the page sounds like the redraw problem you mentioned earlier.", 2),
    ("When you said stop, I thought you meant abandon it. Now I understand it was only a temporary hold for that usability check.", 3),
]


def main():
    model = "qwen3-embedding:0.6b"
    texts = PASSAGES + [
        "Instruct: Retrieve the earlier conversation passage relevant to this later remark.\nQuery: " + query
        for query, _ in QUERIES
    ]
    started = time.monotonic()
    print(json.dumps({"phase": "requesting", "model": model, "synthetic_items": len(texts)}), flush=True)
    with httpx.Client(timeout=httpx.Timeout(180, connect=5)) as client:
        response = client.post("http://127.0.0.1:11434/v1/embeddings", json={"model": model, "input": texts})
        response.raise_for_status()
        body = response.json()
    if body.get("model") != model:
        raise ValueError("Embedding model identity mismatch")
    items = body["data"]
    if sorted(item["index"] for item in items) != list(range(len(texts))):
        raise ValueError("Missing, duplicated or unexpected embedding indexes")
    vectors = [item["embedding"] for item in sorted(items, key=lambda item: item["index"])]
    dimension = len(vectors[0])
    normalized = []
    for vector in vectors:
        if not dimension or len(vector) != dimension or not all(math.isfinite(x) for x in vector):
            raise ValueError("Invalid embedding dimension or non-finite value")
        norm = math.sqrt(sum(x * x for x in vector))
        if not norm:
            raise ValueError("Zero embedding")
        normalized.append([x / norm for x in vector])
    results = []
    for offset, (_, expected) in enumerate(QUERIES):
        query = normalized[len(PASSAGES) + offset]
        scores = [sum(a * b for a, b in zip(query, doc)) for doc in normalized[:len(PASSAGES)]]
        ranked = sorted(range(len(PASSAGES)), key=lambda i: -scores[i])
        results.append({"query": offset, "expected": expected, "rank": ranked.index(expected) + 1,
                        "top_three": [{"passage": i, "score": round(scores[i], 4)} for i in ranked[:3]]})
    print(json.dumps({"phase": "complete", "seconds": round(time.monotonic() - started, 2),
                      "model": body["model"], "dimensions": dimension, "results": results,
                      "all_top_one": all(result["rank"] == 1 for result in results)}), flush=True)


if __name__ == "__main__":
    main()
