# 一键同步：把本机对 pi / pi-web-ui 的改动同步到 GitHub 的 pi-web-ui-setup
#
# 做四件事：
#   1. 重新打包便携安装包（含补丁、插件、定位模块、启动器）
#   2. 同步到公开仓库目录 pi-web-ui-setup
#   3. 提交并推送私有仓库 AIWork 与公开仓库 pi-web-ui-setup
#   4. 从 GitHub 匿名下载关键文件，与本地逐个比对 hash，确认真的同步成功
#
# 用法：powershell -ExecutionPolicy Bypass -File scripts\sync-pi-web-ui-setup.ps1
$ErrorActionPreference = 'Stop'

$repoRoot   = Split-Path $PSScriptRoot -Parent
$workRoot   = Split-Path $repoRoot -Parent                       # C:\AIWork\PI
$privateDir = Split-Path $workRoot -Parent                       # C:\AIWork
$publicDir  = Join-Path $workRoot 'pi-web-ui-setup'
$zipName    = 'PiWebUI-Setup_pi-0.85.1_web-0.94.1.zip'
$files      = @('install.ps1', 'install.cmd', 'uninstall.ps1', 'uninstall.cmd', $zipName, 'source/docs/after-install-checklist.md', 'source/projects/piwork-tools-plugin/manifest.json')
$rawBase    = 'https://raw.githubusercontent.com/xieweimo/pi-web-ui-setup/main'

function Info($m) { Write-Host $m }
function Ok($m) { Write-Host $m -ForegroundColor Green }
function Warn($m) { Write-Host $m -ForegroundColor Yellow }

# 不用 Get-FileHash：本机 PowerShell 5.1 的 Microsoft.PowerShell.Utility 偶尔加载不出来
# （Import-Module 也救不回来），校验就会整段报 CommandNotFoundException。
# 直接走 .NET 计算 SHA256，只依赖 Base Class Library，永远可用。
function Get-Sha256([string]$Path) {
    $stream = [System.IO.File]::OpenRead($Path)
    try {
        $sha = [System.Security.Cryptography.SHA256]::Create()
        try {
            return (($sha.ComputeHash($stream) | ForEach-Object { $_.ToString('x2') }) -join '')
        } finally { $sha.Dispose() }
    } finally { $stream.Dispose() }
}

Info '=== 1/5 重新打包安装包 ==='
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'create-portable-pi-web-ui-bundle.ps1')
$zipPath = Join-Path $repoRoot "archive\$zipName"
if (-not (Test-Path $zipPath)) { throw "打包失败：$zipPath 不存在" }
Copy-Item $zipPath (Join-Path $publicDir $zipName) -Force
# 公开安装入口只保留当前版本，避免用户误下载旧包；私有 archive/ 仍保留历史包。
Get-ChildItem $publicDir -File -Filter 'PiWebUI-Setup_pi-*_web-*.zip' |
    Where-Object { $_.Name -ne $zipName } |
    Remove-Item -Force
Ok ('  安装包已更新: ' + [math]::Round((Get-Item $zipPath).Length / 1KB, 1) + ' KB')

