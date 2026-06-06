#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
build_whisperx_initial_prompt.py

Reads the top-N terms from IndrasNet's `personal_vocabulary` store and emits a
WhisperX `--initial_prompt` string biased toward personal names + domain jargon.
Prints the prompt to stdout (UTF-8) so it can be captured into a shell variable
or piped into the re-transcription driver.

WHY
---
WhisperX (faster-whisper backend) seeds the decoder with `initial_prompt` as a
"previous context" string. Listing salient names/jargon there nudges the model
toward the correct surface forms (e.g. "Sahil" not "Sahel", "Claude" not
"cloud", "diarization" not "diurization"). It is a soft bias, not a hard
constraint, and it competes for a *limited* prompt window.

THE ~224-TOKEN BUDGET
---------------------
Whisper's decoder context is 448 tokens total. By convention the *prompt* (the
`initial_prompt`, fed as the "previous text" condition) is capped at roughly
HALF of that — `n_text_ctx // 2 - 1` == 223 tokens — so the model still has
room to emit the current segment. Tokens beyond that are silently dropped from
the *front* by Whisper, which would discard our highest-priority terms. So we
must budget ourselves and TRUNCATE FROM THE TAIL (drop lowest-priority terms),
never overrun and let Whisper truncate the head.

We target a conservative default of 220 tokens (`--max-tokens`) to leave slack
for the framing words ("Glossary of names and terms: ...").

TOKEN COUNTING
--------------
If `tiktoken` is importable we count exactly with the GPT-2/Whisper-compatible
"gpt2" encoding (Whisper's multilingual tokenizer is a superset but byte-pair
counts track very closely for ASCII glossary text). If tiktoken is absent we
fall back to a conservative heuristic: ceil(len(chars)/3.5), which over-counts
slightly so we under-fill rather than overrun.

