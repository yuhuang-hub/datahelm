'use strict';
const { app, BrowserWindow, ipcMain, dialog, clipboard, shell } = require('electron');
const path = require('path');
const fs = require('fs');
// 测试钩子：用独立 userData 启动（避免与用户正在使用的实例互相干扰）
if (process.env.DH_USER_DATA) app.setPath('userData', process.env.DH_USER_DATA);
// 覆盖式滚动条：悬浮在内容上不占布局空间（否则水平滚动条会遮住树最后一行，右键/点击落空）
app.commandLine.appendSwitch('enable-features', 'OverlayScrollbar');
// 禁用原生窗口遮挡计算：锁屏/最小化时 Windows 会把窗口标记为 occluded → 合成器停发帧 →
// rAF 停摆 → antd(rc-motion) 浮层收场动画永久卡在起始相位（pointer-events:none 幽灵层吞点击）。
// 数据库工具在后台也应保持 UI 状态机健康
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
const store = require('./services/connections');
const db = require('./services/db');
const queries = require('./services/queries');
const models = require('./services/models');
const backup = require('./services/backup');

// 调试日志：渲染层 DH-* 输出落盘（userData/ui-debug.log），用于排查“点了没反应”类问题
const dbgPath = path.join(app.getPath('userData'), 'ui-debug.log');
const dbg = (line) => { try { fs.appendFileSync(dbgPath, `${new Date().toISOString()} ${line}\n`); } catch {} };

const APP_VER = 'v0927.52';
// DH_QUIET=1：自动化电池专用——Splash 不置顶、主窗 showInactive 不抢焦点，
// 长时间回归期间用户可正常操作其他软件（渲染管线不受影响：遮挡计算已全局禁用 + 主窗关节流）
const QUIET_UI = process.env.DH_QUIET === '1';
// 启动动画（Splash）：主窗口加载期间显示品牌小窗（电子绕核运动）。
// 主窗口【就绪后才显示】：等渲染层上报 dh-ui-ready（连接列表已加载）+ 最短展示时间
// 二者都满足才 show 主窗并触发图标“扩散铺满”过渡——避免先露出空窗/白屏再等连接出现。
// 动画展示 1~2 秒（1500ms）；加载耗时与动画时长取 max 而非相加——后续新增模块的
// 加载耗时会自然吸收动画时长（总等待=加载耗时，动画时间已从中扣去）。
// DH_SPLASH_MS 可拉长展示便于截图/调试。
const SPLASH_MIN_MS = Number(process.env.DH_SPLASH_MS) > 0 ? Number(process.env.DH_SPLASH_MS) : 1500;
let splashWin = null;
let splashShownAt = 0;
let mainWin = null;
let mainWinDestroyed = false;
const bootAt = Date.now();
let uiReadyAt = 0;
let mainRevealed = false;

