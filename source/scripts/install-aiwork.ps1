param([switch]$SkipNpmInstall)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$templateFile = Join-Path $root 'configs\pi-settings.template.json'
$agentDir = Join-Path $env:USERPROFILE '.pi\agent'
if (-not $SkipNpmInstall) { npm install -g '@earendil-works/pi-coding-agent@0.85.1' 'pi-web-ui@0.94.1' }
if (-not (Get-Command pi -ErrorAction SilentlyContinue) -or -not (Get-Command pi-web-ui -ErrorAction SilentlyContinue)) { throw 'pi or pi-web-ui was not found.' }
New-Item -ItemType Directory -Force -Path $agentDir | Out-Null
$template = Get-Content $templateFile -Raw -Encoding UTF8 | ConvertFrom-Json
$settingsFile = Join-Path $agentDir 'settings.json'
$current = if (Test-Path $settingsFile) { Get-Content $settingsFile -Raw -Encoding UTF8 | ConvertFrom-Json } else { [pscustomobject]@{} }
foreach ($p in $template.PSObject.Properties) { $current | Add-Member -Force NoteProperty $p.Name $p.Value }
# 必须写成「无 BOM」的 UTF-8：Windows PowerShell 5.1 的 Set-Content -Encoding UTF8
# 会写入 BOM(EF BB BF)，而 pi 用 Node 的 JSON.parse 读取 settings.json，遇到 BOM 会直接
# 报 "Unexpected token '', '{ "s"... is not valid JSON"（Failed to parse settings file）。
$json = $current | ConvertTo-Json -Depth 20
[System.IO.File]::WriteAllText($settingsFile, $json, (New-Object System.Text.UTF8Encoding($false)))

# 代理防复发：设置里没有 httpProxy、但本机确实开着系统代理时，把它写进 pi 设置。
# 不写的话 Codex 等境外模型会直连 chatgpt.com，全部报 fetch failed（2026-09-13 丢过一次 httpProxy）。
$resolveProxy = Join-Path $root 'scripts\resolve-proxy.ps1'
if ((Test-Path $resolveProxy) -and -not $current.httpProxy) {
    . $resolveProxy
    $detected = Get-PiProxyUrl
    if ($detected) {
        $current | Add-Member -Force NoteProperty httpProxy $detected.url
        [System.IO.File]::WriteAllText($settingsFile, ($current | ConvertTo-Json -Depth 20), (New-Object System.Text.UTF8Encoding($false)))
        Write-Host ('  已把检测到的代理写入 pi 设置（来源：' + $detected.source + '）：' + $detected.url)
    }
}

# 全局 AGENTS.md 与自定义模型库：只补缺失，已存在则原样保留（不覆盖用户自己的改动）。
$seedFiles = @(
    @{ src = 'configs\global-AGENTS.md';  dst = 'AGENTS.md';         label = '全局 AGENTS.md' },
    @{ src = 'configs\models-store.json'; dst = 'models-store.json'; label = '自定义模型库 models-store.json' }
)
foreach ($seed in $seedFiles) {
    $srcFile = Join-Path $root $seed.src
    $dstFile = Join-Path $agentDir $seed.dst
    if (-not (Test-Path $srcFile)) { Write-Host ('  缺少 ' + $seed.src + '，跳过'); continue }
    if (Test-Path $dstFile) { Write-Host ('  ' + $seed.label + ' 已存在，保留现有文件') }
    else { Copy-Item $srcFile $dstFile -Force; Write-Host ('  已写入 ' + $seed.label + ' -> ' + $dstFile) }
}

# 界面插件（codex-usage 额度/成本、piwork-tools 同步、quick-ask 临时问问、reconnect 重连）：拷进 <dataDir>/plugins/，
# 与 pi-web-ui 包目录分离，npm 升级不会动它们。
node (Join-Path $root 'scripts\install-plugins.js')

# 浏览器扩展 page-picker：解压到安装目录并预先打好「全站放行」补丁。
# 扩展活在浏览器里，安装脚本只能准备好文件，实际加载要在 edge://extensions 里手动点
# 「加载解压缩的扩展」（步骤写在下面的桌面清单里）。
$extZip = Join-Path $root 'extras\page-picker-extension.zip'
$extDir = Join-Path $root 'page-picker-extension'
$extPatch = Join-Path $root 'patches\apply-page-picker-all-urls.js'
if (Test-Path $extZip) {
    Remove-Item $extDir -Recurse -Force -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Force -Path $extDir | Out-Null
    Expand-Archive -Force $extZip $extDir
    if (Test-Path $extPatch) {
        & node $extPatch --dir $extDir | Out-Null
    }
    Write-Host ('  page-picker 扩展已就绪（含全站放行补丁）：' + $extDir)
} else {
    Write-Host '  未找到 extras\page-picker-extension.zip，跳过浏览器扩展准备'
}
node (Join-Path $root 'scripts\apply-pi-web-ui-profile.js')
$launcher = Join-Path $root 'scripts\pi-web-ui-launcher.ps1'
$desktop = [Environment]::GetFolderPath('Desktop')
if (-not $desktop) { $desktop = Join-Path $env:USERPROFILE 'Desktop' }
New-Item -ItemType Directory -Force -Path $desktop | Out-Null
$shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $desktop 'Pi Web UI.lnk'))
$shortcut.TargetPath = 'powershell.exe'
$shortcut.Arguments = '-NoProfile -ExecutionPolicy Bypass -File "' + $launcher + '"'
$shortcut.WorkingDirectory = $root
$shortcut.IconLocation = "$env:SystemRoot\System32\shell32.dll,220"
$shortcut.Save()
$shortcut.Save()

# 桌面放一份「装完之后要做的事」清单：登录 / 装浏览器扩展 / shellPath 三件事。
# 写成 UTF-8 带 BOM 的 .txt，记事本双击打开不会乱码。
$checklist = Join-Path $root 'docs\after-install-checklist.md'
if (Test-Path $checklist) {
    $desktopCopy = Join-Path $desktop '装完之后要做的事.txt'
    $md = Get-Content $checklist -Raw -Encoding UTF8
    [System.IO.File]::WriteAllText($desktopCopy, $md, (New-Object System.Text.UTF8Encoding($true)))
    Write-Host ('  已放置说明文档到桌面：' + $desktopCopy)
}

Write-Host 'Install complete. A Pi Web UI launcher shortcut was created on Desktop.'
Write-Host 'Configure OAuth/API keys separately on this computer.'
