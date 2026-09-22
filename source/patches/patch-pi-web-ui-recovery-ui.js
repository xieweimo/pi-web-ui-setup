const fs = require('fs');
const path = require('path');
const { locateWebUiFile } = require('../scripts/pi-web-ui-locate.js');
const file = locateWebUiFile('web', 'dist', 'index.html');
const marker = 'pi-recovery-ui';
/**
 * 断连浮层（重新连接 / 重启网页服务）。
 *
 * 版本敏感点：浮层靠「连接状态元素」判断是否断连。
 *   - 旧版（<=0.86.x）：`.conn-dot.err`
 *   - 0.90.0 起：状态栏连接项 `.status-conn.error` / `.status-dot.error`
 * 0.90.0 换掉旧选择器后，本补丁曾静默失效（浮层永远不显示），所以现在同时认多种。
 * 注入内容带版本标记：老版本注入块会被识别并替换，而不是被「已存在」跳过。
 */
const VER = 'v4';
/** 0.94.1 起该项目不再需要断连浮层：顶栏「🔄 重连」插件在断连时会直连 watchdog，
 *  浮层与它能力重叠。带 --remove 运行即从安装包里清掉已注入的那段（幂等）。 */
const REMOVE = process.argv.includes('--remove');
if (!file || !fs.existsSync(file)) { console.error('未找到 pi-web-ui 的 web/dist/index.html'); process.exit(1); }
let html = fs.readFileSync(file, 'utf8');
if (REMOVE) {
  const before = html;
  html = html.replace(new RegExp(`<style id="${marker}">[\\s\\S]*?</script>`), '');
  if (html === before) { console.log('✓ 未发现断连浮层注入（无需移除）'); process.exit(0); }
  fs.writeFileSync(file, html, 'utf8');
  console.log('✓ 已从 web/dist/index.html 移除断连浮层注入');
  process.exit(0);
}
// 已是当前版本：直接跳过（幂等）。
if (html.includes(`${marker}-${VER}`)) { console.log('recovery UI patch already exists'); process.exit(0); }
// 否则先移除旧注入块（含没有 v2 标记的历史版本），保证升级路径可用。
html = html.replace(new RegExp(`<style id="${marker}">[\\s\\S]*?</script>`), '');
const inject = `<style id="${marker}">#pi-recovery{position:fixed;right:16px;bottom:16px;z-index:9999;display:none;gap:8px;align-items:center;padding:10px 12px;border:1px solid #ef4444;border-radius:10px;background:#241417;color:#fff;box-shadow:0 8px 30px #0008;font:12px system-ui}#pi-recovery.show{display:flex}#pi-recovery button{border:1px solid #f87171;border-radius:6px;background:#dc2626;color:#fff;padding:5px 9px;cursor:pointer}#pi-recovery button:hover{background:#ef4444}</style><script id="${marker}">/* ${marker}-${VER} */ (()=>{const box=document.createElement('div');box.id='pi-recovery';box.innerHTML='<span>连接已断开</span><button data-a="reconnect">重新连接</button><button data-a="restart">重启网页服务</button>';document.addEventListener('DOMContentLoaded',()=>document.body.append(box));box.onclick=async e=>{const a=e.target.dataset.a;if(a==='reconnect')location.reload();if(a==='restart'){e.target.textContent='正在重启…';e.target.disabled=true;try{await fetch('http://127.0.0.1:8790/restart',{method:'POST'});const ready=async()=>{try{const s=await fetch('http://127.0.0.1:8790/state').then(r=>r.json());if(s.serviceHealthy)return location.reload()}catch{}setTimeout(ready,500)};setTimeout(ready,500)}catch{e.target.textContent='守护进程未启动';e.target.disabled=false}}};const down=()=>!!(document.querySelector('.status-dot.error')||document.querySelector('.status-conn.error')||document.querySelector('.conn-dot.err'));const sync=()=>box.classList.toggle('show',down());new MutationObserver(sync).observe(document.documentElement,{childList:true,subtree:true,attributes:true,attributeFilter:['class']});setInterval(sync,2000)})()</script>`;
html = html.replace('</head>', inject + '</head>');
fs.writeFileSync(file, html, 'utf8');
console.log('recovery UI patch applied');
