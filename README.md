# pi-web-ui-setup

一键在 Windows 上安装**定制版 pi-web-ui**（Codex 额度显示、人民币成本、断连恢复按钮、红色停止按钮）。

**不需要管理员权限**：没有 Node.js 时会自动下载便携版 Node（解压即用），不需要登录 GitHub。

## 一键安装

**PowerShell：**

```powershell
irm https://raw.githubusercontent.com/xieweimo/pi-web-ui-setup/main/install.ps1 | iex
```

**cmd（命令提示符）：**

```cmd
powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/xieweimo/pi-web-ui-setup/main/install.ps1 | iex"
```

或直接运行本仓库的 `install.cmd`。

安装完成后桌面出现 **Pi Web UI** 快捷方式，双击即可使用。

## 安装器会做什么

1. 检查 Node.js 22+；没有就下载便携版到 `%USERPROFILE%\PiWebUI\node`（免管理员），并优先选用国内可达镜像。
2. 安装固定版本 `pi 0.85.1` 与 `pi-web-ui 0.81.0`，registry 依次尝试 npmmirror 与官方源。
3. 下载定制安装包并应用补丁（按版本 profile 校验，版本不匹配就跳过，不盲改）。
4. 写入通用 pi 偏好（**无 BOM** 的 UTF-8，避免 pi 报 `Failed to parse settings file`）。
5. 在桌面创建 `Pi Web UI` 快捷方式，并记录便携 Node 路径供启动器使用。

## 网络受限时

`install.ps1` 会依次尝试 raw.githubusercontent.com、jsDelivr CDN、ghproxy 镜像下载安装包；Node.js 会依次尝试 nodejs.org、npmmirror、清华镜像。全部失败时手动离线安装：

```powershell
Expand-Archive .\PiWebUI-Setup_pi-0.85.1_web-0.81.0.zip .\PiWebUI
powershell -ExecutionPolicy Bypass -File .\PiWebUI\scripts\install-aiwork.ps1
```

（离线安装需要系统已装 Node.js 22+。）

## 不会做什么

不包含也不读取任何凭据：OAuth、API key、SSH 私钥、代理地址都不在安装包内。安装后请自行登录 Codex、填写 DeepSeek key 与代理。
