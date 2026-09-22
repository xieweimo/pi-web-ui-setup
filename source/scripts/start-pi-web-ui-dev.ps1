# Start the isolated pi-web-ui source development environment.
# -OpenBrowser 启动后自动打开开发页面
# -NoWatch     不进入「页面一关就停服」的监控（默认会监控，与正式版启动器同一套行为）
param([switch]$OpenBrowser, [switch]$NoWatch)

$ErrorActionPreference = 'Stop'

$root = Split-Path $PSScriptRoot -Parent
$source = Join-Path $root 'projects\pi-web-ui-source'
$runtime = Join-Path $root 'work\pi-web-ui-dev'
$watchdog = Join-Path $root 'scripts\pi-web-ui-recovery-watchdog.js'
$descriptor = Join-Path $runtime 'restart-descriptor.json'
$watchdogPidFile = Join-Path $runtime 'watchdog.pid'
$watchdogPort = 8791
$serverPort = 8788
$webPort = 5173

function Test-Port([int]$Port) {
    return [bool](Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
}

if (-not (Test-Path (Join-Path $source 'package.json'))) {
    throw "Source checkout not found: $source"
}
if (-not (Test-Path (Join-Path $source 'node_modules'))) {
    throw "Dependencies are missing. Run npm ci in: $source"
}

New-Item -ItemType Directory -Force -Path $runtime | Out-Null
$devData = Join-Path $runtime 'data'
New-Item -ItemType Directory -Force -Path $devData | Out-Null
# 有意让开发版与正式版共用同一个工作目录和会话记录（用户选择不隔离），
# 方便在开发页面直接对照正式会话。代价：两边看到的是同一批 jsonl，
# 不要在开发页面给正在正式版里使用的对话发消息 —— 两个后端会同时写同一份转录。
# 不设 PI_CODING_AGENT_SESSION_DIR：上游只在「列/开历史会话」时读它，
# 恢复最近会话和新建会话不传，会造成「列表读 A、写入 B」的错位。
$node = (Get-Command node.exe -ErrorAction Stop).Source
$npmCmd = (Get-Command npm.cmd -ErrorAction Stop).Source
$npmCli = Join-Path (Split-Path $npmCmd) 'node_modules\npm\bin\npm-cli.js'
if (-not (Test-Path $npmCli)) { throw "npm CLI not found: $npmCli" }

@{
    label = 'pi-web-ui 源码开发环境'
    profile = 'development'
    watchdogPort = $watchdogPort
    primaryServiceId = 'backend'
    cwd = $source
    startupTimeoutMs = 60000
    env = @{
        PI_WEB_CWD = $root
        PI_WEB_DATA_DIR = $devData
        PI_WEB_PLUGIN_CATALOG_URL = 'off'
    }
    stop = @{ mode = 'process-tree'; portFallback = $true; allowUnowned = $false }
    services = @{
        backend = @{
            label = 'Node 后端'
            kind = 'backend'
            description = 'pi-web-ui API、WebSocket、会话和插件服务'
            command = $node
            # 不用 `npm run dev:server`（它跑的是 `node --watch --import tsx server/index.ts`）。
            # --watch 默认监视进程加载过的所有模块，而本实例会加载 ~/.pi/agent 下的扩展与
            # 子代理代码；AI 在 PIwork 里活动就会改写那些文件 → 后端被反复重启，页面反复断连。
            # --watch-path=server 把监视范围限定在源码的 server/ 目录，前端热更新不受影响。
            args = @('--watch-path=server', '--import', 'tsx', 'server/index.ts')
            env = @{
                PI_WEB_PORT = "$serverPort"
                PI_WEB_ALLOW_ORIGINS = "http://localhost:$webPort,http://127.0.0.1:$webPort"
            }
            servicePort = $serverPort
            healthUrl = "http://localhost:$serverPort/api/health"
            stdoutFile = (Join-Path $runtime 'backend.out.log')
            stderrFile = (Join-Path $runtime 'backend.err.log')
            actions = @('restart', 'start', 'stop')
            order = 10
        }
        frontend = @{
            label = 'Vite 前端'
            kind = 'frontend'
            description = '浏览器访问的开发界面与热更新服务'
            command = $node
            # 直接跑 vite，不经 `npm run`。Windows 上 npm 执行 script 会再起一层
            # `cmd.exe /d /s /c vite ...`，那一层不受 watchdog 的 windowsHide 控制，
            # 每次重启前端都会闪一个黑框。
            args = @((Join-Path $source 'node_modules\vite\bin\vite.js'), '--config', 'web/vite.config.ts')
            servicePort = $webPort
            healthUrl = "http://localhost:$webPort/"
            stdoutFile = (Join-Path $runtime 'frontend.out.log')
            stderrFile = (Join-Path $runtime 'frontend.err.log')
            actions = @('restart', 'start', 'stop')
            order = 20
        }
    }
} | ConvertTo-Json -Depth 8 | Set-Content -Path $descriptor -Encoding UTF8

if (-not (Test-Port $watchdogPort)) {
    if ((Test-Port $serverPort) -or (Test-Port $webPort)) {
        # The watchdog may have exited while its detached npm tree kept running.
        # Reattach only when the saved root PID still clearly belongs to this dev command.
        $stateFile = Join-Path $env:TEMP "pi-web-ui-recovery-watchdog-$watchdogPort.json"
        $managed = $false
        if (Test-Path $stateFile) {
            try {
                $saved = Get-Content $stateFile -Raw -Encoding UTF8 | ConvertFrom-Json
                $savedPids = @($saved.pid) + @($saved.services.PSObject.Properties.Value | ForEach-Object { $_.pid })
                foreach ($savedPid in ($savedPids | Where-Object { $_ })) {
                    $savedProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$savedPid" -ErrorAction SilentlyContinue
                    if (-not $savedProcess) { continue }
                    # watchdog 记录的 PID 仍在跑，就认为是它启动的服务（服务现在是 node 直启，
                    # 命令行里不一定再出现 pi-web-ui-source 或 npm，不能靠字符串匹配）。
                    $knownCommand = ($savedProcess.CommandLine -like '*pi-web-ui-source*') -or
                        ($savedProcess.CommandLine -like '*pi-web-ui-recovery-watchdog.js*') -or
                        ($savedProcess.CommandLine -like '*vite*') -or
                        ($savedProcess.CommandLine -like '*npm*run*dev*') -or
                        ($savedProcess.CommandLine -like '*watch-path=server*')
                    # state 文件只由 watchdog 写，记录里的 PID 还在跑、且确实是 node，
                    # 就认定这个端口是我们的服务（命令行不再逐项匹配，避免误判为“不受管”）。
                    if ($knownCommand -or $savedProcess.Name -eq 'node.exe') {
                        $managed = $true
                        break
                    }
                }
            } catch { }
        }
        if (-not $managed) {
            throw "Development ports $serverPort or $webPort are occupied by an unmanaged process."
        }
    }
    $process = Start-Process -FilePath $node `
        -ArgumentList @($watchdog, '--descriptor', $descriptor) `
        -WindowStyle Hidden -PassThru
    Set-Content -Path $watchdogPidFile -Value $process.Id -Encoding ASCII
    for ($i = 0; $i -lt 50 -and -not (Test-Port $watchdogPort); $i++) { Start-Sleep -Milliseconds 100 }
}

if (-not (Test-Port $watchdogPort)) { throw "Development watchdog failed to listen on $watchdogPort." }

# 开发环境的插件与正式版保持一致（幂等；已存在的 config.json 不会被覆盖）。
# 其中 piwork-tools 提供了 /busy 端点，供下面的停服监控判断“还有任务在跑吗”。
$pluginInstaller = Join-Path $root 'scripts\install-plugins.js'
if (Test-Path $pluginInstaller) { & node $pluginInstaller --data-dir $devData | Out-Null }

$state = Invoke-RestMethod -Uri "http://127.0.0.1:$watchdogPort/state" -TimeoutSec 3
if (-not $state.serviceHealthy) {
    Invoke-RestMethod -Uri "http://127.0.0.1:$watchdogPort/start" -Method Post -TimeoutSec 3 | Out-Null
}

$ready = $false
for ($i = 0; $i -lt 120; $i++) {
    try {
        $response = Invoke-WebRequest -Uri "http://localhost:$webPort/" -UseBasicParsing -TimeoutSec 1
        if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500) { $ready = $true; break }
    } catch { }
    Start-Sleep -Milliseconds 500
}
if (-not $ready) {
    throw "Development UI did not become ready. Check $runtime\dev.err.log and dev.out.log."
}