Info '=== 2/5 镜像定制源码到公开仓库 source/ ==='
# 公开仓库只放 zip 的话，别人（包括你自己换电脑）在 GitHub 上看不到任何定制内容——
# 插件源码、补丁、配置模板、清单文档都藏在二进制 zip 里。这里把它们一并镜像到
# pi-web-ui-setup/source/：既能在网页上直接浏览，也能用
# `pi-web-ui install https://github.com/<owner>/pi-web-ui-setup/tree/main/source/projects/<插件>` 直接装插件。
$mirror = @(
    @{ from = 'projects\codex-usage-plugin';      to = 'source\projects\codex-usage-plugin' },
    @{ from = 'projects\piwork-tools-plugin';     to = 'source\projects\piwork-tools-plugin' },
    @{ from = 'projects\quick-ask-plugin';        to = 'source\projects\quick-ask-plugin' },
    @{ from = 'projects\reconnect-plugin';        to = 'source\projects\reconnect-plugin' },
    @{ from = 'patches';                          to = 'source\patches' },
    @{ from = 'configs';                          to = 'source\configs' },
    @{ from = 'docs\after-install-checklist.md'; to = 'source\docs\after-install-checklist.md' },
    @{ from = 'extras\page-picker-extension.zip'; to = 'source\extras\page-picker-extension.zip' },
    @{ from = 'scripts';                          to = 'source\scripts' }
)
$srcRoot = Join-Path $publicDir 'source'
Remove-Item $srcRoot -Recurse -Force -ErrorAction SilentlyContinue
foreach ($m in $mirror) {
    $from = Join-Path $repoRoot $m.from
    $to = Join-Path $publicDir $m.to
    if (-not (Test-Path $from)) { Warn ('  跳过（不存在）：' + $m.from); continue }
    New-Item -ItemType Directory -Force -Path (Split-Path $to -Parent) | Out-Null
    Copy-Item $from $to -Recurse -Force
}
# 日志/备份不入公开仓库
Get-ChildItem $srcRoot -Recurse -File -Include *.log,*.bak -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
# 本机设置快照（带本机代理端口/绝对路径）不是分发内容，只公开真正的模板与档案
foreach ($junk in @('settings.json', 'settings.json.bak-before-fix', 'pi-settings-snapshot.json')) {
    Remove-Item (Join-Path $srcRoot ('configs\' + $junk)) -Force -ErrorAction SilentlyContinue
}
Ok ('  已镜像 ' + $mirror.Count + ' 项到 source/')

Info '=== 3/5 提交并推送两个仓库 ==='
foreach ($dir in @($privateDir, $publicDir)) {
    Push-Location $dir
    try {
        $dirty = (git status --porcelain)
        if ($dirty) {
            $stamp = Get-Date -Format 'yyyy-MM-dd HH:mm'
            git add -A | Out-Null
            if ($LASTEXITCODE -ne 0) { throw "git add 失败: $dir" }
            git commit -q -m "同步 pi / pi-web-ui 定制（$stamp）" | Out-Null
            if ($LASTEXITCODE -ne 0) { throw "git commit 失败: $dir" }
            Info ("  已提交: " + (Split-Path $dir -Leaf))
        } else {
            Info ("  无改动: " + (Split-Path $dir -Leaf))
        }
        $branch = (git rev-parse --abbrev-ref HEAD).Trim()
        if ($LASTEXITCODE -ne 0 -or -not $branch -or $branch -eq 'HEAD') { throw "仓库不在有效分支上: $dir" }
        git push -q origin $branch
        if ($LASTEXITCODE -ne 0) { throw "git push 失败: $dir ($branch)" }
        $local = (git rev-parse HEAD).Trim()
        if ($LASTEXITCODE -ne 0) { throw "读取本地提交失败: $dir" }
        $remote = (git rev-parse "origin/$branch").Trim()
        if ($LASTEXITCODE -ne 0) { throw "读取远端跟踪提交失败: $dir" }
        if ($local -ne $remote) { throw "推送后仍不一致: $dir" }
        Ok ("  已推送: " + (Split-Path $dir -Leaf) + " " + $local.Substring(0, 7))
    } finally {
        Pop-Location
    }
}

# 校验必须固定到刚推送的精确提交。若继续请求 main，GitHub Raw/CDN 可能短时间
# 返回旧分支内容，把已经成功的推送误报成失败。
$publicCommit = (git -C $publicDir rev-parse HEAD).Trim()
$verifyRawBase = "https://raw.githubusercontent.com/xieweimo/pi-web-ui-setup/$publicCommit"

Info ("=== 4/5 从 GitHub 匿名核对（精确提交 " + $publicCommit.Substring(0, 7) + "） ===")
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch { }
try { [System.Net.WebRequest]::DefaultWebProxy = New-Object System.Net.WebProxy } catch { }
# 国内直连 raw.githubusercontent 可能超时：如果 pi 设置里有 httpProxy，就给校验请求也用上
$piSettingsFile = Join-Path $env:USERPROFILE '.pi\agent\settings.json'
if (Test-Path $piSettingsFile) {
    try {
        $proxyUrl = (Get-Content $piSettingsFile -Raw -Encoding UTF8 | ConvertFrom-Json).httpProxy
        if ($proxyUrl) { [System.Net.WebRequest]::DefaultWebProxy = New-Object System.Net.WebProxy($proxyUrl) }
    } catch { }
}

$failed = @()
$offline = 0
foreach ($f in $files) {
    $localFile = Join-Path $publicDir $f
    $localHash = Get-Sha256 $localFile
    $got = $null
    # 临时文件名不能带路径分隔符（source/... 这种 $f 直接拼进去会让 -OutFile 写到不存在的子目录而报错）
    $safeName = ($f -replace '[^A-Za-z0-9._-]', '_')
    for ($i = 1; $i -le 3 -and -not $got; $i++) {
        try {
            $tmp = Join-Path $env:TEMP ("raw-" + $safeName + "-" + $i)
            $url = "$verifyRawBase/$f"
            Invoke-WebRequest $url -OutFile $tmp -UseBasicParsing -TimeoutSec 20
            $got = Get-Sha256 $tmp
            Remove-Item $tmp -Force -ErrorAction SilentlyContinue
        } catch {
            Start-Sleep -Seconds 3
        }
    }
    if ($got -eq $localHash) {
        Ok ("  一致  $f")
    } else {
        Warn ("  不一致 $f  (本地 $($localHash.Substring(0,12)) / 远端 " + ($(if ($got) { $got.Substring(0,12) } else { '取不到' })) + ')')
        if ($got) { $failed += $f } else { $offline += 1 }
    }
}

Info '=== 5/5 结果 ==='
if ($failed.Count -gt 0) {
    Warn ('  以下文件与 GitHub 精确提交不一致：' + ($failed -join ', '))
    exit 2
}
if ($offline -gt 0) {
    Warn ("  有 $offline 个文件因网络不通未能匿名核对（raw.githubusercontent 超时）——推送本身已由第 3 步的 git 比对验证")
    exit 0
}
Ok '  全部一致，pi-web-ui-setup 已是最新，可随时随地安装。'
Info ''
Info '机房/新电脑安装命令（PowerShell）：'
Info "  `$u='$rawBase/install.ps1?t='+(Get-Random);try{`$s=irm `$u}catch{[Net.WebRequest]::DefaultWebProxy=New-Object Net.WebProxy;`$s=irm `$u};iex `$s"
