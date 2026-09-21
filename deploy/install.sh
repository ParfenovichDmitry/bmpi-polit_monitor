#!/usr/bin/env bash
# One-time setup on Ubuntu/Debian. Run from the repository root as the user that will own the job.
set -euo pipefail
cd "$(dirname "$0")/.."
if ! command -v python3 >/dev/null || ! python3 -c "import venv" 2>/dev/null; then
  sudo apt-get update && sudo apt-get install -y python3 python3-venv git
fi
python3 -m venv .venv
.venv/bin/pip install --upgrade pip -q
.venv/bin/pip install -r requirements.txt -q
chmod +x deploy/run_daily.sh
if [ -d seed ] && [ ! -d data ]; then
  echo "seeding stored history from seed/ ..."
  .venv/bin/python -m bmpi_monitor.cli --campaign usa-congress-2026 seed --dir seed
fi
echo "done. Next: ./deploy/run_daily.sh   (first run backfills missing days)"
