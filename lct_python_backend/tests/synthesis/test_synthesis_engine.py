"""Tests for the engine dispatcher's privacy gate."""

import pytest

from lct_python_backend.services.synthesis import synthesis_engine
from lct_python_backend.services.synthesis.synthesis_engine import (
    FrontierRefused,
    run_stage,
)


class TestLocalEngine:
    def test_local_runs_without_consent(self, monkeypatch):
        monkeypatch.setattr(synthesis_engine, "_local", lambda prompt, **k: "LOCAL_OK")
        assert run_stage("local", "hello") == "LOCAL_OK"

    def test_unknown_engine_raises(self):
        with pytest.raises(ValueError):
            run_stage("gpt9", "hi")


class TestFrontierGate:
    def test_external_refused_under_local_only(self, monkeypatch):
        monkeypatch.setenv("LCT_LOCAL_ONLY", "1")
        with pytest.raises(FrontierRefused):
            run_stage("codex", "summarize", consented=True)

    def test_external_refused_unconsented(self, monkeypatch):
        monkeypatch.setenv("LCT_LOCAL_ONLY", "0")
        with pytest.raises(FrontierRefused):
            run_stage("claude", "summarize", consented=False)

    def test_external_refused_without_canonical_map(self, monkeypatch):
        # Fail-closed (ADR-038 round-2 finding 9): consent + local-only off, but the
        # built-in default map (map_id is None) is a denylist only — an un-enrolled
        # real name could slip past it — so the send is refused, not warned-and-sent.
        # A real external send must supply the canonical IndrasNet map (PR#2).
        monkeypatch.setenv("LCT_LOCAL_ONLY", "0")
        monkeypatch.setattr(synthesis_engine, "_codex", lambda p, t: "should not get here")
        with pytest.raises(FrontierRefused):
            run_stage("codex", "summarize", consented=True)  # no redaction_map -> default

    def test_external_redacts_before_subprocess(self, monkeypatch):
        # With consent + local-only off + a CANONICAL map (map_id set), the frontier
        # runs — but the payload it receives MUST be redacted (no real name reaches
        # the subprocess).
        from lct_python_backend.services.synthesis.redaction import RedactionMap

        monkeypatch.setenv("LCT_LOCAL_ONLY", "0")
        canonical = RedactionMap(
            forward={"Vatsal": "[Friend A]", "Bhishma": "[Friend C]"}, map_id="test-canon-v1"
        )
        captured = {}

        def fake_codex(prompt, timeout):
            captured["sent"] = prompt
            return "Friend A made a good point"  # model drops brackets

        monkeypatch.setattr(synthesis_engine, "_codex", fake_codex)
        out = run_stage(
            "codex", "What did Vatsal argue about Bhishma?",
            consented=True, redaction_map=canonical,
        )

        assert "Vatsal" not in captured["sent"]
        assert "Bhishma" not in captured["sent"]
        assert "[Friend A]" in captured["sent"]
        # Restore brings the real name back into the LOCAL-only result.
        assert "Vatsal" in out

    def test_leak_gate_fires_if_redaction_would_miss(self, monkeypatch):
        # Force a redaction map that does NOT cover a forbidden name to prove the
        # assert_clean leak gate is a real backstop (it must refuse the send). The
        # map carries a map_id so it passes the canonical-map gate and reaches the
        # leak gate.
        from lct_python_backend.services.synthesis.redaction import RedactionMap

        monkeypatch.setenv("LCT_LOCAL_ONLY", "0")
        monkeypatch.setattr(synthesis_engine, "_codex", lambda p, t: "should not get here")
        broken_map = RedactionMap(forward={"Vatsal": "[Friend A]"}, map_id="test-canon-v1")
        broken_map.forbidden = ["Vatsal", "Bhishma"]  # claims to forbid Bhishma but won't redact it
        with pytest.raises(PermissionError):
            run_stage("codex", "Bhishma said hi", consented=True, redaction_map=broken_map)


class TestCliInvocation:
    def test_codex_argv_skips_git_repo_check(self, monkeypatch):
        # codex review of the migration: the sandboxed spawn runs codex in a fresh
        # EMPTY temp cwd (no git repo), so the argv MUST carry --skip-git-repo-check
        # or `codex exec` refuses the non-git cwd before doing any work.
        import subprocess as _sp

        import lct_python_backend.services.privacy_boundary as pb

        captured = {}

        def fake_spawn(argv, **kwargs):
            captured["argv"] = argv
            return _sp.CompletedProcess(argv, 0, stdout=b"out", stderr=b"")

        monkeypatch.setattr(pb, "spawn_external_cli", fake_spawn)
        synthesis_engine._codex("hello", 10.0)
        assert "--skip-git-repo-check" in captured["argv"]

    def test_claude_argv_has_no_git_flag(self, monkeypatch):
        # claude -p runs fine from an empty cwd (no git requirement) — the flag is
        # codex-specific and must NOT be added to the claude invocation.
        import subprocess as _sp

        import lct_python_backend.services.privacy_boundary as pb

        captured = {}

        def fake_spawn(argv, **kwargs):
            captured["argv"] = argv
            return _sp.CompletedProcess(argv, 0, stdout=b"out", stderr=b"")

        monkeypatch.setattr(pb, "spawn_external_cli", fake_spawn)
        synthesis_engine._claude_opus("hello", 10.0)
        assert "--skip-git-repo-check" not in captured["argv"]
        assert captured["argv"][:2] == ["claude", "-p"]

    def test_claude_tools_disabled(self, monkeypatch):
        # grok review: the agent must NOT have file-read tools, or a prompt could
        # tell it to read a local file of real names the stdin scan can't see.
        import subprocess as _sp

        import lct_python_backend.services.privacy_boundary as pb

        captured = {}

        def fake_spawn(argv, **kwargs):
            captured["argv"] = argv
            return _sp.CompletedProcess(argv, 0, stdout=b"out", stderr=b"")

        monkeypatch.setattr(pb, "spawn_external_cli", fake_spawn)
        synthesis_engine._claude_opus("hello", 10.0)
        argv = captured["argv"]
        assert "--allowed-tools" in argv          # variadic, no values -> zero tools
        assert "--strict-mcp-config" in argv
        assert '{"mcpServers": {}}' in argv        # no MCP servers started
