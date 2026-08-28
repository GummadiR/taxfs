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

  # bootstrap-db exits 2 ONLY when PostgreSQL rejected the password — the one
  # failure a password prompt fixes. Every other failure (service stopped,
  # broken migration, missing module) is shown verbatim instead of being
  # misdiagnosed as a wrong password.
  try_boot() {
    boot_output="$(node scripts/bootstrap-db.mjs 2>&1)"
    boot_rc=$?
    if [ "$boot_rc" -ne 0 ]; then return "$boot_rc"; fi
    printf '%s\n' "$boot_output" | grep -v '^TAXFS_DATABASE_URL=' || true
    TAXFS_DATABASE_URL="$(printf '%s\n' "$boot_output" | sed -n 's/^TAXFS_DATABASE_URL=//p')"
    [ -n "$TAXFS_DATABASE_URL" ]
  }

  show_boot_failure() {
    echo
    echo "  --- what the database setup actually reported ---"
    printf '%s\n' "$boot_output"
    echo
    echo "  Database setup did not finish. Is PostgreSQL installed and running?"
    echo "  If the password was wrong, delete $cred and re-run."
    exit 1
  }

  if ! try_boot; then
    [ "$boot_rc" -eq 2 ] || show_boot_failure
    # The password really was rejected — asking is the fix.
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
      show_boot_failure
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
