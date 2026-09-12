@echo off
setlocal
echo === pi-web-ui-setup ===
powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/xieweimo/pi-web-ui-setup/main/install.ps1 | iex"
if errorlevel 1 (
  echo.
  echo Install failed. See the messages above.
  pause
  exit /b 1
)
echo.
pause
