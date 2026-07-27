@echo off
chcp 65001 >nul
cd /d "%~dp0"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0muc-check.ps1"
echo.
echo MUC score checker stopped. Press any key to close.
pause >nul
