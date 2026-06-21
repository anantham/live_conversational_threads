"""Unit tests for the ADR-038 privacy boundary primitive.

Covers the parts that are pure (no transport): the hardened matcher, the
leaks-only predicate (finding 1.6), tier classification, the fail-closed map,
the sandboxed CLI helper, and the audio hard-gate. The chokepoint integration
(request.content byte-check) lives in ``test_egress_redaction_gate.py``.
"""

import sys

import pytest

from lct_python_backend.services import privacy_boundary as pb
from lct_python_backend.services.privacy_boundary import (
    AudioEgressBlocked,
    UnverifiedEgressBlocked,
    assert_audio_egress_allowed,
    boundary_forbidden_names,
    classify_engine_tier,
    egress_requires_leak_verify,
    leak_verify,
    redact,
    restore,
    spawn_external_cli,
)


# --- tier classification (by real host identity, not the allowlist) ----------

@pytest.mark.parametrize("url,tier", [
    ("http://127.0.0.1:11434/v1/chat", "E1"),
    ("http://localhost:1234/v1", "E1"),
    ("http://100.83.228.35:11434/api", "E1"),          # Tailscale CGNAT
    ("http://192.168.1.50:8000/x", "E1"),              # LAN
    ("https://box.tail1234.ts.net/x", "E1"),
    ("https://x.modal.run/v1", "E2"),                  # owner-rented
    ("https://api.openai.com/v1/chat/completions", "E4"),
    ("https://api.anthropic.com/v1/messages", "E4"),
    ("https://generativelanguage.googleapis.com/v1", "E4"),
    ("https://openrouter.ai/api/v1", "E4"),
    ("not a url", "E4"),                               # unparseable -> conservative
])
def test_classify_engine_tier(url, tier):
    assert classify_engine_tier(url) == tier


def test_allowlist_does_not_downgrade_frontier(monkeypatch):
    # Allowlisting a frontier host (an egress escape hatch) must NOT move it out
    # of the redaction-required tier — classify ignores LCT_LOCAL_ONLY_ALLOW_HOSTS.
    monkeypatch.setenv("LCT_LOCAL_ONLY_ALLOW_HOSTS", "api.openai.com")
    assert classify_engine_tier("https://api.openai.com/v1/x") == "E4"
    assert egress_requires_leak_verify("https://api.openai.com/v1/x") is True
    assert egress_requires_leak_verify("http://127.0.0.1:11434/x") is False


# --- the pinned map ----------------------------------------------------------

def test_map_enrolls_all_people_incl_chin_aishwarya_owner():
    fb = {n.lower() for n in boundary_forbidden_names()}
    for required in ["vatsal", "vatsal mehra", "sahil", "bhishma",
                     "bhishmaraj", "chin", "aishwarya", "aditya"]:
        assert required in fb, f"{required!r} not enrolled in the pinned map"


# --- the hardened matcher / leaks-only predicate (finding 1.6, 1.7) ----------

def test_leak_caught_case_insensitive_and_possessive():
    r = leak_verify("we met vatsal's brother")
    assert not r.leaks_clean
    assert r.leaks[0][0] == "Vatsal"


def test_whole_word_avoids_substring_false_positive():
    # 'chin' is enrolled but must not match inside 'chinstrap' / 'machine'.
    r = leak_verify("the chinstrap on the machine was loose")
    assert r.leaks_clean, r.leaks


def test_pseudonym_only_payload_is_clean():
    r = leak_verify("[Friend A] and [Friend C] discussed the plan")
    assert r.leaks_clean


def test_bytes_and_unicode_nfc():
    # bytes input + a Devanagari needle, NFC-normalized on both sides.
    r = leak_verify("मैंने वत्सल से बात की".encode("utf-8"), forbidden=["वत्सल"])
    assert not r.leaks_clean


def test_leak_caught_through_json_unicode_escape():
    # JSON ensure_ascii ships names as \uXXXX literals in the body bytes; an ASCII
    # letter can be adversarially \u-escaped too. The scanner must decode the
    # escape, not see only the literal backslash sequence (codex Bug 6).
    body = '{"content":"meeting with V' + chr(92) + 'u0061tsal"}'  # a = 'a'
    assert "\\u0061" in body  # the literal escape is present (not pre-decoded)
    assert leak_verify(body).leaks_clean is False


def test_leak_caught_through_percent_encoding():
    # %56 = 'V'; the raw view has no "Vatsal", only the percent-decoded view does.
    body = "note=%56atsal+Mehra"
    assert "Vatsal" not in body
    assert leak_verify(body).leaks_clean is False


def test_leak_caught_through_composed_encoding():
    # codex round-2: %2556atsal -> %56atsal -> Vatsal (double percent). The
    # bounded-fixpoint decoder must catch the composed form.
    assert "Vatsal" not in "%2556atsal"
    assert leak_verify("%2556atsal").leaks_clean is False


def test_docker_internal_treated_nonlocal_consistently():
    # codex round-3: host.docker.internal must be NON-local CONSISTENTLY with
    # egress_guard (the locality authority) — no split-brain where the audio gate
    # says local but assert_local_egress blocks it. Both treat it as non-local.
    from lct_python_backend.services.egress_guard import is_local_host

    assert is_local_host("host.docker.internal") is False
    with pytest.raises(AudioEgressBlocked):
        assert_audio_egress_allowed("http://host.docker.internal:7777/api/transcribe")


def test_leaks_only_predicate_missing_pseudonym_does_not_block():
    # finding 1.6: a leak-free payload missing an expected pseudonym is CLEAN
    # (advisory quality_ok=False), never blocked.
    r = leak_verify("totally clean text", expected_pseudonyms=["[Friend A]"])
    assert r.leaks_clean is True
    assert r.quality_ok is False
    assert r.expected_pseudonyms_missing == ["[Friend A]"]


