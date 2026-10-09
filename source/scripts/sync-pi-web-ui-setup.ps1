# 一键同步：把本机对 pi / pi-web-ui 的改动同步到 GitHub 的 pi-web-ui-setup
#
# 做四件事：
#   1. 重新打包便携安装包（含补丁、插件、定位模块、启动器）
#   2. 同步到公开仓库目录 pi-web-ui-setup
#   3. 提交并推送私有仓库 AIWork 与公开仓库 pi-web-ui-setup
#   4. 从 GitHub 匿名下载关键文件，与本地逐个比对 hash（文本按行尾归一化），确认真的同步成功
#
# 用法：powershell -ExecutionPolicy Bypass -File scripts\sync-pi-web-ui-setup.ps1
$ErrorActionPreference = 'Stop'

$repoRoot   = Split-Path $PSScriptRoot -Parent
$workRoot   = Split-Path $repoRoot -Parent                       # C:\AIWork\PI
$privateDir = Split-Path $workRoot -Parent                       # C:\AIWork
$publicDir  = Join-Path $workRoot 'pi-web-ui-setup'
$zipName    = 'PiWebUI-Setup_pi-1.0.2_web-0.99.0.zip'
$files      = @('install.ps1', 'install.cmd', 'uninstall.ps1', 'uninstall.cmd', $zipName, 'source/docs/after-install-checklist.md', 'source/projects/piwork-tools-plugin/manifest.json')
$rawBase    = 'https://raw.githubusercontent.com/xieweimo/pi-web-ui-setup/main'

function Info($m) { Write-Host $m }
function Ok($m) { Write-Host $m -ForegroundColor Green }
function Warn($m) { Write-Host $m -ForegroundColor Yellow }

# GitHub 的 SSH 22 端口在部分网络中会被重置或长时间无响应。先按用户现有
# ssh config 正常推送；失败时自动改走 GitHub 官方 ssh.github.com:443。
# HostKeyAlias=github.com 复用已信任的 GitHub host key，不静默接受新密钥。
function Push-GitHubBranch([string]$Branch) {
    $oldSshCommand = $env:GIT_SSH_COMMAND
    try {
        $normalSsh = if ($oldSshCommand) { $oldSshCommand + ' -o BatchMode=yes -o ConnectTimeout=15' } else { 'ssh -o BatchMode=yes -o ConnectTimeout=15' }
        $env:GIT_SSH_COMMAND = $normalSsh
        & git push -q origin $Branch
        if ($LASTEXITCODE -eq 0) { return }
    } finally {
        $env:GIT_SSH_COMMAND = $oldSshCommand
    }

    $originUrl = (& git remote get-url origin).Trim()
    if ($LASTEXITCODE -ne 0 -or $originUrl -notmatch 'github\.com[:/]') {
        throw "git push 失败，且远端不是 GitHub SSH，不能自动切换 443: $originUrl"
    }

    Warn '  SSH 22 推送失败，自动切换 GitHub SSH 443 重试…'
    try {
        $env:GIT_SSH_COMMAND = 'ssh -o BatchMode=yes -o ConnectTimeout=20 -o HostName=ssh.github.com -o HostKeyAlias=github.com -p 443'
        for ($attempt = 1; $attempt -le 3; $attempt++) {
            & git push -q origin $Branch
            if ($LASTEXITCODE -eq 0) { return }
            if ($attempt -lt 3) {
                Warn ("  SSH 443 第 $attempt 次失败，3 秒后重试…")
                Start-Sleep -Seconds 3
            }
        }
    } finally {
        $env:GIT_SSH_COMMAND = $oldSshCommand
    }
    throw "git push 失败：SSH 22 与 GitHub 官方 SSH 443 均不可用 ($originUrl)"
}

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

# 文本文件按「CRLF→LF」归一化后再算 SHA256。
# 仓库 core.autocrlf=true 会把工作区的 CRLF 规范成 LF 存进提交，而
# raw.githubusercontent 返回的正是提交里的字节——直接比原始 SHA256 会把
# 「只有行尾不同」误报成同步失败（内容其实一模一样）。
function Get-Sha256Normalized([string]$Path) {
    $text = [System.IO.File]::ReadAllText($Path) -replace "`r`n", "`n"
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($text)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        return (($sha.ComputeHash($bytes) | ForEach-Object { $_.ToString('x2') }) -join '')
    } finally { $sha.Dispose() }
}

