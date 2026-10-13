'use strict';
// 通过 CDP Browser.close 干净关闭测试实例
const CDP = require('chrome-remote-interface');
(async () => {
  try {
    const client = await CDP({ port: Number(process.env.CDP_PORT || 9227) });
    const { Browser } = client;
    await Browser.close();
    console.log('closed');
  } catch (e) {
    console.log('already gone:', e.message.slice(0, 80));
  }
  process.exit(0);
})();
