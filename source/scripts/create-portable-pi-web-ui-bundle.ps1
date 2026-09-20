$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$outDir = Join-Path $root 'archive'
$stage = Join-Path $outDir '.pi-web-ui-stage'
$zip = Join-Path $outDir 'PiWebUI-Setup_pi-0.85.1_web-0.92.0.zip'
Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item $zip -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $stage | Out-Null
$items = @('configs\pi-settings.template.json','configs\global-AGENTS.md','configs\models-store.json','configs\pi-web-ui-profiles','docs\after-install-checklist.md','extras','patches','projects\codex-usage-plugin','projects\piwork-tools-plugin','projects\quick-ask-plugin','projects\reconnect-plugin','scripts\install-aiwork.ps1','scripts\install-plugins.js','scripts\apply-pi-web-ui-profile.js','scripts\pi-web-ui-locate.js','scripts\pi-web-ui-launcher.ps1','scripts\pi-web-ui-recovery-watchdog.js','scripts\resolve-proxy.ps1')
foreach ($item in $items) {
  $source = Join-Path $root $item
  $target = Join-Path $stage $item
  New-Item -ItemType Directory -Force -Path (Split-Path $target -Parent) | Out-Null
  Copy-Item $source $target -Recurse -Force
}
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip -Force
Remove-Item $stage -Recurse -Force
Write-Host $zip
