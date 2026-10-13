'use strict';
// verify-ui-cd.js 前置（CDP 驱动 live 实例；端口 env CDP_PORT 默认 9222；目标选 dist/index.html 页，非 Splash）：
//  1 打开「演示 SQLite 库」连接：未连接时对 .node-title 合成 dblclick；已连接（.node-title.on）跳过——
//    对已连连接双击会触发断开；已连但折叠时点连接行 .ant-tree-switcher 展开
//  2 连接节点右键（合成 contextmenu）→ 菜单「新建查询」；.cm-content el.focus() + Ctrl+A + Input.insertText
//    灌入 7 条语句，点「运行」按钮（el.click），轮询消息面板出现 >= 7 行含 OK（DROP/CREATE + 5 INSERT；
//    成功词是 OK 不是 成功）
//  3 树上看到 dh_ui_cd_t（分类未展开点 switcher；已展开但子级陈旧则右键「刷新」）→ 对其 .node-title
//    合成 dblclick 打开数据页并成为激活页签；行数据 5 行：Beijing×2 且 Carol 的 id 最大（D2：筛选
//    city='Beijing' + id 降序后 names[0]==='Carol'、count===2），Shanghai/Shenzhen/Hangzhou 各 1（D5：清筛选后 5 行）
//  4 建 D:/DataHelm/.tmp-test 截图目录
//  纪律：全程合成事件（dispatchEvent / el.click / el.focus），不做 getBoundingClientRect 坐标点击；
//        等待一律轮询（树节点 15×500ms 档）。幂等：可重复执行（DROP IF EXISTS 重建、再开数据页）。
//  输出 PRECFG-OK。
const fs = require('fs');
const CDP = require('D:/DataHelm/node_modules/chrome-remote-interface');

const PORT = Number(process.env.CDP_PORT || 9222);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CONN_NAME = '演示 SQLite 库';
const TABLE = 'dh_ui_cd_t';
const SQL_TEXT =
  'DROP TABLE IF EXISTS dh_ui_cd_t;\n' +
  'CREATE TABLE dh_ui_cd_t(id INTEGER PRIMARY KEY, name TEXT NOT NULL, city TEXT NOT NULL);\n' +
  "INSERT INTO dh_ui_cd_t VALUES (1, 'Alice', 'Shanghai');\n" +
  "INSERT INTO dh_ui_cd_t VALUES (2, 'Bob', 'Shenzhen');\n" +
  "INSERT INTO dh_ui_cd_t VALUES (3, 'Dave', 'Beijing');\n" +
  "INSERT INTO dh_ui_cd_t VALUES (4, 'Eve', 'Hangzhou');\n" +
  "INSERT INTO dh_ui_cd_t VALUES (5, 'Carol', 'Beijing');";

