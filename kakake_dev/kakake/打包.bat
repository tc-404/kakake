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

echo [Kakake] Portable pack: Windows x64 + Linux x64
echo [Kakake] Output: dist\kakake-win-x64  and  dist\kakake-linux-x64
echo.

node scripts\pack-portable.mjs
set EXIT_CODE=%ERRORLEVEL%

echo.
if not "%EXIT_CODE%"=="0" (
  echo [ERROR] Pack failed, exit code %EXIT_CODE%
) else (
  echo [Kakake] Pack finished.
)
echo.
pause
exit /b %EXIT_CODE%