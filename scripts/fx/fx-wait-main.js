'use strict';
// 等待调试实例主页面就绪：轮询 /json/list 直到首个 dist/index.html 目标出现（Splash 关闭后
// 自然晋升首项），再 sleep 3s 放行套件。端口仅收 9222-9230（本机调试端口段，
// host 固定 127.0.0.1 回环——无外联）。
const http = require('http');

const port = Number(process.argv[2] || 0);
if (!(port >= 9222 && port <= 9230)) {
  console.error('WAIT-MAIN port must be 9222-9230, got: ' + port);
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const listOnce = () => new Promise((resolve) => {
  const req = http.get({ host: '127.0.0.1', port, path: '/json/list', timeout: 2500 }, (res) => {
    let body = '';
    res.on('data', (c) => { body += c; });
    res.on('end', () => {
      try { resolve(JSON.parse(body)); } catch { resolve(null); }
    });
  });
  req.on('error', () => resolve(null));
  req.on('timeout', () => { req.destroy(); resolve(null); });
});

(async () => {
  for (let i = 0; i < 60; i += 1) {
    const list = await listOnce();
    const main = Array.isArray(list) && list.find((t) => String(t.url || '').indexOf('dist/index.html') >= 0);
    if (main) {
      await sleep(3000);
      console.log('MAIN-READY port=' + port);
      process.exit(0);
    }
    await sleep(500);
  }
  console.error('WAIT-MAIN timeout port=' + port);
  process.exit(1);
})();
