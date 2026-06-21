"""Engine-agnostic privacy boundary (ADR-038) — leak-verify the REAL outbound bytes.

This is the enforceable core of ADR-038, built per the 2026-06-20 enforcement
redesign AND its codex GO-gate (which No-Go'd the first redesign for overclaiming).
What it actually delivers — and, just as importantly, what it does NOT:

  * ``leak_verify(bytes_or_text)`` — a deterministic, leaks-only forbidden-name
    scan over the EXACT bytes about to leave (request body / CLI stdin), with a
    matcher hardened past the prototype's ASCII ``\\b`` regex: Unicode-NFC
    normalized, case-insensitive, whole-word, possessive-tolerant (finding 1.7).
    The egress gate keys on ``leaks_clean`` (no forbidden name survived); the
    "did the expected pseudonym appear" signal is the SEPARATE, non-blocking
    ``quality_ok`` (finding 1.6 — never brick a legit redacted send).

  * ``classify_engine_tier(url)`` + ``REDACTION_REQUIRED_TIERS`` — tier by REAL
    host identity (not the local allowlist, so allowlisting can't downgrade a
    frontier host out of redaction). E1 local / E2 modal / E3 BAA / E4 public.

  * ``spawn_external_cli(...)`` — ONE sanctioned door for frontier CLIs
    (claude/codex/gemini): leak-verifies the exact stdin bytes BEFORE the spawn
    (it OWNS encode→scan→spawn, closing finding 1.1's "Popen can't hash run(input=)"
    gap), and runs the child in a fresh empty cwd with a scrubbed env and
    ``close_fds=True`` (Windows-correct — ``pass_fds=()`` is POSIX-only, per the
    codex blocker). HONEST RESIDUAL (codex blocker 3): a sandboxed cwd is NOT an
    exfiltration boundary — the child keeps its own network and, given an
    absolute path in argv/stdin, could still read it. The real guarantee is
    "the stdin we send carries no forbidden NAME"; ambient access is reduced, not
    eliminated. Full containment of a networked CLI is out of reach here.

  * ``assert_audio_egress_allowed(url)`` — a hard gate that keeps raw voice
    local-only EVEN WHEN ``LCT_LOCAL_ONLY=0`` (codex blocker 2: the redesign's
    "audio stays local-only" claim was false — at LOCAL_ONLY=0 realtime/HTTP STT
    streamed raw audio to the cloud ungated). Cloud audio now requires an
    explicit ``LCT_ALLOW_CLOUD_AUDIO=1`` opt-in. You cannot redact a voice, so
    the boundary is binary local-only for audio, not leak-verify.

  * ``bootstrap_egress()`` — idempotent process-entry installer (finding 1.3).

Canonical-source note (ADR-038 D1): the long-term design vendors ONE primitive
from IndrasNet ``redaction_verify``. This LCT module ships the hardened matcher
locally (contention-safe — it does not touch the actively-edited synthesis
package) and is the thing IndrasNet's canonical should converge to. The forbidden
set is pinned in ``privacy_boundary_map.json`` (not auto-derived from contacts
consent yet — documented follow-up).

KNOWN RESIDUALS (codex GO-gate, 2026-06-21 — stated, not silently dropped):
  * The text scanner decodes raw + JSON-``\\u`` + percent views; it does NOT
    defeat base64 blobs, homoglyph / zero-width-joiner obfuscation, or a name
    carried in a header / URL / multipart field. ADR-038 already states leak-verify
    is a floor, not a semantic panacea — those need semantic adjudication.
  * Tier is by hostname, not DNS/CNAME proof — the same locality-trust model as
    ``egress_guard`` (a frontier host behind a local-looking suffix is policy
    trust). Conservative default: unknown remote → E4 → scanned.
  * Cloud WEBSOCKET text payloads are not per-message scanned; LCT's only cloud
    websocket is realtime AUDIO STT, which IS audio-gated. A cloud-text-websocket
    would need its own gate (none exists in LCT today).
  * ``spawn_external_cli`` reduces but cannot eliminate a networked child's
    exfiltration (it keeps its own network + can read absolute paths we didn't
    hand it). The real guarantee is "the stdin + argv we send carry no forbidden
    NAME". Migrating the production synthesis/eval spawns onto it is deferred.
"""

