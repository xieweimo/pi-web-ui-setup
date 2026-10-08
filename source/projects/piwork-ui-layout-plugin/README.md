# PIwork 界面布局插件

把原 `patch-pi-web-ui-topbar-menu-buttons.js` 的“常用宿主条目显示在顶栏”偏好迁为官方 `manifest.ui.arrange`。

## 做什么

声明式显示并排序以下宿主条目：

- 浏览器操作
- 声音/通知
- 语言
- 主题
- 版本/更新
- GitHub

插件没有 `index.mjs`、`client/`、轮询或 DOM 操作；宿主负责渲染、响应式溢出、设置页布局以及用户覆盖。

## 用户控制与窄屏行为

`ui.arrange` 的优先级低于用户在“设置 → 界面布局”里的选择：用户可隐藏、移动或恢复任一条目；禁用插件会恢复宿主默认布局。

旧补丁还修改了宿主内部的 `pinned` 集合。该集合没有公开扩展点，因此本插件**不**复刻该内部实现。窄屏时条目仍会按宿主标准策略进入“⋯”菜单，但功能、下拉交互和可恢复性完整保留。这是使用稳定公开接口替代私有实现的刻意取舍。

## 安装与验证

```bash
node projects/piwork-ui-layout-plugin/tests/manifest.test.mjs
node scripts/install-plugins.js --only piwork-ui-layout
```

安装后刷新页面或执行插件热重载；在“设置 → 界面布局”确认这些条目显示 `arrangedBy: piwork-ui-layout`。在旧 bundle 补丁仍激活的过渡期，二者视觉结果相同；只有移除 `topbar-menu-buttons` 后才由本插件单独承担该布局。

## 卸载/回滚

在“设置 → 界面插件”禁用或卸载 `piwork-ui-layout` 即恢复宿主默认布局，不需要写回 `web/dist`。在迁移验收完成前，旧补丁仅保留为 profile 中的回滚路径，不再新增功能。