(async () => {
  const targets = await CDP.List({ port: PORT });
  const main = targets.find((t) => t.type === 'page' && String(t.url || '').indexOf('dist/index.html') >= 0);
  if (!main) throw new Error('no dist/index.html target on port ' + PORT);
  const client = await CDP({ port: PORT, target: main });
  const { Runtime, Input } = client;
  await Runtime.enable();
  const ev = async (expr) => {
    const r = await Runtime.evaluate({ expression: expr, returnByValue: true });
    if (r.exceptionDetails) return null;
    return r.result.value;
  };
  const j = (v) => JSON.stringify(v);

  // ---- 页面内合成事件原语（零 getBoundingClientRect） ----
  const hasNode = (title) =>
    ev("!![...document.querySelectorAll('.tree-wrap .node-title')].find((x) => x.textContent.trim() === " + j(title) + ")");
  const connOpen = () =>
    ev("!![...document.querySelectorAll('.tree-wrap .node-title.on')].find((x) => x.textContent.trim() === " + j(CONN_NAME) + ")");
  const nodeAct = (title, type) =>
    ev("(() => { const el = [...document.querySelectorAll('.tree-wrap .node-title')].find((x) => x.textContent.trim() === " + j(title) + "); if (!el) return false; el.dispatchEvent(new MouseEvent('" + type + "', { bubbles: true, cancelable: true, view: window, clientX: 12, clientY: 12 })); return true; })()");
  const clickSwitcher = (title) =>
    ev("(() => { const row = [...document.querySelectorAll('.tree-wrap .ant-tree-treenode')].find((r) => { const t = r.querySelector('.node-title'); return t && t.textContent.trim() === " + j(title) + "; }); const s = row && row.querySelector('.ant-tree-switcher'); if (!s) return false; s.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); s.click(); return true; })()");
  const catOpen = (title) =>
    ev("(() => { const row = [...document.querySelectorAll('.tree-wrap .ant-tree-treenode')].find((r) => { const t = r.querySelector('.node-title'); return t && t.textContent.trim() === " + j(title) + "; }); return !!(row && row.querySelector('.ant-tree-switcher.ant-tree-switcher_open')); })()");
  const clickMenuItem = async (kw, tries) => {
    for (let i = 0; i < (tries || 12); i += 1) {
      const ok = await ev("(() => { const it = [...document.querySelectorAll('.ctx-menu .ant-menu-item')].find((x) => x.textContent.replace(/\\s+/g, '').indexOf(" + j(kw) + ") >= 0); if (!it) return false; it.click(); return true; })()");
      if (ok) return true;
      await sleep(350);
    }
    return false;
  };
  const focusEditor = () =>
    ev("(() => { const el = document.querySelector('.ant-tabs-tabpane-active .query-editor-wrap .cm-content'); if (!el) return false; el.focus(); return true; })()");
  const clickRun = () =>
    ev("(() => { const b = [...document.querySelectorAll('.ant-tabs-tabpane-active button')].find((x) => x.textContent.replace(/\\s+/g, '') === '运行Ctrl+Enter'); if (!b) return false; b.click(); return true; })()");
  const okLines = () =>
    ev("(() => { const ps = document.querySelectorAll('.ant-tabs-tabpane-active .msg-pane .msg'); let n = 0; ps.forEach((p) => { if (p.textContent.indexOf('OK') >= 0) n += 1; }); return n; })()");
  const gridRows = () =>
    ev("(() => { const ps = [...document.querySelectorAll('.ant-tabs-tabpane-active')].filter((p) => p.querySelector('.grid-area')); return ps.length ? ps[0].querySelectorAll('.grid-area .ant-table-row').length : 0; })()");

  // ---- 1 树就绪 + 打开连接（幂等） ----
  for (let i = 0; i < 30 && !(await hasNode(CONN_NAME)); i += 1) await sleep(500);
  if (!(await hasNode(CONN_NAME))) throw new Error('conn node not found: ' + CONN_NAME);
  if (!(await connOpen())) {
    if (!(await nodeAct(CONN_NAME, 'dblclick'))) throw new Error('dblclick conn failed');
    for (let i = 0; i < 15 && !(await hasNode('表')); i += 1) await sleep(500);
  }
  if (!(await hasNode('表'))) {
    if (!(await clickSwitcher(CONN_NAME))) throw new Error('expand conn failed');
    for (let i = 0; i < 15 && !(await hasNode('表')); i += 1) await sleep(500);
  }
  if (!(await hasNode('表'))) throw new Error('表 分类节点未出现');

  // ---- 2 新建查询 → 灌 SQL → 运行 → 等 >= 7 行 OK ----
  await nodeAct(CONN_NAME, 'contextmenu');
  if (!(await clickMenuItem('新建查询'))) throw new Error('菜单 新建查询 未点击');
  for (let i = 0; i < 20 && !(await focusEditor()); i += 1) await sleep(500);
  if (!(await focusEditor())) throw new Error('查询编辑器未出现');
  await sleep(400);
  await Input.dispatchKeyEvent({ type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
  await Input.dispatchKeyEvent({ type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
  await sleep(150);
  await Input.insertText({ text: SQL_TEXT });
  await sleep(400);
  if (!(await clickRun())) throw new Error('运行 按钮未点击');
  let oks = 0;
  for (let i = 0; i < 30; i += 1) {
    oks = (await okLines()) || 0;
    if (oks >= 7) break;
    await sleep(500);
  }
  if (oks < 7) throw new Error('OK 消息行数 = ' + oks + '（期望 >= 7）');

  // ---- 3 树上出现 dh_ui_cd_t → 双击开数据页（成为激活页签，套件直接操作 .grid-area） ----
  if (!(await hasNode(TABLE))) {
    if (!(await catOpen('表'))) {
      if (!(await clickSwitcher('表'))) throw new Error('展开 表 分类失败');
      for (let i = 0; i < 15 && !(await hasNode(TABLE)); i += 1) await sleep(500);
    }
    if (!(await hasNode(TABLE))) {
      // 已展开但子级陈旧：右键刷新（round12 同款路径）
      await nodeAct('表', 'contextmenu');
      if (!(await clickMenuItem('刷新'))) throw new Error('菜单 刷新 未点击');
      for (let i = 0; i < 15 && !(await hasNode(TABLE)); i += 1) await sleep(500);
    }
  }
  if (!(await hasNode(TABLE))) throw new Error('树节点未出现: ' + TABLE);
  if (!(await nodeAct(TABLE, 'dblclick'))) throw new Error('dblclick 表节点失败');
  let rows = 0;
  for (let i = 0; i < 30; i += 1) {
    rows = (await gridRows()) || 0;
    if (rows === 5) break;
    await sleep(500);
  }
  if (rows !== 5) throw new Error('数据页行数 = ' + rows + '（期望 5）');

  // ---- 4 截图目录 ----
  fs.mkdirSync('D:/DataHelm/.tmp-test', { recursive: true });

  console.log('PRECFG-OK');
  try { await client.close(); } catch (e) { /* 已退则忽略 */ }
  process.exit(0);
})().catch((e) => { console.error('FX-ERR', e && e.message); process.exit(1); });
