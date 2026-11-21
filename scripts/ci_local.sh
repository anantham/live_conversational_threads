#!/usr/bin/env bash
# Local CI for live_conversational_threads.
#
# Every check is keyed on the paths a push actually changes, so a guard runs
# for the condition it protects and for nothing else:
#
#   lct_app/**                 -> frontend-deps, frontend-vitest
#   lct_python_backend/**      -> backend-pytest-unit
#   ops/observability/**       -> observability-promtool, observability-contract-tests
#   scripts/ci_local.sh, scripts/test_ci_local_gating.sh, scripts/install_git_hooks.sh
#                              -> ci-gating-selftest
#   anything else              -> EVERY check (unclassified path: fail closed)
#
# There is deliberately no "docs need no checks" class: vitest and pytest read
# files under docs/ and root *.md, so those paths are unclassified.
#
# Changed paths come from, in order:
#   1. git's pre-push stdin ("<local ref> <local sha> <remote ref> <remote sha>"
#      per pushed ref), which .git/hooks/pre-push passes through;
#   2. git diff --name-only @{upstream}...HEAD when there is no such stdin;
#   3. nothing: if the changed set cannot be determined, EVERY check runs.
#
# Usage:
#   bash scripts/ci_local.sh [remote-name [remote-url]]   # as the pre-push hook does
#   bash scripts/ci_local.sh --all     # run every check
#   bash scripts/ci_local.sh --plan    # print the decisions, run nothing
# Install the hook with: bash scripts/install_git_hooks.sh
#
# Overrides: LCT_PYTHON (interpreter with pytest), LCT_PROMTOOL (promtool binary).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

PLAN_ONLY="${CI_LOCAL_PLAN_ONLY:-0}"
FORCE_ALL=0
REMOTE="origin"
positional=0
for arg in "$@"; do
  case "$arg" in
    --plan) PLAN_ONLY=1 ;;
    --all) FORCE_ALL=1 ;;
    -*) echo "[ci] unknown option: $arg" >&2; exit 2 ;;
    *)
      positional=$((positional + 1))
      if (( positional == 1 )); then REMOTE="$arg"; fi
      ;;
  esac
done

CHANGED_FILE="$(mktemp)"
trap 'rm -f "$CHANGED_FILE" "$CHANGED_FILE.npm"' EXIT

RUN_ALL=0
RUN_ALL_REASON=""
SCOPE_SOURCE=""

run_everything() {
  # First reason wins; it is the one printed for every check.
  if (( RUN_ALL == 0 )); then
    RUN_ALL=1
    RUN_ALL_REASON="$1"
  fi
}

is_zero_sha() { [[ "$1" =~ ^0+$ ]]; }
is_sha() { [[ "$1" =~ ^[0-9a-f]{40,64}$ ]]; }

default_remote_ref() {
  local candidate
  for candidate in "refs/remotes/$REMOTE/HEAD" "refs/remotes/$REMOTE/main" "refs/remotes/$REMOTE/master"; do
    if git rev-parse --verify --quiet "$candidate^{commit}" >/dev/null 2>&1; then
      echo "$candidate"
      return 0
    fi
  done
  return 1
}

append_diff() {
  # --no-renames: a file moved out of a checked directory must still be seen
  # as a deletion there, not only as an addition somewhere else.
  local base="$1" tip="$2" label="$3"
  if ! git diff --name-only --no-renames "$base" "$tip" >>"$CHANGED_FILE" 2>/dev/null; then
    run_everything "git diff failed for $label"
  fi
}

