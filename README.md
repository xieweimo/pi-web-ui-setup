# pi-web-ui-setup

一键在 Windows 上安装**定制版 pi-web-ui**（Codex 额度显示、人民币成本、断连恢复按钮、红色停止按钮）。

**不需要管理员权限**，不需要登录 GitHub：没有 Node.js 时会自动下载便携版 Node（解压即用）。

> 定制的**源码**（插件 / 补丁 / 配置 / 脚本）全部镜像在本仓库 [`source/`](./source) 内，可直接在 GitHub 上浏览，见下文「定制内容在哪」。

## 一条命令搞定

**PowerShell**（自愈式：第一次失败会自动绕过失效的系统代理重试）：

```powershell
$u='https://raw.githubusercontent.com/xieweimo/pi-web-ui-setup/main/install.ps1?t='+(Get-Random);try{$s=irm $u}catch{[Net.WebRequest]::DefaultWebProxy=New-Object Net.WebProxy;$s=irm $u};iex $s
```

**cmd（命令提示符）**：

```cmd
powershell -NoProfile -ExecutionPolicy Bypass -Command "$u='https://raw.githubusercontent.com/xieweimo/pi-web-ui-setup/main/install.ps1?t='+(Get-Random); try{$s=irm $u}catch{[Net.WebRequest]::DefaultWebProxy=New-Object Net.WebProxy; $s=irm $u}; iex $s"
```

若 `raw.githubusercontent.com` 连不上，改用 jsDelivr 镜像：

```powershell
$u='https://cdn.jsdelivr.net/gh/xieweimo/pi-web-ui-setup@main/install.ps1?t='+(Get-Random);try{$s=irm $u}catch{[Net.WebRequest]::DefaultWebProxy=New-Object Net.WebProxy;$s=irm $u};iex $s
```

或直接运行本仓库的 `install.cmd`（会自动尝试 jsDelivr）。

装完桌面出现 **Pi Web UI** 快捷方式，双击即可使用。开头会打印 `pi-web-ui-setup vYYYY-MM-DD.n` 版本号。

## 安装器会做什么

