@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed or not on PATH.
  echo Install the Windows LTS version from https://nodejs.org/
  pause
  exit /b 1
)
start http://localhost:8787
node server.mjs
