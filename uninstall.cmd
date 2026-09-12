@echo off
setlocal
set "PS1_URL=https://raw.githubusercontent.com/xieweimo/pi-web-ui-setup/main/uninstall.ps1"
echo === pi-web-ui cleanup (cmd entry) ===
rem Random query string bypasses the CDN cache; retry without the system proxy if the
rem first attempt cannot reach GitHub (stale proxy apps are common on Windows).
set "BOOT=$ProgressPreference='SilentlyContinue'; try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}; $u='%PS1_URL%?t=' + (Get-Random); iex (irm $u)"
powershell -NoProfile -ExecutionPolicy Bypass -Command "%BOOT%"
if not "%ERRORLEVEL%"=="0" (
  echo Retrying without the system proxy...
  powershell -NoProfile -ExecutionPolicy Bypass -Command "try { [Net.WebRequest]::DefaultWebProxy = New-Object Net.WebProxy } catch {}; %BOOT%"
)
set RC=%ERRORLEVEL%
if not "%RC%"=="0" (
  echo.
  echo Cleanup failed ^(exit %RC%^). See the messages above.
  pause
  exit /b %RC%
)
echo.
echo Cleanup done. Now run the installer.
echo %cmdcmdline% | findstr /i /c:"%~nx0" >nul && pause
exit /b 0
