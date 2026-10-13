'use strict';
// 开发模式：进程内启动 vite dev server（vite JS API），
// 就绪后加载 electron 包自带 cli 启动应用（其内部自行管理子进程）。
const path = require('path');
const root = path.join(__dirname, '..');

(async () => {
  const { createServer } = require('vite');
  const server = await createServer({
    root,
    server: { port: 5175, strictPort: true },
  });
  await server.listen();
  const url = (server.resolvedUrls && server.resolvedUrls.local && server.resolvedUrls.local[0]) || 'http://localhost:5175/';
  console.log('[dev] vite 就绪:', url);
  process.env.ELECTRON_START_URL = url;
  process.argv = [process.argv[0], require.resolve('electron/cli'), '.'];
  require('electron/cli'); // 应用窗口关闭时 cli 会结束本进程（连同 vite）
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
