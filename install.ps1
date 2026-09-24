$ErrorActionPreference = 'Stop'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}

# NOTE: keep this file ASCII-only. Windows PowerShell 5.1 decodes .ps1 files without a
# BOM as ANSI/GBK, so non-ASCII comments break parsing. Explanations live in README.md.

$setupVersion = 'v2026-09-24.1'
$pkgVersion  = 'pi-0.87.1_web-0.95.0'
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
$mirror   = 'https://registry.npmmirror.com'
$official = 'https://registry.npmjs.org'
$packages = @(
  @{ name = '@earendil-works/pi-coding-agent'; ver = '0.87.1'; leaf = 'pi-coding-agent-0.87.1.tgz' },
  @{ name = 'pi-web-ui';                       ver = '0.95.0'; leaf = 'pi-web-ui-0.95.0.tgz' }
)
$allowScripts = 'node-pty,esbuild,protobufjs,@google/genai'

# The Windows system proxy often points at a local proxy app. When that app is not
# running, Invoke-WebRequest fails ("cannot connect to the remote server") even though
# a direct connection works. Remember it, try direct first, then the system proxy,
# and fall back to curl.exe.
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

# A native command writing to stderr aborts the whole script while
# $ErrorActionPreference = 'Stop' (that is how npm ETARGET/404 killed the install),
# so relax it around npm calls and read $LASTEXITCODE instead.
function Invoke-Npm {
  param([string[]]$Arguments)
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & $npmExe @Arguments 2>&1 | ForEach-Object { Write-Host ("  " + $_) }
    return $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $prev
  }
}

function Test-RegistryHasPackage {
  param([string]$Reg, [string]$Pkg, [string]$Ver)
  try {
    Use-DirectLink
    return ((Invoke-WebRequest "$Reg/$Pkg/$Ver" -UseBasicParsing -TimeoutSec 25).StatusCode -eq 200)
  } catch { return $false }
}

Write-Host "=== pi-web-ui-setup $setupVersion : custom pi-web-ui (Codex quota + RMB cost + recovery button) ===" -ForegroundColor Cyan

# --- 1. Node.js: always use an isolated portable copy (no admin rights) ---
# Do not use a machine-wide npm prefix: this installer must not update an existing
# host pi/pi-web-ui installation.
$nodeOk = Test-Path (Join-Path $nodeDir 'node.exe')
if ($nodeOk) {
  Write-Host 'Reusing portable Node.js already installed.'
}
if (-not $nodeOk) {
  Write-Host "Downloading portable Node.js $nodeVersion (no admin rights needed)..."
  if (-not (Get-RemoteFile -Bases $nodeBases -Leaf "node-$nodeVersion-win-x64.zip" -Out $nodeZip)) {
    throw 'Could not download Node.js from any mirror.'
  }
  Write-Host 'Extracting portable Node.js...'
  # $root may not exist yet and Move-Item does not create intermediate folders.
  New-Item -ItemType Directory -Force -Path $root | Out-Null
  $tmpNode = Join-Path $env:TEMP 'node-portable-extract'
  Remove-Item $tmpNode -Recurse -Force -ErrorAction SilentlyContinue
  Expand-Archive -Force $nodeZip $tmpNode
  $inner = Get-ChildItem $tmpNode -Directory | Select-Object -First 1
  if (-not $inner) { throw 'Extracted Node.js archive has no directory.' }
  Remove-Item $nodeDir -Recurse -Force -ErrorAction SilentlyContinue
  Move-Item -Path $inner.FullName -Destination $nodeDir -Force
  Remove-Item $tmpNode -Recurse -Force -ErrorAction SilentlyContinue
  if (-not (Test-Path (Join-Path $nodeDir 'node.exe'))) { throw "Portable Node.js was not installed correctly at $nodeDir" }
  Write-Host "Portable Node.js installed to $nodeDir" -ForegroundColor Green
}
if (Test-Path (Join-Path $nodeDir 'node.exe')) { $env:PATH = "$nodeDir;$env:PATH" }
Write-Host "node $(node -v)"
$npmExe = if (Test-Path (Join-Path $nodeDir 'npm.cmd')) { Join-Path $nodeDir 'npm.cmd' } else { 'npm' }

