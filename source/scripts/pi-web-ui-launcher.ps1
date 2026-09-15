# pi 网页版一键启动器（主版本，位于 PIwork/scripts/）
# 用法：双击桌面「启动 Pi 网页版」图标，或直接运行本脚本
# 行为：启动服务（若未运行）→ 打开浏览器 → 页面一关就停服（几秒内）
$ErrorActionPreference = 'SilentlyContinue'

# ---- 可配置项 ----
$cwd       = Split-Path $PSScriptRoot -Parent                 # 工作目录（仓库迁移后自动适配）
$shim      = Join-Path $env:APPDATA 'npm\pi-web-ui.cmd'      # pi-web-ui 启动命令（默认：npm 全局目录）
$port      = 8787                                         # 服务端口
$idleLimit = 3                                            # 页面断开多少秒后停服（只需容忍刷新页面的重连空档）
$idleFallback = 300                                       # 页面一次都没连上时的兜底秒数（浏览器起不来，别让服务长挂）
$keepAliveWhileRunning = $true                            # 页面断开时若服务端还有任务在跑，先等它跑完再停服
$waitReady = 20                                           # 等待端口就绪的最长秒数

# 便携安装（学校机房等无管理员环境）会在仓库根写 install.json，记录便携 Node 与
# pi-web-ui 启动命令的真实路径；便携 Node 不在系统 PATH，必须先注入再启动服务。
$installCfg = Join-Path $cwd 'install.json'
if (Test-Path $installCfg) {
    try {
        $ic = Get-Content $installCfg -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($ic.nodeDir -and (Test-Path $ic.nodeDir)) { $env:PATH = "$($ic.nodeDir);$env:PATH" }
        if ($ic.shim -and (Test-Path $ic.shim)) { $shim = $ic.shim }
    } catch { }
}
if (-not (Test-Path $shim)) {
    $cmd = Get-Command pi-web-ui -ErrorAction SilentlyContinue
    if ($cmd) { $shim = $cmd.Source }
}

