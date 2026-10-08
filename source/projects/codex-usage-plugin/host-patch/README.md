# host-patch —— 让额度插件支持多标签页 / 并行对话 / 子代理

这个目录里是**宿主补丁**：给 pi-web-ui 的插件快照加上「按浏览器客户端（clientId）取对话」的能力。
额度插件靠它在多标签页、并行对话、子代理同时存在时，仍然只显示**本页面**正在看的那个对话的额度与成本。

## 要打吗？

| 你的用法 | 要不要打 |
| --- | --- |
| 只开一个标签页、不开子代理 | **不用**。插件开着原生「消息数」校验，单页面场景本来就是对的 |
| 同时开多个标签页看不同对话，或跑子代理 | **建议打**。不打也能用，但那些页面会显示 `⚡ 同步中…`（宁可不同步，也不会把别的对话的钱算到你头上） |

## 怎么打

```bash
node <插件目录>/host-patch/apply.cjs            # 应用（幂等，已打过会跳过）
node <插件目录>/host-patch/apply.cjs --dry-run  # 只预览会改哪些文件
```

`<插件目录>` 一般是 `~/.pi-web/plugins/codex-usage`（Windows：`%USERPROFILE%\.pi-web\plugins\codex-usage`）。
打完**重启网页服务**（或设置里点「重启网页服务」）生效。

退出码：`0` 成功 / 已存在；`1` 找不到 pi-web-ui；`2` 锚点失配（版本不兼容，不会乱改）；`3` 改完语法校验失败。
找不到安装目录时可显式指定：`PI_WEB_UI_DIR=<pi-web-ui 包目录> node ...`。

## 为什么必须打补丁才能 100% 正确

截至 pi-web-ui **0.99.0**，官方插件 API 无法让插件知道「本页面在看哪个会话」：

- `host.getActiveConversation()` 不接收 `clientId`，只返回**全局最近活跃**的那个对话；
- `host.conversations.list()` 的运行中会话只给 `{id, title, cwd, kind, isStreaming}`，**不给 `sessionFile`**；
- `onStats`（按会话扇出统计）已在 0.98.0 的清理中**被上游删除**；
- `host.conversations.get(id)` 只在 id 恰好等于当前活跃会话时才返回快照。

所以插件只能知道「全局最近活跃对话」，而无法知道「这个页面看的对话」。接口缺口已作为提案提交上游（见仓库 `upstream/` 目录）。

## 它改了什么（6 处，全部在 pi-web-ui 的编译产物里）

| 文件 | 改动 |
| --- | --- |
| `dist/server/agent-service.js` | `ClientSession.readConversationForPlugins(conversationId?)` 可指定对话；快照补 `isSubagent`；聚合层 `readConversationForPlugins(clientId?)` 按客户端取该页面打开的对话，全局兜底跳过子代理 |
| `dist/server/plugins.js` | `PluginManager.getActiveConversation(clientId)` 与插件 `host.getActiveConversation(clientId)` 透传 clientId |
| `dist/server/index.js` | `conversationProvider(clientId)` 透传 |

## 注意

- 这是**产物补丁**：改的是 `dist/*.js`，所以**升级 pi-web-ui 后要重跑一次**；锚点失配会以退出码 2 拒绝执行（不会把文件改坏）。
- 脚本先做整文件锚点唯一性检查，写盘后立刻 `node --check` 语法校验。
- 不想用补丁、又能接受「多标签时显示同步中」的话，什么都不用做。
