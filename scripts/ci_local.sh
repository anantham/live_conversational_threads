#!/usr/bin/env bash
# Local CI for live_conversational_threads — runs vitest unit tests.
# Run directly: bash scripts/ci_local.sh
# Also called by .git/hooks/pre-push.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

cd "$REPO_ROOT/lct_app"

# Node25+ native Web Storage shadows jsdom unless disabled in every Vitest worker.
# Keep this test-process setting inherited; never change application storage behavior.
node_major="$(node -p 'Number(process.versions.node.split(".")[0])')"
if (( node_major >= 25 )); then
  export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--no-experimental-webstorage"
fi

echo "[ci] 1/1 vitest..."
npm run test -- --run

echo "[ci] ✓ all LCT gates passed"
