"""ADR-059 PR-2 (gdoc-egress SSRF core) — the Google Docs import fetcher follows the
export URL's redirects SSRF-safely: egress is context-scoped to a narrow allowlist,
and EVERY hop is re-validated (public host + allowlist). These tests pin that security
boundary plus the fetch mechanics, hermetically (no live network — httpx.MockTransport
+ a stubbed public-host check; literal internal IPs are checked for real).
"""

from __future__ import annotations

import asyncio

import httpx
import pytest
from fastapi import HTTPException

from lct_python_backend.services.egress_guard import (
    CloudEgressBlocked,
    assert_local_egress,
    import_egress_allow,
)
from lct_python_backend.services.import_pipeline import import_fetchers as fetch


# --- gdoc_export_url: recognize a Google Docs document URL -----------------


def test_gdoc_export_url_recognizes_document():
    got = fetch.gdoc_export_url(
        "https://docs.google.com/document/d/ABC123_-x/edit?usp=sharing"
    )
    assert got == "https://docs.google.com/document/d/ABC123_-x/export?format=txt"


@pytest.mark.parametrize(
    "url",
    [
        "https://example.com/document/d/ABC/edit",      # wrong host
        "https://docs.google.com/spreadsheets/d/ABC",   # not a document
        "http://docs.google.com/document/d/ABC",        # http (must be https)
        "https://docs.google.com/document/d/",          # no doc id
        "",
        "not a url",
    ],
)
def test_gdoc_export_url_rejects_non_gdoc(url):
    assert fetch.gdoc_export_url(url) is None


# --- the context-scoped egress allowlist -----------------------------------


def test_scoped_allow_permits_only_inside_block(monkeypatch):
    monkeypatch.setenv("LCT_LOCAL_ONLY", "1")
    url = "https://docs.google.com/document/d/ABC/export?format=txt"

    # Outside the block: local-only blocks the non-local host.
    with pytest.raises(CloudEgressBlocked):
        assert_local_egress(url)

    # Inside the block: the allowlisted host is permitted.
    with import_egress_allow(["docs.google.com"]):
        assert_local_egress(url)  # must not raise

    # After the block: reset — blocked again (no leak).
    with pytest.raises(CloudEgressBlocked):
        assert_local_egress(url)


def test_scoped_allow_does_not_widen_to_other_hosts(monkeypatch):
    monkeypatch.setenv("LCT_LOCAL_ONLY", "1")
    with import_egress_allow(["docs.google.com"]):
        # a DIFFERENT non-local host stays blocked even inside the block
        with pytest.raises(CloudEgressBlocked):
            assert_local_egress("https://api.openai.com/v1/chat")


def test_scoped_allow_visible_across_await(monkeypatch):
    """The ContextVar propagates into an awaited coroutine in the same task — which
    is exactly what lets the chokepoint-wrapped async httpx.send see the allowlist."""
    monkeypatch.setenv("LCT_LOCAL_ONLY", "1")
    url = "https://abc.googleusercontent.com/doc"

    async def _inner():
        await asyncio.sleep(0)
        assert_local_egress(url)  # set by the outer with-block; must not raise

    async def _run():
        with import_egress_allow(["*.googleusercontent.com"]):
            await _inner()

    asyncio.run(_run())  # no raise


# --- the per-hop SSRF gate --------------------------------------------------


def test_hop_gate_allows_gdoc_hosts(monkeypatch):
    # stub the public-DNS check so the test is hermetic (no real getaddrinfo)
    monkeypatch.setattr(fetch, "assert_url_resolves_to_public_host", lambda url: None)
    fetch._assert_gdoc_hop_allowed(
        "https://docs.google.com/document/d/A/export?format=txt"
    )
    fetch._assert_gdoc_hop_allowed("https://xyz.googleusercontent.com/blob")  # no raise


def test_hop_gate_blocks_off_allowlist(monkeypatch):
    monkeypatch.setattr(fetch, "assert_url_resolves_to_public_host", lambda url: None)
    with pytest.raises(HTTPException):
        fetch._assert_gdoc_hop_allowed("https://evil.example.com/x")


def test_hop_gate_blocks_internal_ip_for_real():
    # 169.254.169.254 (cloud metadata IMDS) is a literal link-local IP → blocked by the
    # REAL public-host check, no DNS needed → hermetic. https so it reaches that check
    # (the scheme gate would otherwise short-circuit an http URL first).
    with pytest.raises(HTTPException):
        fetch._assert_gdoc_hop_allowed("https://169.254.169.254/latest/meta-data/")


def test_hop_gate_rejects_non_https():
    with pytest.raises(HTTPException):
        fetch._assert_gdoc_hop_allowed("http://docs.google.com/document/d/A/export")


def test_host_allowlist_rejects_lookalikes():
    assert fetch._host_is_allowed_gdoc("docs.google.com") is True
    assert fetch._host_is_allowed_gdoc("x.googleusercontent.com") is True
    assert fetch._host_is_allowed_gdoc("docs.google.com.attacker.com") is False
    assert fetch._host_is_allowed_gdoc("notgoogleusercontent.com") is False
    assert fetch._host_is_allowed_gdoc("googleusercontent.com") is False  # needs a subdomain
    assert fetch._host_is_allowed_gdoc("evil.com") is False


