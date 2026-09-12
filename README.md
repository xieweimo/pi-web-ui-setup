# pi-web-ui-setup

一键在 Windows 上安装**定制版 pi-web-ui**（Codex 额度显示、人民币成本、断连恢复按钮、红色停止按钮）。

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

## 网络受限时

`install.ps1` 会依次尝试 raw.githubusercontent.com、jsDelivr CDN、ghproxy 镜像下载安装包；全部失败时可手动下载 `PiWebUI-Setup_pi-0.85.1_web-0.81.0.zip` 离线安装：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-aiwork.ps1
```

## 会做什么

- 需要 Node.js 22+（缺失时尝试用 winget 自动安装）。
- 安装固定版本 `pi 0.85.1` 与 `pi-web-ui 0.81.0`。
- 部署 `codex-usage` 插件与网页端补丁（按版本 profile 校验，不匹配则跳过）。
- 写入通用 pi 偏好（不含任何密钥），创建桌面快捷方式。

## 不会做什么

不包含也不读取任何凭据：OAuth、API key、SSH 私钥、代理地址都不在安装包内。安装后请自行登录 Codex、填写 DeepSeek key 与代理。