from __future__ import annotations

import json
import logging
import os
import re
import subprocess
import tempfile
import unicodedata
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path
from typing import Iterable, Optional
from urllib.parse import urlparse

from lct_python_backend.services.egress_guard import (
    CloudEgressBlocked,
    is_local_host,
    local_only_enabled,
)

logger = logging.getLogger("lct_backend")

_MAP_PATH = Path(__file__).with_name("privacy_boundary_map.json")


# --- exceptions --------------------------------------------------------------

class UnverifiedEgressBlocked(CloudEgressBlocked):
    """Raised when E3/E4 outbound bytes are not redaction-clean (or cannot be
    verified). Subclasses ``CloudEgressBlocked`` so existing ``except
    CloudEgressBlocked`` handlers fail closed on it too."""


class BoundaryMapUnavailable(RuntimeError):
    """The canonical privacy map could not be loaded — the boundary fails CLOSED
    (block E3/E4) rather than pass everything (finding 1.9)."""


# --- engine tiers (ADR-038 D5) ----------------------------------------------

REDACTION_REQUIRED_TIERS = frozenset({"E3", "E4"})

# Owner-controlled infra that is non-local but billed/owned (Modal). Tiered E2.
_MODAL_SUFFIX = ".modal.run"


def _host_of(url: str) -> str:
    try:
        parsed = urlparse(url if "://" in str(url) else f"http://{url}")
    except Exception:
        return ""
    host = parsed.hostname or ""
    return host.strip().lower()


def classify_engine_tier(url: str) -> str:
    """Map a destination URL to an engine tier E1..E4 by REAL host identity.

    Deliberately does NOT consult ``LCT_LOCAL_ONLY_ALLOW_HOSTS`` — allowlisting a
    frontier host (an egress escape hatch) must NOT downgrade it out of the
    redaction-required tier. Locality here means genuinely-local infra only.

      * E1 — loopback / RFC1918 LAN / Tailscale CGNAT / ``*.ts.net`` / ``*.local``
      * E2 — ``*.modal.run`` (owner-rented, non-local but owned)
      * E4 — everything else (public frontier or unknown remote; conservative)

    E3 (BAA/privacy-committed cloud) is reserved; without a reliable host signal
    we treat all non-modal remotes as E4 (mandatory redaction) — fail-closed.
    """
    host = _host_of(url)
    if not host:
        # No parseable host → cannot prove it is local → treat as frontier.
        return "E4"
    if host.endswith(_MODAL_SUFFIX):
        return "E2"
    # _local_infra_host: loopback / LAN / Tailscale / .ts.net / .local, WITHOUT
    # the user allowlist (which is_local_host would also honor).
    if _is_local_infra_host(host):
        return "E1"
    return "E4"


def _is_local_infra_host(host: str) -> bool:
    """Locality for TIERING — genuine local infra only, ignoring the egress
    allowlist. Mirrors egress_guard.is_local_host's IP/suffix logic but never the
    LCT_LOCAL_ONLY_ALLOW_HOSTS escape hatch."""
    import ipaddress

    h = host.strip().lower()
    if h.startswith("[") and "]" in h:
        h = h[1 : h.index("]")]
    elif h.count(":") == 1:
        h = h.split(":", 1)[0]
    # MUST stay consistent with egress_guard.is_local_host (the locality
    # authority): loopback + Tailscale + LAN only. host.docker.internal is
    # deliberately NOT local under the owner's strict 2026-06-04 decision — both
    # this tier/audio predicate AND egress_guard treat it as non-local, so there's
    # no split-brain (codex round-3). Making docker truly local is one owner
    # decision in egress_guard, not a divergence here.
    if h in {"localhost", "ip6-localhost"}:
        return True
    if h.endswith(".ts.net") or h.endswith(".local") or h == "local":
        return True
    try:
        ip = ipaddress.ip_address(h)
    except ValueError:
        return False
    if ip.is_loopback or ip.is_private or ip.is_link_local:
        return True
    if ip.version == 4 and ip in ipaddress.ip_network("100.64.0.0/10"):
        return True
    return False


