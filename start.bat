@echo off
setlocal EnableExtensions
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Node.js 20+ is required. Install from https://nodejs.org/
  pause
  exit /b 1
)

REM start.bat force  = force rebuild Web UI
REM default: build when missing or src\web is newer than packages\web\dist
if /I "%~1"=="force" (
  set KAKAKE_FORCE_WEB_BUILD=1
  echo [Kakake] force rebuild Web UI
)

echo [Kakake] starting via scripts\bootstrap.mjs ...
echo [Kakake] Web build: auto if missing/outdated, or: start.bat force
echo.

node scripts\bootstrap.mjs
set EXIT_CODE=%ERRORLEVEL%
if not "%EXIT_CODE%"=="0" pause
exit /b %EXIT_CODE%