if ($OpenBrowser) { Start-Process "http://localhost:$webPort" }
Write-Host "pi-web-ui dev is ready: http://localhost:$webPort"
Write-Host "Backend: http://localhost:$serverPort  Watchdog: http://localhost:$watchdogPort"

# 监听连接：页面一关就自动停服（与 scripts\pi-web-ui-launcher.ps1 同一套逻辑）。
#   - 断开满 $idleLimit 秒 → 先问一句“还有任务在跑吗”，不忙才停（叉掉即关，但不会截断正在跑的活）；
#   - 刷新页面 / 网络抖动会在这个窗口内重连，计数自动重置；
#   - 页面一次都没连上时用 $idleFallback 兜底；
#   - 服务不在监听（例如从界面点「重启」）时不计时；watchdog 重启服务时会写 stamp 重置计数。
if (-not $NoWatch) {
    $idleLimit = 3
    $idleFallback = 300
    $stampFile = Join-Path $env:TEMP 'pi-web-ui-restart.stamp'
    $lastStamp = if (Test-Path $stampFile) { (Get-Item $stampFile).LastWriteTimeUtc } else { [datetime]::MinValue }
    $idle = 0
    $seen = $false
    while ($true) {
        if (Test-Path $stampFile) {
            $st = (Get-Item $stampFile).LastWriteTimeUtc
            if ($st -gt $lastStamp) { $lastStamp = $st; $idle = 0 }
        }
        $listen = Test-Port $webPort
        $est = [bool](Get-NetTCPConnection -LocalPort $webPort -State Established -ErrorAction SilentlyContinue)
        if (-not $listen) { $idle = 0 }
        elseif ($est) { $idle = 0; $seen = $true }
        else { $idle++ }
        if ($seen) {
            if ($idle -ge $idleLimit) {
                $busy = $false
                try {
                    $busy = [bool](Invoke-RestMethod -Uri "http://127.0.0.1:$serverPort/plugins-api/piwork-tools/busy" -TimeoutSec 2 -ErrorAction Stop).busy
                } catch { $busy = $false }
                if ($busy) { $idle = 0 } else { break }
            }
        }
        elseif ($idle -ge $idleFallback) { break }
        Start-Sleep -Seconds 1
    }
    Write-Host '页面已断开，正在停止开发环境（正式版 8787 不受影响）…'
    try {
        Invoke-RestMethod -Uri "http://127.0.0.1:$watchdogPort/stop" -Method Post -TimeoutSec 3 -ErrorAction Stop | Out-Null
    } catch {
        Get-NetTCPConnection -LocalPort $serverPort, $webPort -State Listen -ErrorAction SilentlyContinue |
            ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
    }
    # 开发版不留常驻 watchdog：用户要求“关浏览器就全清”，所以连 8791 一起收掉。
    # （正式版不同——它由桌面启动器长期托管，那个 watchdog 要留着；下次双击启动会自动重建本地的。）
    Get-NetTCPConnection -LocalPort $watchdogPort -State Listen -ErrorAction SilentlyContinue |
        ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
    Remove-Item $watchdogPidFile -Force -ErrorAction SilentlyContinue
    Write-Host "开发环境已停止：前端 :$webPort 、后端 :$serverPort 、watchdog :$watchdogPort 全部释放。"
}
