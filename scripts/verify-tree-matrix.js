'use strict';
// 全矩阵树右键验证：所有行层级 + 滚动后 + 窗口底部 + 鼠标移开保留
const CDP = require('chrome-remote-interface');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // 绑定主窗目标（dist/index.html）：裸 CDP({port}) 会绑到第一个 page 目标——启动早期那是
  // 闪屏窗，闪屏关闭即连接报废（readyState 3）
  const targets = await CDP.List({ port: Number(process.env.CDP_PORT || 9226) });
  const mainTgt = targets.find((t) => t.url.includes('dist/index.html'));
  if (!mainTgt) { console.log('FATAL main target not found'); process.exit(1); }
  const client = await CDP({ target: mainTgt.webSocketDebuggerUrl });
  const { Input, Runtime, Log } = client;
  await Runtime.enable();
  await Log.enable();
  const errors = [];
  Log.entryAdded(({ entry }) => { if (entry.level === 'error') errors.push(entry.text.slice(0, 200)); });
  const ev = async (expr) => {
    const r = await Runtime.evaluate({ expression: expr, returnByValue: true });
    if (r.exceptionDetails) return { err: 'exception' };
    return r.result.value;
  };
  // 定位：按标题找行；where: name/icon/blank 决定横向落点
  const pos = (title, where, yOff = 0) => ev(`(() => {
    const rows = [...document.querySelectorAll('.tree-wrap .ant-tree-treenode')].filter((r) => r.querySelector('.node-title') && r.getBoundingClientRect().height > 0);
    const f = rows.find((r) => r.querySelector('.node-title').textContent === '${title}');
    if (!f) return null;
    const r = f.getBoundingClientRect();
    const t = f.querySelector('.node-title').getBoundingClientRect();
    const ic = f.querySelector('.ant-tree-iconEle').getBoundingClientRect();
    const x = ${JSON.stringify(where)} === 'icon' ? Math.round(ic.x + ic.width / 2) : ${JSON.stringify(where)} === 'blank' ? Math.round(r.x + r.width - 15) : Math.round(t.x + t.width / 2);
    return { x, y: Math.round(r.y + r.height / 2 + ${yOff}) };
  })()`);
  const press = async (x, y, btn, cnt) => {
    await Input.dispatchMouseEvent({ type: 'mousePressed', x, y, button: btn, clickCount: cnt });
    await Input.dispatchMouseEvent({ type: 'mouseReleased', x, y, button: btn, clickCount: cnt });
  };
  const rclick = async (x, y) => { await press(x, y, 'right', 1); await sleep(350); };
  const lclick = async (x, y) => { await press(x, y, 'left', 1); await sleep(300); };
  const dblclick = async (x, y) => { await press(x, y, 'left', 1); await sleep(80); await press(x, y, 'left', 2); await sleep(1200); };
  const moveAway = async () => {
    await Input.dispatchMouseEvent({ type: 'mouseMoved', x: 520, y: 520 }); await sleep(120);
    await Input.dispatchMouseEvent({ type: 'mouseMoved', x: 660, y: 640 }); await sleep(350);
  };
  const menu = () => ev(`(() => {
    const d = document.querySelector('.ctx-menu');
    return d ? [...d.querySelectorAll('.ant-menu-item')].map((i) => i.textContent.replace(/\\s+/g, '')) : null;
  })()`);
  const results = [];
  const expect = (name, p, where, keyword, extra) => results.push([name, p, where, keyword, extra]);
  const runExpect = async (name, p, where, keyword) => {
    const g = await pos(p, where);
    if (!g) { results.push([name, false, 'row not found']); console.log('FAIL', name, '未找到行:' + p); return; }
    await rclick(g.x, g.y);
    await moveAway();
    const m = await menu();
    const ok = !!m && m.some((i) => i.includes(keyword));
    results.push([name, ok]); console.log(ok ? 'PASS' : 'FAIL', name, m ? JSON.stringify(m.slice(0, 4)) : '无菜单');
    await lclick(650, 640);
  };

  // 等对象树渲染（连接节点出现）：MAIN-READY 只代表页面开始加载，树首帧晚 ~1.5s
  for (let i = 0; i < 30; i += 1) {
    const n = await ev("(() => document.querySelectorAll('.tree-wrap .node-title').length)()");
    if (n && n > 0) break;
    await sleep(500);
  }

  // ---- sqlite：连接 → 表分类 → 表 ----
  await runExpect('M1 sqlite连接行(名字)', '演示 SQLite 库', 'name', '打开连接');
  let p = await pos('演示 SQLite 库', 'name');
  await dblclick(p.x, p.y); // 连接+展开
  await runExpect('M2 表分类行(图标)', '表', 'icon', '新建表');
  await runExpect('M3 表分类行(空白)', '表', 'blank', '新建表');
  const catP = await pos('表', 'name');
  await dblclick(catP.x, catP.y); // 展开 employees
  await runExpect('M4 表行employees(名字)', 'employees', 'name', '打开表');
  await runExpect('M5 表行employees(空白)', 'employees', 'blank', '打开表');
  await runExpect('M6 视图分类行', '视图', 'name', '新建');

  // ---- MSSQL：连接 → 数据库行 → 表分类 → 深层表行 ----
  p = await pos('1', 'name');
  await dblclick(p.x, p.y);
  // mssql 冷连接：双击展开后库列表要等连接完成才出现（曾 2 轮里抖动 1 次），重试等待
  let firstDb;
  for (let i = 0; i < 24 && !firstDb; i += 1) {
    const dbs = await ev('[...document.querySelectorAll(\'.tree-wrap .node-title\')].map(n=>n.textContent)');
    firstDb = ['cpPlaForm', 'cpPlatForm1', 'dwstore', 'FileLoad', 'master'].find((d) => dbs.includes(d));
    if (!firstDb) await sleep(500);
  }
  await runExpect('M7 MSSQL库行(名字)', firstDb, 'name', '新建查询');
  await runExpect('M8 MSSQL库行(图标)', firstDb, 'icon', '新建查询');
  // 展开该库 → 表分类 → 展开 → 深层表行
  p = await pos(firstDb, 'name');
  await dblclick(p.x, p.y);
  const mssqlCats = await ev('[...document.querySelectorAll(\'.tree-wrap .node-title\')].map(n=>n.textContent)');
  // 找该库下的“表”分类：取最后一个“表”（MSSQL 树里 sqlite 的表分类在前）
  const catRows = await ev(`(() => {
    const rows = [...document.querySelectorAll('.tree-wrap .ant-tree-treenode')].filter((r) => r.querySelector('.node-title') && r.getBoundingClientRect().height > 0);
    return rows.filter((r) => r.querySelector('.node-title').textContent === '表').map((r) => Math.round(r.getBoundingClientRect().y));
  })()`);
  console.log('表分类行 y 坐标:', JSON.stringify(catRows));
  const lastCatY = catRows[catRows.length - 1];
  if (lastCatY !== undefined) {
    await rclick(100, lastCatY + 12);
    await moveAway();
    let m = await menu();
    const ok = !!m && m.some((i) => i.includes('新建表'));
    results.push(['M9 MSSQL表分类行', ok]); console.log(ok ? 'PASS' : 'FAIL', 'M9 MSSQL表分类行', m ? JSON.stringify(m.slice(0, 4)) : '无菜单');
    await lclick(650, 640);
    // 展开取第一个表行
    await ev(`(() => {
      const rows = [...document.querySelectorAll('.tree-wrap .ant-tree-treenode')].filter((r) => r.querySelector('.node-title') && r.getBoundingClientRect().height > 0);
      const cat = rows.filter((r) => r.querySelector('.node-title').textContent === '表').pop();
      const sw = cat.querySelector('.ant-tree-switcher').getBoundingClientRect();
      return true;
    })()`);
    // 单击箭头展开（用 CDP 点击 switcher 位置）
    const swP = await ev(`(() => {
      const rows = [...document.querySelectorAll('.tree-wrap .ant-tree-treenode')].filter((r) => r.querySelector('.node-title') && r.getBoundingClientRect().height > 0);
      const cat = rows.filter((r) => r.querySelector('.node-title').textContent === '表').pop();
      if (!cat) return null;
      const sw = cat.querySelector('.ant-tree-switcher').getBoundingClientRect();
      return { x: Math.round(sw.x + sw.width / 2), y: Math.round(sw.y + sw.height / 2) };
    })()`);
    if (swP) {
      await lclick(swP.x, swP.y);
      // 第一个深层表行
      const tblP = await ev(`(() => {
        const rows = [...document.querySelectorAll('.tree-wrap .ant-tree-treenode')].filter((r) => r.querySelector('.node-title') && r.getBoundingClientRect().height > 0);
        const catIdx = rows.map((r) => r.querySelector('.node-title').textContent).lastIndexOf('表');
        const t = rows[catIdx + 1];
        if (!t) return null;
        const r = t.getBoundingClientRect();
        return { x: Math.round(r.x + r.width - 15), y: Math.round(r.y + r.height / 2), name: t.querySelector('.node-title').textContent };
      })()`);
      if (tblP) {
        await rclick(tblP.x, tblP.y);
        await moveAway();
        const m2 = await menu();
        const ok2 = !!m2; // 深层行（无论命中箭头/缩进/标题区）都必须有菜单
        results.push(['M10 MSSQL深层表行', ok2]); console.log(ok2 ? 'PASS' : 'FAIL', 'M10 MSSQL深层行(' + tblP.name + ')', m2 ? JSON.stringify(m2.slice(0, 4)) : '无菜单');
        await lclick(650, 640);
      }
    }
  }

  // ---- 滚动后 + 最后一个完整可见行（真实用户场景：滚动找表后右键） ----
  await ev(`(() => { const w = document.querySelector('.tree-wrap'); w.scrollTop = 200; return w.scrollTop; })()`);
  await sleep(300);
  const visRows = await ev(`(() => {
    const w = document.querySelector('.tree-wrap');
    const wb = w.getBoundingClientRect();
    const clientBottom = wb.y + w.clientHeight; // 不含滚动条占位
    const rows = [...w.querySelectorAll('.ant-tree-treenode')].filter((r) => r.querySelector('.node-title') && r.getBoundingClientRect().height > 0);
    // 最后一个“整行都在客户区内”的行，点其中心（避开行缝与滚动条）
    const full = rows.filter((r) => { const rr = r.getBoundingClientRect(); return rr.y >= wb.y && rr.bottom <= clientBottom; });
    const last = full[full.length - 1];
    return last ? { name: last.querySelector('.node-title').textContent, y: Math.round(last.getBoundingClientRect().y + 12), clientH: w.clientHeight, rectH: Math.round(wb.height) } : null;
  })()`);
  if (visRows) {
    await rclick(100, visRows.y);
    await moveAway();
    const m = await menu();
    const ok = !!m;
    results.push(['M11 滚动后完整可见行右键', ok]);
    console.log(ok ? 'PASS' : 'FAIL', 'M11 滚动后行(' + visRows.name + ') clientH=' + visRows.clientH + '/rectH=' + visRows.rectH, m ? JSON.stringify(m.slice(0, 3)) : '无菜单');
    await lclick(650, 640);
  }

  const fails = results.filter((r) => !r[1]).length;
  console.log('\n汇总:', fails === 0 ? '全部通过 (' + results.length + ')' : fails + ' 项失败 / ' + results.length);
  if (errors.length) console.log('console errors:', errors.slice(0, 6));
  await client.close();
  process.exit(fails === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