function createSplash() {
  // 整工作区大小的透明窗口做舞台（透明窗口内容会被窗口边界裁剪，
  // 卡片扩散动画必须发生在与主窗等大的窗口内才不会被切掉）
  const { screen } = require('electron');
  const wa = screen.getPrimaryDisplay().workArea;
  splashWin = new BrowserWindow({
    x: wa.x,
    y: wa.y,
    width: wa.width,
    height: wa.height,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    show: false,
    skipTaskbar: true,
    alwaysOnTop: !QUIET_UI,
    focusable: false,
    hasShadow: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  splashWin.loadFile(path.join(__dirname, 'splash.html'), { query: { v: APP_VER } });
  splashWin.once('ready-to-show', () => {
    try {
      // QUIET：showInactive 不激活窗口（透明全屏舞台若置顶会盖住用户正在用的其他软件）
      if (QUIET_UI) splashWin.showInactive();
      else splashWin.show();
      splashShownAt = Date.now();
      dbg(`DH-SPLASH shown ${APP_VER}`);
    } catch {}
  });
  return splashWin;
}

let splashClosed = false;
function closeSplash() {
  const w = splashWin;
  if (splashClosed || !w || w.isDestroyed()) return;
  splashClosed = true; // 防重入：手动触发的关闭动画与 reveal 触发的关闭只走一次
  const rest = SPLASH_MIN_MS - (splashShownAt ? Date.now() - splashShownAt : SPLASH_MIN_MS);
  setTimeout(() => {
    try {
      // 触发“扩散成窗体”动画（0.5s 扩散），随后销毁
      w.webContents.executeJavaScript('window.dhSplashClose && window.dhSplashClose()', true).catch(() => {});
      setTimeout(() => {
        try {
          if (!w.isDestroyed()) w.destroy();
          dbg('DH-SPLASH closed');
        } catch {}
      }, 700);
    } catch {}
  }, Math.max(0, rest));
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 680,
    show: false,
    backgroundColor: '#f7f8fa',
    icon: path.join(__dirname, 'icons', 'icon.png'),
    title: 'DataHelm',
    // 关后台节流：窗口被遮挡/会话锁屏时 Chromium 会停发 rAF，antd(rc-motion) 浮层收场动画
    // 卡死成 pointer-events:none 幽灵层（下拉/弹层点不进、选区层不绘制）。数据库工具后台也应保持响应
    backgroundThrottling: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  mainWin = win;
  mainWinDestroyed = false;
  mainRevealed = false; // macOS activate 重建窗口时重新走 reveal 时序
  // 调试日志：渲染层 DH-* 输出落盘（userData/ui-debug.log），用于排查“点了没反应”类问题
  dbg(`APP-START electron=${process.versions.electron} node=${process.versions.node} ${APP_VER}`);
  win.webContents.on('console-message', (_e, _lvl, message) => {
    if (typeof message === 'string' && message.startsWith('DH-')) dbg(message);
  });
  win.webContents.on('render-process-gone', (_e, details) => {
    dbg(`RENDER-GONE ${details.reason}`);
    // 渲染层已崩，不会再来 dh-ui-ready：强制放行显示，让用户看到错误状态而不是黑屏
    if (!uiReadyAt) { uiReadyAt = Date.now(); tryReveal(); }
    closeSplash();
  });
  // 禁用 DevTools 快捷键（v0927.52）：Ctrl+Shift+I / F12 不再打开开发者工具（防误触+产品化）。
  // CDP 自动化（--remote-debugging-port）不受影响——那是独立调试通道，不经输入管线
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    const k = String(input.key || '').toLowerCase();
    if ((input.control && input.shift && k === 'i') || k === 'f12') e.preventDefault();
  });
  win.setMenuBarVisibility(false);
  // 关窗协商：默认拦截 close，让渲染层检查未保存修改（无脏 → 直接放行；有脏 → 弹确认，
  // 用户确认“放弃并退出”后才 destroy 放行）。测试钩子 sys:requestClose 走同一条链路。
  win.on('close', (e) => {
    if (mainWinDestroyed) return;
    e.preventDefault();
    try { win.webContents.send('dh-close-request'); } catch {}
  });
  if (process.env.ELECTRON_START_URL) win.loadURL(process.env.ELECTRON_START_URL);
  else win.loadFile(path.join(__dirname, '../dist/index.html'));
}

// 主窗口显示时序：ui-ready（渲染层连接已加载）+ Splash 最短展示时间都满足才 reveal。
// reveal 即：show 主窗（DH_TEST 下显示为屏幕右缘 40px 细条）+ 触发 Splash 图标扩散关闭。
function tryReveal() {
  if (mainRevealed || mainWinDestroyed || !mainWin || mainWin.isDestroyed()) return;
  const base = splashShownAt || bootAt;
  const rest = SPLASH_MIN_MS - (Date.now() - base);
  if (rest > 0) { setTimeout(tryReveal, rest + 30); return; }
  if (!uiReadyAt) return; // 还没收到渲染层就绪信号（兜底超时会强制放行）
  mainRevealed = true;
  try {
    if (process.env.DH_TEST) {
      // 自动化验证：窗口显示为屏幕右缘 40px 细条（跳过任务栏）。
      // 完全不 show 或完全移出屏幕都会让合成器停绘，rc-motion 动画冻结在
      // appear/leave 中间态（下拉坐标塌缩/僵尸、模态残留全屏遮罩）。
      // 屏上有可见像素即可保证渲染管线活跃，动画正常完成。
      mainWin.showInactive();
      mainWin.setSkipTaskbar(true);
      try {
        const { screen } = require('electron');
        const d = screen.getPrimaryDisplay();
        mainWin.setBounds({ x: d.workArea.x + d.workArea.width - 40, y: d.workArea.y, width: 1440, height: 900 });
      } catch {}
    } else if (QUIET_UI) {
      // 电池/自动化：完整窗口但不激活（不抢走用户当前焦点）
      mainWin.showInactive();
    } else {
      mainWin.show();
    }
    dbg('DH-MAIN shown');
  } catch {}
  closeSplash();
}

