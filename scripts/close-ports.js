'use strict';
// 关闭指定 CDP 端口上的测试实例（Browser.close 优雅退出）
const CDP = require('chrome-remote-interface');
(async () => {
  for (const port of [9225, 9226, 9227]) {
    try {
      const c = await CDP({ port });
      await c.Browser.close();
      await c.close();
      console.log('closed', port);
    } catch (e) {
      console.log('port', port, 'not reachable:', e.message.slice(0, 40));
    }
  }
})();
