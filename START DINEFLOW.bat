@echo off
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
 echo Install Node.js 24 or later, then run this launcher again.
 pause
 exit /b 1
)
if not exist "node_modules\nodemailer\package.json" (
 call npm ci --no-audit --no-fund
 if errorlevel 1 (
  pause
  exit /b 1
 )
)
start "" "http://127.0.0.1:4173"
node server.cjs
pause
