@echo off
setlocal
PowerShell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\Start-Shiro.ps1"
if errorlevel 1 (
  echo.
  echo Shiro could not start. See the message above.
  pause
)
