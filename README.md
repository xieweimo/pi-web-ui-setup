# pi-web-ui-setup

一键在 Windows 上安装**定制版 pi-web-ui**（Codex 额度显示、人民币成本、断连恢复按钮、红色停止按钮）。

**不需要管理员权限**：没有 Node.js 时会自动下载便携版 Node（解压即用），不需要登录 GitHub。

## 一键安装

**PowerShell**（`irm`/`iex` 是 PowerShell 专有命令，不要塞进 cmd）：

```powershell
irm https://raw.githubusercontent.com/xieweimo/pi-web-ui-setup/main/install.ps1 | iex
```

如果报「无法连接到远程服务器」，说明系统代理指向了没在运行的代理软件，改用：

```powershell
try { [Net.WebRequest]::DefaultWebProxy = New-Object Net.WebProxy } catch {}; irm "https://raw.githubusercontent.com/xieweimo/pi-web-ui-setup/main/install.ps1?t=$(Get-Random)" | iex
```

**cmd（命令提示符）**：

```cmd
powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/xieweimo/pi-web-ui-setup/main/install.ps1 | iex"
```

或直接双击/运行本仓库的 `install.cmd`（自带直连 + 绕过系统代理两次尝试）。

安装完成后桌面出现 **Pi Web UI** 快捷方式，双击即可使用。安装器开头会打印版本号，例如 `pi-web-ui-setup v2026-09-13.1`，可用来确认跑的是最新脚本。

## 安装器会做什么

1. 检查 Node.js 22+；没有就下载便携版到 `%USERPROFILE%\PiWebUI\node`（免管理员），镜像依次尝试 nodejs.org / npmmirror / 清华。
2. 安装固定版本 `pi 0.85.1` 与 `pi-web-ui 0.81.0`：依赖走国内镜像，镜像缺失的包单独从官方 tarball 拉取。
3. 写入 `install.json`（记录便携 Node 与启动命令位置，补丁与启动器都靠它定位）。
4. 解压定制包并应用补丁（按版本 profile 校验，版本不匹配就跳过，不盲改）。
5. 写入通用 pi 偏好（**无 BOM** 的 UTF-8，避免 pi 报 `Failed to parse settings file`）。
6. 在桌面创建 `Pi Web UI` 快捷方式。

## 不会做什么

不包含也不读取任何凭据：OAuth、API key、SSH 私钥、代理地址都不在安装包内。安装后请自行登录 Codex、填写 DeepSeek key 与代理。

## 手动 / 离线安装

下载 `PiWebUI-Setup_pi-0.85.1_web-0.81.0.zip`，解压后运行：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-aiwork.ps1
```

（离线安装需要系统已装 Node.js 22+。）
