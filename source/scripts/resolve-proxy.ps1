# 解析「该用哪个代理」并注入当前进程环境，供 pi / pi-web-ui 子进程继承。
#
# 为什么要这层兜底：pi 的 settings.json 里的 httpProxy 一旦丢失（2026-09-13 真丢过一次），
# Node 就直连 chatgpt.com，Codex 等境外模型全部报 "fetch failed，正在自动重试"。
# 而系统代理通常是开着的 —— 所以拿它当第二来源。
#
# 优先级：pi settings 的 httpProxy → Windows 系统代理（WinINET）→ 不设。
# 用法（dot-source 后调用）：
#   . "$PSScriptRoot\resolve-proxy.ps1"
#   if (-not (Set-PiProxyEnv)) { ... }

function Get-PiProxyUrl {
    param([string]$PiSettingsFile = (Join-Path $env:USERPROFILE '.pi\agent\settings.json'))

    function Test-LocalProxyAlive([string]$Url) {
        try {
            $u = [uri]$Url
            if ($u.Host -notin @('127.0.0.1', 'localhost', '::1')) { return $true }
            return [bool](Get-NetTCPConnection -LocalPort $u.Port -State Listen -ErrorAction SilentlyContinue)
        } catch { return $false }
    }

    # 1) pi 设置里的 httpProxy（authoritative）
    if (Test-Path $PiSettingsFile) {
        try {
            $v = (Get-Content $PiSettingsFile -Raw -Encoding UTF8 | ConvertFrom-Json).httpProxy
            if ($v -and (Test-LocalProxyAlive ([string]$v))) {
                return @{ url = [string]$v; source = 'pi settings.json' }
            }
        } catch { }
    }

    # 2) Windows 系统代理：ProxyServer 可能是 "host:port" 或 "http=host:port;https=host:port"
    try {
        $ie = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' -ErrorAction Stop
        if ($ie.ProxyEnable -eq 1 -and $ie.ProxyServer) {
            $srv = [string]$ie.ProxyServer
            if ($srv -match '=') {
                $map = @{}
                foreach ($kv in $srv -split ';') {
                    $i = $kv.IndexOf('=')
                    if ($i -gt 0) { $map[$kv.Substring(0, $i).Trim().ToLower()] = $kv.Substring($i + 1).Trim() }
                }
                $srv = if ($map['https']) { $map['https'] } elseif ($map['http']) { $map['http'] } else { '' }
            }
            if ($srv) {
                if ($srv -notmatch '^https?://') { $srv = 'http://' + $srv }
                if (Test-LocalProxyAlive $srv) {
                    return @{ url = $srv; source = 'Windows 系统代理' }
                }
            }
        }
    } catch { }

    return $null
}

# 注入 HTTP_PROXY / HTTPS_PROXY / NO_PROXY（本机地址永远直连）。
# 返回 $true 表示注入成功；$false 表示没找到任何代理。
function Set-PiProxyEnv {
    param([string]$PiSettingsFile = (Join-Path $env:USERPROFILE '.pi\agent\settings.json'))
    $p = Get-PiProxyUrl -PiSettingsFile $PiSettingsFile
    if (-not $p) { return $false }
    # 已存在的环境变量也可能是代理软件上一次使用的旧端口，因此以当前可用配置覆盖。
    $env:HTTP_PROXY  = $p.url
    $env:HTTPS_PROXY = $p.url
    # 本机服务 / 浏览器回连绝不能绕到代理，否则 127.0.0.1:8787 会返回 502。
    $localNoProxy = 'localhost,127.0.0.1,::1'
    # Windows 环境变量曾被误写成带引号的值（例如 "api.deepseek.com"）。
    # pi 的 NO_PROXY 解析器把引号当域名的一部分，导致本应直连的域名又走了代理；
    # NO_PROXY 不需要引号，注入前统一剔除，且保留已有的业务绕行项。
    $existingNoProxy = ([string]$env:NO_PROXY).Replace('"', '').Replace("'", '').Trim()
    $noProxyEntries = @(($existingNoProxy + ',' + $localNoProxy).Split(',')) |
        ForEach-Object { $_.Trim() } | Where-Object { $_ } | Select-Object -Unique
    $env:NO_PROXY = $noProxyEntries -join ','
    $env:no_proxy = $env:NO_PROXY
    Write-Host ("  代理已注入（来源：" + $p.source + "）：" + $p.url)
    return $true
}
