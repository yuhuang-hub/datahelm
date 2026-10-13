'use strict';
// 真实使用路径验证：右键菜单在鼠标移开后必须保留；切换/ESC/点击关闭；MSSQL 树行；数据格右键
const CDP = require('chrome-remote-interface');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const client = await CDP({ port: Number(process.env.CDP_PORT || 9225) });
  const { Input, Runtime, Log } = client;
  await Runtime.enable();
  await Log.enable();
  const errors = [];
  Log.entryAdded(({ entry }) => { if (entry.level === 'error') errors.push(entry.text.slice(0, 300)); });
  const ev = async (expr) => {
    const r = await Runtime.evaluate({ expression: expr, returnByValue: true });
    if (r.exceptionDetails) return { err: 'exception' };
    return r.result.value;
  };
  const pos = (title) => ev(`(() => {
    const rows = [...document.querySelectorAll('.tree-wrap .ant-tree-treenode')].filter((r) => r.querySelector('.node-title') && r.getBoundingClientRect().height > 0);
    const f = rows.find((r) => r.querySelector('.node-title').textContent === '${title}');
    if (!f) return null;
    const r = f.getBoundingClientRect();
    return { x: Math.round(r.x + Math.min(r.width - 8, 140)), y: Math.round(r.y + r.height / 2) };
  })()`);
  const press = async (x, y, btn, cnt) => {
    await Input.dispatchMouseEvent({ type: 'mousePressed', x, y, button: btn, clickCount: cnt });
    await Input.dispatchMouseEvent({ type: 'mouseReleased', x, y, button: btn, clickCount: cnt });
  };
  const rclick = async (x, y) => { await press(x, y, 'right', 1); await sleep(400); };
  const lclick = async (x, y) => { await press(x, y, 'left', 1); await sleep(400); };
  const dblclick = async (x, y) => {
    await press(x, y, 'left', 1); await sleep(80); await press(x, y, 'left', 2); await sleep(900);
  };
  const moveAway = async () => {
    await Input.dispatchMouseEvent({ type: 'mouseMoved', x: 500, y: 500 });
    await sleep(150);
    await Input.dispatchMouseEvent({ type: 'mouseMoved', x: 620, y: 620 });
    await sleep(400);
  };
  const esc = async () => {
    await Input.dispatchKeyEvent({ type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await Input.dispatchKeyEvent({ type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await sleep(400);
  };
  const menu = () => ev(`(() => {
    const d = document.querySelector('.ctx-menu');
    return d ? { items: [...d.querySelectorAll('.ant-menu-item')].map((i) => i.textContent.replace(/\\s+/g, '')).slice(0, 6) } : null;
  })()`);
  const results = [];
  const check = (n, ok, d) => { results.push(ok); console.log(ok ? 'PASS' : 'FAIL', n, d || ''); };

  // R1 右键连接 → 菜单出现；鼠标移开 → 菜单必须仍在（本次回归核心）
  let p = await pos('演示 SQLite 库');
  await rclick(p.x, p.y);
  let m = await menu();
  check('R1a 右键弹菜单', !!m && m.items.includes('打开连接'), JSON.stringify(m && m.items.slice(0, 3)));
  await moveAway();
  m = await menu();
  check('R1b 鼠标移开菜单仍在', !!m && m.items.includes('打开连接'), m ? '' : '菜单消失');

  // R2 点击别处 → 关闭
  await lclick(600, 600);
  m = await menu();
  check('R2 点击别处关闭', !m);

  // R3 直接右键另一行（不先关闭）→ 切到新菜单
  p = await pos('演示 SQLite 库');
  await rclick(p.x, p.y);
  await moveAway();
  p = await pos('1');
  await rclick(p.x, p.y);
  await moveAway();
  m = await menu();
  check('R3 连续右键切换菜单', !!m && m.items.includes('打开连接'), JSON.stringify(m && m.items.slice(0, 3)));
  await lclick(600, 600);

  // R4 ESC 关闭
  p = await pos('演示 SQLite 库');
  await rclick(p.x, p.y);
  await esc();
  m = await menu();
  check('R4 ESC 关闭', !m, m ? 'ESC 未关闭（点击别处可关，可接受）' : '');
  if (m) await lclick(600, 600);

  // R5 连接 sqlite → 展开表 → 右键表行 → 移开仍在
  p = await pos('演示 SQLite 库');
  await dblclick(p.x, p.y);
  p = await pos('表');
  if (p) {
    await dblclick(p.x, p.y);
    p = await pos('employees');
    await rclick(p.x, p.y);
    await moveAway();
    m = await menu();
    check('R5 表行右键菜单保留', !!m && m.items.includes('打开表'), JSON.stringify(m && m.items.slice(0, 4)));
    // R6 点击菜单项 打开表 → 数据页签；右键数据格 → 菜单移开仍在
    await ev(`(() => {
      const d = document.querySelector('.ctx-menu');
      const it = [...d.querySelectorAll('.ant-menu-item')].find((i) => i.textContent.replace(/\\s+/g, '') === '打开表');
      if (it) it.click();
      return true;
    })()`);
    await sleep(1200);
    const cell = await ev(`(() => {
      const c = document.querySelector('.ant-tabs-tabpane-active .grid-area .cell');
      if (!c) return null;
      const r = c.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    })()`);
    if (cell) {
      await rclick(cell.x, cell.y);
      await moveAway();
      // 数据格菜单是 antd Dropdown：项类名为 .ant-dropdown-menu-item（树 ctx-menu 才是 .ant-menu-item）
      m = await ev(`(() => {
        const d = [...document.querySelectorAll('.ant-dropdown')].find((x) => x.offsetParent);
        return d ? { items: [...d.querySelectorAll('.ant-dropdown-menu-item')].map((i) => i.textContent.replace(/\\s+/g, '')).slice(0, 6) } : null;
      })()`);
      check('R6 数据格右键菜单保留', !!m && m.items.some((i) => i.includes('复制')), JSON.stringify(m && m.items.slice(0, 3)));
      await lclick(600, 600);
    } else check('R6 定位数据格', false);
  } else check('R5 定位表分类', false, '未找到');

  // R7 MSSQL 连接树：双击连接 → 右键数据库行（只读）
  p = await pos('1');
  if (p) {
    await dblclick(p.x, p.y);
    // mssql 连接建立 + treeRoot 需要数秒：轮询等库行出现（固定 sleep 会闪失）
    let dbs = [];
    for (let i = 0; i < 16; i += 1) {
      dbs = await ev(`[...document.querySelectorAll('.tree-wrap .node-title')].map((n) => n.textContent).filter((t) => t === 'master' || t === 'model' || t === 'msdb')`);
      if (dbs.length) break;
      await sleep(500);
    }
    const dbRow = await pos(dbs[0] || 'master');
    if (dbRow) {
      await rclick(dbRow.x, dbRow.y);
      await moveAway();
      m = await menu();
      check('R7 MSSQL 库行右键菜单保留', !!m && m.items.includes('新建查询'), JSON.stringify(m && m.items.slice(0, 4)));
    } else check('R7 定位 MSSQL 库行', false);
  } else check('R7 定位 MSSQL 连接行', false);

  const fails = results.filter((x) => !x).length;
  console.log('\n汇总:', fails === 0 ? '全部通过 (' + results.length + ')' : fails + ' 项失败');
  if (errors.length) console.log('console errors:', errors.slice(0, 6));
  await client.close();
  process.exit(fails === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
