# 重新应用 pi-web-ui 停止按钮补丁（升级 pi-web-ui 后执行一次即可）
# 作用：在 web/dist/index.html 的 </head> 前注入红色脉冲样式，让停止按钮更醒目
# 说明：本文件必须保存为「无 BOM 的 UTF-8」，且行尾为 LF，否则 PS 5.1 解析器会误判 here-string。
$ErrorActionPreference = 'Stop'

# 输出按 UTF-8 编码：调用方（Node 的 profile 应用器、同步插件）按 UTF-8 读 stdout，
# 默认的 GBK 控制台编码会让中文变成乱码。
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }

# 定位 pi-web-ui：便携安装（install.json 记录 nodeDir/shim）优先，其次 npm 全局目录。
$root = Split-Path $PSScriptRoot -Parent
$candidates = @()
$cfg = Join-Path $root 'install.json'
if (Test-Path $cfg) {
    try {
        $ic = Get-Content $cfg -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($ic.nodeDir) { $candidates += (Join-Path $ic.nodeDir 'node_modules\pi-web-ui') }
        if ($ic.shim) { $candidates += (Join-Path (Split-Path $ic.shim -Parent) 'node_modules\pi-web-ui') }
    } catch { }
}
$candidates += (Join-Path $env:APPDATA 'npm\node_modules\pi-web-ui')
$candidates += (Join-Path $root 'node_modules\pi-web-ui')
$webRoot = $null
foreach ($c in $candidates) {
    if (Test-Path (Join-Path $c 'package.json')) { $webRoot = $c; break }
}
if (-not $webRoot) {
    Write-Host '未找到 pi-web-ui 安装目录（便携 install.json 与 npm 全局目录都没有）' -ForegroundColor Red
    exit 1
}
$html = Join-Path $webRoot 'web\dist\index.html'

if (-not (Test-Path $html)) {
    Write-Host "未找到 $html" -ForegroundColor Red
    exit 1
}

$content = [System.IO.File]::ReadAllText($html, [System.Text.Encoding]::UTF8)

# pi-web-ui 0.95.0 起原生 `.inputbox .btn.stop` 已有 --stop-red + stop-pulse。
# 样式在 assets/*.css，不在 index.html；当前脚本只为旧版本 profile 留存，
# 新版本上绝不再用 !important 覆盖上游主题变量。
$assets = Join-Path $webRoot 'web\dist\assets'
$nativeStopStyle = $false
if (Test-Path $assets) {
    foreach ($cssFile in Get-ChildItem -Path $assets -Filter '*.css' -File -ErrorAction SilentlyContinue) {
        $cssText = [System.IO.File]::ReadAllText($cssFile.FullName, [System.Text.Encoding]::UTF8)
        if ($cssText -match 'stop-pulse' -and $cssText -match '--stop-red') { $nativeStopStyle = $true; break }
    }
}
if ($nativeStopStyle) {
    Write-Host '上游已内建红色脉冲停止按钮，历史补丁不再应用。' -ForegroundColor Yellow
    exit 0
}

if ($content -match 'stopPulse') {
    Write-Host '补丁已存在，跳过。' -ForegroundColor Green
    exit 0
}

$css = @'
<style>
	/* 停止按钮增强：醒目红色 + 脉冲提示 */
	.btn.stop{background:#dc2626 !important;border-color:#dc2626 !important;color:#fff !important;box-shadow:0 0 0 0 rgba(220,38,38,.7) !important;animation:stopPulse 1.3s ease-in-out infinite}
	.btn.stop:hover:not(:disabled){background:#ef4444 !important;border-color:#ef4444 !important}
	@keyframes stopPulse{0%{box-shadow:0 0 0 0 rgba(220,38,38,.55)}70%{box-shadow:0 0 0 12px rgba(220,38,38,0)}100%{box-shadow:0 0 0 0 rgba(220,38,38,0)}}
</style>
'@

$content = $content -replace '</head>', ($css + "`n</head>")
# 必须无 BOM 写出：Set-Content -Encoding UTF8 在 PS 5.1 下会写入 EF BB BF
[System.IO.File]::WriteAllText($html, $content, (New-Object System.Text.UTF8Encoding($false)))
Write-Host '补丁已应用。' -ForegroundColor Green
