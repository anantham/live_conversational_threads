"""Fact-check provider integration and response normalization helpers."""

import json
import logging
from typing import Any, Dict, List, Optional
from urllib.parse import urlparse

import httpx

from lct_python_backend.config import PERPLEXITY_API_KEY, PERPLEXITY_API_URL

logger = logging.getLogger(__name__)

FACT_CHECK_MODEL = "sonar-pro"
FACT_CHECK_TIMEOUT_SECONDS = 45


def is_http_url(value: str) -> bool:
    parsed = urlparse(value.strip())
    return parsed.scheme in {"http", "https"} and bool(parsed.netloc)


def normalize_verdict(value: Any) -> str:
    text = str(value or "").strip().lower()
    if text in {"true", "verified", "correct"}:
        return "True"
    if text in {"false", "incorrect"}:
        return "False"
    return "Unverified"


def normalize_citations(raw: Any, max_items: int = 2) -> List[Dict[str, str]]:
    normalized: List[Dict[str, str]] = []
    if not isinstance(raw, list):
        return normalized

    for idx, item in enumerate(raw, start=1):
        title = ""
        url = ""

        if isinstance(item, dict):
            title = str(item.get("title") or f"Source {idx}").strip()
            url = str(item.get("url") or item.get("link") or "").strip()
        elif isinstance(item, str):
            title = f"Source {idx}"
            url = item.strip()

        if is_http_url(url):
            normalized.append({"title": title, "url": url})

        if len(normalized) >= max_items:
            break

    return normalized


def extract_json_payload(text: str) -> Optional[Dict[str, Any]]:
    raw = str(text or "").strip()
    if not raw:
        return None

    try:
        parsed = json.loads(raw)
        if isinstance(parsed, dict):
            return parsed
    except json.JSONDecodeError:
        pass

    fence_start = raw.find("```")
    if fence_start != -1:
        fence_end = raw.find("```", fence_start + 3)
        if fence_end != -1:
            fenced = raw[fence_start + 3 : fence_end].strip()
            if fenced.startswith("json"):
                fenced = fenced[4:].strip()
            try:
                parsed = json.loads(fenced)
                if isinstance(parsed, dict):
                    return parsed
            except json.JSONDecodeError:
                pass

    first = raw.find("{")
    last = raw.rfind("}")
    if first != -1 and last != -1 and first < last:
        candidate = raw[first : last + 1]
        try:
            parsed = json.loads(candidate)
            if isinstance(parsed, dict):
                return parsed
        except json.JSONDecodeError:
            return None

    return None


def build_unverified_results(claims: List[str], reason: str) -> Dict[str, List[Dict[str, Any]]]:
    return {
        "claims": [
            {
                "claim": claim,
                "verdict": "Unverified",
                "explanation": reason,
                "citations": [],
            }
            for claim in claims
        ]
    }


async def generate_fact_check_json_perplexity(claims: List[str]) -> Dict[str, Any]:
    if not PERPLEXITY_API_KEY:
        logger.warning("[FACTCHECK] PERPLEXITY_API_KEY not configured; returning Unverified results.")
        return build_unverified_results(
            claims,
            "Perplexity integration is not configured on the server.",
        )

    system_prompt = (
        "You are a factual verification assistant. "
        "For each claim, return JSON with verdict (True/False/Unverified), explanation, and citations."
    )
    user_prompt = (
        "Fact-check the following claims.\n"
        "Return only valid JSON in this schema:\n"
        "{\n"
        '  "claims": [\n'
        "    {\n"
        '      "claim": "original claim text",\n'
        '      "verdict": "True|False|Unverified",\n'
        '      "explanation": "short explanation",\n'
        '      "citations": [{"title": "Source name", "url": "https://..."}]\n'
        "    }\n"
        "  ]\n"
        "}\n\n"
        f"Claims: {json.dumps(claims, ensure_ascii=True)}"
    )

    payload = {
        "model": FACT_CHECK_MODEL,
        "temperature": 0,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
    }
    headers = {
        "Authorization": f"Bearer {PERPLEXITY_API_KEY}",
        "Content-Type": "application/json",
        "Accept": "application/json",
    }

    try:
        async with httpx.AsyncClient(timeout=FACT_CHECK_TIMEOUT_SECONDS) as client:
            response = await client.post(PERPLEXITY_API_URL, json=payload, headers=headers)
            response.raise_for_status()
    except httpx.HTTPStatusError as exc:
        logger.error(
            "[FACTCHECK] Perplexity returned HTTP %s for %d claims: %s",
            exc.response.status_code,
            len(claims),
            exc.response.text[:300],
        )
        return build_unverified_results(claims, "Fact-check provider returned an upstream error.")
    except httpx.HTTPError as exc:
        logger.error("[FACTCHECK] Perplexity request failed: %s", str(exc))
        return build_unverified_results(claims, "Fact-check provider request failed.")

    upstream = response.json()
    content = upstream.get("choices", [{}])[0].get("message", {}).get("content", "")
    parsed = extract_json_payload(content)
    if not parsed or not isinstance(parsed.get("claims"), list):
        logger.warning("[FACTCHECK] Could not parse provider JSON output; using fallback formatting.")
        return build_unverified_results(
            claims,
            "Unable to parse fact-check provider response.",
        )

    parsed_claims = parsed.get("claims", [])
    shared_citations = normalize_citations(upstream.get("citations"))
    normalized: List[Dict[str, Any]] = []

    for idx, original_claim in enumerate(claims):
        item = parsed_claims[idx] if idx < len(parsed_claims) and isinstance(parsed_claims[idx], dict) else {}
        explanation = str(item.get("explanation") or "").strip()
        if not explanation:
            explanation = "No explanation returned by provider."

        citations = normalize_citations(item.get("citations"))
        if not citations:
            citations = shared_citations

        normalized.append(
            {
                "claim": original_claim,
                "verdict": normalize_verdict(item.get("verdict")),
                "explanation": explanation,
                "citations": citations,
            }
        )

    return {"claims": normalized}