def test_redact_restore_roundtrip():
    src = "Vatsal Mehra and Sahil talked to Bhishmaraj S"
    red = redact(src)
    assert "Vatsal" not in red and "Sahil" not in red and "Bhishmaraj" not in red
    assert leak_verify(red).leaks_clean
    # restore is cosmetic/local; brings a conversational form back
    back = restore(red)
    assert "Vatsal" in back and "Sahil" in back


# --- fail-closed map (finding 1.9) -------------------------------------------

def test_assert_body_clean_fails_closed_without_map(monkeypatch):
    from lct_python_backend.services.privacy_boundary import (
        BoundaryMapUnavailable,
        assert_body_clean,
    )

    def _boom():
        raise BoundaryMapUnavailable("simulated missing map")

    monkeypatch.setattr(pb, "boundary_forbidden_names", _boom)
    with pytest.raises(UnverifiedEgressBlocked):
        assert_body_clean(b"anything", "https://api.openai.com/x")


# --- sanctioned CLI door (findings 1.1, 1.2) ---------------------------------

def test_spawn_blocks_forbidden_stdin_before_spawn():
    # A forbidden name on stdin is refused BEFORE the child is spawned.
    with pytest.raises(UnverifiedEgressBlocked):
        spawn_external_cli(
            [sys.executable, "-c", "import sys; sys.stdin.read()"],
            redacted_input="secret notes about Vatsal Mehra",
            engine_tier="E4",
        )


def test_spawn_scrubs_env_and_isolates_cwd(monkeypatch):
    monkeypatch.setenv("LCT_SECRET_PLANT", "topsecret-should-not-reach-child")
    code = (
        "import os,sys; sys.stdin.read();"
        "print('PLANT' if 'LCT_SECRET_PLANT' in os.environ else 'NOPLANT');"
        "print('FOUNDMAP' if os.path.exists('privacy_boundary_map.json') else 'ISOLATED')"
    )
    cp = spawn_external_cli(
        [sys.executable, "-c", code],
        redacted_input="[Friend A] only",
        engine_tier="E4",
    )
    out = cp.stdout.decode()
    assert "NOPLANT" in out, f"planted secret leaked into child env: {out!r}"
    assert "ISOLATED" in out, f"child cwd was not isolated from the repo: {out!r}"


def test_spawn_refuses_path_bearing_argv(tmp_path):
    planted = tmp_path / "private.txt"
    planted.write_text("secret")
    with pytest.raises(UnverifiedEgressBlocked):
        spawn_external_cli(
            [sys.executable, str(planted)],
            redacted_input="clean",
            engine_tier="E4",
        )


def test_spawn_frontier_cannot_self_downgrade_tier():
    # codex Bug 2: a frontier binary labeled engine_tier="E1" must STILL scan
    # stdin (the tier is derived from argv[0], not trusted from the caller). The
    # dirty stdin must raise BEFORE 'claude' is ever spawned.
    with pytest.raises(UnverifiedEgressBlocked):
        spawn_external_cli(["claude", "-p"], redacted_input="about Vatsal", engine_tier="E1")


def test_spawn_blocks_forbidden_name_in_argv():
    # codex Bug 3: a forbidden name riding argv (clean stdin) is still blocked.
    with pytest.raises(UnverifiedEgressBlocked):
        spawn_external_cli(
            [sys.executable, "-c", "pass", "--note", "remember to ask Vatsal"],
            redacted_input="clean stdin",
            engine_tier="E4",
        )


def test_spawn_launcher_form_cannot_self_downgrade():
    # codex round-2 B2: a launcher form (cmd /c claude) where argv[0] is not the
    # frontier binary must STILL scan — classify ANY argv token.
    with pytest.raises(UnverifiedEgressBlocked):
        spawn_external_cli(
            ["cmd.exe", "/c", "claude", "-p"],
            redacted_input="about Vatsal",
            engine_tier="E1",
        )


def test_spawn_scans_argv0_binary_path():
    # codex round-2 B3: a forbidden name in the binary PATH (argv[0]) is scanned.
    with pytest.raises(UnverifiedEgressBlocked):
        spawn_external_cli(
            [r"C:\Users\Vatsal\bin\claude.exe", "-p"],
            redacted_input="clean stdin",
            engine_tier="E4",
        )


@pytest.mark.parametrize("argv", [
    ["cmd.exe", "/c", "claude -p"],   # Windows shell-string launcher
    ["sh", "-lc", "claude -p"],       # POSIX shell-string launcher
])
def test_spawn_shell_launcher_form_cannot_self_downgrade(argv):
    # codex round-3 B2: a frontier CLI inside a shell-string token must still be
    # detected (and thus scanned), even when argv[0] is the shell.
    with pytest.raises(UnverifiedEgressBlocked):
        spawn_external_cli(argv, redacted_input="about Vatsal", engine_tier="E1")


# --- audio hard-gate (codex blocker 2) ---------------------------------------

def test_cloud_audio_blocked_by_default(monkeypatch):
    monkeypatch.delenv("LCT_ALLOW_CLOUD_AUDIO", raising=False)
    with pytest.raises(AudioEgressBlocked):
        assert_audio_egress_allowed("wss://api.openai.com/v1/realtime")


def test_local_audio_allowed():
    assert_audio_egress_allowed("ws://127.0.0.1:9000/stt")  # no raise


def test_cloud_audio_opt_in(monkeypatch):
    monkeypatch.setenv("LCT_ALLOW_CLOUD_AUDIO", "1")
    assert_audio_egress_allowed("wss://api.openai.com/v1/realtime")  # no raise