PRIORITIZATION POLICY (highest -> lowest)
-----------------------------------------
Terms are scored, filtered, then greedily packed until the budget is hit:

  1. FILTER OUT noise first:
       - terms containing the Unicode replacement char U+FFFD (mojibake from a
         cp1252/utf-8 mishap in the source data, e.g. 'Yeah,�')
       - terms whose normalized form is a stopword / discourse marker / common
         contraction (Send, Do, What's, Let's, Wow, Thank, It's, ...). These
         are sentence-starter capitalization noise harvested by the bootstrap,
         not vocabulary the model needs help with.
       - terms below --min-freq (default 5): too rare to trust.
       - pure single ASCII letters and obvious junk.

  2. SCORE each surviving term:
       score = frequency
             * NAME_BOOST     (1.5 if it parses as a proper name)
             * MISREC_BOOST   (2.0 if it has recorded misrecognitions —
                               PROVEN to be confused by the ASR, highest value)
       Names + proven-confusions float to the top because that is exactly what
       initial_prompt fixes; generic high-freq acronyms (AI, API) are real but
       the base model already gets them right, so they rank lower per-token.

  3. DEDUPE near-duplicates: if a multi-word term is present ("Vatsal Mehra"),
     drop its bare-surname/standalone components ("Mehra") to avoid spending
     budget twice. Possessives ("Bishma's") are dropped when the base
     ("Bishma") is already included.

  4. PACK greedily by descending score until the token budget is exhausted;
     the tail (lowest score) is what gets dropped if we run out of room.

The emitted string groups results as:
    "Glossary of names and terms: <Name1>, <Name2>, ...; <term1>, <term2>, ..."
Grouping names vs terms is purely cosmetic for the human reading the prompt;
Whisper treats it as flat text.

USAGE
-----
    python scripts/build_whisperx_initial_prompt.py \
        [--db PATH] [--top-n 120] [--min-freq 5] [--max-tokens 220] \
        [--include-misrec-hints] [--json-debug]

    # Capture into a WhisperX call (PowerShell):
    $prompt = python scripts/build_whisperx_initial_prompt.py
    whisperx.exe clip.wav --initial_prompt "$prompt" ...

DB LOCATION
-----------
Reads `personal_vocabulary` from the IndrasNet sqlite DB. Resolution order:
    1. --db CLI arg
    2. $INDRAS_DB_PATH
    3. canonical sibling-repo path:
       ../TemporalCoordination/grimoire/IndrasNet/db/indras_net_mvp.db
Read-only: opens with mode=ro URI; never writes.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import sqlite3
import sys
from pathlib import Path
from typing import Dict, List, Optional, Tuple

# --- Make stdout UTF-8 on Windows (cp1252 default mangles unicode) -----------
try:
    sys.stdout.reconfigure(encoding="utf-8")  # py3.7+
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass


# --- DB path resolution ------------------------------------------------------
def _default_db_path() -> Path:
    here = Path(__file__).resolve()
    # repo_root = .../live_conversational_threads ; sibling = TemporalCoordination
    repo_root = here.parent.parent
    sibling = repo_root.parent / "TemporalCoordination"
    return sibling / "grimoire" / "IndrasNet" / "db" / "indras_net_mvp.db"


def resolve_db_path(cli_db: Optional[str]) -> Path:
    if cli_db:
        return Path(cli_db)
    env = os.getenv("INDRAS_DB_PATH")
    if env:
        return Path(env)
    return _default_db_path()


# --- Noise filtering ---------------------------------------------------------
# Discourse markers / sentence-starter capitals / common contractions that the
# bootstrap harvest captured as "proper nouns" but are NOT vocabulary the ASR
# needs help with. Mirrors (and extends) bootstrap_personal_vocab.STOPWORDS.
STOPWORDS = {
    # contractions & common verbs seen capitalized at sentence start
    "it's", "that's", "what's", "let's", "there's", "he's", "they're",
    "we're", "don't", "i'", "ai's", "india's", "sah's", "aisha's", "maple's",
    "let", "do", "did", "send", "add", "give", "have", "provide", "review",
    "wait", "thank", "are", "not", "for", "two", "who", "which", "because",
    "maybe", "exactly", "nice", "wow", "huh", "bro", "dude", "hey", "oh",
    "yeah", "no", "yes", "okay", "ok", "well", "so", "and", "but", "the",
    "this", "that", "these", "those", "there", "here", "now", "file", "decisions",
    "are", "are.",
    # backchannels / fillers / common words seen capitalized at sentence start
    "mhm", "mm", "hmm", "uh", "um", "like", "is", "can", "will", "would",
    "could", "should", "was", "were", "been", "being", "get", "got", "go",
    "say", "said", "see", "saw", "know", "knew", "think", "thought", "want",
    "need", "make", "made", "take", "took", "come", "came", "look", "looked",
    "sah",  # truncated 'Sahil' artifact
    "meet",  # ambiguous: the verb dominates over Google Meet in this corpus
    # months / days that leak in capitalized
    "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
    "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
    "january", "february", "march", "april", "june", "july", "august",
    "september", "october", "november", "december",
}

# Single ASCII letters are never useful vocabulary on their own.
_SINGLE_LETTER = re.compile(r"^[A-Za-z]$")
# Mojibake / non-glossary chars. The source data has artifacts like 'Yeah,…'
# (comma + U+2026 ellipsis) and 'Foo,�' (replacement char) — real glossary
# entries are clean names/terms and NEVER contain a comma or these chars.
_MOJIBAKE_CHARS = "�…"  # replacement char, horizontal ellipsis


def is_noise(term: str) -> bool:
    if not term or len(term.strip()) < 2:
        return True
    if any(ch in term for ch in _MOJIBAKE_CHARS):
        return True
    if "," in term:  # multi-clause discourse fragment, not a glossary entry
        return True
    norm = term.strip().lower()
    if norm in STOPWORDS:
        return True
    if _SINGLE_LETTER.match(term.strip()):
        return True
    # Drop terms that are entirely non-alphanumeric
    if not re.search(r"[A-Za-z0-9]", term):
        return True
    return False


# --- Misrecognition parsing (handles both real-data dict shape AND the ------
#     string-array shape documented in core/db/vocabulary.py) -----------------
def parse_misrecognitions(raw: Optional[str]) -> List[str]:
    if not raw:
        return []
    try:
        data = json.loads(raw)
    except Exception:
        return []
    out: List[str] = []
    if isinstance(data, list):
        for el in data:
            if isinstance(el, str):
                out.append(el)
            elif isinstance(el, dict):
                m = el.get("misrecognition") or el.get("term")
                if m:
                    out.append(str(m))
    return out


# --- Name detection ----------------------------------------------------------
def looks_like_name(term: str) -> bool:
    """Proper-name heuristic: starts uppercase, alphabetic-ish, not an all-caps
    acronym (those are 'terms' not 'names'). Multi-word title-case counts."""
    t = term.strip()
    if not t or not t[0].isupper():
        return False
    words = t.split()
    # all-caps single token == acronym (AI, API, LLM) -> term, not name
    if len(words) == 1 and t.isupper():
        return False
    # every word title-cased and alphabetic-ish -> name
    alpha_words = [w for w in words if re.match(r"^[A-Z][a-zA-Z'\-]*$", w)]
    return len(alpha_words) == len(words) and len(words) >= 1


# --- Token counting ----------------------------------------------------------
_tiktoken_enc = None


def _get_tiktoken():
    global _tiktoken_enc
    if _tiktoken_enc is not None:
        return _tiktoken_enc
    try:
        import tiktoken  # type: ignore
        _tiktoken_enc = tiktoken.get_encoding("gpt2")
    except Exception:
        _tiktoken_enc = False
    return _tiktoken_enc


def count_tokens(text: str) -> int:
    enc = _get_tiktoken()
    if enc:
        return len(enc.encode(text))
    # Conservative fallback: over-count slightly so we under-fill, not overrun.
    # ~3.5 chars/token is conservative for English; punctuation adds tokens.
    return math.ceil(len(text) / 3.5)


# --- Core build --------------------------------------------------------------
def fetch_vocab(db_path: Path, min_freq: int) -> List[Dict]:
    if not db_path.exists():
        raise FileNotFoundError(f"IndrasNet DB not found: {db_path}")
    uri = f"file:{db_path.as_posix()}?mode=ro"
    conn = sqlite3.connect(uri, uri=True, timeout=30.0)
    conn.row_factory = sqlite3.Row
    try:
        cur = conn.cursor()
        cur.execute(
            """
            SELECT term, frequency, correction_count, common_misrecognitions
            FROM personal_vocabulary
            WHERE frequency >= ?
            ORDER BY frequency DESC, correction_count DESC
            """,
            (min_freq,),
        )
        rows = [dict(r) for r in cur.fetchall()]
    finally:
        conn.close()
    return rows


NAME_BOOST = 1.5
MISREC_BOOST = 2.0


def score_terms(rows: List[Dict]) -> List[Dict]:
    scored = []
    for r in rows:
        term = (r["term"] or "").strip()
        if is_noise(term):
            continue
        freq = r.get("frequency") or 1
        misrec = parse_misrecognitions(r.get("common_misrecognitions"))
        is_name = looks_like_name(term)
        score = float(freq)
        if is_name:
            score *= NAME_BOOST
        if misrec:
            score *= MISREC_BOOST
        scored.append({
            "term": term,
            "frequency": freq,
            "is_name": is_name,
            "misrecognitions": misrec,
            "score": score,
        })
    scored.sort(key=lambda x: x["score"], reverse=True)
    return scored


def dedupe_subsumed(scored: List[Dict]) -> List[Dict]:
    """Drop standalone surnames/possessives already covered by a multi-word or
    base form that is also present. Keeps the higher-scored representative."""
    kept_terms = {s["term"] for s in scored}
    kept_lower = {s["term"].lower() for s in scored}
    out = []
    for s in scored:
        t = s["term"]
        low = t.lower()
        # possessive: "Bishma's" -> base "Bishma" present?
        if low.endswith("'s") and low[:-2] in kept_lower:
            continue
        # bare single-word surname subsumed by a multiword that ends with it
        if " " not in t:
            subsumed = any(
                " " in other and other.split()[-1].lower() == low
                for other in kept_terms
                if other != t
            )
            if subsumed:
                continue
        out.append(s)
    return out


def build_prompt(
    scored: List[Dict],
    max_tokens: int,
    top_n: Optional[int],
    include_misrec_hints: bool,
) -> Tuple[str, List[Dict], int]:
    """Greedily pack terms (descending score) under the token budget.

    Returns (prompt_string, included_terms, token_count)."""
    prefix = "Glossary of names and terms: "
    candidates = scored if top_n is None else scored[:top_n]

    included: List[Dict] = []
    # Greedy pack: rebuild candidate prompt incrementally, stop when over budget.
    for s in candidates:
        trial = included + [s]
        body = _render(trial, include_misrec_hints)
        if count_tokens(prefix + body) > max_tokens:
            # term s doesn't fit; since later terms are lower-priority but may be
            # SHORTER, keep scanning a little to fill remaining slack.
            continue_scan = True
            if continue_scan:
                continue
        included = trial
    body = _render(included, include_misrec_hints)
    prompt = (prefix + body) if included else ""
    return prompt, included, count_tokens(prompt)


def _render(terms: List[Dict], include_misrec_hints: bool) -> str:
    names = [t for t in terms if t["is_name"]]
    other = [t for t in terms if not t["is_name"]]

    def fmt(t: Dict) -> str:
        if include_misrec_hints and t["misrecognitions"]:
            return f"{t['term']} (not {t['misrecognitions'][0]})"
        return t["term"]

    parts = []
    if names:
        parts.append(", ".join(fmt(t) for t in names))
    if other:
        parts.append(", ".join(fmt(t) for t in other))
    return "; ".join(parts) + "." if parts else ""


def main(argv: Optional[List[str]] = None) -> int:
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--db", default=None, help="Path to indras_net_mvp.db")
    p.add_argument("--top-n", type=int, default=150,
                   help="Consider at most this many top-scored terms (default 150)")
    p.add_argument("--min-freq", type=int, default=5,
                   help="Drop terms below this frequency (default 5)")
    p.add_argument("--max-tokens", type=int, default=220,
                   help="Token budget for the prompt (Whisper cap ~223; default 220)")
    p.add_argument("--include-misrec-hints", action="store_true",
                   help="Append '(not <misrec>)' hints for confused terms (costs tokens)")
    p.add_argument("--json-debug", action="store_true",
                   help="Emit JSON {prompt, token_count, included_terms} to stderr")
    args = p.parse_args(argv)

    db_path = resolve_db_path(args.db)
    try:
        rows = fetch_vocab(db_path, args.min_freq)
    except FileNotFoundError as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return 2

    scored = score_terms(rows)
    scored = dedupe_subsumed(scored)
    prompt, included, ntok = build_prompt(
        scored, args.max_tokens, args.top_n, args.include_misrec_hints
    )

    if args.json_debug:
        dbg = {
            "db_path": str(db_path),
            "tiktoken": bool(_get_tiktoken()),
            "rows_scanned": len(rows),
            "after_filter": len(scored),
            "included_count": len(included),
            "token_count": ntok,
            "max_tokens": args.max_tokens,
            "included_terms": [t["term"] for t in included],
        }
        print(json.dumps(dbg, ensure_ascii=False, indent=2), file=sys.stderr)

    # The prompt itself goes to stdout (the capturable artifact).
    print(prompt)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
