@echo off
setlocal
set "PS1_URL=https://raw.githubusercontent.com/xieweimo/pi-web-ui-setup/main/install.ps1"
echo === pi-web-ui-setup (cmd entry) ===
rem The random query string bypasses the CDN cache so the newest install.ps1 is fetched.
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ProgressPreference='SilentlyContinue'; $u='%PS1_URL%?t=' + (Get-Random); iex (irm $u)"
set RC=%ERRORLEVEL%
if not "%RC%"=="0" (
  echo.
  echo Install failed ^(exit %RC%^). See the messages above.
  pause
  exit /b %RC%
)
echo.
echo Done. Use the "Pi Web UI" shortcut on your Desktop.
rem Pause only when double-clicked (cmdcmdline contains this script name).
echo %cmdcmdline% | find /i "%~nx0" >nul && pause
exit /b 0
