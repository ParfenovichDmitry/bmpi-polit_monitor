#!/usr/bin/env bash
# Daily job: collect new GDELT intervals, recompute indicators, publish docs/data to GitHub Pages.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p logs
exec 9>logs/.lock
flock -n 9 || { echo "another run is in progress"; exit 0; }

source .venv/bin/activate
git pull --rebase --quiet || echo "warning: git pull failed, continuing with local copy"

python -m bmpi_monitor.cli run "$@"

git add docs/data
if ! git diff --cached --quiet; then
  git commit --quiet -m "data: update $(date -u +%Y-%m-%d)"
  git push --quiet
  echo "published"
else
  echo "no changes to publish"
fi