collect_from_push_stdin() {
  local lref lsha rref rsha extra base default_ref refs=0
  # -t: a stdin that is open but silent (not git) must not hang the hook.
  while IFS=' ' read -r -t 5 lref lsha rref rsha extra; do
    [[ -z "${lref:-}" ]] && continue
    refs=$((refs + 1))
    rsha="${rsha%$'\r'}"
    if ! is_sha "${lsha:-}" || ! is_sha "${rsha:-}"; then
      run_everything "stdin is not git's pre-push ref list (first field: '$lref')"
      continue
    fi
    if is_zero_sha "$lsha"; then
      echo "[ci] push deletes $rref: nothing to check for that ref"
      continue
    fi
    if is_zero_sha "$rsha"; then
      if ! default_ref="$(default_remote_ref)"; then
        run_everything "$rref is new on the remote and no $REMOTE default branch is known locally to diff against"
        continue
      fi
      if ! base="$(git merge-base "$lsha" "$default_ref" 2>/dev/null)"; then
        run_everything "$rref is new on the remote and shares no history with $default_ref"
        continue
      fi
      echo "[ci] $rref is new on the remote: diffing against its merge-base with $default_ref (${base:0:9})"
      append_diff "$base" "$lsha" "$rref"
      continue
    fi
    if ! git cat-file -e "$rsha^{commit}" 2>/dev/null; then
      run_everything "remote tip ${rsha:0:9} of $rref is not present locally (fetch first)"
      continue
    fi
    append_diff "$rsha" "$lsha" "$rref"
  done
  if (( refs > 0 )); then
    SCOPE_SOURCE="pre-push stdin ($refs ref(s) pushed to $REMOTE)"
    return 0
  fi
  return 1
}

collect_from_upstream() {
  if ! git rev-parse --verify --quiet '@{upstream}' >/dev/null 2>&1; then
    run_everything "there is no pre-push ref list on stdin and the current branch has no upstream"
    return 0
  fi
  SCOPE_SOURCE="git diff @{upstream}...HEAD (no pre-push ref list on stdin)"
  if ! git diff --name-only --no-renames '@{upstream}...HEAD' >>"$CHANGED_FILE" 2>/dev/null; then
    run_everything "git diff @{upstream}...HEAD failed"
  fi
}

if (( FORCE_ALL == 1 )); then
  run_everything "--all was given"
elif [[ -t 0 ]] || ! collect_from_push_stdin; then
  collect_from_upstream
fi

sort -u "$CHANGED_FILE" -o "$CHANGED_FILE"
sed -i '/^$/d' "$CHANGED_FILE"
changed_total="$(wc -l <"$CHANGED_FILE" | tr -d ' ')"