# --- 2. Dependencies come from the CN mirror; only packages the mirror is missing are
#        fetched as official tarballs. --replace-registry-host=never stops npm from
#        rewriting the tarball host to the configured registry CDN. ---
Write-Host 'Resolving package sources...'
$mirrorSpecs = @()
$plainSpecs = @()
foreach ($p in $packages) {
  $plainSpecs += "$($p.name)@$($p.ver)"
  if (Test-RegistryHasPackage -Reg $mirror -Pkg $p.name -Ver $p.ver) {
    Write-Host "  mirror has $($p.name)@$($p.ver)"
    $mirrorSpecs += "$($p.name)@$($p.ver)"
  } else {
    Write-Host "  mirror missing $($p.name)@$($p.ver) -> official tarball" -ForegroundColor DarkYellow
    $mirrorSpecs += "$official/$($p.name)/-/$($p.leaf)"
  }
}

$npmMajor = 0
try { $npmMajor = [int](((& $npmExe --version) 2>$null) -replace '\..*', '') } catch { }
$allowArgs = @()
if ($npmMajor -ge 11) { $allowArgs = @("--allow-scripts=$allowScripts") }
Write-Host "npm major = $npmMajor"

$installed = $false
Write-Host 'Installing pi + pi-web-ui (fast path: mirror + official tarball)...'
$code = Invoke-Npm -Arguments (@('install', '-g', '--registry', $mirror, '--replace-registry-host=never', '--no-audit', '--no-fund', '--fetch-retries', '3', '--fetch-timeout', '120000') + $allowArgs + $mirrorSpecs)
if ($code -eq 0) { $installed = $true }
if (-not $installed) {
  Write-Host 'Fast path failed; retrying against the official registry...' -ForegroundColor Yellow
  $code = Invoke-Npm -Arguments (@('install', '-g', '--registry', $official, '--no-audit', '--no-fund', '--fetch-retries', '3', '--fetch-timeout', '120000') + $allowArgs + $plainSpecs)
  if ($code -eq 0) { $installed = $true }
}
if (-not $installed) { throw 'npm install failed for every registry.' }

foreach ($n in @('pi', 'pi-web-ui')) {
  $p = Join-Path $nodeDir "$n.cmd"
  if (Test-Path $p) { Write-Host "  shim ok: $p" } else { Write-Host "  missing shim: $n" -ForegroundColor DarkYellow }
}

# --- 3. Record node/shim paths FIRST ---
# install.json must exist before the patches run: they resolve the portable pi-web-ui
# through it. If it were written afterwards they would fall back to the npm global
# directory and silently patch the wrong copy (or fail on a machine without one).
# The launcher starts the shim via cmd.exe, so a .cmd shim is required: Get-Command may
# resolve the .ps1 variant, which cmd.exe cannot run.
$shim = Join-Path $nodeDir 'pi-web-ui.cmd'
if (-not (Test-Path $shim)) {
  $candidates = @((Join-Path $env:APPDATA 'npm\pi-web-ui.cmd'))
  $found = Get-Command pi-web-ui -ErrorAction SilentlyContinue | Where-Object { $_.Source -like '*.cmd' } | Select-Object -First 1
  if ($found) { $candidates += $found.Source }
  foreach ($c in $candidates) { if (Test-Path $c) { $shim = $c; break } }
}
New-Item -ItemType Directory -Force -Path $root | Out-Null
$cfg = @{ nodeDir = $nodeDir; shim = $shim } | ConvertTo-Json
[System.IO.File]::WriteAllText((Join-Path $root 'install.json'), $cfg, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "install.json written (nodeDir=$nodeDir)"

# --- 4. Download the customization bundle and apply it ---
# Prefer a local package sitting next to this script (offline / testing); $PSScriptRoot is
# empty when the script is piped into iex, so the check is guarded.
$localZip = $null
if ($PSScriptRoot) { $localZip = Join-Path $PSScriptRoot $zipName }
if ($localZip -and (Test-Path $localZip)) {
  Write-Host "Using local setup package: $localZip"
  Copy-Item $localZip $zip -Force
} elseif (-not (Get-RemoteFile -Bases $scriptBases -Leaf $zipName -Out $zip)) {
  throw 'Could not download the setup package from any mirror.'
}
foreach ($sub in @('configs', 'patches', 'projects', 'scripts')) {
  Remove-Item (Join-Path $root $sub) -Recurse -Force -ErrorAction SilentlyContinue
}
New-Item -ItemType Directory -Force -Path $root | Out-Null
Expand-Archive -Force $zip $root
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'scripts\install-aiwork.ps1') -SkipNpmInstall

Write-Host ''
Write-Host 'Done. Use the "Pi Web UI" shortcut on your Desktop.' -ForegroundColor Green
Write-Host 'Sign in to Codex / DeepSeek inside pi on first use.'