#!/usr/bin/env node
// 每天 0 点抓取 USD→CNY 真实汇率，更新 pi-web-ui 前端的人民币汇率配置
// 数据源：open.er-api.com（免费、无需 key）
// 用法：node update-cny-rate.js
// 由 Windows 任务计划程序每天 00:00 调用，日志重定向到同目录 update-cny-rate.log
const fs = require('fs');
const path = require('path');

const API = 'https://open.er-api.com/v6/latest/USD';
const htmlPath = path.join(process.env.APPDATA || '', 'npm', 'node_modules', 'pi-web-ui', 'web', 'dist', 'index.html');

const logPath = path.join(__dirname, 'update-cny-rate.log');
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(logPath, line + '\n', 'utf8'); } catch {}
}

async function main() {
  // 1. 抓汇率
  log('抓取汇率: ' + API);
  let resp;
  try {
    resp = await fetch(API, { signal: AbortSignal.timeout(15000) });
  } catch (e) {
    log('✗ 网络请求失败: ' + e.message);
    process.exit(1);
  }
  if (!resp.ok) {
    log('✗ HTTP 错误: ' + resp.status);
    process.exit(1);
  }
  const data = await resp.json();
  const cny = data?.rates?.CNY;
  if (typeof cny !== 'number' || cny <= 0) {
    log('✗ 未解析到有效 CNY 汇率');
    process.exit(1);
  }
  const rate = cny.toFixed(4); // 保留 4 位小数
  log('获取到汇率: 1 USD = ' + rate + ' CNY');

  // 2. 更新 index.html
  if (!fs.existsSync(htmlPath)) {
    log('✗ 未找到 ' + htmlPath);
    process.exit(1);
  }
  let html = fs.readFileSync(htmlPath, 'utf8');
  const re = /(window\.__PI_USD_TO_CNY__\s*=\s*)[0-9.]+/;
  if (!re.test(html)) {
    log('✗ index.html 里没有 window.__PI_USD_TO_CNY__ 配置（可能没打人民币补丁）');
    process.exit(1);
  }
  const old = html.match(re)[0];
  html = html.replace(re, '$1' + rate);
  fs.writeFileSync(htmlPath, html, 'utf8');
  log('✓ 已更新: ' + old + ' → window.__PI_USD_TO_CNY__ = ' + rate);
}

main().catch(e => {
  log('✗ 异常: ' + e.message);
  process.exit(1);
});