def url_is_local_infra(url: str) -> bool:
    """Public: is the URL's host genuinely-local infra (for the audio backstop)?"""
    return _is_local_infra_host(_host_of(url))


def egress_requires_leak_verify(url: str) -> bool:
    """True iff a send to ``url`` must be leak-verified (E3/E4)."""
    return classify_engine_tier(url) in REDACTION_REQUIRED_TIERS


# --- the pinned consent map --------------------------------------------------

@dataclass(frozen=True)
class BoundaryMap:
    map_id: str
    version: str
    forbidden: tuple[str, ...]          # real names that must not leak (E3/E4)
    forward: dict[str, str]             # real name -> pseudonym (longest-first redact)
    reverse: dict[str, str]             # pseudonym -> real name (restore)
    owner_is_forbidden: bool


@lru_cache(maxsize=1)
def load_boundary_map() -> BoundaryMap:
    """Load + cache the pinned map. Raises ``BoundaryMapUnavailable`` on any
    problem so callers fail CLOSED rather than silently with an empty forbidden
    set (finding 1.9)."""
    try:
        data = json.loads(_MAP_PATH.read_text(encoding="utf-8"))
    except Exception as exc:  # missing / malformed JSON
        raise BoundaryMapUnavailable(f"cannot load {_MAP_PATH.name}: {exc}") from exc

    people = data.get("people")
    if not isinstance(people, list) or not people:
        raise BoundaryMapUnavailable(f"{_MAP_PATH.name} has no 'people'")

    owner_forbidden = bool(data.get("owner_is_forbidden", True))
    forbidden: list[str] = []
    forward: dict[str, str] = {}
    reverse: dict[str, str] = {}
    for person in people:
        if person.get("is_owner") and not owner_forbidden:
            continue  # owner opted out of self-redaction
        pseud = person.get("pseudonym")
        names = [person.get("canonical"), *(person.get("aliases") or [])]
        names = [n for n in names if n]
        for n in names:
            forbidden.append(n)
            if pseud:
                forward[n] = pseud
        if pseud and names:
            # restore picks the shortest, most conversational real form
            reverse.setdefault(pseud, min(names, key=len))
            if pseud.startswith("[") and pseud.endswith("]"):
                reverse.setdefault(pseud[1:-1], reverse[pseud])

    # Dedup forbidden case-insensitively, keep one representative spelling.
    seen: set[str] = set()
    deduped: list[str] = []
    for n in forbidden:
        k = n.lower()
        if k not in seen:
            seen.add(k)
            deduped.append(n)

    if not deduped:
        raise BoundaryMapUnavailable(f"{_MAP_PATH.name} yields an empty forbidden set")

    return BoundaryMap(
        map_id=str(data.get("map_id", "unknown")),
        version=str(data.get("version", "0")),
        forbidden=tuple(deduped),
        forward=forward,
        reverse=reverse,
        owner_is_forbidden=owner_forbidden,
    )


def boundary_forbidden_names() -> tuple[str, ...]:
    """The pinned forbidden set; raises ``BoundaryMapUnavailable`` (fail-closed)."""
    return load_boundary_map().forbidden


def reload_boundary_map() -> None:
    """Drop the cached map so the next call re-reads ``privacy_boundary_map.json``.
    The map is ``lru_cached`` (a pinned config read once); call this after editing
    the map at runtime (codex review, Finding 7 — otherwise a change is hidden
    until process restart). Corruption AFTER a good load keeps the last-good cached
    copy until reload, which is the safer failure mode."""
    load_boundary_map.cache_clear()


# --- the leak-verify primitive (hardened matcher) ----------------------------

@dataclass(frozen=True)
class LeakReport:
    """Result of ``leak_verify``. The egress gate keys on ``leaks_clean`` ONLY;
    ``quality_ok`` (expected-pseudonym presence) is advisory and NEVER blocks
    (ADR-038 finding 1.6 — a leak-free payload merely missing an expected
    pseudonym is stamped clean, not refused)."""

    leaks_clean: bool
    leaks: list[tuple[str, int]] = field(default_factory=list)        # (name, offset)
    expected_pseudonyms_missing: list[str] = field(default_factory=list)
    quality_ok: bool = True
    body_chars: int = 0


