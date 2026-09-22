@echo off
set "ROOT=%~dp0.."
echo.
echo   Starting pi-web-ui DEV environment...
echo   (dev UI :5173  backend :8788  watchdog :8791)
echo.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%ROOT%\scripts\start-pi-web-ui-dev.ps1" -OpenBrowser
echo.
if %ERRORLEVEL% neq 0 (
  echo   [FAILED] exit code = %ERRORLEVEL%
) else (
  echo   [OK] dev UI should be open in your browser: http://localhost:5173
  echo   To stop it later, double-click: stop-pi-web-ui-dev.cmd
)
echo.
pause
exit /b %ERRORLEVEL%
