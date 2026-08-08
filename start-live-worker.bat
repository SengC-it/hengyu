@echo off
setlocal
cd /d "%~dp0"

if not exist "node_modules" (
  echo [Hengyu] node_modules is missing. Please open this project once in the Codex workspace so dependencies are available.
  pause
  exit /b 1
)

where node >nul 2>&1
if errorlevel 1 (
  echo [Hengyu] Node.js 22 or newer is required but was not found in PATH.
  pause
  exit /b 1
)

if not exist ".env.live.local" (
  copy /Y "config\live-worker.env.example" ".env.live.local" >nul
  echo [Hengyu] Created .env.live.local from the template.
  echo Please fill HENGYU_INGEST_SECRET, save the file, and double-click this BAT again.
  notepad ".env.live.local"
  pause
  exit /b 2
)

echo [Hengyu] Starting local live worker. Keep this window open.
node --use-env-proxy "scripts\live-worker.mjs"
set "EXIT_CODE=%ERRORLEVEL%"
echo.
echo [Hengyu] Worker stopped with code %EXIT_CODE%.
pause
exit /b %EXIT_CODE%
