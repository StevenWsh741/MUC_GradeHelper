@echo off
chcp 65001 >nul
cd /d "%~dp0"
node.exe "%~dp0muc-score-checker.js" --test-alert
echo.
echo Phoenix alert test launched. Press any key to close this console.
pause >nul
