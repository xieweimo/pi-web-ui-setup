# ⚡ 模型额度与成本（codex-usage）

pi-web-ui 通用计费面板：统一显示订阅额度、API 按量成本、预付积分消耗、免费/本地调用、混合计费和无法确认的中转站目录价。

插件 id 为兼容已有安装仍保留 `codex-usage`，界面名称已经改为「额度与成本」。

## 支持的计费模式

| 模式 | 含义 | 显示方式 |
|---|---|---|
| `subscription` | 包月/包年订阅 | 排除理论 API 目录价；有 adapter 时显示额度窗口 |
| `metered` | 官方 API key 按 token / 请求付费 | 显示会话成本估算（USD + CNY） |
| `prepaid` | 预充值积分/余额、中转余额 | 显示按模型目录价计算的消耗估算 |
| `free` | 本地模型或明确免费的服务 | 排除目录价，标记为免费 |
| `hybrid` | 订阅包含额度、超额另收费 | 显示混合计费估算，提醒需结合服务商账单 |
| `unknown` | 中转站或无法确认结算关系 | 显示“未确认目录价”，绝不冒充真实扣款 |

## 自动识别顺序

从高到低：

1. `provider/model` 精确用户规则；
2. provider 用户规则；
3. 内置订阅/余额 adapter；
4. 已知产品特征（Codex、Coding Plan 路径、OpenRouter）；
5. `auth.json` 的认证类型（OAuth = 订阅/套餐，API key = 按量线索）；
6. `models-store.json` 的 `baseUrl` 是否为官方 API endpoint；
7. 主流按量厂商名（仅在无 baseUrl 反证时）；
8. 无法证明时归 `unknown`。

## 内置识别清单

### 官方按量 endpoint（API key，高置信度 `metered`）

| 厂商 | endpoint |
|---|---|
| OpenAI | `api.openai.com` |
| Anthropic | `api.anthropic.com` |
| Google | `generativelanguage.googleapis.com` / `aiplatform.googleapis.com` |
| DeepSeek | `api.deepseek.com` |
| Kimi / Moonshot | `api.moonshot.cn` / `api.moonshot.ai` / `api.kimi.com` |
| 智谱 GLM（普通 API） | `open.bigmodel.cn`（非 `/coding/` 路径） |
| 通义 Qwen | `dashscope.aliyuncs.com`（含国际站） |
| 豆包 / 火山方舟 | `ark.cn-beijing.volces.com` / `ark.ap-southeast.volces.com` |
| MiniMax | `api.minimax.chat` / `api.minimaxi.com` |
| 零一万物 / 阶跃 / 百川 | `api.lingyiwanwu.com` / `api.stepfun.com` / `open.baichuan-ai.com` |
| 百度千帆 / 腾讯混元 | `aip.baidubce.com` / `qianfan.baidubce.com` / `hunyuan.tencentcloudapi.com` |
| SiliconFlow | `api.siliconflow.cn` / `api.siliconflow.com` |
| Mistral / xAI / Cohere | `api.mistral.ai` / `api.x.ai` / `api.cohere.com` |
| Groq / Perplexity | `api.groq.com` / `api.perplexity.ai` |
| Together / Fireworks / Cerebras / Novita | 对应官方域名 |

### 订阅 / 套餐（`subscription`）

| 特征 | 例子 | 置信度 |
|---|---|---|
| 内置额度 adapter | `openai-codex`（真实读取 5h/每周窗口） | high |
| baseUrl 含 `/coding/` 路径 | GLM Coding Plan、Kimi for Coding | medium |
| provider 名含 `coding-plan` | 各厂商 Coding Plan | medium |
| OAuth 登录 | Claude Code / Claude Max、Gemini CLI、Qwen OAuth | medium |

### 预付积分（`prepaid`）

- `openrouter.ai` endpoint 或 provider 名 `openrouter`（OpenRouter credits）。