1. 安装或复用隔离的便携 Node.js 22+ 到 `%USERPROFILE%\PiWebUI\node`（免管理员，不会改动系统 Node/npm），镜像依次尝试 nodejs.org / npmmirror / 清华。
2. 安装固定版本 `pi 0.87.1` + `pi-web-ui 0.95.0`：依赖走国内镜像，镜像缺的包单独从官方 tarball 拉取。
3. 写入 `install.json`（记录便携 Node 与启动命令位置；补丁和启动器靠它定位）。
4. 解压定制包并应用补丁（按版本 profile 校验，版本不匹配就跳过，不盲改）。
5. 写入通用 pi 偏好（**无 BOM** 的 UTF-8，避免 pi 报 `Failed to parse settings file`）。
6. 准备**浏览器扩展** page-picker：解压到安装目录 `page-picker-extension\`，并预先打好「全站放行」补丁。
7. 在**桌面**放一份《装完之后要做的事.txt》（登录 / 装扩展 / shellPath 三步 + 自检清单）。
8. 桌面创建 `Pi Web UI` 快捷方式。

## 定制内容在哪（源码 / 补丁 / 插件 / 配置）

`source/` 是定制内容的**明文镜像**，每次同步自动覆盖重建（不用手工维护）：

```
source/
├── projects/                       ← 四个界面插件（完整源码）
│   ├── codex-usage-plugin/         ChatGPT 订阅额度 + 人民币成本
│   ├── piwork-tools-plugin/        顶栏 ⤴同步
│   ├── quick-ask-plugin/           💬 临时问问
│   └── reconnect-plugin/           🔄 重连
├── patches/                        ← pi-web-ui 补丁 + page-picker 扩展「全站放行」补丁
├── configs/                        ← pi 设置模板、全局 AGENTS.md、模型库、版本档案
├── scripts/                        ← 启动器、断连守护、插件安装器、打包与同步脚本
├── extras/page-picker-extension.zip
└── docs/after-install-checklist.md 装完之后要做的事
```

| 目录 | 内容 |
|---|---|
| `source/projects/codex-usage-plugin/` | 界面插件：ChatGPT 订阅额度 + 人民币成本（服务端入口 + 客户端视图 + 声明式设置） |
| `source/projects/piwork-tools-plugin/` | 界面插件：顶栏 `⤴同步`（打包→推送→校验）+ `🛠PIwork` 状态视图 |
| `source/projects/quick-ask-plugin/` | 界面插件：`💬 临时问问`独立临时问答浮层 |
| `source/projects/reconnect-plugin/` | 界面插件：`🔄 重连`与网页服务重启 |
| `source/patches/` | pi-web-ui 补丁 + page-picker 扩展「全站放行」补丁 |
| `source/configs/` | pi 设置模板、全局 AGENTS.md、模型库、版本档案（`pi-web-ui-profiles/`） |
| `source/scripts/` | 启动器、断连守护、插件安装器、打包与同步脚本 |
| `source/extras/page-picker-extension.zip` | 浏览器扩展（配合 `source/patches/apply-page-picker-all-urls.js`） |
| `source/docs/after-install-checklist.md` | 装完之后要手动做的事 |

单独补装/更新某个界面插件（浏览器里的 pi-web-ui 已在跑时）：

```bash
pi-web-ui install https://github.com/xieweimo/pi-web-ui-setup/tree/main/source/projects/piwork-tools-plugin --force
```

（一键安装已自动装好四个插件，这条命令只在别处补装时用。）

## 不会做什么

不包含也不读取任何凭据：OAuth、API key、SSH 私钥、代理地址都不在安装包内。装完请自行登录 Codex、填写 DeepSeek key 与代理。

## 手动 / 离线安装

下载 `PiWebUI-Setup_pi-0.87.1_web-0.95.0.zip`，解压后运行：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-aiwork.ps1
```

（离线安装需要系统已装 Node.js 22+。）

## 清理旧的失败安装

如果之前装失败过，先清一次再装（只会删除 `%USERPROFILE%\PiWebUI`、临时文件和它创建的 `Pi Web UI` 桌面快捷方式；不会停止宿主机服务，也不会删除 `~/.pi`、`~/.pi-web` 的共享配置/插件）：

```powershell
$u='https://raw.githubusercontent.com/xieweimo/pi-web-ui-setup/main/uninstall.ps1?t='+(Get-Random);try{$s=irm $u}catch{[Net.WebRequest]::DefaultWebProxy=New-Object Net.WebProxy;$s=irm $u};iex $s
```

清理是可选的：安装器本身可以重复执行，会复用已下载的便携 Node 并重新应用补丁。

## 命令一览（PowerShell 与 cmd 都有）

| 用途 | PowerShell 一键 | cmd 一键 |
|---|---|---|
| 清理旧安装 | 上文「清理旧的失败安装」那条 | 见下，或运行 `uninstall.cmd` |
| 安装 | 上文「一条命令搞定」那条 | 见下，或运行 `install.cmd` |

**cmd 清理：**

```cmd
powershell -NoProfile -ExecutionPolicy Bypass -Command "$u='https://raw.githubusercontent.com/xieweimo/pi-web-ui-setup/main/uninstall.ps1?t='+(Get-Random); try{$s=irm $u}catch{[Net.WebRequest]::DefaultWebProxy=New-Object Net.WebProxy; $s=irm $u}; iex $s"
```

**cmd 安装：**

```cmd
powershell -NoProfile -ExecutionPolicy Bypass -Command "$u='https://raw.githubusercontent.com/xieweimo/pi-web-ui-setup/main/install.ps1?t='+(Get-Random); try{$s=irm $u}catch{[Net.WebRequest]::DefaultWebProxy=New-Object Net.WebProxy; $s=irm $u}; iex $s"
```

两条 cmd 命令都自带「失败则绕过系统代理重试」，与 PowerShell 版等价。
