#!/usr/bin/env bash
# TaxFS - one-command start (macOS / Linux). The Windows twin is start.bat;
# keep the two in step.
set -euo pipefail
cd "$(dirname "$0")"

echo
echo "============================================"
echo "  TaxFS - starting up"
echo "============================================"
echo

echo "[1/5] Getting the latest version..."
git checkout -- start.sh 2>/dev/null || true
git pull origin main || echo "  Could not update - continuing with the version you have."

echo
echo "[2/5] Installing / updating dependencies..."
pnpm install

echo
echo "[3/5] Preparing your local database..."
if [ -n "${TAXFS_DATABASE_URL:-}" ]; then
  echo "  Using the database from TAXFS_DATABASE_URL - skipping local setup."
else
  boot_output="$(node scripts/bootstrap-db.mjs)"
  echo "$boot_output" | grep -v '^TAXFS_DATABASE_URL=' || true
  TAXFS_DATABASE_URL="$(echo "$boot_output" | sed -n 's/^TAXFS_DATABASE_URL=//p')"
  if [ -z "$TAXFS_DATABASE_URL" ]; then
    echo "  Database setup did not finish - is PostgreSQL installed and running?"
    exit 1
  fi
  export TAXFS_DATABASE_URL
fi

echo
echo "[4/5] Building the app for fast navigation (one-time, ~20-40 seconds)..."
pnpm build

echo
echo "[5/5] Starting TaxFS..."
echo "  When you see \"Ready\", open  http://localhost:3000"
echo "  Press Ctrl+C to stop."
echo
export TAXFS_LOCAL_OPERATOR=1
exec pnpm --filter web start
