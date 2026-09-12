$ErrorActionPreference = 'Stop'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}

$pkgVersion  = 'pi-0.85.1_web-0.81.0'
$zipName     = "PiWebUI-Setup_$pkgVersion.zip"
$nodeVersion = if ($env:PI_SETUP_NODE_VERSION) { $env:PI_SETUP_NODE_VERSION } else { 'v22.23.2' }
$root        = Join-Path $env:USERPROFILE 'PiWebUI'
$nodeDir     = Join-Path $root 'node'
$zip         = Join-Path $env:TEMP $zipName
$nodeZip     = Join-Path $env:TEMP 'node-portable.zip'

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

# Windows 的系统代理常指向本机代理软件；代理没开时，PowerShell 的 Invoke-WebRequest
# 会直接报「无法连接到远程服务器」，而直连其实是通的。所以先记住它，按
# 直连 → 系统代理 → curl.exe 的顺序尝试，哪种能下就用哪种。
$savedProxy = $null
try { $savedProxy = [System.Net.WebRequest]::DefaultWebProxy } catch { }
function Use-DirectLink { try { [System.Net.WebRequest]::DefaultWebProxy = New-Object System.Net.WebProxy } catch { } }
function Use-SystemLink { if ($savedProxy) { try { [System.Net.WebRequest]::DefaultWebProxy = $savedProxy } catch { } } }

function Try-Download {
  param([string]$Url, [string]$Out)
  try {
    Invoke-WebRequest $Url -OutFile $Out -UseBasicParsing -TimeoutSec 300
    if ((Test-Path $Out) -and ((Get-Item $Out).Length -gt 0)) { return $true }
  } catch { }
  try {
    if (Get-Command curl.exe -ErrorAction SilentlyContinue) {
      & curl.exe -L -s --max-time 300 -o $Out $Url
      if ((Test-Path $Out) -and ((Get-Item $Out).Length -gt 0)) { return $true }
    }
  } catch { }
  return $false
}

function Get-RemoteFile {
  param([string[]]$Bases, [string]$Leaf, [string]$Out)
  foreach ($mode in @('direct', 'system')) {
    if ($mode -eq 'direct') { Use-DirectLink } else { Use-SystemLink }
    Write-Host "  [$mode] trying mirrors for $Leaf"
    foreach ($b in $Bases) {
      Write-Host "    $b"
      if (Try-Download -Url "$b/$Leaf" -Out $Out) { return $true }
    }
  }
  return $false
}

Write-Host '=== pi-web-ui-setup: custom pi-web-ui (Codex quota + RMB cost + recovery button) ===' -ForegroundColor Cyan

# --- 1. Node.js：优先用系统 22+，否则装便携版（免管理员） ---
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
  if (-not (Get-RemoteFile -Bases $nodeBases -Leaf "node-$nodeVersion-win-x64.zip" -Out $nodeZip)) {
    throw 'Could not download Node.js from any mirror.'
  }
  Write-Host 'Extracting portable Node.js...'
  $tmpNode = Join-Path $env:TEMP 'node-portable-extract'
  Remove-Item $tmpNode -Recurse -Force -ErrorAction SilentlyContinue
  Expand-Archive -Force $nodeZip $tmpNode
  $inner = Get-ChildItem $tmpNode -Directory | Select-Object -First 1
  Remove-Item $nodeDir -Recurse -Force -ErrorAction SilentlyContinue
  Move-Item $inner.FullName $nodeDir
  Remove-Item $tmpNode -Recurse -Force -ErrorAction SilentlyContinue
  Write-Host "Portable Node.js installed to $nodeDir" -ForegroundColor Green
}
if (Test-Path (Join-Path $nodeDir 'node.exe')) { $env:PATH = "$nodeDir;$env:PATH" }
Write-Host "node $(node -v)"

# --- 2. 安装 pi 与 pi-web-ui ---
Use-DirectLink
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

# --- 3. 下载定制安装包并应用 ---
if (-not (Get-RemoteFile -Bases $scriptBases -Leaf $zipName -Out $zip)) {
  throw 'Could not download the setup package from any mirror.'
}
foreach ($sub in @('configs', 'patches', 'projects', 'scripts')) {
  Remove-Item (Join-Path $root $sub) -Recurse -Force -ErrorAction SilentlyContinue
}
Expand-Archive -Force $zip $root
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'scripts\install-aiwork.ps1') -SkipNpmInstall

# --- 4. 记录 node/shim 路径供启动器使用（便携 Node 不在系统 PATH） ---
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