### 免费 / 本地（`free`）

- `localhost` / `127.0.0.1` / `::1` 且无任何凭证（Ollama、LM Studio 等）。

### 厂商名白名单（中置信度）

openai、anthropic、google、deepseek、mistral、xai、cohere、groq、perplexity、together、fireworks、moonshot、kimi、zai、zhipu、qwen、dashscope、minimax、doubao、volcengine、siliconflow、novita、cerebras 等——仅在**没有 baseUrl 反证**（即没有挂到自定义域名）时生效，避免把中转站误判成官方按量。

### 不自动判定的情况

- API key + 自定义域名（中转站）：`unknown / 未确认目录价`；
- 官方厂商名挂在中转域名下：同样 `unknown`，名字不作为证据；
- 其他未收录域名：`unknown`，可通过 `billingOverrides` 手工指定。

中转站即使伪装成 OpenAI-compatible API，也不会仅凭模型名字认定为官方按量计费。

## 当前内置 adapter

### ChatGPT / Codex

- provider：`openai-codex`
- OAuth 凭证：`<agentDir>/auth.json`
- 用量接口：`GET https://chatgpt.com/backend-api/wham/usage`
- 显示 5 小时 / 每周窗口、重置倒计时、套餐与可用 reset。

### 通用订阅

其他 provider 可以通过规则标记为 `subscription`。插件会正确排除其理论 API 目录价；如果厂商没有稳定可读取的额度 API，则显示“已识别为订阅模式，暂无额度查询 adapter”。

后续增加厂商额度接口时，只需增加 adapter，不需要改会话成本账本。

## 通用会话账本

插件读取当前会话 JSONL 的活动分支，按 provider 汇总：

- assistant 回复的 `usage.cost.total`；
- compaction、branch summary 与其他有 usage 的辅助调用；
- 压缩前消息仍保留，不会因为上下文压缩归零；
- fork 废弃分支不计入；
- 订阅/免费调用的目录价单独展示并排除；
- 按量、预付、混合、未知调用分别标注。

`usage.cost.total` 是按模型价格表计算的目录价，不一定等于服务商最终账单。只有厂商账单/余额 adapter 才能称为真实扣款。

## Provider 规则配置

设置 → 界面插件 → `codex-usage` →「Provider 计费方式覆盖」。

### 简写

```text
anthropic=subscription,openrouter=prepaid,my-relay=unknown
```

### JSON（推荐）

```json
{
  "anthropic": {
    "mode": "subscription",
    "label": "Claude Max",
    "note": "个人 Max 订阅，不计理论 API 目录价"
  },
  "openrouter": {
    "mode": "prepaid",
    "label": "OpenRouter 余额"
  },
  "my-relay/gpt-4.1": {
    "mode": "hybrid",
    "label": "公司中转套餐",
    "note": "每月含额度，超额另付"
  }
}
```

精确 `provider/model` 规则优先于 provider 规则。

## 界面

- 顶栏「⚡ 额度」：总金额、当前模型计费识别、provider 明细与订阅窗口；
- 底部状态栏：订阅显示窗口百分比，其他模式显示人民币估算；
- Provider 明细会显示计费模式、识别来源、置信度、endpoint 与备注。

## 设置项

| 键 | 默认 | 说明 |
|---|---|---|
| `mode` | `auto` | 自动识别；也可强制当前模型按订阅或成本显示 |
| `defaultBillingMode` | `unknown` | 无法识别时的默认方式；建议保持 unknown |
| `billingOverrides` | 空 | provider / model 计费规则 |
| `rateSource` | `live` | 实时汇率或固定汇率 |
| `fixedRate` | `7.2` | 1 USD 对应人民币 |
| `refreshSec` | `60` | 刷新间隔 |
| `statusBar` | `true` | 是否显示底部摘要 |
| `hideNativeCost` | `true` | 隐藏宿主原生美元总成本 |
| `proxy` | 空 | 用量和汇率接口代理；留空继承环境/pi 设置 |
| `inheritProxy` | `true` | 为服务进程配置代理兼容 |

