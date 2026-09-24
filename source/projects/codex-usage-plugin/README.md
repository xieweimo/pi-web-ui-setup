# ⚡ codex-usage —— 订阅额度 / 成本显示

pi-web-ui 界面插件：把「当前到底花了多少额度」放在一眼能看到的地方。

- **ChatGPT / Codex 订阅**：显示 5 小时窗口与每周窗口的已用百分比、重置倒计时、
  可用 banked reset 次数、套餐类型（plus / pro …）。
- **非订阅（按量计费的 API key）**：显示当前会话中、当前选中 provider（如 `deepseek`）
  从创建至今的完整累计成本（人民币、实时汇率）；上下文压缩不会让金额归零，也不会混入
  Codex 或其他 provider 的成本。
- 两者按**当前会话实际选择的模型**自动切换（auto 模式）。

## 界面上的两个位置

| 位置 | 内容 |
| --- | --- |
| 底部状态栏（默认开启） | 一行摘要：`⚡ 5h 24% · 7d 4%` 或 `⚡ ¥8.30`，鼠标悬停看详细信息，点击跳到本插件的 tab |
| 顶栏 ⚡ 标签 | 完整卡片：每个窗口的进度条、重置时间、reset 次数、汇率与刷新来源 |

pi-web-ui 0.90.0+ 使用官方 `bottombar` 槽位渲染状态栏摘要；旧版宿主自动降级到 DOM 注入。
插件额外防止状态栏条目在流式回复时被 flex 压缩到不可见。

## 数据来源

| 数据 | 来源 |
| --- | --- |
| 订阅额度 | `GET https://chatgpt.com/backend-api/wham/usage`（Codex CLI `/status` 背后的同一份数据），凭证取自 `<agentDir>/auth.json` 的 `openai-codex` |
| 会话成本 | `<agentDir>/sessions/**/*.jsonl` 当前对话的完整活动分支；只累计当前选中 provider 的 `usage.cost.total`（美元），包含压缩前消息与同 provider 的压缩/摘要调用 |
| 汇率 | `https://open.er-api.com/v6/latest/USD` → `rates.CNY`，缓存 12 小时（免费、无需 key） |

## 设置项

设置面板（⚙）→「界面插件」→ codex-usage：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `mode` | `auto` | `auto` 跟随当前模型；`codex` 强制显示订阅额度；`cost` 强制显示人民币成本 |
| `rateSource` | `live` | `live` 抓实时汇率；`fixed` 用固定汇率 |
| `fixedRate` | `7.2` | 固定汇率（1 USD = ? CNY） |
| `refreshSec` | `60` | 轮询间隔；每轮对话结束、切换会话、附加客户端时也会刷新 |
| `statusBar` | `true` | 是否在底部状态栏注入摘要 |
| `proxy` | 空 | 留空 = 依次读 `HTTPS_PROXY`/`HTTP_PROXY` 环境变量与 `<agentDir>/settings.json` 的 `httpProxy` |

## 隐私与安全

- **只读** `<agentDir>/auth.json`，从不写入，也不打印 token；OAuth access token 只用于
  请求用量接口，不进入日志、不广播给前端。
- 为避免上下文压缩后成本归零，按 `conversationId` 只读对应的会话 JSONL；解析后只使用
  条目父子关系、provider 与 `usage.cost.total`，不存储或广播消息正文。
- 广播给前端的数据只含：窗口百分比、重置时间、reset 次数、套餐类型、脱敏邮箱
  （`xi***@gmail.com`）与会话成本摘要。
- 本插件不注册 AI 工具，也不读取工作区源码文件。

## 故障排查

| 现象 | 原因 / 处理 |
| --- | --- |
| 显示「凭证已过期（HTTP 401）」 | 在 pi（CLI 或 web）里正常用一次 Codex 模型，或重新 `/login`，SDK 会刷新 auth.json |
| 显示「账号/地区不被允许（HTTP 403）」 | 代理出口地区不受支持；换节点（JP/SG/KR/US）后刷新 |
| 显示「代理连接超时」 | 代理没开或端口变了；检查 `HTTPS_PROXY` 与 `<agentDir>/settings.json` 的 `httpProxy` |
| 状态栏没出现摘要 | pi-web-ui 版本改了状态栏结构；关掉 `statusBar` 设置，改用 ⚡ 标签查看 |
| 想让它重新加载代码 | 设置 →「界面插件」→ 重载（或重启 pi-web-ui 服务）后刷新浏览器 |

## 开发

```bash
# 本地跑一遍两条数据线（会真实请求用量与汇率接口，只读不消耗额度）
node projects/codex-usage-plugin/tests/manual-test.mjs

# 部署到数据目录（只装这一个插件）
node scripts/install-plugins.js --only codex-usage
```

源码维护在 `PIwork/projects/codex-usage-plugin/`，部署脚本只做复制——**升级 pi-web-ui
不会覆盖插件目录**，无需重打补丁。
