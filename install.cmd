@echo off
setlocal
set "PS1_URL=https://raw.githubusercontent.com/xieweimo/pi-web-ui-setup/main/install.ps1"
echo === pi-web-ui-setup (cmd entry) ===
rem The random query string bypasses the CDN cache so the newest install.ps1 is fetched.
rem Windows often has a system proxy pointing at a local proxy app that is not running;
rem PowerShell then cannot reach GitHub at all. Try normally first, then with the proxy bypassed.
set "BOOT=$ProgressPreference='SilentlyContinue'; try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}; $u='%PS1_URL%?t=' + (Get-Random); iex (irm $u)"
powershell -NoProfile -ExecutionPolicy Bypass -Command "%BOOT%"
if not "%ERRORLEVEL%"=="0" (
  echo Retrying without the system proxy...
  powershell -NoProfile -ExecutionPolicy Bypass -Command "try { [Net.WebRequest]::DefaultWebProxy = New-Object Net.WebProxy } catch {}; %BOOT%"
)
set RC=%ERRORLEVEL%
if not "%RC%"=="0" (
  echo.
  echo Install failed ^(exit %RC%^). See the messages above.
  pause
  exit /b %RC%
)
echo.
echo Done. Use the "Pi Web UI" shortcut on your Desktop.
rem Pause only when double-clicked (cmdcmdline contains this script name). findstr is used
rem because Git Bash ships a Unix "find" that can shadow Windows find.exe on PATH.
echo %cmdcmdline% | findstr /i /c:"%~nx0" >nul && pause
exit /b 0
