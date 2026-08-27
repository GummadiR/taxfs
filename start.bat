@echo off
REM ===========================================================================
REM  TaxFS - one-click start (Windows)
REM  Double-click this file, or run  start.bat  from the repo folder.
REM  It updates, installs, prepares the database, builds for FAST navigation,
REM  and starts the app. Leave this window open while you use TaxFS;
REM  press Ctrl+C to stop.
REM
REM  The build step takes ~20-40 seconds. That one-time cost is what makes
REM  moving between sections instant afterwards.
REM ===========================================================================
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo(
echo ============================================
echo   TaxFS - starting up
echo ============================================
echo(

echo [1/5] Getting the latest version...
REM The launcher updates itself, so a locally-edited start.bat would block
REM the pull with "local changes would be overwritten". Discard drift on
REM THIS file only; nothing else is touched.
git checkout -- start.bat 2>nul
git pull origin main
if not errorlevel 1 goto pull_ok
echo(
echo   Could not update from GitHub - continuing with the version you have.
echo   (Check your internet connection if this keeps happening.)
echo(

:pull_ok
echo(
echo [2/5] Installing / updating dependencies...
call pnpm install
if errorlevel 1 (
  echo(
  echo   Dependency install failed. Is pnpm installed?  npm install -g pnpm
  echo   Copy the message above and send it to Claude.
  echo(
  pause
  exit /b 1
)
echo(

echo [3/5] Preparing your local database...
if defined TAXFS_DATABASE_URL (
  echo   Using the database from TAXFS_DATABASE_URL - skipping local setup.
  goto db_ready
)
REM The PostgreSQL password. Asked for ONCE, then remembered so later runs
REM stay a plain double-click. It is kept in %APPDATA%\TaxFS (this Windows
REM account only), never in the repo - a password written into a tracked file
REM is one git push away from being public. It guards the local database on
REM this machine and nothing else; treat it accordingly.
if not defined PGPASSWORD if exist "%APPDATA%\TaxFS\pg.txt" (
  set /p PGPASSWORD=<"%APPDATA%\TaxFS\pg.txt"
)
if not defined PGPASSWORD set PGPASSWORD=postgres

call :try_bootstrap
if "%TAXFS_BOOT_OK%"=="1" goto db_ready

REM First attempt failed. If PostgreSQL is reachable but rejected the
REM password, asking is the fix — so ask, rather than dumping instructions.
echo(
echo   PostgreSQL did not accept the stored password.
echo   Enter the password you chose for the "postgres" user during install.
echo   (If PostgreSQL is not installed yet, close this window and install it
echo    from https://www.postgresql.org/download/windows/ first.)
echo(
set "PGPASSWORD="
set /p PGPASSWORD=postgres password: 
if not defined PGPASSWORD goto boot_failed

call :try_bootstrap
if not "%TAXFS_BOOT_OK%"=="1" goto boot_failed

REM It worked - remember it so this is asked exactly once.
if not exist "%APPDATA%\TaxFS" mkdir "%APPDATA%\TaxFS"
> "%APPDATA%\TaxFS\pg.txt" echo %PGPASSWORD%
echo   Password saved for next time (in %APPDATA%\TaxFS, not in the project).
goto db_ready

:boot_failed
REM Re-run WITHOUT swallowing stderr, so the operator sees the real reason
REM rather than only this checklist.
echo(
echo   --- what the database setup actually reported ---
node scripts/bootstrap-db.mjs
echo(
echo   Database setup did not finish. The usual causes:
echo(
echo     * PostgreSQL is not installed - get it from
echo       https://www.postgresql.org/download/windows/
echo     * The PostgreSQL service is not running - open "Services" and start
echo       the postgresql service.
echo     * The password was wrong. Delete %APPDATA%\TaxFS\pg.txt and re-run.
echo(
echo   Copy the messages above and send them to Claude.
echo(
pause
exit /b 1

:try_bootstrap
REM bootstrap-db prints TAXFS_DATABASE_URL=... on its last line; capture it.
set TAXFS_BOOT_OK=0
for /f "usebackq tokens=1,* delims==" %%A in (`node scripts/bootstrap-db.mjs 2^>nul`) do (
  if "%%A"=="TAXFS_DATABASE_URL" (
    set "TAXFS_DATABASE_URL=%%B"
    set TAXFS_BOOT_OK=1
  ) else (
    echo %%A%%B
  )
)
exit /b 0

:db_ready
echo(

echo [4/5] Building the app for fast navigation (one-time, ~20-40 seconds)...
call pnpm build
if errorlevel 1 (
  echo(
  echo   Build failed. Copy the message above and send it to Claude.
  echo(
  pause
  exit /b 1
)
echo(

echo [5/5] Starting TaxFS...
echo(
echo   When you see "Ready", open   http://localhost:3000   in your browser.
echo   Keep this window open while you use TaxFS.  Press Ctrl+C here to stop.
echo(
REM Local operator mode: no hosted sign-in, same database walls (restricted
REM role + row-level security) as the hosted deployment.
set TAXFS_LOCAL_OPERATOR=1
call pnpm --filter web start
