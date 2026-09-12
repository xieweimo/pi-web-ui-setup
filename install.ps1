$ErrorActionPreference = 'Stop'
$repo = 'https://raw.githubusercontent.com/xieweimo/pi-web-ui-setup/main'
$zipName = 'PiWebUI-Setup_pi-0.85.1_web-0.81.0.zip'
$target = Join-Path $env:USERPROFILE 'PiWebUI'
$zip = Join-Path $env:TEMP $zipName

Write-Host '=== pi-web-ui-setup ===' -ForegroundColor Cyan
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host 'Node.js was not found.' -ForegroundColor Yellow
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    Write-Host 'Installing Node.js LTS via winget...'
    winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
    Write-Host 'Node.js installed. Close this window and run the same command again.' -ForegroundColor Yellow
    exit 0
  }
  throw 'Please install Node.js 22 or newer from https://nodejs.org and run this again.'
}

Write-Host 'Downloading setup package...'
Invoke-WebRequest "$repo/$zipName" -OutFile $zip -UseBasicParsing

Remove-Item $target -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $target | Out-Null
Expand-Archive -Force $zip $target

& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $target 'scripts\install-aiwork.ps1')

Write-Host ''
Write-Host 'Done. Use the "Pi Web UI" shortcut on your Desktop to start.' -ForegroundColor Green
Write-Host 'Sign in to Codex / DeepSeek inside pi when you first use it.'
