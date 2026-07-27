@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist "remote-config.local.json" (
  echo 请先双击“配置手机提醒.cmd”完成配对。
  pause
  exit /b 1
)
if not exist "node_modules\playwright-core" (
  call npm.cmd install --no-audit --no-fund
  if errorlevel 1 (
    pause
    exit /b 1
  )
)
title MUC 手机远程控制
node.exe muc-remote-listener.js
pause
