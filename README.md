# pi-web-ui-setup

一键在 Windows 上安装**定制版 pi-web-ui**（Codex 额度显示、人民币成本、断连恢复按钮、红色停止按钮）。

**不需要管理员权限**，不需要登录 GitHub：没有 Node.js 时会自动下载便携版 Node（解压即用）。

## 一条命令搞定

**PowerShell**（自愈式：第一次失败会自动绕过失效的系统代理重试）：

```powershell
$u='https://raw.githubusercontent.com/xieweimo/pi-web-ui-setup/main/install.ps1?t='+(Get-Random);try{$s=irm $u}catch{[Net.WebRequest]::DefaultWebProxy=New-Object Net.WebProxy;$s=irm $u};iex $s
```

**cmd（命令提示符）**：

```cmd
powershell -NoProfile -ExecutionPolicy Bypass -Command "$u='https://raw.githubusercontent.com/xieweimo/pi-web-ui-setup/main/install.ps1?t='+(Get-Random); try{$s=irm $u}catch{[Net.WebRequest]::DefaultWebProxy=New-Object Net.WebProxy; $s=irm $u}; iex $s"
```

或直接运行本仓库的 `install.cmd`。

装完桌面出现 **Pi Web UI** 快捷方式，双击即可使用。开头会打印 `pi-web-ui-setup vYYYY-MM-DD.n` 版本号。

## 安装器会做什么

1. 检查 Node.js 22+；没有就装便携版到 `%USERPROFILE%\PiWebUI\node`（免管理员），镜像依次尝试 nodejs.org / npmmirror / 清华。
2. 安装固定版本 `pi 0.85.1` + `pi-web-ui 0.81.0`：依赖走国内镜像，镜像缺的包单独从官方 tarball 拉取。
3. 写入 `install.json`（记录便携 Node 与启动命令位置；补丁和启动器靠它定位）。
4. 解压定制包并应用补丁（按版本 profile 校验，版本不匹配就跳过，不盲改）。
5. 写入通用 pi 偏好（**无 BOM** 的 UTF-8，避免 pi 报 `Failed to parse settings file`）。
6. 桌面创建 `Pi Web UI` 快捷方式。

## 不会做什么

不包含也不读取任何凭据：OAuth、API key、SSH 私钥、代理地址都不在安装包内。装完请自行登录 Codex、填写 DeepSeek key 与代理。

## 手动 / 离线安装

下载 `PiWebUI-Setup_pi-0.85.1_web-0.81.0.zip`，解压后运行：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-aiwork.ps1
```

（离线安装需要系统已装 Node.js 22+。）

## 清理旧的失败安装

如果之前装失败过，先清一次再装（会删除 `%USERPROFILE%\PiWebUI`、临时文件、桌面快捷方式，并修掉旧版写坏的 BOM）：

```powershell
$u='https://raw.githubusercontent.com/xieweimo/pi-web-ui-setup/main/uninstall.ps1?t='+(Get-Random);try{$s=irm $u}catch{[Net.WebRequest]::DefaultWebProxy=New-Object Net.WebProxy;$s=irm $u};iex $s
```

清理是可选的：安装器本身可以重复执行，会复用已下载的便携 Node 并重新应用补丁。
