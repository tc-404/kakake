@echo off
setlocal EnableExtensions
cd /d "%~dp0"

REM ---- ANSI colors ----
REM Same rule as src/core/console-style.ts: honor NO_COLOR, and never let SGR codes
REM leak into redirected output. ESC itself comes from `prompt $E` — no external tools,
REM and this file must stay ASCII-only (cmd.exe misparses UTF-8 under CJK code pages).
set "ESC="
if not defined NO_COLOR (
  for /F %%a in ('echo prompt $E ^| cmd') do set "ESC=%%a"
)
set "C_RED=%ESC%[31m"
set "C_GREEN=%ESC%[32m"
set "C_YELLOW=%ESC%[33m"
set "C_CYAN=%ESC%[36m"
set "C_OFF=%ESC%[0m"

where node >nul 2>&1
if errorlevel 1 (
  echo %C_RED%[ERROR]%C_OFF% Node.js 20+ is required. Install from https://nodejs.org/
  pause
  exit /b 1
)

REM start.bat [force] [verbose]
REM   force   = rebuild Web UI even if packages\web\dist looks up to date
REM   verbose = keep install/build output (default: quiet, and clear screen before start)
REM NOTE: keep this file ASCII-only, cmd.exe misparses UTF-8 comments under CJK code pages.
:parse_args
if "%~1"=="" goto args_done
if /I "%~1"=="force" set KAKAKE_FORCE_WEB_BUILD=1
if /I "%~1"=="verbose" set KAKAKE_VERBOSE_BOOT=1
shift
goto parse_args
:args_done

REM Managed relaunch: the backend may exit with code 86 to request an in-place
REM update apply + restart. This launcher loop handles it (see scripts/apply-update.mjs).
set KAKAKE_MANAGED_RELAUNCH=1

:run_loop
REM Use CALL: on machines where `node` resolves to a .cmd/.bat shim (nvm-windows,
REM fnm, volta, corporate proxies, DSH harness...), invoking it WITHOUT call hands
REM control to the shim and never returns here, so the relaunch loop would die and
REM the process would exit without being brought back up. CALL is a no-op for node.exe.
call node scripts\bootstrap.mjs
set EXIT_CODE=%ERRORLEVEL%
if "%EXIT_CODE%"=="86" (
  echo %C_CYAN%[Kakake]%C_OFF% Applying update / restarting...
  call node scripts\apply-update.mjs
  REM Windows portable: the running node.exe is locked; a new one was staged as node.exe.new
  if exist runtime\node.exe.new move /y runtime\node.exe.new runtime\node.exe >nul 2>&1
  goto run_loop
)
if not "%EXIT_CODE%"=="0" pause
exit /b %EXIT_CODE%