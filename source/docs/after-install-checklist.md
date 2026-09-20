# 装完之后要做的事（一键安装无法代劳的部分）

> 一键安装已经把界面和配置都装好了，**只有下面 3 件事必须你手动做**（前 2 件必做，第 3 件可忽略）。
> 照做完，这台机器就和你原来那台**同一套界面、同一套功能**。

## 已经自动装好的（不用管，只用对照自检）

- 版本：`pi 0.85.1` + `pi-web-ui 0.92.0`
- 7 个功能补丁：逐条成本、切模型即时刷新、历史列表 fork 去重、永久忽略最近项目、断连恢复浮层、快捷短语排队、红色脉冲停止按钮
- 4 个界面插件：`⚡额度`（ChatGPT 订阅额度 + 人民币成本）、`⤴同步`、`💬临时问问`（独立临时问答浮层）、`🔄重连`
- pi 设置：主题 dark、默认模型 `deepseek-flash`、思考等级 minimal、compaction、4 个扩展包
- 全局中文指令 `AGENTS.md`
- 模型库：deepseek ×2 + openai-codex ×6（含 gpt-5.6-terra / sol / luna、gpt-6-astra）
- 桌面「Pi Web UI」快捷方式；关掉浏览器 3 秒自动停服（有任务在跑则等它跑完）

---

## 【1/3 必做】登录

凭证（Codex OAuth、DeepSeek API key）属于安全红线，**永不随安装包走**。

1. 双击桌面「**Pi Web UI**」打开界面；
2. **Codex / ChatGPT 订阅**：界面里的模型管理 / 服务商面板 → 登录 `openai-codex`（会跳浏览器完成 OAuth）；
3. **DeepSeek 或其他按量模型**：模型管理里填 API key。

凭证落盘在 `~/.pi/agent/auth.json`、`~/.pi/agent/provider-keys.json`（只在本机）。

## 【2/3 必做】装浏览器扩展 page-picker（让 AI 能读/操作你浏览器里的页面）

扩展活在浏览器里，安装脚本碰不到它，只能你点几下。安装包里**已经准备好扩展和一个关键补丁**：

```
<安装目录>\page-picker-extension\      ← Edge/Chrome 直接加载这个目录
```

步骤：

1. 打开 `edge://extensions`（Chrome 是 `chrome://extensions`）→ 打开左下角「**开发人员模式**」；
2. 点「**加载解压缩的扩展**」→ 选上面那个 `page-picker-extension` 目录；
3. 打开 pi-web-ui 页面（`http://localhost:8787`）→ 点浏览器工具栏里的扩展图标 → 点「**授权并绑定**」；
4. **刷新各个想让我操作的页面**（页面桥只在页面加载时注入）。

> **别移动、别删除**这个目录 —— 浏览器直接引用它，移动后扩展会失效。
> 目录里的扩展已经打过「**全站放行**」补丁（否则要逐个站点点授权，AI 每次只能操作一个站点）。
> 想恢复官方行为：删掉目录，从下面地址重新下载解压即可。
> 官方下载地址：https://github.com/xing-shuyin/pi-web-ui/releases/latest/download/page-picker-extension.zip

## 【3/3 可选】shellPath（一般不用管）

原电脑上 `~/.pi/agent/settings.json` 里的 `shellPath` 指向个人的便携 Git Bash。它含绝对路径，**故意没有随包分发** —— 路径不存在时 pi 会直接报 `Custom shell path not found`。

- 不设也行：pi 会自动用系统 Git Bash（`C:\Program Files\Git\bin\bash.exe`）；连 Git 都没装时，pi-web-ui 会自动下载 busybox 到 `~/.pi-web/bin/bash.exe` 兜底。
- 想指定就在 `~/.pi/agent/settings.json` 里加（注意 JSON 不能有 BOM）：

```json
{ "shellPath": "C:\\Program Files\\Git\\bin\\bash.exe" }
```

---

## 装完自检 5 条（都对上 = 与原机器一致）

1. 顶栏能看到 `⚡额度`、`🛠PIwork`、`⤴同步`、`💬临时问问`
2. 底部状态栏有 `⚡ 5h x% · 7d x%`（订阅）或 `⚡ ¥x.xx`（按量）
3. 模型选择器里有 `GPT-5.6 Terra` 等 codex 模型（登录后出现）
4. 对话正在跑时，停止按钮是**红色脉冲**
5. 历史对话列表里，同一个对话（编辑重问产生的多代）只显示**一条**

## 常见问题

| 现象 | 原因 / 处理 |
|---|---|
| 网页里用 Codex 报 `fetch failed，正在自动重试` | 国内直连 `chatgpt.com` 不通：在 `~/.pi/agent/settings.json` 里加 `httpProxy`（启动器会自动把它注入服务进程） |
| 顶栏没有 `⚡额度` / `🛠PIwork` / `💬临时问问` | 设置 →「界面插件」里是否被隐藏；刷新页面 |
| AI 说「页面桥没就绪」 | 扩展没装/没启用，或没在 pi-web-ui 页面点「授权并绑定」，或目标页面没刷新 |
| AI 说「还没有授权任何页面给 AI」 | 说明扩展没打全站放行补丁 —— 重跑 `<安装目录>\patches\apply-page-picker-all-urls.js`（需要 Node）后在扩展页点「重新加载」 |
| 改了定制想同步到 GitHub | 顶栏点 `⤴同步`（或跑 `<安装目录>\scripts\sync-pi-web-ui-setup.ps1`） |
| 关掉浏览器后服务还在跑 | 正常：还有任务在执行，pi 会等它跑完后自动停服 |
