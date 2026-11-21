#!/usr/bin/env bash
# Test intent:
# - A push runs exactly the checks whose paths it changes: frontend for lct_app/,
#   backend for lct_python_backend/, the observability checks for ops/observability/.
# - Anything the gate cannot classify or cannot measure runs EVERY check: a path
#   outside every check's set (docs included), a new remote ref with no known
#   base, a remote tip that is not present locally, no ref list and no upstream.
# - A file moved or deleted out of a checked directory still triggers that
#   directory's checks.
# - Several refs in one push are judged together.
# - A failing check blocks the push; a push with nothing to check goes through.
#
# Method: throwaway repositories and real `git push` through the hook written
# by scripts/install_git_hooks.sh, so git's own pre-push stdin is what is
# classified. CI_LOCAL_PLAN_ONLY=1 makes ci_local.sh print its decisions
# without executing the (expensive) checks.
#
# Run: bash scripts/test_ci_local_gating.sh
set -euo pipefail

SCRIPTS_DIR="$(cd "$(dirname "$0")" && pwd)"
ALL="ci-gating-selftest frontend-deps frontend-vitest backend-pytest-unit observability-promtool observability-contract-tests"
FRONTEND="frontend-deps frontend-vitest"
BACKEND="backend-pytest-unit"
OBSERVABILITY="observability-promtool observability-contract-tests"
SELFTEST="ci-gating-selftest"

# When this runs inside a real pre-push hook, git's repository variables point
# at the real repository. Drop them so every git call below targets the sandbox.
unset $(git rev-parse --local-env-vars 2>/dev/null) 2>/dev/null || true

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
: >"$TMP/gitconfig"
export GIT_CONFIG_GLOBAL="$TMP/gitconfig"
export GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME="ci-selftest" GIT_AUTHOR_EMAIL="ci-selftest@example.invalid"
export GIT_COMMITTER_NAME="ci-selftest" GIT_COMMITTER_EMAIL="ci-selftest@example.invalid"
unset LCT_PYTHON LCT_PROMTOOL CI_LOCAL_PLAN_ONLY 2>/dev/null || true

failures=0
cases=0

without() {
  # without "<all ids>" "<ids to remove>"
  local id out=""
  for id in $1; do
    case " $2 " in *" $id "*) ;; *) out="$out $id" ;; esac
  done
  echo "$out"
}

assert_plan() {
  # assert_plan <label> <output> "<ids that must RUN>" "<ids that must SKIP>"
  local label="$1" output="$2" run="$3" skip="$4" id ok=1
  cases=$((cases + 1))
  for id in $run; do
    if ! grep -qE "^\[ci\] RUN  $id:" <<<"$output"; then ok=0; echo "    expected RUN  $id"; fi
  done
  for id in $skip; do
    if ! grep -qE "^\[ci\] SKIP $id:" <<<"$output"; then ok=0; echo "    expected SKIP $id"; fi
  done
  if (( ok == 1 )); then
    echo "  ok   $label"
  else
    failures=$((failures + 1))
    echo "  FAIL $label"
    sed 's/^/    | /' <<<"$output"
  fi
}

assert_true() {
  # assert_true <label> <command...>
  local label="$1"; shift
  cases=$((cases + 1))
  if "$@"; then
    echo "  ok   $label"
  else
    failures=$((failures + 1))
    echo "  FAIL $label"
  fi
}

commit_all() { git add -A >/dev/null && git commit -q -m "$1"; }
plan_push() { CI_LOCAL_PLAN_ONLY=1 git push "$@" 2>&1 || true; }

git init -q --bare "$TMP/remote.git"
git --git-dir="$TMP/remote.git" symbolic-ref HEAD refs/heads/main
git init -q "$TMP/work"
cd "$TMP/work"
git symbolic-ref HEAD refs/heads/main
mkdir -p scripts lct_app/src lct_python_backend ops/observability docs
cp "$SCRIPTS_DIR/ci_local.sh" "$SCRIPTS_DIR/install_git_hooks.sh" "$SCRIPTS_DIR/test_ci_local_gating.sh" scripts/
echo "export const a = 1;" >lct_app/src/a.js
echo "export const b = 1;" >lct_app/src/b.js
echo "x = 1" >lct_python_backend/mod.py
echo "y = 1" >lct_python_backend/other.py
echo "groups: []" >ops/observability/prometheus-alerts.yml
echo "# notes" >docs/notes.md
echo "# readme" >README.md
commit_all "initial"
git remote add origin "$TMP/remote.git"
bash scripts/install_git_hooks.sh >/dev/null

echo "ci_local.sh gating self-test"

out="$(plan_push origin main)"
assert_plan "first push, no remote default branch known -> every check" "$out" "$ALL" ""
git fetch -q origin
git branch -q --set-upstream-to=origin/main main

echo "groups: [] # edit" >ops/observability/prometheus-alerts.yml
commit_all "observability only"
out="$(plan_push origin main)"
assert_plan "observability-only change -> observability checks only" "$out" "$OBSERVABILITY" "$(without "$ALL" "$OBSERVABILITY")"

echo "export const a = 2;" >lct_app/src/a.js
commit_all "frontend only"
out="$(plan_push origin main)"
assert_plan "frontend-only change -> frontend checks only" "$out" "$FRONTEND" "$(without "$ALL" "$FRONTEND")"

echo "x = 2" >lct_python_backend/mod.py
commit_all "backend only"
out="$(plan_push origin main)"
assert_plan "backend-only change -> backend check only" "$out" "$BACKEND" "$(without "$ALL" "$BACKEND")"

echo "# more notes" >>docs/notes.md
commit_all "docs only"
out="$(plan_push origin main)"
assert_plan "docs-only change is unclassified -> every check" "$out" "$ALL" ""

