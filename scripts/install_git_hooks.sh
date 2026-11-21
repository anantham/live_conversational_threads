#!/usr/bin/env bash
# Installs the repository's git hooks. Hooks live in .git/hooks, which git does
# not track, so every clone needs this once (worktrees share the hooks of the
# main checkout):
#
#   bash scripts/install_git_hooks.sh
#
# pre-push runs scripts/ci_local.sh of the worktree being pushed from. Git's
# arguments (remote name, URL) and stdin (the refs being pushed) pass through;
# ci_local.sh uses them to run only the checks the pushed paths need.
set -euo pipefail

hooks_dir="$(git rev-parse --git-path hooks)"
mkdir -p "$hooks_dir"
hook="$hooks_dir/pre-push"

cat >"$hook" <<'HOOK'
#!/usr/bin/env bash
# Pre-push hook, installed by scripts/install_git_hooks.sh. Do not edit here.
# Runs the local CI gates of the worktree being pushed from.
REPO_ROOT="$(git rev-parse --show-toplevel)"
exec bash "$REPO_ROOT/scripts/ci_local.sh" "$@"
HOOK
chmod +x "$hook"
echo "[hooks] installed $hook"
