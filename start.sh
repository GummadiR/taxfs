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
  # The PostgreSQL password is asked for ONCE and remembered outside the repo
  # (~/.config/taxfs), never in a tracked file. It guards the local database
  # on this machine and nothing else.
  cred="${XDG_CONFIG_HOME:-$HOME/.config}/taxfs/pg"
  if [ -z "${PGPASSWORD:-}" ] && [ -f "$cred" ]; then PGPASSWORD="$(cat "$cred")"; fi
  export PGPASSWORD="${PGPASSWORD:-postgres}"

  try_boot() {
    boot_output="$(node scripts/bootstrap-db.mjs 2>/dev/null)" || return 1
    echo "$boot_output" | grep -v '^TAXFS_DATABASE_URL=' || true
    TAXFS_DATABASE_URL="$(echo "$boot_output" | sed -n 's/^TAXFS_DATABASE_URL=//p')"
    [ -n "$TAXFS_DATABASE_URL" ]
  }

  if ! try_boot; then
    # Reachable-but-rejected is fixed by asking, not by printing a checklist.
    echo
    echo "  PostgreSQL did not accept the stored password."
    printf '  postgres password: '
    read -rs PGPASSWORD
    echo
    export PGPASSWORD
    if try_boot; then
      mkdir -p "$(dirname "$cred")"
      printf '%s' "$PGPASSWORD" > "$cred"
      chmod 600 "$cred"
      echo "  Password saved for next time (in $cred, not in the project)."
    else
      echo
      echo "  --- what the database setup actually reported ---"
      node scripts/bootstrap-db.mjs || true
      echo
      echo "  Database setup did not finish. Is PostgreSQL installed and running?"
      echo "  If the password was wrong, delete $cred and re-run."
      exit 1
    fi
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
