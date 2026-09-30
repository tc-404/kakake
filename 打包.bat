@echo off
setlocal EnableExtensions
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Packing requires Node.js 20+ on the build machine.
  echo         End users run the portable build under dist\ -- no Node install needed.
  echo.
  pause
  exit /b 1
)

node scripts\pack-portable.mjs
set EXIT_CODE=%ERRORLEVEL%

if not "%EXIT_CODE%"=="0" (
  echo.
  echo [ERROR] Pack failed, exit code %EXIT_CODE%
)
echo.
pause
exit /b %EXIT_CODE%