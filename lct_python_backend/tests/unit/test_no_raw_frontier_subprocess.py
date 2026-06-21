"""Ratchet lint (ADR-038 finding 1.1/1.2, codex blocker 3's "lint enforcement").

Every frontier-LLM CLI spawn (claude/codex/gemini/grok) must go through the ONE
sanctioned door ``privacy_boundary.spawn_external_cli`` so its stdin is
leak-verified and the child is sandboxed. This test fails the build on any NEW
raw ``subprocess`` spawn of a frontier binary.

It is a RATCHET, not a clean sweep: the frontier spawns that exist today
(``synthesis_engine`` + the ``synthetic_eval`` CLI drivers) are known and pending
migration onto the helper — that migration is the deferred, contended edit. They
sit in the allowlist below. Anything OUTSIDE the allowlist is a regression.
"""

import ast
import os
from pathlib import Path

_BACKEND = Path(__file__).resolve().parents[2]  # .../lct_python_backend
_FRONTIER = {"claude", "codex", "gemini", "grok"}
_SUBPROCESS_FNS = {"run", "Popen", "call", "check_output", "check_call"}

# Files with a raw frontier spawn that are KNOWN and pending migration onto
# privacy_boundary.spawn_external_cli. Do NOT add to this list to make the test
# pass — route the spawn through the helper instead.
_PENDING_MIGRATION = {
    "services/synthesis/synthesis_engine.py",  # contended (active synthesis session)
    "synthetic_eval/extract.py",               # fake-data harness; isolation preserved
    "synthetic_eval/realtime.py",
    "synthetic_eval/consolidate.py",
}

# The sanctioned helper itself (its subprocess.run is the door).
_SANCTIONED = {"services/privacy_boundary.py"}


def _is_frontier_token(node: ast.AST) -> bool:
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        base = os.path.basename(node.value).lower().rsplit(".", 1)[0]
        return base in _FRONTIER
    if isinstance(node, ast.Name):
        return any(b in node.id.lower() for b in _FRONTIER)
    if isinstance(node, ast.Call):
        fn = node.func
        name = getattr(fn, "attr", "") or getattr(fn, "id", "") or ""
        return any(b in name.lower() for b in _FRONTIER)
    return False


def _file_spawns_frontier(tree: ast.AST) -> bool:
    for node in ast.walk(tree):
        if not (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)):
            continue
        if node.func.attr not in _SUBPROCESS_FNS or not node.args:
            continue
        first = node.args[0]
        if isinstance(first, ast.List) and first.elts:
            if _is_frontier_token(first.elts[0]):
                return True
        elif _is_frontier_token(first):
            return True
    return False


def test_no_new_raw_frontier_subprocess():
    offenders = set()
    for path in _BACKEND.rglob("*.py"):
        rel = path.relative_to(_BACKEND).as_posix()
        if rel.startswith("tests/") or rel in _SANCTIONED:
            continue
        try:
            tree = ast.parse(path.read_text(encoding="utf-8"))
        except (SyntaxError, UnicodeDecodeError):
            continue
        if _file_spawns_frontier(tree):
            offenders.add(rel)

    new = offenders - _PENDING_MIGRATION
    assert not new, (
        "NEW raw frontier-CLI subprocess spawn(s) detected — route them through "
        f"privacy_boundary.spawn_external_cli instead: {sorted(new)}"
    )
