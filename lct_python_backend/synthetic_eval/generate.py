"""Generate fresh synthetic conversations (with ground truth) via a frontier LLM.

The generator authors BOTH a realistic multi-speaker dialogue AND its answer key
in one shot, in the exact ``schema.SyntheticConversation`` JSON shape, then
validates referential integrity before saving. Because the data is synthetic it
runs through the cloud-egress safety helper (synthetic-only process, no real DB).

Usage::

    OPENAI_API_KEY=... python -m lct_python_backend.synthetic_eval.generate \\
        --topic "Should the team adopt a four-day work week?" \\
        --speakers 3 --slug four-day-week --provider openai

    # Batch a few at once on built-in topics:
    python -m lct_python_backend.synthetic_eval.generate --count 3 --provider openai
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from lct_python_backend.synthetic_eval.providers import (
    ProviderSpec,
    build_provider,
    enable_cloud_egress_for_synthetic,
)
from lct_python_backend.synthetic_eval.schema import (
    CONVERSATIONS_DIR,
    SyntheticConversation,
)

SYSTEM_PROMPT = """You author SYNTHETIC test conversations for a conversation-analysis system, \
together with a precise ANSWER KEY (ground truth). The conversations are fully fictional: \
invent names, never reference real private people or data.

You must return ONE JSON object and nothing else, in EXACTLY this shape:

{
  "slug": "kebab-case-id",
  "title": "One-line description",
  "personas": ["Name1", "Name2"],
  "turns": [
    {"id": "t0", "speaker": "Name1", "text": "natural spoken utterance"},
    {"id": "t1", "speaker": "Name2", "text": "..."}
  ],
  "ground_truth": {
    "cruxes":       ["t3", "t9"],
    "tangents":     ["t5"],
    "surprises":    ["t11"],
    "action_items": ["t14"],
    "claims": [
      {"turn": "t1", "text": "fact-checkable assertion", "type": "factual"},
      {"turn": "t2", "text": "value/ought statement",   "type": "normative"},
      {"turn": "t3", "text": "ideological assumption",  "type": "worldview"}
    ],
    "edges": [
      {"type": "rebuts",   "from": "t4", "to": "t2", "note": "why"},
      {"type": "supports", "from": "t6", "to": "t1"},
      {"type": "clarifies","from": "t7", "to": "t5"},
      {"type": "asks",     "from": "t8", "to": "t7"}
    ]
  }
}

LABELLING RULES (apply honestly — these are graded):
- Turn ids are t0, t1, t2 ... in order, one per utterance. Every ground_truth reference MUST point at an existing turn id.
- crux: a pivotal claim, turning point, thesis, or key realization the discussion hinges on. Mark the genuine pivots only (typically 2-4).
- tangent: a digression, aside, personal anecdote, or side-story that branches off the main thread. Include at least ONE clear multi-turn tangent.
- surprise: a genuinely surprising admission, reversal, or counter-intuitive fact. Include at least one real reversal where a speaker changes their mind.
- action_item: a concrete commitment with an owner (and ideally a deadline). Include 1-3.
- claims: factual = verifiable; normative = an ought/value judgment; worldview = a hidden ideological premise. Include a mix.
- edges: connect turn ids. type is one of: rebuts, supports, clarifies, asks, tangent. Build a real back-and-forth (several rebuts AND supports).

