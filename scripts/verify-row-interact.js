'use strict';
// 完整验证：整行双击/右键 + 断开收起无残影 + 箭头/菜单回归
const CDP = require('chrome-remote-interface');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const client = await CDP({ port: Number(process.env.CDP_PORT || 9222) });
  const { Input, Runtime, Log } = client;
  await Runtime.enable();
  await Log.enable();
  const errors = [];
  Log.entryAdded(({ entry }) => { if (entry.level === 'error') errors.push(entry.text.slice(0, 300)); });
  const ev = async (expr) => {
    const r = await Runtime.evaluate({ expression: expr, returnByValue: true });
    if (r.exceptionDetails) return { err: (r.exceptionDetails.exception && r.exceptionDetails.exception.description) || 'exception' };
    return r.result.value;
  };

  // 取第一个连接行几何，带重试（防暂态 NaN）
  async function geom(retries = 6) {
    for (let i = 0; i < retries; i++) {
      const g = await ev(`(() => {
        const rows = [...document.querySelectorAll('.tree-wrap .ant-tree-treenode')].filter((r) => r.querySelector('.node-title') && r.getBoundingClientRect().height > 0);
        const f = rows[0];
        if (!f) return null;
        const r = f.getBoundingClientRect();
        const t = f.querySelector('.node-title').getBoundingClientRect();
        const ic = f.querySelector('.ant-tree-iconEle').getBoundingClientRect();
        const o = { x1: Math.round(t.x + t.width / 2), y1: Math.round(t.y + t.height / 2),
                    ix: Math.round(ic.x + ic.width / 2), iy: Math.round(ic.y + ic.height / 2),
                    blankX: 252, rowY: Math.round(r.y + r.height / 2) };
        return Object.values(o).every((v) => Number.isFinite(v)) ? o : null;
      })()`);
      if (g && !g.err) return g;
      await sleep(300);
    }
    throw new Error('geom failed');
  }
  const state = () => ev(`(() => ({
    rows: [...document.querySelectorAll('.tree-wrap .ant-tree-treenode')].filter((r) => r.querySelector('.node-title') && r.getBoundingClientRect().height > 0).map((r) => (r.querySelector('.node-title')||{}).textContent),
    on: document.querySelectorAll('.node-title.on').length,
    motionGhost: document.querySelectorAll('.ant-tree-treenode-motion, .ant-tree .ant-motion-collapse').length,
    msg: [...document.querySelectorAll('.ant-message-notice')].map((m) => m.textContent).join('|'),
  }))()`);
  const rowPos = (title) => ev(`(() => {
    const rows = [...document.querySelectorAll('.tree-wrap .ant-tree-treenode')].filter((r) => r.querySelector('.node-title') && r.getBoundingClientRect().height > 0);
    const f = rows.find((r) => r.querySelector('.node-title').textContent === '${title}');
    if (!f) return null;
    const r = f.getBoundingClientRect();
    const t = f.querySelector('.node-title').getBoundingClientRect();
    const sw = f.querySelector('.ant-tree-switcher');
    const sr = sw ? sw.getBoundingClientRect() : null;
    return { x: Math.round(t.x + t.width / 2), ty: Math.round(t.y + t.height / 2), y: Math.round(r.y + r.height / 2),
             swx: sr ? Math.round(sr.x + sr.width / 2) : null, swy: sr ? Math.round(sr.y + sr.height / 2) : null };
  })()`);

  const click = async (x, y) => {
    await Input.dispatchMouseEvent({ type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await Input.dispatchMouseEvent({ type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    await sleep(80);
    await Input.dispatchMouseEvent({ type: 'mousePressed', x, y, button: 'left', clickCount: 2 });
    await Input.dispatchMouseEvent({ type: 'mouseReleased', x, y, button: 'left', clickCount: 2 });
    await sleep(900);
  };
  const singleClick = async (x, y) => {
    await Input.dispatchMouseEvent({ type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await Input.dispatchMouseEvent({ type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    await sleep(800);
  };
  const rclick = async (x, y) => {
    await Input.dispatchMouseEvent({ type: 'mousePressed', x, y, button: 'right', clickCount: 1 });
    await Input.dispatchMouseEvent({ type: 'mouseReleased', x, y, button: 'right', clickCount: 1 });
    await sleep(500);
  };
  const esc = async () => {
    await Input.dispatchKeyEvent({ type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await Input.dispatchKeyEvent({ type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await sleep(500);
  };
  const menuInfo = () => ev(`(() => {
    const d = [...document.querySelectorAll('.ant-dropdown')].find((x) => !x.classList.contains('ant-dropdown-hidden'));
    if (!d) return null;
    return { items: [...d.querySelectorAll('.ant-dropdown-menu-item')].map((i) => i.textContent.replace(/\\s+/g, '')) };
  })()`);
  const clickMenuItem = (name) => ev(`(() => {
    const d = [...document.querySelectorAll('.ant-dropdown')].find((x) => !x.classList.contains('ant-dropdown-hidden'));
    if (!d) return false;
    const it = [...d.querySelectorAll('.ant-dropdown-menu-item')].find((i) => i.textContent.replace(/\\s+/g, '') === '${name}');
    if (!it) return false;
    it.click();
    return true;
  })()`);
  const results = [];
  const check = (name, ok, detail) => { results.push(ok); console.log(ok ? 'PASS' : 'FAIL', name, detail || ''); };

  // T1 双击图标 → 连接+展开
  let g = await geom();
  await click(g.ix, g.iy);
  let s = await state();
  check('T1 双击图标连接展开', s.on === 1 && s.rows.length > 2 && s.motionGhost === 0, `on=${s.on} rows=${JSON.stringify(s.rows)}`);

  // T2 再双击图标 → 断开且树完全收起、无动画残影
  g = await geom();
  await click(g.ix, g.iy);
  await sleep(600);
  s = await state();
  check('T2 双击图标断开+收起无残影', s.on === 0 && s.rows.length === 2 && s.motionGhost === 0, `on=${s.on} rows=${JSON.stringify(s.rows)} ghost=${s.motionGhost}`);

  // T3 双击行空白区 → 连接+展开
  g = await geom();
  await click(g.blankX, g.rowY);
  s = await state();
  check('T3 双击空白区连接展开', s.on === 1 && s.rows.length > 2, `on=${s.on} rows=${s.rows.length}`);

  // T4 双击空白区 → 断开+收起
  g = await geom();
  await click(g.blankX, g.rowY);
  await sleep(600);
  s = await state();
  check('T4 双击空白区断开+收起', s.on === 0 && s.rows.length === 2 && s.motionGhost === 0, `on=${s.on} rows=${s.rows.length}`);

  // T5 右键图标 → 菜单（未连接 → 打开连接）
  g = await geom();
  await rclick(g.ix, g.iy);
  let m = await menuInfo();
  check('T5 右键图标出菜单', !!m && m.items.includes('打开连接'), JSON.stringify(m && m.items.slice(0, 4)));
  await esc();

  // T6 右键空白区 → 菜单
  g = await geom();
  await rclick(g.blankX, g.rowY);
  m = await menuInfo();
  check('T6 右键空白区出菜单', !!m && m.items.includes('打开连接'), JSON.stringify(m && m.items.slice(0, 4)));

  // T7 右键名字 → 菜单（回归）+ 菜单项 打开连接 生效
  await esc();
  g = await geom();
  await rclick(g.x1, g.y1);
  m = await menuInfo();
  check('T7 右键名字出菜单', !!m && m.items.includes('打开连接'), JSON.stringify(m && m.items.slice(0, 4)));
  const clicked = await clickMenuItem('打开连接');
  await sleep(1200);
  s = await state();
  check('T8 菜单打开连接生效', clicked && s.on === 1 && s.rows.length > 2, `clicked=${clicked} on=${s.on} rows=${s.rows.length}`);

  // T9 单击箭头展开“表”分类
  let p = await rowPos('表');
  if (p) {
    await singleClick(p.swx, p.swy);
    s = await state();
    check('T9 箭头展开表分类', s.rows.includes('employees'), JSON.stringify(s.rows));
  } else check('T9 定位表分类', false, '未找到');

  // T10 右键表行空白区 → 打开表菜单
  p = await rowPos('employees');
  if (p) {
    await rclick(250, p.y);
    m = await menuInfo();
    check('T10 右键表行空白区出菜单', !!m && m.items.includes('打开表'), JSON.stringify(m && m.items.slice(0, 5)));
    // T11 菜单项 打开表 → 打开数据页签
    if (m && m.items.includes('打开表')) {
      await clickMenuItem('打开表');
      await sleep(1200);
      const s11 = await ev(`(() => ({
        tabs: [...document.querySelectorAll('.ant-tabs-tab')].map((t) => t.textContent),
        cells: document.querySelectorAll('.ant-tabs-tabpane-active .grid-area .cell').length,
      }))()`);
      check('T11 菜单打开表生效', s11.tabs.some((t) => t.includes('employees')) && s11.cells > 0, JSON.stringify(s11.tabs) + ' cells=' + s11.cells);
    }
  } else check('T10 定位表行', false, '未找到');

  const fails = results.filter((x) => !x).length;
  console.log('\n汇总:', fails === 0 ? '全部通过 (' + results.length + ')' : fails + ' 项失败');
  if (errors.length) console.log('console errors:', errors.slice(0, 8));
  await client.close();
  process.exit(fails === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
