#!/usr/bin/env bash
# Local CI for live_conversational_threads — runs vitest unit tests.
# Run directly: bash scripts/ci_local.sh
# Also called by .git/hooks/pre-push.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

cd "$REPO_ROOT/lct_app"

echo "[ci] 1/1 vitest..."
npm run test -- --run

echo "[ci] ✓ all LCT gates passed"