def _nfc(s: str) -> str:
    return unicodedata.normalize("NFC", s)


@lru_cache(maxsize=512)
def _leak_pattern(needle_nfc: str) -> "re.Pattern[str]":
    """Whole-word, case-insensitive, Unicode-aware (``re`` on ``str`` makes ``\\b``
    Unicode by default) — so Devanagari spellings and ``Vatsal's`` are caught
    while ``Mehra`` inside another word is not."""
    return re.compile(rf"\b{re.escape(needle_nfc)}\b", re.IGNORECASE)


def _json_unescape(text: str) -> Optional[str]:
    if "\\u" not in text:
        return None
    try:
        out = re.sub(r"\\u([0-9a-fA-F]{4})", lambda m: chr(int(m.group(1), 16)), text)
        return out if out != text else None
    except Exception:
        return None


def _percent_decode(text: str) -> Optional[str]:
    if "%" not in text:
        return None
    try:
        from urllib.parse import unquote

        out = unquote(text)
        return out if out != text else None
    except Exception:
        return None


def _decoded_views(text: str) -> list[str]:
    """The raw text plus the realistic re-encodings a name could hide behind on
    the wire — JSON ``\\uXXXX`` escapes (the OpenAI SDK does ``json.dumps(
    ensure_ascii=True)``, so a NON-ASCII forbidden name ships ``\\u``-escaped) and
    percent/form-encoding. Decoders are applied to a BOUNDED FIXPOINT so a COMPOSED
    encoding (``%2556atsal`` → ``%56atsal`` → ``Vatsal``) is also caught (codex
    round-2). KNOWN RESIDUALS not decoded (semantic-not-string per ADR-038): base64
    blobs, homoglyph / zero-width-joiner obfuscation, and a name in a header / URL /
    multipart field rather than the JSON body."""
    views = [text]
    seen = {text}
    frontier = [text]
    for _ in range(4):  # bounded to avoid a decode-bomb DoS
        nxt: list[str] = []
        for t in frontier:
            for decoder in (_json_unescape, _percent_decode):
                d = decoder(t)
                if d is not None and d not in seen:
                    seen.add(d)
                    views.append(d)
                    nxt.append(d)
        if not nxt:
            break
        frontier = nxt
    return views


def leak_verify(
    data: "bytes | str",
    *,
    forbidden: Optional[Iterable[str]] = None,
    expected_pseudonyms: Optional[Iterable[str]] = None,
) -> LeakReport:
    """Deterministic leaks-only scan over the EXACT bytes/text about to leave.

    Bytes are decoded utf-8 (``errors='replace'``) then NFC-normalized; the body
    is also scanned through its JSON-``\\u`` and percent-decoded views so an
    ``ensure_ascii``-escaped or form-encoded name cannot slip the check (codex
    review, Bug 6). ``forbidden`` defaults to the pinned canonical set.
    """
    if forbidden is None:
        forbidden = boundary_forbidden_names()
    forbidden = list(forbidden)

    if isinstance(data, (bytes, bytearray)):
        text = bytes(data).decode("utf-8", errors="replace")
    else:
        text = data or ""
    primary = _nfc(text)

    leaks: list[tuple[str, int]] = []
    for view in _decoded_views(text):
        norm = _nfc(view)
        for needle in forbidden:
            if not needle:
                continue
            for m in _leak_pattern(_nfc(needle)).finditer(norm):
                leaks.append((needle, m.start()))
    leaks.sort(key=lambda t: t[1])

    missing: list[str] = []
    for pseud in list(expected_pseudonyms or []):
        if pseud and pseud not in primary:
            missing.append(pseud)

    return LeakReport(
        leaks_clean=not leaks,
        leaks=leaks,
        expected_pseudonyms_missing=missing,
        quality_ok=not missing,
        body_chars=len(primary),
    )