// 渲染层就绪信号：连接列表已加载、DOM 已提交（App.jsx 初始加载完成后上报）
ipcMain.on('dh-ui-ready', () => {
  if (!uiReadyAt) uiReadyAt = Date.now();
  tryReveal();
});
// 兜底：渲染层始终没上报（异常/慢加载）也不能永远不显示窗口
setTimeout(() => {
  if (!mainRevealed && !uiReadyAt) {
    dbg('DH-MAIN forced');
    uiReadyAt = Date.now();
    tryReveal();
  }
}, SPLASH_MIN_MS + 6000);

// 渲染层确认退出（无未保存修改，或用户点了“放弃并退出”）：destroy 绕过 close 拦截
ipcMain.on('dh-close-confirm', () => {
  try {
    if (mainWin && !mainWin.isDestroyed()) {
      mainWinDestroyed = true;
      mainWin.destroy();
    }
  } catch {}
});
// 测试钩子：模拟点击窗口关闭按钮，走同一条 dh-close-request 协商链路
ipcMain.handle('sys:requestClose', () => {
  try { if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('dh-close-request'); } catch {}
  return true;
});

app.whenReady().then(() => {
  createSplash();
  createWindow();
  backup.startScheduler();
});
app.on('window-all-closed', () => {
  try { if (splashWin && !splashWin.isDestroyed()) splashWin.destroy(); } catch {}
  if (process.platform !== 'darwin') app.quit();
});
app.on('will-quit', () => {
  try { db.closeTransfers(); } catch {}
  try { db.closeSyncSessions(); } catch {}
});
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// ---- 连接管理 ----
ipcMain.handle('conn:list', () => store.list());
ipcMain.handle('conn:save', (_e, c) => store.save(c));
ipcMain.handle('conn:delete', (_e, id) => {
  db.close(id);
  store.remove(id);
});
ipcMain.handle('conn:test', (_e, cfg) => db.test(cfg));

