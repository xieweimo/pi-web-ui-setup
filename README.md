# pi-web-ui-setup

一键在 Windows 上安装**定制版 pi-web-ui**（含 Codex 额度显示、人民币成本、断连恢复按钮、红色停止按钮）。

## 一键安装

在 PowerShell 里运行：

```powershell
irm https://raw.githubusercontent.com/xieweimo/pi-web-ui-setup/main/install.ps1 | iex
```

安装完成后，桌面会出现 **Pi Web UI** 快捷方式，双击即可使用。

## 会做什么

- 需要 Node.js 22+（缺失时尝试用 winget 自动安装）。
- 安装固定版本 `pi 0.85.1` 与 `pi-web-ui 0.81.0`。
- 部署 `codex-usage` 插件与网页端定制补丁（按版本 profile 校验，不匹配则跳过）。
- 写入通用的 pi 偏好设置（不含任何密钥），并创建桌面快捷方式。

## 不会做什么

- 不上传、不读取任何凭据：OAuth、API key、SSH 私钥、代理地址都不包含在安装包内。
- 安装后请自行在 pi 里登录 Codex、填写 DeepSeek key 与代理。

## 手动安装（离线）

下载 `PiWebUI-Setup_pi-0.85.1_web-0.81.0.zip`，解压后在解压目录运行：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-aiwork.ps1
```
