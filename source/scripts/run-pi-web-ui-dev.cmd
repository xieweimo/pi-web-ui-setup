@echo off
set "ROOT=%~dp0.."
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%ROOT%\scripts\start-pi-web-ui-dev.ps1" -OpenBrowser
exit /b %ERRORLEVEL%
