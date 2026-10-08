# 🌐 代理健康（proxy-health）

检测可配置的 HTTPS 目标是否可达，并根据第二个对照目标提供**谨慎的**故障提示。它不能直接判断 pi-web-ui 或模型是否出错，也不能仅凭探测结果断定某个代理节点损坏。状态栏正常时显示 🌐，异常时显示提示；仅在状态变化时通知。

## 适用范围和判断

默认目标为 `https://chatgpt.com/backend-api/wham/usage`（无认证 GET，401 也表示 HTTPS 链路可达），对照目标为 `https://www.google.com/generate_204`。两者都能在设置里更改：使用其他模型服务的用户应设为自己需要的 HTTPS 目标；探测**不附带 OAuth/API key**，不会产生模型 token 消耗。

- 配置 HTTP(S) 代理时：经 CONNECT/TLS 探测目标；目标失败达到阈值后，才探对照站点。对照站点可达只能说明目标或路由有问题，**不等于确定代理节点故障**；两站都失败也可能是当地网络、DNS、代理服务或两站各自故障。
- 未配置代理时：直接探目标；直连成功视为正常，失败提示「直连不可用」，不假设用户所在地需要代理。
- 收到任意 HTTP 状态码表示**网络链路可达**，不表示登录有效或上游服务业务正常（包括 401/403/5xx）。这不是模型服务健康检查。
- 支持 `http://`、`https://` 代理与可选 Basic 认证；SOCKS URL 不支持，可换用代理软件提供的 HTTP 混合端口。凭据不写日志、不放在前端状态中。

## 设置

| 键 | 默认 | 说明 |
|---|---|---|
| `targetUrl` | `https://chatgpt.com/backend-api/wham/usage` | 不带凭据的 HTTPS 探测目标 |
| `controlUrl` | `https://www.google.com/generate_204` | 达到失败阈值才访问 |
| `proxy` | 空 | 优先插件配置，其次 `~/.pi/agent/settings.json` 的 `httpProxy`，再到 `HTTPS_PROXY` / `HTTP_PROXY` 环境变量；均无则直连 |
| `intervalSec` | 30 | 探测间隔（10–600 秒） |
| `timeoutMs` | 8000 | 单段连接或响应超时（1000–30000 毫秒） |
| `failThreshold` | 2 | 连续失败阈值（1–5 次） |
| `notifyOnChange` | true | 状态切换时发通知 |
| `showBadge` | true | 显示底栏徽标 |

`http` 权限用于只读状态路由和主动探测；`ui` 权限用于底栏徽标。插件不读会话、不发模型请求、不修改工作区文件。状态路由 `/state` 只显示代理主机和端口（不包含用户信息和密码）。

## 验证

```bash
node plugins/proxy-health/tests/unit.test.mjs      # 确定性模拟，不依赖外网
node plugins/proxy-health/tests/manual-test.mjs    # 可选真实网络冒烟，需可用代理
pi-web-ui install xieweimo/pi-web-ui-contrib/plugins/proxy-health --data-dir <隔离目录>
```

真实网络结果受本机节点和目标站点影响；上架门槛以确定性测试和公开源安装为基础，真实页面只验证安装、渲染和实际状态，不以固定等待秒数判定网络健康。
