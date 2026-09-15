const fs = require('fs');
const path = require('path');
const { locateWebUiFile } = require('../scripts/pi-web-ui-locate.js');
const file = locateWebUiFile('web', 'dist', 'index.html');
const marker = 'pi-recovery-ui';
if (!file || !fs.existsSync(file)) { console.error('未找到 pi-web-ui 的 web/dist/index.html'); process.exit(1); }
let html = fs.readFileSync(file, 'utf8');
if (html.includes(marker)) { console.log('recovery UI patch already exists'); process.exit(0); }
const inject = `<style id="${marker}">#pi-recovery{position:fixed;right:16px;bottom:16px;z-index:9999;display:none;gap:8px;align-items:center;padding:10px 12px;border:1px solid #ef4444;border-radius:10px;background:#241417;color:#fff;box-shadow:0 8px 30px #0008;font:12px system-ui}#pi-recovery.show{display:flex}#pi-recovery button{border:1px solid #f87171;border-radius:6px;background:#dc2626;color:#fff;padding:5px 9px;cursor:pointer}#pi-recovery button:hover{background:#ef4444}</style><script id="${marker}">(()=>{const box=document.createElement('div');box.id='pi-recovery';box.innerHTML='<span>连接已断开</span><button data-a="reconnect">重新连接</button><button data-a="restart">重启网页服务</button>';document.addEventListener('DOMContentLoaded',()=>document.body.append(box));box.onclick=async e=>{const a=e.target.dataset.a;if(a==='reconnect')location.reload();if(a==='restart'){e.target.textContent='正在重启…';e.target.disabled=true;try{await fetch('http://127.0.0.1:8788/restart',{method:'POST'});setTimeout(()=>location.reload(),2500)}catch{e.target.textContent='守护进程未启动';e.target.disabled=false}}};new MutationObserver(()=>{const err=document.querySelector('.conn-dot.err');box.classList.toggle('show',!!err)}).observe(document.documentElement,{childList:true,subtree:true,attributes:true,attributeFilter:['class']})})()</script>`;
html = html.replace('</head>', inject + '</head>');
fs.writeFileSync(file, html, 'utf8');
console.log('recovery UI patch applied');
