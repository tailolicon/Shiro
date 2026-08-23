@echo off
setlocal
PowerShell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\Start-Shiro-Tunnel.ps1"
if errorlevel 1 (
  echo.
  echo The Shiro tunnel could not start. See the message above.
  pause
)
