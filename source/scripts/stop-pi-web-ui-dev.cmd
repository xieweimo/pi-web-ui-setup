@echo off
set "ROOT=%~dp0.."
echo.
echo   Stopping pi-web-ui DEV environment (:5173 / :8788 / :8791)...
echo   The production instance on :8787 is NOT affected.
echo.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%ROOT%\scripts\stop-pi-web-ui-dev.ps1"
echo.
if %ERRORLEVEL% neq 0 (
  echo   [WARN] exit code = %ERRORLEVEL%
) else (
  echo   [OK] dev environment stopped.
)
echo.
pause
exit /b %ERRORLEVEL%
