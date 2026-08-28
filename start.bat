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

REM bootstrap-db exits 2 ONLY when PostgreSQL rejected the password - the one
REM failure a prompt fixes. Anything else (not installed, service stopped,
REM broken migration) is shown verbatim, never misdiagnosed as a bad password.
if not "%TAXFS_BOOT_RC%"=="2" goto boot_failed

echo(
echo   PostgreSQL did not accept the stored password.
echo   Enter the password you chose for the "postgres" user during install.
echo(
set "PGPASSWORD="
set /p PGPASSWORD=postgres password: 
if not defined PGPASSWORD goto boot_failed

call :try_bootstrap
if not "%TAXFS_BOOT_OK%"=="1" goto boot_failed

REM It worked - remember it so this is asked exactly once. Written via
REM PowerShell reading the ENVIRONMENT variable, never via `echo %%var%%`:
REM cmd would corrupt passwords containing & | < > ^ or ! on the way to the
REM file (and run whatever follows an & as a command).
if not exist "%APPDATA%\TaxFS" mkdir "%APPDATA%\TaxFS"
powershell -NoProfile -Command "[IO.File]::WriteAllText($env:APPDATA + '\TaxFS\pg.txt', $env:PGPASSWORD)"
echo   Password saved for next time (in %APPDATA%\TaxFS, not in the project).
goto db_ready

:boot_failed
echo(
echo   --- what the database setup actually reported ---
type "%TEMP%\taxfs-boot.out" 2>nul
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
REM One run, output captured to a file: the same output feeds the URL
REM capture on success and the verbatim error report on failure - the old
REM shape re-ran the bootstrap just to see what it said.
node scripts/bootstrap-db.mjs > "%TEMP%\taxfs-boot.out" 2>&1
set TAXFS_BOOT_RC=%errorlevel%
set TAXFS_BOOT_OK=0
if not "%TAXFS_BOOT_RC%"=="0" exit /b 0
for /f "usebackq tokens=1,* delims==" %%A in ("%TEMP%\taxfs-boot.out") do (
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
