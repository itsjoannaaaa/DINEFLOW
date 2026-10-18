@echo off
cd /d "%~dp0"
if not exist "node_modules\nodemailer\package.json" call npm ci --no-audit --no-fund
node backend\configure-gmail.cjs
pause