def assert_body_clean(data: "bytes | str", url: str = "") -> LeakReport:
    """Egress gate: leak-verify ``data`` for an E3/E4 destination. Raises
    ``UnverifiedEgressBlocked`` if a forbidden name survives OR the canonical map
    is unavailable (fail-closed). Returns the clean report otherwise."""
    try:
        forbidden = boundary_forbidden_names()
    except BoundaryMapUnavailable as exc:
        raise UnverifiedEgressBlocked(
            f"refusing E3/E4 send to {_host_of(url)!r}: no canonical privacy map ({exc})"
        ) from exc

    report = leak_verify(data, forbidden=forbidden)
    if not report.leaks_clean:
        names = sorted({n for n, _ in report.leaks})
        raise UnverifiedEgressBlocked(
            f"PRIVACY LEAK blocked at egress to {_host_of(url)!r}: "
            f"{len(report.leaks)} forbidden name occurrence(s) {names} in "
            f"{report.body_chars}c payload. Redact before sending to a frontier engine."
        )
    return report


# --- redact / restore (pinned-map convenience) -------------------------------

def redact(text: str) -> str:
    """Replace real names with pseudonyms, longest-source-first, case-insensitive."""
    bmap = load_boundary_map()
    out = text or ""
    for name in sorted(bmap.forward, key=len, reverse=True):
        out = re.sub(re.escape(name), bmap.forward[name], out, flags=re.IGNORECASE)
    return out


def restore(text: str) -> str:
    """Inverse of redact for a LOCAL-ONLY result (cosmetic, best-effort)."""
    bmap = load_boundary_map()
    out = text or ""
    for pseud in sorted(bmap.reverse, key=len, reverse=True):
        real = bmap.reverse[pseud]
        if pseud.startswith("[") and pseud.endswith("]"):
            out = re.sub(re.escape(pseud), real, out, flags=re.IGNORECASE)
        else:
            out = re.sub(rf"\b{re.escape(pseud)}\b", real, out, flags=re.IGNORECASE)
    return out


# --- the sanctioned frontier-CLI door (move 2) -------------------------------

# Env vars a frontier CLI legitimately needs to find its login/config on Windows
# + POSIX. Anything NOT on this allowlist (LCT API keys, DB URLs, AUTH_TOKEN, …)
# is dropped so a leaked secret can't ride the child's environment.
_CLI_ENV_ALLOW = (
    "PATH", "SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "COMSPEC", "PATHEXT",
    "TEMP", "TMP", "TMPDIR", "HOME", "HOMEDRIVE", "HOMEPATH", "USERPROFILE",
    "APPDATA", "LOCALAPPDATA", "USERNAME", "LANG", "LC_ALL",
    # CLI-specific config/login homes (so auth still resolves):
    "CLAUDE_CONFIG_DIR", "CODEX_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME",
    "ANTHROPIC_API_KEY", "OPENAI_API_KEY",  # the CLI's OWN auth, if key-based
)

_FRONTIER_BINARIES = frozenset({"claude", "codex", "gemini", "grok"})


def is_frontier_cli(token: str) -> bool:
    """True if ``token`` invokes a known frontier-LLM CLI. Splits on whitespace and
    quotes so a SHELL-STRING launcher (``cmd /c "claude -p"``, ``sh -lc "claude …"``)
    is detected, not just a bare ``claude`` basename (codex round-3 B2). Residual:
    arbitrary in-shell obfuscation (``cla''ude``) is not defeated — the helper is for
    direct/simple-launcher invocation, not adversarial shell injection by the caller."""
    for word in re.split(r"[\s'\"]+", str(token)):
        if not word:
            continue
        base = os.path.basename(word).lower()
        for ext in (".exe", ".cmd", ".bat", ".ps1"):
            if base.endswith(ext):
                base = base[: -len(ext)]
                break
        if base in _FRONTIER_BINARIES:
            return True
    return False


def _scrubbed_env() -> dict:
    """Minimal env: only what a frontier CLI needs to find its login/config. No
    caller-supplied ``extra_env`` (codex review, Bug 4: it would defeat the scrub
    by re-introducing secrets/paths into the child)."""
    allow = {e.upper() for e in _CLI_ENV_ALLOW}
    return {k: v for k, v in os.environ.items() if k.upper() in allow}


