# piwork-tools（PIwork 工作区工具）

pi-web-ui 界面插件：把「改完定制后要跑一次的一键同步」做成顶栏按钮，不再依赖记忆命令。

## 功能

| 入口 | 行为 |
|---|---|
| 顶栏 `⤴ 同步` | 跑一遍 `scripts/sync-pi-web-ui-setup.ps1`：重新打包安装包 → 提交并推送 `AIWork` 与 `pi-web-ui-setup` → 从 GitHub 匿名校验 SHA256 |
| 顶栏 `🛠 PIwork` 视图 | 显示最近一次同步的状态、退出码、最近 80 行输出，并可手动再触发 |

同步期间按钮禁用；同一时刻只允许一个作业（两个同步并发会互抢 zip 与 git 索引）。
成功/失败各给一条宿主通知，退出码 `2`（有文件与 GitHub 不一致，CDN 仍在缓存）会原样显示，稍后重跑即可。

## 为什么用插件而不是补丁

插件目录（`<dataDir>/plugins/<id>/`，默认 `~/.pi-web/plugins/`）与 pi-web-ui 包目录分离：
`npm i -g pi-web-ui` 升级不会动它，也不依赖 pi-web-ui 的内部源码字符串（补丁会随版本失效）。
顶栏条目走官方 slot 框架（`manifest.ui.topbar` + `window.__piWebUiHost.onUiAction`），
宿主负责渲染、排序、溢出菜单与用户偏好，插件不碰 DOM。

## 配置

仓库根按优先级解析：

1. 插件目录里的 `config.json` 的 `repoRoot`（安装器写入，推荐）；
2. 设置面板 → 界面插件 → PIwork 里的「PIwork 仓库根目录」；
3. 环境变量 `PIWORK_ROOT`。

三者都拿不到时，接口返回明确错误，视图里会显示试过哪些目录。

`config.json` 示例：

```json
{ "repoRoot": "C:\\AIWork\\PI\\PIwork" }
```

## 服务端接口

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/plugins-api/piwork-tools/state` | 作业状态：`running / startedAt / finishedAt / exitCode / error / lines / root` |
| `POST` | `/plugins-api/piwork-tools/sync` | 触发同步；已在跑时返回 `409 { ok:false, busy:true }` |

作业墙钟上限 20 分钟，超时终止并把原因写进输出。
