$ErrorActionPreference = 'Stop'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}

$pkgVersion   = 'pi-0.85.1_web-0.81.0'
$zipName      = "PiWebUI-Setup_$pkgVersion.zip"
$nodeVersion  = if ($env:PI_SETUP_NODE_VERSION) { $env:PI_SETUP_NODE_VERSION } else { 'v22.23.2' }
$root         = Join-Path $env:USERPROFILE 'PiWebUI'
$nodeDir      = Join-Path $root 'node'
$zip          = Join-Path $env:TEMP $zipName
$nodeZip      = Join-Path $env:TEMP 'node-portable.zip'

$scriptBases = @(
  'https://raw.githubusercontent.com/xieweimo/pi-web-ui-setup/main',
  'https://cdn.jsdelivr.net/gh/xieweimo/pi-web-ui-setup@main',
  'https://ghproxy.net/https://raw.githubusercontent.com/xieweimo/pi-web-ui-setup/main'
)
$nodeBases = @(
  "https://nodejs.org/dist/$nodeVersion",
  "https://registry.npmmirror.com/-/binary/node/$nodeVersion",
  "https://mirrors.tuna.tsinghua.edu.cn/nodejs-release/$nodeVersion"
)
$registries = @('https://registry.npmmirror.com', 'https://registry.npmjs.org')

function Get-FirstWorkingUrl {
  param([string[]]$Bases, [string]$Leaf, [string]$Out)
  foreach ($b in $Bases) {
    try {
      Write-Host "  trying $b/$Leaf"
      Invoke-WebRequest "$b/$Leaf" -OutFile $Out -UseBasicParsing
      return $true
    } catch {
      Write-Host ('  failed: ' + $_.Exception.Message) -ForegroundColor DarkYellow
    }
  }
  return $false
}

Write-Host '=== pi-web-ui-setup: custom pi-web-ui (Codex quota + RMB cost + recovery button) ===' -ForegroundColor Cyan

# --- 1. Node.js: 优先用系统已装的 22+，否则装便携版（不需要管理员权限） ---
$nodeOk = $false
if (Get-Command node -ErrorAction SilentlyContinue) {
  try {
    $major = [int]((node -v) -replace '^v', '').Split('.')[0]
    if ($major -ge 22) { $nodeOk = $true; Write-Host "Found system Node.js $(node -v)" }
    else { Write-Host "System Node.js $(node -v) is too old (need 22+); using portable Node.js." -ForegroundColor Yellow }
  } catch { }
}
if (-not $nodeOk -and (Test-Path (Join-Path $nodeDir 'node.exe'))) {
  $nodeOk = $true
  Write-Host 'Reusing portable Node.js already installed.'
}
if (-not $nodeOk) {
  Write-Host "Downloading portable Node.js $nodeVersion (no admin rights needed)..."
  $leaf = "node-$nodeVersion-win-x64.zip"
  if (-not (Get-FirstWorkingUrl -Bases $nodeBases -Leaf $leaf -Out $nodeZip)) {
    throw 'Could not download Node.js from any mirror.'
  }
  New-Item -ItemType Directory -Force -Path $root | Out-Null
  $tmpNode = Join-Path $env:TEMP 'node-portable-extract'
  Remove-Item $tmpNode -Recurse -Force -ErrorAction SilentlyContinue
  Expand-Archive -Force $nodeZip $tmpNode
  $inner = Get-ChildItem $tmpNode -Directory | Select-Object -First 1
  Remove-Item $nodeDir -Recurse -Force -ErrorAction SilentlyContinue
  Move-Item $inner.FullName $nodeDir
  Remove-Item $tmpNode -Recurse -Force -ErrorAction SilentlyContinue
  Write-Host "Portable Node.js installed to $nodeDir" -ForegroundColor Green
}
if (Test-Path (Join-Path $nodeDir 'node.exe')) {
  $env:PATH = "$nodeDir;$env:PATH"
}
Write-Host "node $(node -v)"

# --- 2. 安装 pi 与 pi-web-ui（切换 registry 镜像直到成功） ---
$npmExe = if (Test-Path (Join-Path $nodeDir 'npm.cmd')) { Join-Path $nodeDir 'npm.cmd' } else { 'npm' }
$installed = $false
foreach ($reg in $registries) {
  try {
    Write-Host "Installing pi + pi-web-ui (registry: $reg)..."
    & $npmExe install -g --registry $reg '@earendil-works/pi-coding-agent@0.85.1' 'pi-web-ui@0.81.0'
    if ($LASTEXITCODE -eq 0) { $installed = $true; break }
    Write-Host "  npm exited with $LASTEXITCODE" -ForegroundColor DarkYellow
  } catch {
    Write-Host ('  failed: ' + $_.Exception.Message) -ForegroundColor DarkYellow
  }
}
if (-not $installed) { throw 'npm install failed for every registry.' }

# --- 3. 下载安装包并应用定制 ---
if (-not (Get-FirstWorkingUrl -Bases $scriptBases -Leaf $zipName -Out $zip)) {
  throw 'Could not download the setup package from any mirror.'
}
Remove-Item $root\configs, $root\patches, $root\projects, $root\scripts -Recurse -Force -ErrorAction SilentlyContinue
Expand-Archive -Force $zip $root
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'scripts\install-aiwork.ps1') -SkipNpmInstall

# --- 4. 记录 node/shim 位置，供启动器使用（便携 Node 不在系统 PATH 里） ---
$shim = Join-Path $nodeDir 'pi-web-ui.cmd'
if (-not (Test-Path $shim)) {
  $cmd = Get-Command pi-web-ui -ErrorAction SilentlyContinue
  if ($cmd) { $shim = $cmd.Source } else { $shim = Join-Path $env:APPDATA 'npm\pi-web-ui.cmd' }
}
$cfg = @{ nodeDir = $nodeDir; shim = $shim } | ConvertTo-Json
[System.IO.File]::WriteAllText((Join-Path $root 'install.json'), $cfg, (New-Object System.Text.UTF8Encoding($false)))

Write-Host ''
Write-Host 'Done. Use the "Pi Web UI" shortcut on your Desktop.' -ForegroundColor Green
Write-Host 'Sign in to Codex / DeepSeek inside pi on first use.'
