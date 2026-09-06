@echo off
setlocal EnableExtensions
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Node.js 20+ is required. Install from https://nodejs.org/
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

node scripts\bootstrap.mjs
set EXIT_CODE=%ERRORLEVEL%
if not "%EXIT_CODE%"=="0" pause
exit /b %EXIT_CODE%