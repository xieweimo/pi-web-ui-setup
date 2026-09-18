$ErrorActionPreference = 'Continue'
# Clean up a previous (possibly failed) install so the installer can start fresh.
# Removing PiWebUI is optional - the installer reuses an existing portable Node - but it
# guarantees no half-applied state survives.

Write-Host '=== pi-web-ui cleanup ==='

# Only stop processes launched by this portable installation. Never kill a host pi-web-ui
# merely because it happens to use the same localhost ports.
$root = Join-Path $env:USERPROFILE 'PiWebUI'
$portableNode = Join-Path $root 'node\node.exe'
if (Test-Path $portableNode) {
  foreach ($port in 8787, 8788) {
    Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | ForEach-Object {
      $proc = Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue
      if ($proc -and $proc.Path -and $proc.Path.Equals($portableNode, [System.StringComparison]::OrdinalIgnoreCase)) {
        Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue
      }
    }
  }
}

# 2. install directory (portable node + applied patches + install.json)
if (Test-Path $root) {
  Remove-Item $root -Recurse -Force -ErrorAction SilentlyContinue
  Write-Host "removed $root"
} else {
  Write-Host "no install directory at $root"
}

# 3. temp artifacts
foreach ($f in @('node-portable.zip', 'node-portable-extract', 'PiWebUI-Setup.zip', 'PiWebUI-Setup_pi-0.85.1_web-0.86.2.zip')) {
  $p = Join-Path $env:TEMP $f
  if (Test-Path $p) { Remove-Item $p -Recurse -Force -ErrorAction SilentlyContinue; Write-Host "removed temp $f" }
}

# 4. desktop files created by the installer
$desktop = [Environment]::GetFolderPath('Desktop')
if (-not $desktop) { $desktop = Join-Path $env:USERPROFILE 'Desktop' }
$lnk = Join-Path $desktop 'Pi Web UI.lnk'
if (Test-Path $lnk) { Remove-Item $lnk -Force -ErrorAction SilentlyContinue; Write-Host 'removed desktop shortcut' }
# 5. Shared ~/.pi-web plugins and ~/.pi settings are intentionally preserved.
# They may belong to a host installation or contain user configuration.

# 6. settings.json written by the OLD installer may contain a BOM, which makes pi fail
#    with "Failed to parse settings file". Report it here; the installer rewrites the file
#    without a BOM on the next run.
$settings = Join-Path $env:USERPROFILE '.pi\agent\settings.json'
if (Test-Path $settings) {
  $bytes = [System.IO.File]::ReadAllBytes($settings)
  $bom = ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
  if ($bom) {
    [System.IO.File]::WriteAllText($settings, [System.Text.Encoding]::UTF8.GetString($bytes, 3, $bytes.Length - 3), (New-Object System.Text.UTF8Encoding($false)))
    Write-Host 'stripped BOM from .pi\agent\settings.json'
  } else {
    Write-Host 'settings.json has no BOM (ok)'
  }
}

Write-Host ''
Write-Host 'Cleanup done. Re-run the installer to get a fresh, fully patched install.'