# 发布只提交明确列出的文件；其他项目与本机文件即使已暂存，也保留在索引中而不进入发布提交。
$privatePaths = @('.gitignore', 'PI/PIwork/.gitignore', ('PI/PIwork/archive/' + $zipName), 'PI/PIwork/configs/pi-settings.template.json', 'PI/PIwork/configs/global-AGENTS.md', 'PI/PIwork/configs/models-store.json', 'PI/PIwork/configs/pi-web-ui-restart-descriptor.example.json', 'PI/PIwork/configs/pi-web-ui-profiles', 'PI/PIwork/docs/after-install-checklist.md', 'PI/PIwork/docs/升级适配/发送前快照延迟修复.md', 'PI/PIwork/extras', 'PI/PIwork/projects/codex-usage-plugin', 'PI/PIwork/projects/page-picker-extension', 'PI/PIwork/projects/piwork-tools-plugin', 'PI/PIwork/projects/piwork-ui-layout-plugin', 'PI/PIwork/projects/proxy-health-plugin', 'PI/PIwork/projects/reconnect-plugin', 'PI/PIwork/scripts/apply-pi-web-ui-profile.js', 'PI/PIwork/scripts/check-pi-web-ui-patches.js', 'PI/PIwork/scripts/check-codex-usage.js', 'PI/PIwork/scripts/test-workspace-layout.mjs', 'PI/PIwork/scripts/test-prompt-snapshot-budget.mjs', 'PI/PIwork/scripts/维护工具/test-message-send-latency.js', 'PI/PIwork/configs/README.md', 'PI/PIwork/scripts/create-portable-pi-web-ui-bundle.ps1', 'PI/PIwork/scripts/install-aiwork.ps1', 'PI/PIwork/scripts/install-plugins.js', 'PI/PIwork/scripts/pi-web-ui-locate.js', 'PI/PIwork/scripts/pi-core-locate.js', 'PI/PIwork/scripts/pi-web-ui-entry-cache-bust.js', 'PI/PIwork/scripts/pi-web-ui-launcher.ps1', 'PI/PIwork/scripts/pi-web-ui-recovery-watchdog.js', 'PI/PIwork/scripts/resolve-proxy.ps1', 'PI/PIwork/scripts/manage-plan-board.mjs', 'PI/PIwork/scripts/test-pi-web-ui-plan-marker.mjs', 'PI/PIwork/scripts/repair-invalid-toolcall-names.js', 'PI/PIwork/scripts/sync-pi-web-ui-setup.ps1', 'PI/PIwork/configs/安装入口/install.ps1', 'PI/PIwork/docs/安装与同步/一键安装验收状态.md', 'PI/PIwork/scripts/安装验收/test-install-entry.ps1')
$publicPaths = @('README.md', 'install.ps1', 'install.cmd', 'uninstall.ps1', 'uninstall.cmd', '.gitignore', $zipName, 'source')
# 已跟踪的旧安装包即使在工作区已删除，仍须进入 pathspec 才会提交删除；只取仓库根下的安装包名。
$trackedZips = @(& git -C $publicDir ls-files -- 'PiWebUI-Setup_pi-*_web-*.zip')
if ($LASTEXITCODE -ne 0) { throw '无法检查公开仓库已跟踪的安装包' }
$publicPaths += @($trackedZips | Where-Object { $_ -ne $zipName -and $_ -match '^PiWebUI-Setup_pi-[0-9A-Za-z.]+_web-[0-9A-Za-z.]+\.zip$' })
$distributionPatches = @()
foreach ($profile in Get-ChildItem (Join-Path $repoRoot 'configs\pi-web-ui-profiles') -Filter '*.json' -File) {
    $data = Get-Content $profile.FullName -Raw -Encoding UTF8 | ConvertFrom-Json
    $distributionPatches += @($data.patches)
}
$distributionPatches = @($distributionPatches | Sort-Object -Unique)
foreach ($rel in $distributionPatches) {
    if ($rel -notmatch '^patches/[A-Za-z0-9_.-]+\.(js|ps1)$') { throw "不合法的补丁路径：$rel" }
    if (-not (Test-Path (Join-Path $repoRoot $rel) -PathType Leaf)) { throw "缺少补丁：$rel" }
    $privatePaths += 'PI/PIwork/' + $rel
}
# 已暂存的范围外内容不能靠 git commit --only 解决：它会在下一次普通提交时泄漏。
# 发现时直接停止，让操作者单独处理，而不是擅自撤销暂存。
$staged = @(& git -C $privateDir -c core.quotePath=false diff --cached --name-only)
if ($LASTEXITCODE -ne 0) { throw '无法检查私有仓库暂存区' }
$outside = @($staged | Where-Object { $name = $_; -not @($privatePaths | Where-Object { $name -eq $_ -or $name.StartsWith($_ + '/') }).Count })
if ($outside.Count) { throw "私有仓库暂存区含 $($outside.Count) 项安装范围外文件；为防止日后误推送，先单独处理暂存区。" }