n_frontend=0; n_backend=0; n_observability=0; n_tooling=0; n_unclassified=0
ex_frontend=""; ex_backend=""; ex_observability=""; ex_tooling=""; ex_unclassified=""
while IFS= read -r path; do
  path="${path%$'\r'}"
  case "$path" in
    lct_app/*) n_frontend=$((n_frontend + 1)); : "${ex_frontend:=$path}" ;;
    lct_python_backend/*) n_backend=$((n_backend + 1)); : "${ex_backend:=$path}" ;;
    ops/observability/*) n_observability=$((n_observability + 1)); : "${ex_observability:=$path}" ;;
    scripts/ci_local.sh|scripts/test_ci_local_gating.sh|scripts/install_git_hooks.sh)
      n_tooling=$((n_tooling + 1)); : "${ex_tooling:=$path}" ;;
    *) n_unclassified=$((n_unclassified + 1)); : "${ex_unclassified:=$path}" ;;
  esac
done <"$CHANGED_FILE"

if (( RUN_ALL == 0 && n_unclassified > 0 )); then
  run_everything "$n_unclassified changed path(s) belong to no check's path set (e.g. $ex_unclassified)"
fi

echo "[ci] repo: $REPO_ROOT"
if (( RUN_ALL == 1 )); then
  echo "[ci] scope: EVERY check, because $RUN_ALL_REASON"
else
  echo "[ci] scope: $changed_total changed path(s) from $SCOPE_SOURCE"
fi
if [[ -n "$(git status --porcelain --untracked-files=no 2>/dev/null)" ]]; then
  echo "[ci] WARNING: the working tree has uncommitted changes; checks run on the working tree, not on the pushed commit"
fi

CHECK_IDS=()
CHECK_STATE=()   # run | skip
CHECK_REASON=()

decide() {
  # decide <id> <changed-count> <example-path> <path-set-description>
  local id="$1" count="$2" example="$3" scope="$4" state reason
  if (( RUN_ALL == 1 )); then
    state="run"; reason="$RUN_ALL_REASON"
  elif (( count > 0 )); then
    state="run"; reason="$count changed path(s) under $scope (e.g. $example)"
  else
    state="skip"; reason="no changed path under $scope"
  fi
  CHECK_IDS+=("$id"); CHECK_STATE+=("$state"); CHECK_REASON+=("$reason")
  if [[ "$state" == "run" ]]; then
    echo "[ci] RUN  $id: $reason"
  else
    echo "[ci] SKIP $id: $reason"
  fi
}

decide ci-gating-selftest "$n_tooling" "$ex_tooling" "the hook tooling (scripts/ci_local.sh, its installer and self-test)"
decide frontend-deps "$n_frontend" "$ex_frontend" "lct_app/"
decide frontend-vitest "$n_frontend" "$ex_frontend" "lct_app/"
decide backend-pytest-unit "$n_backend" "$ex_backend" "lct_python_backend/"
decide observability-promtool "$n_observability" "$ex_observability" "ops/observability/"
decide observability-contract-tests "$n_observability" "$ex_observability" "ops/observability/"

if [[ "$PLAN_ONLY" == "1" ]]; then
  echo "[ci] plan only: no check was executed"
  exit 0
fi

# ---------------------------------------------------------------- helpers ---

to_native_path() {
  if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else echo "$1"; fi
}

PYTHON_BIN=""
find_python() {
  [[ -n "$PYTHON_BIN" ]] && return 0
  local main_root candidate
  main_root="$(dirname "$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null || echo "$REPO_ROOT/.git")")"
  for candidate in \
    "${LCT_PYTHON:-}" \
    "$REPO_ROOT/.venv/Scripts/python.exe" "$REPO_ROOT/.venv/bin/python" \
    "$main_root/.venv/Scripts/python.exe" "$main_root/.venv/bin/python" \
    "$(command -v python 2>/dev/null || true)" "$(command -v python3 2>/dev/null || true)"; do
    [[ -z "$candidate" ]] && continue
    if "$candidate" -c 'import pytest' >/dev/null 2>&1; then
      PYTHON_BIN="$candidate"
      return 0
    fi
  done
  return 1
}

PROMTOOL_BIN=""
find_promtool() {
  if [[ -n "${LCT_PROMTOOL:-}" ]]; then
    [[ -f "$LCT_PROMTOOL" ]] || return 1
    PROMTOOL_BIN="$LCT_PROMTOOL"
    return 0
  fi
  local root candidate=""
  # Git Bash exports the variable as "ProgramData"; bash names are case-sensitive.
  for root in "${PROGRAMDATA:-${ProgramData:-${ALLUSERSPROFILE:-}}}" "${LOCALAPPDATA:-}"; do
    [[ -z "$root" ]] && continue
    if command -v cygpath >/dev/null 2>&1; then root="$(cygpath -u "$root")"; fi
    [[ -d "$root/LCT/observability/bin" ]] || continue
    candidate="$(find "$root/LCT/observability/bin" -maxdepth 4 -name promtool.exe -path '*prometheus-*' 2>/dev/null | sort | tail -n 1)"
    [[ -n "$candidate" ]] && break
  done
  if [[ -z "$candidate" ]]; then candidate="$(command -v promtool 2>/dev/null || true)"; fi
  [[ -n "$candidate" ]] || return 1
  PROMTOOL_BIN="$candidate"
}

no_python_message() {
  echo "[ci] No Python interpreter with pytest was found (tried LCT_PYTHON, .venv here and in the main checkout, python on PATH)."
  echo "[ci] Fix: set LCT_PYTHON to an interpreter that has pytest and the backend requirements."
}

# ----------------------------------------------------------------- checks ---

check_ci_gating_selftest() {
  bash "$REPO_ROOT/scripts/test_ci_local_gating.sh"
}

check_frontend_deps() {
  # vitest fails with dozens of unrelated-looking errors when node_modules is
  # older than package.json (2026-11: 26 test files failed only because jose,
  # drizzle-orm, @huggingface/transformers and onnxruntime-web had never been
  # installed in that checkout). Name that cause once instead.
  if [[ ! -d "$REPO_ROOT/lct_app/node_modules" ]]; then
    echo "[ci] lct_app/node_modules does not exist in this worktree."
    echo "[ci] Fix: (cd lct_app && npm ci)   # every git worktree needs its own install"
    return 1
  fi
  if ! (cd "$REPO_ROOT/lct_app" && npm ls --depth=0 >/dev/null 2>"$CHANGED_FILE.npm"); then
    grep -E 'missing:|invalid:' "$CHANGED_FILE.npm" | sed 's/^/[ci]   /' || true
    echo "[ci] lct_app/node_modules does not match lct_app/package.json, so the frontend tests cannot be trusted."
    echo "[ci] Fix: (cd lct_app && npm ci)   # stop any dev server using this node_modules first"
    return 1
  fi
}

check_frontend_vitest() {
  (
    set -e
    cd "$REPO_ROOT/lct_app"
    # Node25+ native Web Storage shadows jsdom unless disabled in every Vitest worker.
    # Keep this test-process setting inherited; never change application storage behavior.
    node_major="$(node -p 'Number(process.versions.node.split(".")[0])')"
    if (( node_major >= 25 )); then
      export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--no-experimental-webstorage"
    fi
    npm run test -- --run
  )
}

check_backend_pytest_unit() {
  if ! find_python; then
    no_python_message
    return 1
  fi
  echo "[ci] python: $PYTHON_BIN"
  # Repo root on purpose, exactly as .github/workflows/pytest-unit.yml runs it.
  "$PYTHON_BIN" -m pytest lct_python_backend/tests/unit -q --tb=short
}

check_observability_promtool() {
  if ! find_promtool; then
    echo "[ci] ============================================================"
    echo "[ci] promtool NOT FOUND: the alert rules were NOT validated."
    echo "[ci] Looked at LCT_PROMTOOL, then LCT/observability/bin/prometheus-* under"
    echo "[ci] PROGRAMDATA and LOCALAPPDATA, then PATH."
    echo "[ci] Fix: install the pinned Prometheus"
    echo "[ci]      (ops/observability/start_observability.ps1 -Action Prepare) or set LCT_PROMTOOL."
    echo "[ci] ============================================================"
    return 1
  fi
  echo "[ci] promtool: $PROMTOOL_BIN"
  "$PROMTOOL_BIN" check rules "$(to_native_path "$REPO_ROOT/ops/observability/prometheus-alerts.yml")"
}

check_observability_contract_tests() {
  # These two files hold every existing guard on ops/observability: the
  # forbidden-word lint on prometheus-alerts.yml ("authorization", "cookie",
  # "prompt", "transcript", "response_body"), the required-alert list, the
  # promtool config/rule checks, the alert unit test, and the PowerShell
  # launcher/task contracts.
  if ! find_python; then
    no_python_message
    return 1
  fi
  echo "[ci] python: $PYTHON_BIN"
  "$PYTHON_BIN" -m pytest \
    lct_python_backend/tests/unit/test_native_observability_supervision.py \
    lct_python_backend/tests/unit/test_observability_alert_rules.py \
    -q --tb=short -p no:cacheprovider
}

# -------------------------------------------------------------------- run ---

CHECK_RESULT=()
failed=0
frontend_deps_failed=0
for i in "${!CHECK_IDS[@]}"; do
  id="${CHECK_IDS[$i]}"
  if [[ "${CHECK_STATE[$i]}" == "skip" ]]; then
    CHECK_RESULT+=("SKIPPED (${CHECK_REASON[$i]})")
    continue
  fi
  if [[ "$id" == "frontend-vitest" ]] && (( frontend_deps_failed == 1 )); then
    echo "[ci] ---- $id: NOT RUN because frontend-deps failed; counted as a failure"
    CHECK_RESULT+=("FAIL (not run: frontend-deps failed)")
    failed=1
    continue
  fi
  echo "[ci] ---- $id"
  fn="check_${id//-/_}"
  set +e
  "$fn"
  status=$?
  set -e
  if (( status == 0 )); then
    CHECK_RESULT+=("PASS")
  else
    CHECK_RESULT+=("FAIL (exit $status)")
    failed=1
    if [[ "$id" == "frontend-deps" ]]; then frontend_deps_failed=1; fi
  fi
done

echo "[ci] ==== summary"
for i in "${!CHECK_IDS[@]}"; do
  printf '[ci] %-30s %s\n' "${CHECK_IDS[$i]}" "${CHECK_RESULT[$i]}"
done
if (( failed == 1 )); then
  echo "[ci] FAILED: at least one check did not pass; the push is blocked"
  exit 1
fi
echo "[ci] OK: every check required for these paths passed"
