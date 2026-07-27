@echo off
chcp 65001 >nul
cd /d "%~dp0"
node.exe muc-remote-notify.js --test
pause
