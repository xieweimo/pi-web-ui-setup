# pi 网页版一键启动器（主版本，位于 PIwork/scripts/）
# 用法：双击桌面「启动 Pi 网页版」图标，或直接运行本脚本
# 行为：启动服务（若未运行）→ 打开浏览器 → 页面一关就停服（几秒内）
$ErrorActionPreference = 'SilentlyContinue'

# ---- 可配置项 ----
$cwd       = Split-Path $PSScriptRoot -Parent                 # 工作目录（仓库迁移后自动适配）
$shim      = Join-Path $env:APPDATA 'npm\pi-web-ui.cmd'      # pi-web-ui 启动命令（默认：npm 全局目录）
$port      = 8787                                         # 服务端口
$watchdogPort = 8790                                      # 独立守护端口（避开上游 npm run dev 的 8788）
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
# 断连浮层（recovery-ui）自 0.94.1 起不再注入：顶栏「重连」插件在断连时会直连
# watchdog（127.0.0.1:8790），能力已覆盖浮层，用户确认删除。文件保留，需要清理已注入
# 的块时手动跑 `node patches\patch-pi-web-ui-recovery-ui.js --remove`。
# $recoveryUiPatch 已停用（旧版本包回退时可重新启用）。
$hideForkedPatch = Join-Path $cwd 'patches\patch-pi-web-ui-hide-forked-sessions.js'
$managedRecentProjectsPatch = Join-Path $cwd 'patches\patch-pi-web-ui-permanent-project-ignore.js'
# 快捷短语排队（quick-phrase-queue）自 0.94.1 起停用：上游已内建右键排队。
# 启动时只跑 --remove：幂等清除旧 ⏳ 注入，并安装一次性 SW 缓存清理，绝不重新添加按钮。
$quickPhraseQueueCleanup = Join-Path $cwd 'patches\patch-pi-web-ui-quick-phrase-queue.js'
$topbarMenuButtonsPatch = Join-Path $cwd 'patches\patch-pi-web-ui-topbar-menu-buttons.js'
$pluginTopbarCachePatch = Join-Path $cwd 'patches\patch-pi-web-ui-plugin-topbar-cache.js'
$planBoardClearPatch = Join-Path $cwd 'patches\patch-pi-web-ui-plan-board-clear.js'
$planBoardManager = Join-Path $cwd 'scripts\manage-plan-board.mjs'
# 入口 bundle 是就地打补丁的（文件名不变），必须让 SW 对入口强制回源重校验，
# 否则浏览器会一直跑补丁前的老前端（"说改好了，用起来还是老样子"）。
$swEntryRevalidatePatch = Join-Path $cwd 'patches\patch-pi-web-ui-sw-entry-revalidate.js'
# 插件快照按客户端取对话（多标签/并行对话/子代理不再串页）。
$perClientConversationPatch = Join-Path $cwd 'patches\patch-pi-web-ui-plugin-per-client-conversation.js'
# 所有动手改 bundle 的补丁跑完后再执行：把 index.html 的一次性缓存自愈标记
# 对到当前 bundle 内容 hash（内容没变就不动，变了则浏览器下次打开自动换新代码）。
$entryCacheBust = Join-Path $cwd 'scripts\pi-web-ui-entry-cache-bust.js'
$danglingToolCallsPatch = Join-Path $cwd 'patches\patch-pi-web-ui-dangling-tool-calls.js'
$recoveryWatchdog = Join-Path $cwd 'scripts\pi-web-ui-recovery-watchdog.js'
$pluginInstaller = Join-Path $cwd 'scripts\install-plugins.js'
# usageCost / hideForked / managedRecentProjects 三项已退役（上游 0.94.x 自己内建）：
# 脚本内自带探测，遇到上游实现即打印“已退役”并退出 0，保留调用是为了兼容旧版本包。
foreach ($patch in @($usageCostPatch, $liveModelPatch, $hideForkedPatch, $managedRecentProjectsPatch, $topbarMenuButtonsPatch, $pluginTopbarCachePatch, $planBoardClearPatch, $danglingToolCallsPatch, $swEntryRevalidatePatch, $perClientConversationPatch)) {
    if ((Test-Path $patch) -and (Get-Command node -ErrorAction SilentlyContinue)) { & node $patch | Out-Null }
}
# 看板不是普通装饰补丁：必须补齐、校验并跑行为测试。失败时拒绝启动，避免
# 「标题里写了 =done、右侧仍是待执行」这类静默脏状态。
if ((Test-Path $planBoardManager) -and (Get-Command node -ErrorAction SilentlyContinue)) {
    & node $planBoardManager | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Add-Type -AssemblyName System.Windows.Forms
        [System.Windows.Forms.MessageBox]::Show('任务看板自检失败，已拒绝启动。请运行 node scripts\manage-plan-board.mjs 查看诊断。', 'pi-web-ui')
        exit $LASTEXITCODE
    }
}
if ((Test-Path $quickPhraseQueueCleanup) -and (Get-Command node -ErrorAction SilentlyContinue)) {
    & node $quickPhraseQueueCleanup --remove | Out-Null
}
# 必须排在所有 bundle 补丁之后：把缓存自愈标记对齐到最终 bundle 内容。
if ((Test-Path $entryCacheBust) -and (Get-Command node -ErrorAction SilentlyContinue)) {
    & node $entryCacheBust | Out-Null
}
# 所有受管插件（含 wechat-ilink fork）的运行副本必须与仓库同步；安装器保留用户的 config.json。
if ((Test-Path $pluginInstaller) -and (Get-Command node -ErrorAction SilentlyContinue)) {
    & node $pluginInstaller | Out-Null
}
# 独立守护端口：网页断连后仍可请求它重启服务。
# watchdog 只执行显式 restart descriptor，不猜测 CLI / npm / dev 等启动方式。
# 当前启动器登记全局/便携 CLI；其他方式可直接给 watchdog 传自己的 descriptor。
$nodeExe = if (Test-Path (Join-Path (Split-Path $PSScriptRoot -Parent) 'node\node.exe')) {
    Join-Path (Split-Path $PSScriptRoot -Parent) 'node\node.exe'
} else { (Get-Command node.exe -ErrorAction SilentlyContinue).Source }
$webEntry = Join-Path (Split-Path $shim) 'node_modules\pi-web-ui\bin\pi-web-ui.mjs'
$descriptorFile = Join-Path $env:TEMP 'pi-web-ui-restart-descriptor.json'
# 服务端日志：watchdog 的 descriptor 支持 stdoutFile/stderrFile；不填则服务完全没有日志，
# 一旦出现「大模型连接失败 / 自动重试」就只能靠猜（2026-09-26 排查教训）。
$logDir = Join-Path (Split-Path $PSScriptRoot -Parent) 'work\pi-web-ui-prod'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$serviceStdout = Join-Path $logDir 'service.out.log'
$serviceStderr = Join-Path $logDir 'service.err.log'
$env:PI_WEB_UI_WATCHDOG_PORT = [string]$watchdogPort
if ($nodeExe -and (Test-Path $webEntry)) {
    @{
        command = $nodeExe
        args = @($webEntry, '--no-browser', '--cwd', $cwd)
        cwd = $cwd
        label = 'pi-web-ui 用户环境'
        profile = 'user'
        actions = @('restart', 'start', 'stop')
        servicePort = $port
        healthUrl = "http://127.0.0.1:$port/"
        watchdogPort = $watchdogPort
        startupTimeoutMs = 60000
        stdoutFile = $serviceStdout
        stderrFile = $serviceStderr
        env = @{}
        stop = @{ mode = 'process-tree'; portFallback = $true; allowUnowned = $false }
    } | ConvertTo-Json -Depth 5 | Set-Content -Path $descriptorFile -Encoding UTF8
    if ((Test-Path $recoveryWatchdog) -and -not (Get-NetTCPConnection -LocalPort $watchdogPort -State Listen -ErrorAction SilentlyContinue)) {
        Start-Process -FilePath $nodeExe -ArgumentList @($recoveryWatchdog, '--descriptor', $descriptorFile) -WindowStyle Hidden
        for ($i = 0; $i -lt 30; $i++) {
            if (Get-NetTCPConnection -LocalPort $watchdogPort -State Listen -ErrorAction SilentlyContinue) { break }
            Start-Sleep -Milliseconds 100
        }
    }
}

# 1. 仅在服务未运行时启动（避免重复实例）。通过 watchdog 启动后会记录根 PID，
# 后续重启可终止 npm/concurrently/node --watch 在内的整棵进程树。
if (-not (Test-Listening)) {
    try {
        Invoke-RestMethod -Uri "http://127.0.0.1:$watchdogPort/start" -Method Post -TimeoutSec 3 -ErrorAction Stop | Out-Null
    } catch {
        Add-Type -AssemblyName System.Windows.Forms
        [System.Windows.Forms.MessageBox]::Show('重启守护未能启动服务，请检查 restart descriptor。', 'pi-web-ui')
        exit 1
    }

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

# 4. 停服。优先让 watchdog 清理整棵进程树与 PID 状态；不可用时才按端口兜底。
try {
    Invoke-RestMethod -Uri "http://127.0.0.1:$watchdogPort/stop" -Method Post -TimeoutSec 3 -ErrorAction Stop | Out-Null
} catch {
    Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
        ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
}
