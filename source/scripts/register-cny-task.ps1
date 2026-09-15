# Register the daily task that updates the USD->CNY rate in pi-web-ui.
# Run once after reinstalling the system, or after moving the workspace.
$node   = "C:\Program Files\nodejs\node.exe"
$script = "C:\AIWork\PI\PIwork\scripts\update-cny-rate.js"
$workdir = "C:\AIWork\PI\PIwork\scripts"

$action  = New-ScheduledTaskAction -Execute $node -Argument ('"' + $script + '"') -WorkingDirectory $workdir
$trigger = New-ScheduledTaskTrigger -Daily -At "00:00"
Register-ScheduledTask -TaskName "PIwork-UpdateCNYRate" -Action $action -Trigger $trigger -Description "Daily update USD-CNY rate for pi-web-ui" -Force | Out-Null
Write-Host "registered OK"
