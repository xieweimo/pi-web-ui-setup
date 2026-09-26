# pi-web-ui 停止按钮历史补丁（已退役）

> 状态：**pi-web-ui 0.95.0 起已退役，不得加入新版本 profile。**

历史上，`apply-stop-button.ps1` 会在 `web/dist/index.html` 的 `</head>` 前注入一段 `.btn.stop` CSS，用硬编码的 `#dc2626` 和 `stopPulse` 动画强调生成中的停止按钮。

当前上游已经原生提供等价且更好的实现：

```css
.inputbox .btn.stop {
  background: var(--stop-red);
  border-color: var(--stop-red);
  animation: stop-pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite;
}
```

它支持主题变量、hover 状态和系统“减少动画”偏好。历史补丁的 `!important` 只会覆盖上游主题值，既不增加功能，也增加升级风险。

## 保留脚本的原因

`patches/apply-stop-button.ps1` 没有删除，以便极旧版本 profile 仍可按当时的方式恢复样式；但脚本会先检测 `stop-pulse` / `--stop-red`，一旦发现上游已有实现就输出提示并不改文件。

当前版本应只使用上游默认样式，不需要 `piwork-stop-style` 插件，也不需要 DOM 授权。
