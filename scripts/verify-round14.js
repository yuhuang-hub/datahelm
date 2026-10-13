'use strict';
// v0927.52 数据库品牌图标验证（sqlite+mssql 双连接的 9228 新实例）：
//  A 连接树：两连接行图标换成品牌 svg（data-dh-dbt + 品牌色 + 尺寸）
//  B 展开后连接图标保持品牌 svg、分类图标仍是 antd 图标（树行为未破坏）
//  C 连接右键菜单：打开/关闭连接菜单项图标为该库品牌 svg
//  D 新建连接弹窗：数据库类型下拉 8 个类型选项全部带品牌图标，云预设行不带
const CDP = require('chrome-remote-interface');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const client = await CDP({ port: Number(process.env.CDP_PORT || 9228) });
  const { Input, Runtime, Log } = client;
  await Runtime.enable();
  await Log.enable();
  const errors = [];
  Log.entryAdded(({ entry }) => { if (entry.level === 'error') errors.push(entry.text.slice(0, 200)); });
  const ev = async (expr) => {
    const r = await Runtime.evaluate({ expression: expr, returnByValue: true });
    if (r.exceptionDetails) return { err: String(r.exceptionDetails.exception?.description || '').slice(0, 300) };
    return r.result.value;
  };
  const press = async (x, y, btn, cnt) => {
    await Input.dispatchMouseEvent({ type: 'mousePressed', x, y, button: btn, clickCount: cnt });
    await Input.dispatchMouseEvent({ type: 'mouseReleased', x, y, button: btn, clickCount: cnt });
  };
  const lclick = async (x, y) => { await press(x, y, 'left', 1); await sleep(280); };
  const rclick = async (x, y) => { await press(x, y, 'right', 1); await sleep(420); };
  const esc = async () => {
    await Input.dispatchKeyEvent({ type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await Input.dispatchKeyEvent({ type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await sleep(250);
  };
  const pass = (n) => console.log('PASS', n);
  const fail = (n, d) => { console.log('FAIL', n, d || ''); process.exitCode = 1; };

  // 连接行的品牌图标信息（type/类名/颜色/宽度）
  const connIcon = (title) => ev(`(() => {
    const rows = [...document.querySelectorAll('.tree-wrap .ant-tree-treenode')].filter((r) => r.querySelector('.node-title') && r.getBoundingClientRect().height > 0);
    const f = rows.find((r) => r.querySelector('.node-title').textContent === ${JSON.stringify(title)});
    if (!f) return { miss: 'row' };
    const s = f.querySelector('.dh-dbi');
    if (!s) return { miss: 'svg', hasAnticon: !!f.querySelector('.ant-tree-iconEle .anticon') };
    return { t: s.getAttribute('data-dh-dbt'), cls: s.getAttribute('class') || '', color: getComputedStyle(s).color, w: Math.round(s.getBoundingClientRect().width) };
  })()`);
  const treePos = (title) => ev(`(() => {
    const rows = [...document.querySelectorAll('.tree-wrap .ant-tree-treenode')].filter((r) => r.querySelector('.node-title') && r.getBoundingClientRect().height > 0);
    const f = rows.find((r) => r.querySelector('.node-title').textContent === ${JSON.stringify(title)});
    if (!f) return null;
    const t = f.querySelector('.node-title').getBoundingClientRect();
    return { x: Math.round(t.x + t.width / 2), y: Math.round(t.y + t.height / 2) };
  })()`);

  await sleep(2500);
  // S0 版本
  const ver = await ev(`(() => { const s = document.querySelector('.statusbar'); return s ? s.textContent : ''; })()`);
  if (/v0927.52/.test(String(ver))) pass('S0 状态栏 v0927.52'); else fail('S0 状态栏 v0927.52', String(ver).slice(0, 120));

  // A1 sqlite 连接行：品牌 svg + 品牌色
  const a1 = await connIcon('演示 SQLite 库');
  if (a1 && a1.t === 'sqlite' && /dh-dbi-sqlite/.test(a1.cls || '') && a1.color === 'rgb(15, 128, 204)' && a1.w === 14) pass('A1 SQLite 连接品牌图标'); else fail('A1 SQLite 连接品牌图标', JSON.stringify(a1));
  // A2 mssql 连接行
  const a2 = await connIcon('1');
  if (a2 && a2.t === 'mssql' && /dh-dbi-mssql/.test(a2.cls || '') && a2.color === 'rgb(204, 41, 39)') pass('A2 MSSQL 连接品牌图标'); else fail('A2 MSSQL 连接品牌图标', JSON.stringify(a2));

  // B1 展开连接后图标保持品牌 svg；B2 分类图标仍是 antd 线框图标
  const p1 = await treePos('演示 SQLite 库');
  if (!p1) { fail('B1 展开后连接图标', 'no conn row'); } else {
    await press(p1.x, p1.y, 'left', 1); await sleep(80); await press(p1.x, p1.y, 'left', 2); await sleep(1800);
    const b1 = await connIcon('演示 SQLite 库');
    if (b1 && b1.t === 'sqlite' && b1.w === 14) pass('B1 展开后连接图标保持品牌 svg'); else fail('B1 展开后连接图标保持品牌 svg', JSON.stringify(b1));
  }
  const b2 = await ev(`(() => {
    const rows = [...document.querySelectorAll('.tree-wrap .ant-tree-treenode')].filter((r) => r.querySelector('.node-title') && r.getBoundingClientRect().height > 0);
    const cats = rows.filter((r) => r.querySelector('.node-title').textContent === '表' || r.querySelector('.node-title').textContent === '视图');
    if (!cats.length) return { miss: 'cats' };
    return { anticon: cats.every((r) => !!r.querySelector('.ant-tree-iconEle .anticon')), dbi: cats.some((r) => !!r.querySelector('.dh-dbi')) };
  })()`);
  if (b2 && b2.anticon && !b2.dbi) pass('B2 分类图标仍为 antd 线框'); else fail('B2 分类图标仍为 antd 线框', JSON.stringify(b2));

  // C 连接右键菜单项图标
  const p2 = await treePos('演示 SQLite 库');
  if (!p2) { fail('C1 菜单项品牌图标', 'no conn row'); } else {
    await rclick(p2.x, p2.y);
    const c1 = await ev(`(() => {
      const it = [...document.querySelectorAll('.ctx-menu .ant-menu-item')].find((i) => i.textContent.replace(/\\s+/g, '') === '关闭连接');
      if (!it) return { miss: 'item' };
      const s = it.querySelector('.dh-dbi');
      return s ? { t: s.getAttribute('data-dh-dbt'), w: Math.round(s.getBoundingClientRect().width) } : { miss: 'svg' };
    })()`);
    if (c1 && c1.t === 'sqlite' && c1.w === 14) pass('C1 关闭连接菜单项品牌图标'); else fail('C1 关闭连接菜单项品牌图标', JSON.stringify(c1));
    await esc();
  }

  // D 新建连接弹窗：类型下拉品牌图标
  const nb = await ev(`(() => { const b = [...document.querySelectorAll('.sidebar-head button')].find((x) => x.title === '新建连接'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
  if (!nb) { fail('D1 类型下拉品牌图标', 'no btn'); } else {
    await lclick(nb.x, nb.y);
    await sleep(900);
    const sel = await ev(`(() => { const m = [...document.querySelectorAll('.ant-modal-wrap')].filter((w) => w.getBoundingClientRect().height > 0).find((w) => /新建连接/.test(w.textContent)); if (!m) return null; const s = m.querySelector('.ant-select-selector'); if (!s) return null; const r = s.getBoundingClientRect(); return { x: Math.round(r.x + 60), y: Math.round(r.y + r.height / 2) }; })()`);
    if (!sel) { fail('D1 类型下拉品牌图标', 'no modal/select'); } else {
      await lclick(sel.x, sel.y); // antd Select 打开需真实 mousedown
      await sleep(900);
      // 下拉是虚拟列表：先取首屏的标准类型，再滚到底取云预设
      const d1a = await ev(`(() => {
        const dd = [...document.querySelectorAll('.ant-select-dropdown')].filter((x) => x.getBoundingClientRect().height > 0).pop();
        if (!dd) return { miss: 'dropdown' };
        const opts = [...dd.querySelectorAll('.ant-select-item-option')];
        const types = opts.map((o) => { const s = o.querySelector('.dh-dbi'); return s ? s.getAttribute('data-dh-dbt') : null; }).filter(Boolean);
        return { total: opts.length, types: [...new Set(types)].sort(), colors: (() => { const s = dd.querySelector('.dh-dbi-mysql'); return s ? getComputedStyle(s).color : null; })() };
      })()`);
      await ev(`(() => { const dd = [...document.querySelectorAll('.ant-select-dropdown')].filter((x) => x.getBoundingClientRect().height > 0).pop(); const h = dd && dd.querySelector('.rc-virtual-list-holder'); if (h) h.scrollTop = h.scrollHeight; return !!h; })()`);
      await sleep(600);
      const probeCloud = () => ev(`(() => {
        const dd = [...document.querySelectorAll('.ant-select-dropdown')].filter((x) => x.getBoundingClientRect().height > 0).pop();
        if (!dd) return { miss: 'dropdown' };
        const opts = [...dd.querySelectorAll('.ant-select-item-option')];
        return { cloud: opts.some((o) => !o.querySelector('.dh-dbi') && o.textContent.includes('☁')), cloudIcons: opts.some((o) => o.querySelector('.dh-dbi') && o.textContent.includes('☁')) };
      })()`);
      let d1b = await probeCloud();
      // 虚拟列表滚动后偶发未渲染出云预设：最多再滚三次重查
      for (let w = 0; w < 3 && !(d1b && d1b.cloud); w += 1) {
        await ev(`(() => { const dd = [...document.querySelectorAll('.ant-select-dropdown')].filter((x) => x.getBoundingClientRect().height > 0).pop(); const h = dd && dd.querySelector('.rc-virtual-list-holder'); if (h) h.scrollTop = h.scrollHeight; return !!h; })()`);
        await sleep(900);
        d1b = await probeCloud();
      }
      const want = ['mariadb', 'mongo', 'mssql', 'mysql', 'oracle', 'postgres', 'redis', 'sqlite'];
      if (d1a && d1a.total >= 8 && JSON.stringify(d1a.types) === JSON.stringify(want) && d1a.colors === 'rgb(68, 121, 161)' && d1b && d1b.cloud && !d1b.cloudIcons) pass('D1 类型下拉 8 库全带品牌图标');
      else fail('D1 类型下拉 8 库全带品牌图标', JSON.stringify(d1a) + ' / ' + JSON.stringify(d1b));
      await esc();
      await sleep(300);
    }
    // D2 关闭弹窗
    const x = await ev(`(() => { const m = [...document.querySelectorAll('.ant-modal-wrap')].filter((w) => w.getBoundingClientRect().height > 0).find((w) => /新建连接/.test(w.textContent)); if (!m) return null; const c = m.querySelector('.ant-modal-close'); if (!c) return null; const r = c.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
    if (x) { await lclick(x.x, x.y); await sleep(500); }
    const gone = await ev(`![...document.querySelectorAll('.ant-modal-wrap')].some((w) => w.getBoundingClientRect().height > 0 && /新建连接/.test(w.textContent))`);
    if (gone) pass('D2 弹窗关闭'); else fail('D2 弹窗关闭');
  }

  // S5 无渲染错误
  await sleep(600);
  if (!errors.length) pass('S5 无控制台错误'); else fail('S5 无控制台错误', errors.slice(0, 3).join(' | '));
  await client.close();
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