# --- download_gdoc_text: redirect-follow, hermetic via MockTransport --------


def _run_download(handler, monkeypatch, url="https://docs.google.com/document/d/ABC/edit"):
    # MockTransport hosts don't really resolve — stub the public check; the allowlist
    # + content-type gates are what these tests exercise.
    monkeypatch.setattr(fetch, "assert_url_resolves_to_public_host", lambda u: None)
    transport = httpx.MockTransport(handler)
    return asyncio.run(fetch.download_gdoc_text(url, _transport=transport))


def test_download_follows_redirect_to_googleusercontent(monkeypatch):
    def handler(request):
        if request.url.host == "docs.google.com":
            return httpx.Response(
                302, headers={"location": "https://x.googleusercontent.com/doc"}
            )
        return httpx.Response(
            200, headers={"content-type": "text/plain; charset=utf-8"}, text="hello world"
        )

    assert _run_download(handler, monkeypatch) == "hello world"


def test_download_blocks_redirect_off_allowlist(monkeypatch):
    """A redirect to a non-allowlisted host (here the IMDS IP) is refused BEFORE the
    fetch — the SSRF defense against an attacker-controlled Location header."""

    def handler(request):
        if request.url.host == "docs.google.com":
            return httpx.Response(302, headers={"location": "https://169.254.169.254/latest/"})
        return httpx.Response(200, headers={"content-type": "text/plain"}, text="secret")

    with pytest.raises(HTTPException):
        _run_download(handler, monkeypatch)


def test_download_blocks_http_downgrade_redirect(monkeypatch):
    """A redirect that downgrades to http (even on an allowlisted host) is refused."""

    def handler(request):
        return httpx.Response(302, headers={"location": "http://x.googleusercontent.com/doc"})

    with pytest.raises(HTTPException):
        _run_download(handler, monkeypatch)


def test_download_rejects_missing_content_type(monkeypatch):
    """A 200 with NO Content-Type header is rejected (not assumed to be the doc body)."""

    def handler(request):
        if request.url.host == "docs.google.com":
            return httpx.Response(302, headers={"location": "https://x.googleusercontent.com/doc"})
        # content= (bytes) does not auto-set a Content-Type, unlike text=
        return httpx.Response(200, content=b"body with no content-type header")

    with pytest.raises(HTTPException):
        _run_download(handler, monkeypatch)


def test_download_rejects_non_text_content_type(monkeypatch):
    """A text/html login/error page from an allowlisted host is rejected (not treated
    as the document body)."""

    def handler(request):
        if request.url.host == "docs.google.com":
            return httpx.Response(
                302, headers={"location": "https://x.googleusercontent.com/doc"}
            )
        return httpx.Response(
            200, headers={"content-type": "text/html"}, text="<html>login</html>"
        )

    with pytest.raises(HTTPException):
        _run_download(handler, monkeypatch)


def test_download_rejects_redirect_loop(monkeypatch):
    def handler(request):
        # always redirect (within the allowlist) → exceed GDOC_MAX_REDIRECTS
        return httpx.Response(302, headers={"location": "https://x.googleusercontent.com/next"})

    with pytest.raises(HTTPException):
        _run_download(handler, monkeypatch)


def test_download_rejects_non_gdoc_url():
    with pytest.raises(HTTPException):
        asyncio.run(fetch.download_gdoc_text("https://example.com/not-a-doc"))


# --- load-bearing integration: the REAL chokepoint honors the scoped allow --


@pytest.mark.asyncio
async def test_chokepoint_honors_scoped_allow(monkeypatch):
    """END-TO-END: with the network chokepoint installed, a gdoc host is blocked
    normally but PERMITTED inside import_egress_allow — proving the ContextVar reaches
    the chokepoint-wrapped httpx.send. This is the load-bearing property of the whole
    design: the fetch succeeds ONLY because the scoped allow lets it past the guard,
    and WITHOUT widening egress for any other host. Hermetic (MockTransport, no network).
    """
    from lct_python_backend.services.egress_chokepoint import (
        install_egress_chokepoint,
        uninstall_egress_chokepoint,
    )

    monkeypatch.setenv("LCT_LOCAL_ONLY", "1")
    monkeypatch.delenv("LCT_LOCAL_ONLY_ALLOW_HOSTS", raising=False)
    transport = httpx.MockTransport(lambda req: httpx.Response(200, text="ok"))
    install_egress_chokepoint()
    try:
        # Outside the scoped allow: the chokepoint blocks docs.google.com before send.
        async with httpx.AsyncClient(transport=transport) as client:
            with pytest.raises(CloudEgressBlocked):
                await client.get("https://docs.google.com/robots.txt")

        # Inside the scoped allow: the guard lets it through to the (mock) transport.
        with import_egress_allow(["docs.google.com"]):
            async with httpx.AsyncClient(transport=transport) as client:
                resp = await client.get("https://docs.google.com/robots.txt")
                assert resp.status_code == 200

        # A DIFFERENT host stays blocked even inside the block (no global widening).
        with import_egress_allow(["docs.google.com"]):
            async with httpx.AsyncClient(transport=transport) as client:
                with pytest.raises(CloudEgressBlocked):
                    await client.get("https://api.openai.com/v1/models")
    finally:
        uninstall_egress_chokepoint()
