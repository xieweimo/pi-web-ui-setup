# pi-web-ui 停止按钮增强补丁

来源：对 `C:\Users\X\AppData\Roaming\npm\node_modules\pi-web-ui\web\dist\index.html` 的定制。

## 注入位置

在 `</head>` 之前插入下面的 `<style>` 块（原 `dist/index.html` 中紧接在
`<link rel="stylesheet" crossorigin href="/assets/index-*.css">` 之后）。

## 补丁内容

```html
<style>
	/* 停止按钮增强：醒目红色 + 脉冲提示 */
	.btn.stop{background:#dc2626 !important;border-color:#dc2626 !important;color:#fff !important;box-shadow:0 0 0 0 rgba(220,38,38,.7) !important;animation:stopPulse 1.3s ease-in-out infinite}
	.btn.stop:hover:not(:disabled){background:#ef4444 !important;border-color:#ef4444 !important}
	@keyframes stopPulse{0%{box-shadow:0 0 0 0 rgba(220,38,38,.55)}70%{box-shadow:0 0 0 12px rgba(220,38,38,0)}100%{box-shadow:0 0 0 0 rgba(220,38,38,0)}}
</style>
```

## 注意

- 这是对 npm 包构建产物（`dist/index.html`）的直接修改，**升级 pi-web-ui 会被覆盖**，需要重新应用。
- 若要把该定制固化，理想做法是向 pi-web-ui 上游提 PR 或改用正式的主题/扩展机制，而不是直接改 dist。
