$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$outDir = Join-Path $root 'archive'
$stage = Join-Path $outDir '.pi-web-ui-stage'
$zip = Join-Path $outDir 'PiWebUI-Setup_pi-1.0.2_web-0.99.0.zip'
$candidate = Join-Path $outDir '.pi-web-ui-next.zip'
$backup = Join-Path $outDir '.pi-web-ui-previous.zip'
Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item $candidate -Force -ErrorAction SilentlyContinue
Remove-Item $backup -Force -ErrorAction SilentlyContinue
try {
New-Item -ItemType Directory -Force -Path $stage | Out-Null
$items = @('configs\pi-settings.template.json','configs\global-AGENTS.md','configs\models-store.json','configs\pi-web-ui-restart-descriptor.example.json','configs\pi-web-ui-profiles','docs\after-install-checklist.md','extras','projects\codex-usage-plugin','projects\piwork-tools-plugin','projects\piwork-ui-layout-plugin','projects\proxy-health-plugin','projects\reconnect-plugin','scripts\install-aiwork.ps1','scripts\install-plugins.js','scripts\apply-pi-web-ui-profile.js','scripts\pi-web-ui-locate.js','scripts\pi-core-locate.js','scripts\pi-web-ui-entry-cache-bust.js','scripts\pi-web-ui-launcher.ps1','scripts\pi-web-ui-recovery-watchdog.js','scripts\resolve-proxy.ps1','scripts\manage-plan-board.mjs','scripts\repair-invalid-toolcall-names.js','scripts\check-pi-web-ui-patches.js')
foreach ($item in $items) {
  $source = Join-Path $root $item
  $target = Join-Path $stage $item
  New-Item -ItemType Directory -Force -Path (Split-Path $target -Parent) | Out-Null
  Copy-Item $source $target -Recurse -Force
}
# 仅打包所有版本 profile 实际需要的补丁，以及扩展安装补丁；不把设备补丁/上游草稿整目录带出。
$patches = @('patches/apply-page-picker-all-urls.js')
foreach ($profile in Get-ChildItem (Join-Path $root 'configs\pi-web-ui-profiles') -Filter '*.json' -File) {
  $data = Get-Content $profile.FullName -Raw -Encoding UTF8 | ConvertFrom-Json
  $patches += @($data.patches)
}
foreach ($rel in ($patches | Sort-Object -Unique)) {
  if ($rel -notmatch '^patches/[A-Za-z0-9_.-]+\.(js|ps1)$') { throw "不合法的补丁路径：$rel" }
  $source = Join-Path $root $rel
  if (-not (Test-Path $source -PathType Leaf)) { throw "缺少补丁：$rel" }
  $target = Join-Path $stage $rel
  New-Item -ItemType Directory -Force -Path (Split-Path $target -Parent) | Out-Null
  Copy-Item $source $target -Force
}
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $candidate -Force
if (Test-Path $zip) {
  [System.IO.File]::Replace($candidate, $zip, $backup)
} else {
  Move-Item $candidate $zip
}
} finally {
  Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item $candidate -Force -ErrorAction SilentlyContinue
  Remove-Item $backup -Force -ErrorAction SilentlyContinue
}
Write-Host $zip