Info '=== 1/5 重新打包安装包 ==='
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'create-portable-pi-web-ui-bundle.ps1')
if ($LASTEXITCODE -ne 0) { throw "打包子进程失败（退出码 $LASTEXITCODE），禁止使用旧 zip 继续同步" }
$zipPath = Join-Path $repoRoot "archive\$zipName"
if (-not (Test-Path $zipPath)) { throw "打包失败：$zipPath 不存在" }
Copy-Item $zipPath (Join-Path $publicDir $zipName) -Force
# 公开安装入口只保留当前版本，避免用户误下载旧包；私有 archive/ 仍保留历史包。
Get-ChildItem $publicDir -File -Filter 'PiWebUI-Setup_pi-*_web-*.zip' |
    Where-Object { $_.Name -ne $zipName } |
    Remove-Item -Force
Ok ('  安装包已更新: ' + [math]::Round((Get-Item $zipPath).Length / 1KB, 1) + ' KB')

# 公开安装入口以工作区无密钥、纯 ASCII 模板为唯一来源；不在同步前写外部仓库。
$entryTemplate = Join-Path $repoRoot 'configs\安装入口\install.ps1'
$entryBytes = [System.IO.File]::ReadAllBytes($entryTemplate)
if (@($entryBytes | Where-Object { $_ -gt 127 }).Count) { throw '公开安装入口必须为纯 ASCII' }
Copy-Item $entryTemplate (Join-Path $publicDir 'install.ps1') -Force
Info '=== 2/5 镜像定制源码到公开仓库 source/ ==='
# 公开仓库只放 zip 的话，别人（包括你自己换电脑）在 GitHub 上看不到任何定制内容——
# 插件源码、补丁、配置模板、清单文档都藏在二进制 zip 里。这里把它们一并镜像到
# pi-web-ui-setup/source/：既能在网页上直接浏览，也能用
# `pi-web-ui install https://github.com/<owner>/pi-web-ui-setup/tree/main/source/projects/<插件>` 直接装插件。
$mirror = @(
    @{ from = 'projects\codex-usage-plugin';      to = 'source\projects\codex-usage-plugin' },
    @{ from = 'projects\piwork-tools-plugin';     to = 'source\projects\piwork-tools-plugin' },
    @{ from = 'projects\reconnect-plugin';        to = 'source\projects\reconnect-plugin' },
    @{ from = 'projects\piwork-ui-layout-plugin'; to = 'source\projects\piwork-ui-layout-plugin' },
    @{ from = 'projects\proxy-health-plugin';     to = 'source\projects\proxy-health-plugin' },
    @{ from = 'configs\pi-settings.template.json'; to = 'source\configs\pi-settings.template.json' },
    @{ from = 'configs\global-AGENTS.md';         to = 'source\configs\global-AGENTS.md' },
    @{ from = 'configs\models-store.json';        to = 'source\configs\models-store.json' },
    @{ from = 'configs\pi-web-ui-restart-descriptor.example.json'; to = 'source\configs\pi-web-ui-restart-descriptor.example.json' },
    @{ from = 'configs\pi-web-ui-profiles';        to = 'source\configs\pi-web-ui-profiles' },
    @{ from = 'docs\after-install-checklist.md';  to = 'source\docs\after-install-checklist.md' },
    @{ from = 'extras\page-picker-extension.zip'; to = 'source\extras\page-picker-extension.zip' }
)
# 公开脚本只取安装包实际携带的脚本；不公开 scripts/ 下的其他项目或本机运维脚本。
$mirror += @('install-aiwork.ps1','install-plugins.js','apply-pi-web-ui-profile.js','pi-web-ui-locate.js','pi-core-locate.js','pi-web-ui-entry-cache-bust.js','pi-web-ui-launcher.ps1','pi-web-ui-recovery-watchdog.js','resolve-proxy.ps1','manage-plan-board.mjs','test-pi-web-ui-plan-marker.mjs','repair-invalid-toolcall-names.js','check-pi-web-ui-patches.js') | ForEach-Object {
    @{ from = "scripts\$_"; to = "source\scripts\$_" }
}
$mirror += @(
    @{ from = 'scripts\create-portable-pi-web-ui-bundle.ps1'; to = 'source\scripts\create-portable-pi-web-ui-bundle.ps1' },
    @{ from = 'scripts\sync-pi-web-ui-setup.ps1'; to = 'source\scripts\sync-pi-web-ui-setup.ps1' }
)
$srcRoot = Join-Path $publicDir 'source'
Remove-Item $srcRoot -Recurse -Force -ErrorAction SilentlyContinue
foreach ($m in $mirror) {
    $from = Join-Path $repoRoot $m.from
    $to = Join-Path $publicDir $m.to
    if (-not (Test-Path $from)) { throw ('镜像清单文件不存在：' + $m.from) }
    New-Item -ItemType Directory -Force -Path (Split-Path $to -Parent) | Out-Null
    Copy-Item $from $to -Recurse -Force
}
# 公开镜像与安装包使用同一补丁范围：历史 profile 并集（扩展全站模式已在 ZIP 内）。
foreach ($rel in $distributionPatches) {
    $from = Join-Path $repoRoot $rel
    if (-not (Test-Path $from -PathType Leaf)) { throw "缺少补丁：$rel" }
    $to = Join-Path $srcRoot $rel
    New-Item -ItemType Directory -Force -Path (Split-Path $to -Parent) | Out-Null
    Copy-Item $from $to -Force
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
        $paths = if ($dir -eq $privateDir) { $privatePaths } else { $publicPaths }
        git add -A -- @paths | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "git add 失败: $dir" }
        $dirty = @(git diff --cached --name-only -- @paths)
        if ($LASTEXITCODE -ne 0) { throw "git diff 失败: $dir" }
        if ($dirty.Count) {
            $stamp = Get-Date -Format 'yyyy-MM-dd HH:mm'
            git commit -q --only -m "同步 pi / pi-web-ui 定制（$stamp）" -- @paths | Out-Null
            if ($LASTEXITCODE -ne 0) { throw "git commit 失败: $dir" }
            Info ("  已提交: " + (Split-Path $dir -Leaf))
        } else {
            Info ("  无改动: " + (Split-Path $dir -Leaf))
        }
        $branch = (git rev-parse --abbrev-ref HEAD).Trim()
        if ($LASTEXITCODE -ne 0 -or -not $branch -or $branch -eq 'HEAD') { throw "仓库不在有效分支上: $dir" }
        Push-GitHubBranch $branch
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
    $isText = $f -notmatch '\.(zip|png|jpe?g|gif|ico|exe)$'
    $localHash = if ($isText) { Get-Sha256Normalized $localFile } else { Get-Sha256 $localFile }
    $got = $null
    # 临时文件名不能带路径分隔符（source/... 这种 $f 直接拼进去会让 -OutFile 写到不存在的子目录而报错）
    $safeName = ($f -replace '[^A-Za-z0-9._-]', '_')
    for ($i = 1; $i -le 3 -and -not $got; $i++) {
        try {
            $tmp = Join-Path $env:TEMP ("raw-" + $safeName + "-" + $i)
            $url = "$verifyRawBase/$f"
            Invoke-WebRequest $url -OutFile $tmp -UseBasicParsing -TimeoutSec 20
            $got = if ($isText) { Get-Sha256Normalized $tmp } else { Get-Sha256 $tmp }
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