function Test-Listening {
    return [bool](Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
}

# 页面断开后还要不要等：问 piwork-tools 插件「还有任务在跑吗」。
# 拿到 false 的情况（插件未安装 404 / 服务已停 / 请求超时）都按「不忙」处理，不阻塞停服。
function Test-WebBusy {
    if (-not $keepAliveWhileRunning) { return $false }
    try {
        $r = Invoke-RestMethod -Uri "http://127.0.0.1:$port/plugins-api/piwork-tools/busy" -TimeoutSec 2 -ErrorAction Stop
        return [bool]$r.busy
    } catch { return $false }
}

# 0. 检查启动命令是否存在
if (-not (Test-Path $shim)) {
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show("找不到 pi-web-ui 启动命令：`n$shim`n请先运行安装器（install.ps1）或执行 npm install -g pi-web-ui。", 'pi-web-ui')
    exit 1
}

# 0.5 代理注入（重要）
# pi 的 Codex / OpenAI 请求从【进程环境变量】读代理（https_proxy / all_proxy），
# 而 pi-web-ui 服务自己不会去读 pi 的 settings.json —— 不注入就会出现
# 「大模型 API 出错，正在自动重试：fetch failed」（国内直连 chatgpt.com 失败）。
# 来源优先级（见 scripts\resolve-proxy.ps1）：pi settings 的 httpProxy → Windows 系统代理。
# 第二层是防复发：2026-09-13 settings.json 里的 httpProxy 丢过一次，当时服务一直没重启所以
# 没被发现，一重启就全断 —— 现在系统代理开着就能自愈。
$resolveProxy = Join-Path $PSScriptRoot 'resolve-proxy.ps1'
if (Test-Path $resolveProxy) {
    . $resolveProxy
    if (-not (Set-PiProxyEnv)) {
        Write-Host '  没找到可用代理（pi settings.json 无 httpProxy、系统代理也没开）：Codex 等境外模型可能报 fetch failed'
    }
}

# 0.6 为插件补充逐条 usageCost（用于剔除 Codex 订阅的理论 API 成本）。
# npm 升级会覆盖 pi-web-ui/dist；启动前幂等重打补丁，失败不阻断主服务。
$usageCostPatch = Join-Path $cwd 'patches\patch-pi-web-ui-usage-cost.js'
$liveModelPatch = Join-Path $cwd 'patches\patch-pi-web-ui-plugin-live-model.js'
$recoveryUiPatch = Join-Path $cwd 'patches\patch-pi-web-ui-recovery-ui.js'
$hideForkedPatch = Join-Path $cwd 'patches\patch-pi-web-ui-hide-forked-sessions.js'
$recoveryWatchdog = Join-Path $cwd 'scripts\pi-web-ui-recovery-watchdog.js'
$stopButtonPatch = Join-Path $cwd 'patches\apply-stop-button.ps1'
foreach ($patch in @($usageCostPatch, $liveModelPatch, $recoveryUiPatch, $hideForkedPatch)) {
    if ((Test-Path $patch) -and (Get-Command node -ErrorAction SilentlyContinue)) { & node $patch | Out-Null }
}
# 停止按钮样式属于静态网页资源；npm 升级覆盖后启动时幂等恢复。
if (Test-Path $stopButtonPatch) {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $stopButtonPatch | Out-Null
}

# 独立守护端口：网页断连后仍可请求它重启 8787 服务。
# 便携 Node 不在系统 PATH，优先用 install.json 里的绝对路径。
if ((Test-Path $recoveryWatchdog) -and -not (Get-NetTCPConnection -LocalPort 8788 -State Listen -ErrorAction SilentlyContinue)) {
    $nodeExe = if (Test-Path (Join-Path (Split-Path $PSScriptRoot -Parent) 'node\node.exe')) {
        Join-Path (Split-Path $PSScriptRoot -Parent) 'node\node.exe'
    } else { 'node.exe' }
    Start-Process -FilePath $nodeExe -ArgumentList $recoveryWatchdog -WindowStyle Hidden
}

# 1. 仅在服务未运行时启动（避免重复实例）
if (-not (Test-Listening)) {
    Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', $shim, '--no-browser', '--cwd', $cwd -WindowStyle Hidden | Out-Null

    $ready = $false
    for ($i = 0; $i -lt $waitReady; $i++) {
        if (Test-Listening) { $ready = $true; break }
        Start-Sleep -Seconds 1
    }
    if (-not $ready) {
        Add-Type -AssemblyName System.Windows.Forms
        [System.Windows.Forms.MessageBox]::Show('pi-web-ui 启动失败，请重试。', 'pi-web-ui')
        exit 1
    }
}

# 2. 已有页面连着就不再开新标签（重跑启动器只为接管守护时不该多弹一个页面）
if (-not (Get-NetTCPConnection -LocalPort $port -State Established -ErrorAction SilentlyContinue)) {
    Start-Process "http://localhost:$port"
}
Start-Sleep -Seconds 5

# 3. 监听连接：页面一关就停服。
#    - 断开满 $idleLimit 秒 → 停服（几秒内，叉掉即关）；
#    - 刷新页面 / 网络抖动会在这个窗口内重连，计数自动重置；
#    - 页面一次都没连上时不计时，改用 $idleFallback 兜底；
#    - 服务不在监听（例如从界面点「重启网页服务」，独立 watchdog 正在重启它）时不计时，
#      且 watchdog 重启时会写 stamp 文件重置计数，避免把刚拉起的服务又杀掉。
$stampFile = Join-Path $env:TEMP 'pi-web-ui-restart.stamp'
$lastStamp = if (Test-Path $stampFile) { (Get-Item $stampFile).LastWriteTimeUtc } else { [datetime]::MinValue }
$idle = 0
$seen = $false
while ($true) {
    if (Test-Path $stampFile) {
        $st = (Get-Item $stampFile).LastWriteTimeUtc
        if ($st -gt $lastStamp) { $lastStamp = $st; $idle = 0 }
    }
    $listen = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    $est    = Get-NetTCPConnection -LocalPort $port -State Established -ErrorAction SilentlyContinue
    if (-not $listen) { $idle = 0 }                 # 服务不在跑（重启中/已停）：不由本进程计数
    elseif ($est)     { $idle = 0; $seen = $true }  # 仍有页面连着
    else              { $idle++ }
    if ($seen) {
        if ($idle -ge $idleLimit) {
            # 页面没了，但服务端可能还在跑任务（对话 / 工具 / 子代理）——先问一句：
            # 有活就继续等，活干完再停；这样「叉掉即关」不会把执行到一半的活截断。
            if (Test-WebBusy) { $idle = 0 } else { break }
        }
    }
    else { if ($idle -ge $idleFallback) { break } }
    Start-Sleep -Seconds 1
}

# 4. 停服
Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
    ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
