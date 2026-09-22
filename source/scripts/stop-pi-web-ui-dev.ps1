# Stop the isolated pi-web-ui source development environment.
$ErrorActionPreference = 'SilentlyContinue'

$root = Split-Path $PSScriptRoot -Parent
$runtime = Join-Path $root 'work\pi-web-ui-dev'
$watchdogPidFile = Join-Path $runtime 'watchdog.pid'
$watchdogPort = 8791

try {
    Invoke-RestMethod -Uri "http://127.0.0.1:$watchdogPort/stop" -Method Post -TimeoutSec 3 | Out-Null
} catch { }

for ($i = 0; $i -lt 50; $i++) {
    $devPorts = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
        Where-Object { $_.LocalPort -in @(8788, 5173) }
    if (-not $devPorts) { break }
    Start-Sleep -Milliseconds 100
}

if (Test-Path $watchdogPidFile) {
    $watchdogPid = [int](Get-Content $watchdogPidFile -Raw)
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$watchdogPid" -ErrorAction SilentlyContinue
    if ($process -and $process.CommandLine -like '*pi-web-ui-recovery-watchdog.js*') {
        Stop-Process -Id $watchdogPid -Force -ErrorAction SilentlyContinue
    }
    Remove-Item $watchdogPidFile -Force -ErrorAction SilentlyContinue
}

Write-Host 'pi-web-ui development environment stopped.'