QUALITY:
- 14-22 turns. Natural, spoken, with disfluencies and interruptions where realistic.
- A real disagreement that partially resolves. Do not make everyone agree immediately.
- Do NOT label every turn; most turns are ordinary. Precision of the answer key matters.
Return only the JSON object."""

BUILTIN_TOPICS: List[Tuple[str, int]] = [
    ("Should our startup take the acquisition offer or stay independent?", 3),
    ("Is remote-first hurting our engineering culture?", 2),
    ("Do we deprecate the legacy API now or support it another year?", 3),
    ("Should the city build the new bike-lane network downtown?", 2),
    ("Is it worth migrating the data warehouse to a new vendor?", 3),
]


def _slugify(value: str) -> str:
    cleaned = re.sub(r"[^a-z0-9]+", "-", str(value).lower()).strip("-")
    return (cleaned[:48] or "synthetic-conversation").strip("-")


def _chat_json(
    spec: ProviderSpec,
    system_prompt: str,
    user_prompt: str,
    *,
    temperature: float = 0.9,
) -> Tuple[Any, str]:
    """Generic JSON chat across provider kinds. Returns (parsed_data, backend_label)."""
    if spec.kind == "mock":
        raise ValueError("The 'mock' provider cannot generate; use openai/openrouter/gemini/local.")

    if spec.kind == "fallback":
        from lct_python_backend.services.local_llm_client import chat_with_provider_fallback_sync

        result = chat_with_provider_fallback_sync(
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            providers=spec.providers,
            temperature=temperature,
            max_tokens=4000,
            require_json=True,
        )
        return result.data, result.backend_label()

    if spec.kind == "gemini":
        from google import genai
        from google.genai import types

        from lct_python_backend.services.local_llm_client import extract_json_from_text
        from lct_python_backend.services.transcript_llm_callers import _resolve_gemini_api_key

        api_key, _ = _resolve_gemini_api_key()
        model = str(spec.llm_config.get("chat_model", "gemini-2.5-flash"))
        client = genai.Client(api_key=api_key)
        config = types.GenerateContentConfig(
            temperature=temperature,
            response_mime_type="application/json",
            system_instruction=[types.Part.from_text(text=system_prompt)],
        )
        full = ""
        for chunk in client.models.generate_content_stream(
            model=model,
            contents=[types.Content(role="user", parts=[types.Part.from_text(text=user_prompt)])],
            config=config,
        ):
            if hasattr(chunk, "text") and chunk.text:
                full += chunk.text
        return extract_json_from_text(full), f"online_{model}"

    raise ValueError(f"Unknown provider kind {spec.kind!r}")


def _coerce_payload(data: Any, *, slug: Optional[str], topic: str, backend: str) -> Dict[str, Any]:
    if not isinstance(data, dict):
        raise ValueError(f"generator returned a {type(data).__name__}, expected a JSON object")
    payload = dict(data)
    if slug:
        payload["slug"] = slug
    elif not payload.get("slug"):
        payload["slug"] = _slugify(payload.get("title", topic))
    payload["slug"] = _slugify(payload["slug"])
    prov = dict(payload.get("provenance", {}))
    prov.update({
        "author": "model",
        "backend": backend,
        "topic": topic,
        "system_prompt_sha256": hashlib.sha256(SYSTEM_PROMPT.encode("utf-8")).hexdigest()[:16],
        "license": "synthetic-fixture: model-generated, fully fictional",
    })
    payload["provenance"] = prov
    return payload


def generate_conversation(
    spec: ProviderSpec,
    *,
    topic: str,
    n_speakers: int,
    slug: Optional[str] = None,
    repair_attempts: int = 1,
) -> SyntheticConversation:
    user_prompt = (
        f"Topic: {topic}\n"
        f"Number of speakers: {n_speakers}\n"
        "Author the conversation and its ground-truth answer key now."
    )
    last_error: Optional[str] = None
    for attempt in range(repair_attempts + 1):
        prompt = user_prompt if attempt == 0 else (
            f"{user_prompt}\n\nYour previous attempt was invalid: {last_error}\n"
            "Fix it and return only the corrected JSON object."
        )
        data, backend = _chat_json(spec, SYSTEM_PROMPT, prompt)
        payload = _coerce_payload(data, slug=slug, topic=topic, backend=backend)
        try:
            return SyntheticConversation.from_json(payload)
        except (ValueError, KeyError) as exc:
            last_error = str(exc)
            print(f"   attempt {attempt + 1} invalid: {last_error}")
    raise ValueError(f"generator failed validation after {repair_attempts + 1} attempts: {last_error}")


def _save(convo: SyntheticConversation, out_dir: Path, *, overwrite: bool) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / f"{convo.slug}.json"
    if path.exists() and not overwrite:
        raise FileExistsError(f"{path} exists; pass --overwrite to replace it")
    with path.open("w", encoding="utf-8") as fh:
        json.dump(convo.to_json(), fh, indent=2, ensure_ascii=False)
    return path


def main(argv: Optional[List[str]] = None) -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
    except Exception:
        pass

    parser = argparse.ArgumentParser(
        prog="synthetic_eval.generate",
        description="Generate synthetic conversations with ground truth via a frontier LLM.",
    )
    parser.add_argument("--provider", "-p", default="openai", help="openai | openrouter | gemini | local")
    parser.add_argument("--topic", "-t", help="conversation topic")
    parser.add_argument("--speakers", "-s", type=int, default=2, help="number of speakers")
    parser.add_argument("--slug", help="output slug (default: derived from title)")
    parser.add_argument("--count", "-n", type=int, default=1, help="generate N from built-in topics (ignored if --topic)")
    parser.add_argument("--out", help=f"output dir (default: {CONVERSATIONS_DIR})")
    parser.add_argument("--overwrite", action="store_true", help="overwrite existing files")
    args = parser.parse_args(argv)

    try:
        spec = build_provider(args.provider)
    except ValueError as exc:
        print(f"!! {exc}")
        return 2
    if spec.kind == "mock":
        print("!! 'mock' cannot generate. Use openai / openrouter / gemini / local.")
        return 2
    if not spec.ready:
        print(f"!! provider {spec.name!r} needs ${spec.missing_key_env} ({spec.label}).")
        return 2
    if spec.requires_cloud:
        enable_cloud_egress_for_synthetic()

    out_dir = Path(args.out) if args.out else CONVERSATIONS_DIR

    jobs: List[Tuple[str, int, Optional[str]]] = []
    if args.topic:
        jobs.append((args.topic, args.speakers, args.slug))
    else:
        for topic, n in BUILTIN_TOPICS[: max(1, args.count)]:
            jobs.append((topic, n, None))

    written = 0
    for topic, n_speakers, slug in jobs:
        print(f"\n>> generating: {topic} ({n_speakers} speakers) via {spec.label}")
        try:
            convo = generate_conversation(spec, topic=topic, n_speakers=n_speakers, slug=slug)
        except Exception as exc:  # noqa: BLE001
            print(f"!! generation failed: {type(exc).__name__}: {exc}")
            continue
        gt = convo.ground_truth
        print(
            f"   {convo.slug}: {len(convo.turns)} turns, "
            f"{len(gt.cruxes)} crux / {len(gt.tangents)} tangent / "
            f"{len(gt.surprises)} surprise / {len(gt.action_items)} action / "
            f"{len(gt.claims)} claims / {len(gt.edges)} edges"
        )
        try:
            path = _save(convo, out_dir, overwrite=args.overwrite)
            print(f"   wrote {path}")
            written += 1
        except FileExistsError as exc:
            print(f"!! {exc}")

    print(f"\nDone. {written} conversation(s) written to {out_dir}")
    return 0 if written else 1


if __name__ == "__main__":
    sys.exit(main())
