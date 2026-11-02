@echo off
setlocal EnableExtensions
cd /d "%~dp0"

REM ---- ANSI colors (keep ASCII-only: cmd.exe misparses UTF-8 under CJK code pages) ----
set "ESC="
if not defined NO_COLOR (
  for /F %%a in ('echo prompt $E ^| cmd') do set "ESC=%%a"
)
set "C_RED=%ESC%[31m"
set "C_CYAN=%ESC%[36m"
set "C_OFF=%ESC%[0m"

where node >nul 2>&1
if errorlevel 1 (
  echo %C_RED%[ERROR]%C_OFF% Packing requires Node.js 20+ on the build machine.
  echo         End users run the portable build under dist\ -- no Node install needed.
  echo.
  pause
  exit /b 1
)

node scripts\pack-portable.mjs
set EXIT_CODE=%ERRORLEVEL%

if not "%EXIT_CODE%"=="0" (
  echo.
  echo %C_RED%[ERROR]%C_OFF% Pack failed, exit code %EXIT_CODE%
)
echo.
pause
exit /b %EXIT_CODE%