echo "# readme edit" >>README.md
echo "x = 3" >lct_python_backend/mod.py
commit_all "backend plus root file"
out="$(plan_push origin main)"
assert_plan "classified + unclassified path in one push -> every check" "$out" "$ALL" ""

git mv lct_app/src/b.js ops/observability/b.js
commit_all "move source out of lct_app"
out="$(plan_push origin main)"
assert_plan "file moved out of lct_app/ -> frontend still runs (plus the destination's checks)" "$out" "$FRONTEND $OBSERVABILITY" "$BACKEND $SELFTEST"

git rm -q lct_python_backend/other.py
commit_all "delete backend source"
out="$(plan_push origin main)"
assert_plan "deleted backend file -> backend check" "$out" "$BACKEND" "$(without "$ALL" "$BACKEND")"

echo "# tooling edit" >>scripts/ci_local.sh
commit_all "hook tooling"
out="$(plan_push origin main)"
assert_plan "hook tooling change -> gating self-test only" "$out" "$SELFTEST" "$(without "$ALL" "$SELFTEST")"
git fetch -q origin

git checkout -q -b feature/obs
echo "groups: [] # feature" >ops/observability/prometheus-alerts.yml
commit_all "feature: observability"
out="$(plan_push origin feature/obs)"
assert_plan "new remote branch -> diffed against origin/main merge-base" "$out" "$OBSERVABILITY" "$(without "$ALL" "$OBSERVABILITY")"

git checkout -q main
git checkout -q -b feature/web
echo "export const a = 3;" >lct_app/src/a.js
commit_all "feature: frontend"
git checkout -q feature/obs
echo "groups: [] # feature 2" >ops/observability/prometheus-alerts.yml
commit_all "feature: observability again"
out="$(plan_push origin feature/obs feature/web)"
assert_plan "two refs in one push -> union of both refs' checks" "$out" "$FRONTEND $OBSERVABILITY" "$BACKEND $SELFTEST"

git checkout -q --orphan lonely
git rm -q -rf . >/dev/null
mkdir -p scripts ops/observability
git show main:scripts/ci_local.sh >scripts/ci_local.sh
echo "groups: []" >ops/observability/prometheus-alerts.yml
commit_all "unrelated history"
out="$(plan_push origin lonely)"
assert_plan "new remote branch with no shared history -> every check" "$out" "$ALL" ""

git checkout -q main
out="$(CI_LOCAL_PLAN_ONLY=1 bash scripts/ci_local.sh </dev/null 2>&1 || true)"
assert_plan "direct run, branch level with its upstream -> nothing to check" "$out" "" "$ALL"
echo "x = 4" >lct_python_backend/mod.py
commit_all "backend ahead of upstream"
out="$(CI_LOCAL_PLAN_ONLY=1 bash scripts/ci_local.sh </dev/null 2>&1 || true)"
assert_plan "direct run, no ref list -> @{upstream}...HEAD decides" "$out" "$BACKEND" "$(without "$ALL" "$BACKEND")"
out="$(printf 'this is not a ref list\n' | CI_LOCAL_PLAN_ONLY=1 bash scripts/ci_local.sh 2>&1 || true)"
assert_plan "stdin that is not a ref list -> every check" "$out" "$ALL" ""
out="$(bash scripts/ci_local.sh --plan --all </dev/null 2>&1 || true)"
assert_plan "--all -> every check" "$out" "$ALL" ""
git checkout -q -b no-upstream
out="$(CI_LOCAL_PLAN_ONLY=1 bash scripts/ci_local.sh </dev/null 2>&1 || true)"
assert_plan "direct run, no ref list and no upstream -> every check" "$out" "$ALL" ""
git checkout -q main

# Real (non-plan) runs: the hook's exit status must decide the push.
git checkout -q -b blocked origin/main
echo "groups: [] # blocked" >ops/observability/prometheus-alerts.yml
commit_all "observability change that cannot be validated"
set +e
out="$(LCT_PROMTOOL="$TMP/no-such-promtool.exe" git push origin blocked 2>&1)"
push_status=$?
set -e
assert_true "failing check -> push exits non-zero" test "$push_status" -ne 0
assert_true "failing check -> missing promtool is reported loudly" grep -q "promtool NOT FOUND" <<<"$out"
assert_true "failing check -> summary marks observability-promtool FAIL" grep -qE "^\[ci\] observability-promtool +FAIL" <<<"$out"
assert_true "failing check -> unrelated checks are reported as skipped" grep -qE "^\[ci\] frontend-vitest +SKIPPED" <<<"$out"
assert_true "failing check -> the remote ref was not created" test -z "$(git ls-remote origin refs/heads/blocked)"

set +e
out="$(git push origin :feature/web 2>&1)"
push_status=$?
set -e
assert_true "ref deletion (nothing to check) -> push succeeds" test "$push_status" -eq 0
assert_true "ref deletion -> the remote ref is gone" test -z "$(git ls-remote origin refs/heads/feature/web)"
assert_plan "ref deletion -> every check skipped" "$out" "" "$ALL"

# A remote tip this clone has never fetched cannot be diffed against.
git clone -q "$TMP/remote.git" "$TMP/other"
(
  cd "$TMP/other"
  git checkout -q main
  echo "# from elsewhere" >>README.md
  commit_all "someone else's commit"
  git push -q origin main
)
git checkout -q main
out="$(plan_push origin main)"
assert_plan "remote tip not present locally -> every check" "$out" "$ALL" ""

echo "ci_local.sh gating self-test: $((cases - failures))/$cases passed"
if (( failures > 0 )); then
  exit 1
fi