// ---- 数据库会话 ----
ipcMain.handle('db:open', (_e, id) => db.open(id));
ipcMain.handle('db:close', (_e, id) => db.close(id));
ipcMain.handle('db:call', async (_e, payload) => {
  try {
    return { ok: true, data: await db.call(payload) };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});
ipcMain.handle('db:transfer', async (_e, payload) => {
  try {
    return { ok: true, data: await db.transfer(payload) };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});
// 比较进度回推：服务层逐表回调 → e.sender.send 推给渲染层进度条；
// reqId 随请求往返（渲染层每次比较生成），并发的两个比较互不串台
ipcMain.handle('db:syncCompare', async (e, payload) => {
  try {
    const reqId = (payload && payload.reqId) || '';
    const onProg = (p) => { try { e.sender.send('db:syncProgress', Object.assign({}, p, { kind: 'struct', reqId })); } catch {} };
    return { ok: true, data: await db.syncCompare(payload, onProg) };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});
ipcMain.handle('db:dataCompare', async (e, payload) => {
  try {
    const reqId = (payload && payload.reqId) || '';
    const onProg = (p) => { try { e.sender.send('db:syncProgress', Object.assign({}, p, { kind: 'data', reqId })); } catch {} };
    return { ok: true, data: await db.dataCompare(payload, onProg) };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});
ipcMain.handle('db:dataApply', async (_e, payload) => {
  try {
    return { ok: true, data: await db.dataApply(payload) };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

// ---- 系统 ----
ipcMain.handle('sys:pickFile', async (_e, opts) => {
  const r = await dialog.showOpenDialog({
    title: (opts && opts.title) || '选择文件',
    properties: ['openFile'],
    filters: opts && opts.filters,
  });
  return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
});
ipcMain.handle('sys:pickDir', async (_e, opts) => {
  const r = await dialog.showOpenDialog({
    title: (opts && opts.title) || '选择目录',
    properties: ['openDirectory', 'createDirectory'],
  });
  return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
});
ipcMain.handle('sys:copy', (_e, text) => {
  clipboard.writeText(String(text));
  return true;
});
ipcMain.handle('sys:openPath', (_e, p) => shell.openPath(String(p || '')));
// 保存文件：弹原生保存对话框并写盘（SQL 转储/导出用）
ipcMain.handle('sys:saveFile', async (_e, opts) => {
  const o = opts || {};
  const r = await dialog.showSaveDialog({
    title: o.title || '保存文件',
    defaultPath: o.defaultPath,
    filters: o.filters,
  });
  if (r.canceled || !r.filePath) return null;
  // base64 模式用于二进制内容（ER 图导出 PNG 等）；文本默认 utf8
  if (o.base64) fs.writeFileSync(r.filePath, Buffer.from(String(o.content || ''), 'base64'));
  else fs.writeFileSync(r.filePath, String(o.content == null ? '' : o.content), 'utf8');
  return r.filePath;
});

// ---- 导入向导：文件解析（CSV/JSON → 表头+全量行，渲染端做预览/映射） ----
ipcMain.handle('imp:parse', async (_e, payload) => {
  try {
    return { ok: true, data: require('./services/csv').parseImportFile(payload && payload.file) };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

// ---- 保存的查询 ----
ipcMain.handle('queries:list', () => queries.list());
ipcMain.handle('queries:save', (_e, q) => queries.save(q));
ipcMain.handle('queries:delete', (_e, id) => {
  try {
    queries.remove(id);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

// ---- 保存的 ER 模型 ----
ipcMain.handle('models:list', (_e, connId) => models.list(connId));
ipcMain.handle('models:save', (_e, m) => models.save(m));
ipcMain.handle('models:delete', (_e, id) => {
  try {
    models.remove(id);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

// ---- 备份计划 ----
ipcMain.handle('backup:list', () => backup.list());
ipcMain.handle('backup:save', (_e, sc) => backup.upsert(sc));
ipcMain.handle('backup:delete', (_e, id) => {
  try {
    backup.remove(id);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});
ipcMain.handle('backup:toggle', (_e, payload) => {
  backup.setEnabled(payload.id, payload.enabled);
  return true;
});
ipcMain.handle('backup:run', async (_e, id) => {
  try {
    return { ok: true, data: await backup.runNow(id) };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});
ipcMain.handle('backup:defaultDir', () => backup.defaultDir());
ipcMain.handle('backup:files', (_e, dir) => backup.files(dir));

// 查询解释（EXPLAIN 执行计划）：语句文本来自查询编辑器，主进程按方言包装后经 query 分发执行
ipcMain.handle('db:explain', async (_e, payload) => {
  try {
    return { ok: true, data: await db.explainQuery(payload || {}) };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

// 运行 SQL 文件（还原备份）：本层负责文件 IO 边界（仅 .sql、64MB 上限、去 BOM），
// 语句文本交由 db.runSqlFile 经 query 分发逐句原样执行（无拼接）
ipcMain.handle('db:runSqlFile', async (_e, payload) => {
  try {
    const p = payload || {};
    if (typeof p.file !== 'string' || !/\.sql$/i.test(p.file)) throw new Error('仅支持 .sql 文件');
    const st = fs.statSync(p.file);
    if (!st.isFile()) throw new Error('不是文件: ' + p.file);
    if (st.size > 64 * 1024 * 1024) throw new Error(`文件过大（${(st.size / 1048576).toFixed(1)}MB，上限 64MB）`);
    const text = fs.readFileSync(p.file, 'utf8').replace(/^\uFEFF/, '');
    return { ok: true, data: await db.runSqlFile({ connId: p.connId, db: p.db, schema: p.schema, text, stopOnError: !!p.stopOnError }) };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});
