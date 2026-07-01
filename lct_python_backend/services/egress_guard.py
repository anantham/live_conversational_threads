"""Local-only egress guard — the single switch you can trust.

The problem this solves: "run the same audio through the pipeline many times
without spending cloud credits" was previously governed by ~5 independent
flags (STT ``local_only``, ``live_cloud_fallback_enabled``, per-provider
``enabled`` that flips true whenever an API key exists, LLM ``mode``, the LLM
provider list) plus three direct-SDK bypasses (OpenAI embeddings, Anthropic
claim/bias, Perplexity fact-check). No single switch governed them, so none
could be trusted.

This module is that single switch. When local-only is ON, every outbound
network call funnels through ``assert_local_egress(url)`` and anything that
is not a local host is REFUSED (raises ``CloudEgressBlocked``). New cloud
providers added later are blocked by default — fail-closed, not fail-open.

"Local" (strict, per owner decision 2026-06-04) = loopback + Tailscale +
LAN only:
  - 127.0.0.0/8, ::1, ``localhost``
  - Tailscale CGNAT 100.64.0.0/10 and ``*.ts.net``
  - RFC1918 LAN (10/8, 172.16/12, 192.168/16), ``*.local``
Explicitly BLOCKED even though they are the owner's own infra: ``*.modal.run``
(billed per-second) and all third-party paid APIs (OpenAI / OpenRouter /
Anthropic / Perplexity / Google).

Trust model: the switch is read from the ``LCT_LOCAL_ONLY`` environment
variable (default ON). It is intentionally process/startup-scoped, NOT a
DB/HTTP-mutable setting, so a compromised or buggy settings endpoint cannot
silently turn egress back on at runtime. An optional allowlist
(``LCT_LOCAL_ONLY_ALLOW_HOSTS``, comma-separated host globs) exists as an
escape hatch but is empty by default.
"""

from __future__ import annotations

import contextlib
import contextvars
import fnmatch
import ipaddress
import logging
import os
from urllib.parse import urlparse

logger = logging.getLogger("lct_backend")


class CloudEgressBlocked(RuntimeError):
    """Raised when local-only mode refuses a non-local outbound call."""


_LOCAL_HOST_SUFFIXES = (".ts.net", ".local")
_LOCALHOST_NAMES = {"localhost", "ip6-localhost"}


def local_only_enabled() -> bool:
    """Master switch. ``LCT_LOCAL_ONLY`` wins; default ON (fail-closed).

    Default ON codifies the existing local-first setup (STT_LOCAL_ONLY and
    LLM mode already default local) and guarantees zero cloud spend on
    repeated test runs. Set ``LCT_LOCAL_ONLY=0`` to allow cloud/Modal (the
    ADR-034 public profile does this — a VPS has no local GPU).
    """
    flag = os.getenv("LCT_LOCAL_ONLY")
    if flag is not None and flag.strip() != "":
        return flag.strip().lower() in {"1", "true", "yes", "on"}
    return True


def _extra_allow_globs() -> list[str]:
    raw = os.getenv("LCT_LOCAL_ONLY_ALLOW_HOSTS", "")
    return [g.strip().lower() for g in raw.split(",") if g.strip()]


# --- Import-scoped egress allowlist ----------------------------------------
# A context-local set of host globs that ``assert_local_egress`` additionally
# permits, ONLY inside an ``import_egress_allow(...)`` block. This lets one
# specific outbound fetch (e.g. a Google Docs export) reach a narrow set of
# hosts WITHOUT widening the process-wide ``LCT_LOCAL_ONLY_ALLOW_HOSTS`` for
# every other call. Being a ContextVar it propagates across ``await`` in the
# same task (so a chokepoint-wrapped httpx.send inside the block sees it) and
# is reset on block exit — it can never leak to an unrelated request.
_scoped_allow_hosts: contextvars.ContextVar[tuple[str, ...]] = contextvars.ContextVar(
    "lct_scoped_egress_allow", default=()
)


@contextlib.contextmanager
def import_egress_allow(host_globs):
    """Temporarily permit egress to ``host_globs`` (fnmatch globs) for this context only.

    Scoped to the current context, NOT the global env — the allowlist is reset when
    the block exits and cannot affect any other (sequential) outbound call.

    CAVEAT: do NOT spawn asyncio tasks (``create_task`` / ``TaskGroup``) inside the
    block. A child task copies the ContextVar at creation time and would RETAIN the
    allowlist after the block exits. The gdoc fetcher awaits httpx directly in the
    same task, so it is safe; keep any future caller task-free inside the block.
    """
    normalized = tuple(g.strip().lower() for g in (host_globs or ()) if g and g.strip())
    token = _scoped_allow_hosts.set(normalized)
    try:
        yield
    finally:
        _scoped_allow_hosts.reset(token)


def _host_in_scoped_allow(host: str) -> bool:
    if not host:
        return False
    h = host.strip().lower()
    return any(fnmatch.fnmatch(h, glob) for glob in _scoped_allow_hosts.get())


def is_local_host(host: str) -> bool:
    """True if ``host`` (a hostname or IP) is loopback / Tailscale / LAN."""
    if not host:
        return False
    h = host.strip().lower()
    # strip a possible port and IPv6 brackets
    if h.startswith("[") and "]" in h:
        h = h[1 : h.index("]")]
    elif h.count(":") == 1:  # host:port (not bare IPv6)
        h = h.split(":", 1)[0]

    if h in _LOCALHOST_NAMES:
        return True
    if any(h == s.lstrip(".") or h.endswith(s) for s in _LOCAL_HOST_SUFFIXES):
        return True
    if any(fnmatch.fnmatch(h, glob) for glob in _extra_allow_globs()):
        return True

    try:
        ip = ipaddress.ip_address(h)
    except ValueError:
        # A non-IP, non-allowlisted hostname (e.g. api.openai.com,
        # foo.modal.run) is NOT local.
        return False

    if ip.is_loopback or ip.is_private or ip.is_link_local:
        return True
    # Tailscale CGNAT range 100.64.0.0/10
    if ip.version == 4 and ip in ipaddress.ip_network("100.64.0.0/10"):
        return True
    return False


def is_local_url(url: str) -> bool:
    try:
        parsed = urlparse(url if "://" in str(url) else f"http://{url}")
    except Exception:
        return False
    return is_local_host(parsed.hostname or "")


def assert_local_egress(url: str, *, purpose: str = "") -> None:
    """Refuse a non-local outbound call when local-only mode is ON.

    No-op when local-only is OFF. Call this immediately before any outbound
    HTTP request / cloud SDK call at an egress funnel.
    """
    if not local_only_enabled():
        return
    if is_local_url(url):
        return
    host = urlparse(url if "://" in str(url) else f"http://{url}").hostname or url
    if _host_in_scoped_allow(host):
        return
    msg = (
        f"local-only mode blocked a non-local call to {host!r}"
        + (f" ({purpose})" if purpose else "")
        + ". Set LCT_LOCAL_ONLY=0 to allow cloud egress, or add the host to "
        "LCT_LOCAL_ONLY_ALLOW_HOSTS."
    )
    logger.warning("[egress-guard] %s", msg)
    raise CloudEgressBlocked(msg)
