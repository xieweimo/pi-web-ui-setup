param(
    [Parameter(Mandatory=$true)][string]$StatusFile,
    [Parameter(Mandatory=$true)][int]$ParentId
)
# 独立窗口避免启动器执行同步检查时界面冻结；不显示无法测量的百分比。
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$form = New-Object System.Windows.Forms.Form
$form.Text = '正在启动 Pi 网页版'
$form.Size = New-Object System.Drawing.Size(470, 145)
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.MinimizeBox = $true
$label = New-Object System.Windows.Forms.Label
$label.Location = New-Object System.Drawing.Point(18, 18)
$label.Size = New-Object System.Drawing.Size(420, 38)
$label.Text = '正在准备启动，请稍候…'
$bar = New-Object System.Windows.Forms.ProgressBar
$bar.Location = New-Object System.Drawing.Point(20, 65)
$bar.Size = New-Object System.Drawing.Size(415, 20)
$bar.Style = 'Marquee'
$bar.MarqueeAnimationSpeed = 30
$form.Controls.Add($label)
$form.Controls.Add($bar)
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 400
$timer.Add_Tick({
    if (-not (Get-Process -Id $ParentId -ErrorAction SilentlyContinue)) { $form.Close(); return }
    try {
        if (Test-Path -LiteralPath $StatusFile) {
            $status = [System.IO.File]::ReadAllText($StatusFile, [System.Text.Encoding]::UTF8)
            if ($status -eq '__DONE__') { $form.Close(); return }
            if ($status) { $label.Text = $status }
        }
    } catch { }
})
$form.Add_Shown({ $timer.Start() })
try { [void]$form.ShowDialog() } finally { $timer.Stop(); $timer.Dispose(); $form.Dispose() }
