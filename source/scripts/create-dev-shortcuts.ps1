<#
在桌面创建 pi-web-ui 开发环境的「启动 / 停止」快捷方式。

可重复运行（同名快捷方式会被覆盖重建）。
用法：
  powershell -ExecutionPolicy Bypass -File scripts\create-dev-shortcuts.ps1
#>
$ErrorActionPreference = 'Stop'

$root = Split-Path $PSScriptRoot -Parent
$desktop = [Environment]::GetFolderPath('Desktop')
$shell = New-Object -ComObject WScript.Shell

# 优先用 node 的图标（开发环境更贴切），找不到就退回 cmd 图标。
$nodeExe = Join-Path $env:ProgramFiles 'nodejs\node.exe'
$icon = if (Test-Path $nodeExe) { "$nodeExe,0" } else { "$env:SystemRoot\System32\cmd.exe,0" }

# 只需要一个入口：关掉浏览器后，启动脚本会自己停服（与正式版同一套行为）。
$items = @(
	@{
		Name   = '启动 pi-web-ui 开发环境'
		Target = Join-Path $root 'scripts\start-pi-web-ui-dev.vbs'
		Desc   = '无窗口启动开发版：前端 :5173 / 后端 :8788 / watchdog :8791。关掉浏览器后自动停服；正式版 :8787 不受影响。'
	}
)

# 旧版曾创建过「停止」快捷方式——现在不需要了，顺手清掉。
$stale = Join-Path $desktop '停止 pi-web-ui 开发环境.lnk'
if (Test-Path $stale) { Remove-Item $stale -Force; Write-Host '  已删除不再需要的「停止」快捷方式' }

foreach ($item in $items) {
	$lnk = Join-Path $desktop ($item.Name + '.lnk')
	$sc = $shell.CreateShortcut($lnk)
	$sc.TargetPath = $item.Target
	$sc.WorkingDirectory = $root
	$sc.Description = $item.Desc
	$sc.IconLocation = $icon
	$sc.Save()
	Write-Host ('  已创建: ' + $lnk)
}

Write-Host '完成：双击「启动 pi-web-ui 开发环境」即可（无窗口，关掉浏览器后自动停服）。'