## 隐私

- 不上传对话正文；
- 只从会话 JSONL 读取 provider、model、父子关系和 usage cost；
- OAuth token 不写日志、不广播到前端；
- 前端只收到汇总金额、额度窗口、脱敏邮箱和计费识别信息；
- 不注册 AI 工具，不修改工作区文件。

## 测试

```bash
node projects/codex-usage-plugin/tests/billing-profile.test.mjs
node projects/codex-usage-plugin/tests/session-ledger.test.mjs
node projects/codex-usage-plugin/tests/session-file-identity.test.mjs
node projects/codex-usage-plugin/tests/per-client-state.test.mjs
node projects/codex-usage-plugin/tests/stale-client-ttl.test.mjs
node projects/codex-usage-plugin/tests/plan-decoupling.test.mjs
node projects/codex-usage-plugin/tests/state-alignment.test.mjs
node projects/codex-usage-plugin/tests/manual-test.mjs
node scripts/install-plugins.js --only codex-usage
node scripts/check-codex-usage.js --reload
```

手工测试覆盖：Codex 订阅、多 provider API 按量、非 Codex 订阅、预付积分中转和未知 provider。
识别引擎单元测试注入认证与 endpoint 元数据，覆盖全部官方 endpoint、订阅特征、中转反证和规则优先级，不依赖本机真实配置。会话账本回归测试覆盖活动分支排除、辅助调用、缺失成本与模型级计费规则冲突；会话文件身份测试复现重开后的短内存 id（`c1`/`c4`）复用，断言始终以 `sessionFile` 读取完整 JSONL 账本、缓存不会串会话，同样不依赖真实会话或网络。按页面隔离测试用两个页面指向不同对话，断言各自拿到自己的状态；幽灵页面测试验证心跳过期后死页面不再占据状态栏；解耦测试验证看板/规划条目不会改动成本账本。

## 按页面隔离（多标签 / 并行对话 / 子代理）

宿主的插件快照只给「全客户端最近活跃对话」（`readConversationForPlugins()`），而状态栏是全局单例。
只要有第二个标签页、并行对话或子代理在跑，某个页面就会挂上别的对话的模型与额度
（典型现象：模型选了 DeepSeek，底部却显示 `openai-codex` 的额度窗口）。

本插件配合宿主补丁 `patches/patch-pi-web-ui-plugin-per-client-conversation.js` 修正：

- 服务端在每个页面接入（`onAttach` / `onMessage` 的 `from`）时记住 `clientId`，刷新时用
  `host.getActiveConversation(clientId)` 取**该页面打开的对话**，各算一份并用
  `host.sendTo(clientId, { state, perClient: true })` 定向下发；汇率与 Codex 额度这类
  账号级数据每轮只查一次；
- 客户端只在「本页面那份」与「宿主槽位那份」**不一致**时才接管底部状态栏
  （自己注入 + 藏掉宿主那一项），一致时继续用官方槽位；
- 客户端每 45s 发一次心跳，服务端超过 180s 没听到的页面按幽灵清掉（宿主没有 detach 回调），
  避免掉线的临时页面一直占着官方槽位那一份状态；
- **对齐防线**：宿主重启后每个浏览器的活动对话会被重置成「本项目最近一条会话」，不一定是
  你眼前那个（典型表现：重启后额度变 0）。客户端因此拿页面原生「消息 N」校验每份状态是否
  属于本页面：对不上就不采用，保留上一次对齐值、显示 `⚡ 同步中…` 并自动请求重算；
- 面板上用 `data-cu-*` 暴露快照会话、消息数、provider 与对齐标记，供
  `scripts/check-codex-usage.js` 断言「插件快照会话 == 本页面会话」且「状态已对齐」。