def spawn_external_cli(
    argv: list[str],
    *,
    redacted_input: str,
    engine_tier: str = "E4",
    timeout: float = 600.0,
) -> "subprocess.CompletedProcess[bytes]":
    """The ONE sanctioned way to spawn a frontier CLI. Leak-verifies the EXACT
    stdin bytes AND argv BEFORE the spawn (owning encode→scan→spawn so there is no
    gap between what is scanned and what is written — finding 1.1), and sandboxes
    the child (empty temp cwd, scrubbed env, ``close_fds=True``). See module
    docstring for the honest residual (a networked child is not fully containable).
    """
    body = redacted_input.encode("utf-8")

    # codex review, Bug 2: a frontier binary ALWAYS requires scanning — a caller
    # must NOT opt out via engine_tier="E1". Classify ANY argv token, not just
    # argv[0], so a launcher form (``cmd /c claude -p``) cannot self-downgrade.
    effective_tier = engine_tier
    if argv and any(is_frontier_cli(a) for a in argv) and effective_tier not in REDACTION_REQUIRED_TIERS:
        effective_tier = "E4"

    if effective_tier in REDACTION_REQUIRED_TIERS:
        assert_body_clean(body, url="cli:" + (argv[0] if argv else "?"))
        # codex review, Bug 3: a forbidden name can ride ANY argv token — the
        # prompt/flags AND the binary path (``C:\\Users\\Vatsal\\...``). Scan all.
        if argv:
            assert_body_clean("\x00".join(str(a) for a in argv),
                              url="cli-argv:" + str(argv[0]))

    # Defense-in-depth: an absolute path to an existing file in argv could direct
    # the child to read it. leak_verify catches NAMES, not paths — so refuse
    # path-bearing argv for a sandboxed frontier spawn.
    for tok in argv[1:]:
        t = str(tok)
        if os.path.isabs(t) and os.path.exists(t):
            raise UnverifiedEgressBlocked(
                f"refusing frontier spawn: argv carries an absolute existing path {t!r} "
                "(could exfiltrate a private file the stdin scan cannot see)"
            )

    workdir = tempfile.mkdtemp(prefix="lct_cli_")
    try:
        return subprocess.run(
            argv,
            input=body,
            cwd=workdir,
            env=_scrubbed_env(),
            close_fds=True,            # Windows-correct isolation (pass_fds=() is POSIX-only)
            capture_output=True,
            timeout=timeout,
        )
    finally:
        try:
            os.rmdir(workdir)
        except OSError:
            pass  # child may have written transient files; best-effort cleanup


# --- audio hard-gate (codex blocker 2) ---------------------------------------

class AudioEgressBlocked(CloudEgressBlocked):
    """Raised when raw audio would leave for a non-local host. You cannot redact a
    voice, so cloud audio is binary-gated, independent of LCT_LOCAL_ONLY."""


def _cloud_audio_allowed() -> bool:
    flag = os.getenv("LCT_ALLOW_CLOUD_AUDIO", "")
    return flag.strip().lower() in {"1", "true", "yes", "on"}


def assert_audio_egress_allowed(url: str, *, purpose: str = "") -> None:
    """Keep raw voice LOCAL-ONLY even when ``LCT_LOCAL_ONLY=0`` (codex blocker 2).

    ``assert_local_egress`` already blocks non-local audio when local-only is ON;
    this closes the LOCAL_ONLY=0 hole where realtime/HTTP STT streamed raw audio
    to the cloud ungated. Cloud audio requires an explicit ``LCT_ALLOW_CLOUD_AUDIO=1``.
    """
    host = _host_of(url)
    if _is_local_infra_host(host):
        return
    if _cloud_audio_allowed():
        return
    raise AudioEgressBlocked(
        f"raw audio egress to {host!r} blocked"
        + (f" ({purpose})" if purpose else "")
        + ". Audio cannot be redacted; it stays local-only. Set "
        "LCT_ALLOW_CLOUD_AUDIO=1 to explicitly opt in to cloud STT."
    )


# --- bootstrap (finding 1.3) -------------------------------------------------

def bootstrap_egress() -> None:
    """Idempotent process-entry installer for the egress chokepoint. Call FIRST,
    before route/service modules import, at every E3/E4-capable entrypoint. Safe
    to call repeatedly (the underlying installer guards itself)."""
    from lct_python_backend.services.egress_chokepoint import install_egress_chokepoint

    install_egress_chokepoint()
