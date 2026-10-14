'use strict';
// v0927.53 图标间距 + 库节点品牌图标验证（sqlite+mssql 双连接 9228 新实例）：
//  A 连接行品牌图标仍在（回归）+ 箭头→图标→标题 间距收紧到 1~8px
//  B sqlite 分类行仍是 antd 线框文件夹；mssql 展开后 master 库行用品牌 svg（非文件夹）
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
  const press = async (x, y, cnt) => {
    await Input.dispatchMouseEvent({ type: 'mousePressed', x, y, button: 'left', clickCount: cnt });
    await Input.dispatchMouseEvent({ type: 'mouseReleased', x, y, button: 'left', clickCount: cnt });
  };
  const dblclick = async (x, y) => { await press(x, y, 1); await sleep(80); await press(x, y, 2); await sleep(2000); };
  const pass = (n) => console.log('PASS', n);
  const fail = (n, d) => { console.log('FAIL', n, d || ''); process.exitCode = 1; };
  const rowGeom = (title) => ev(`(() => {
    const rows = [...document.querySelectorAll('.tree-wrap .ant-tree-treenode')].filter((r) => r.querySelector('.node-title') && r.getBoundingClientRect().height > 0);
    const f = rows.find((r) => r.querySelector('.node-title').textContent === ${JSON.stringify(title)});
    if (!f) return { miss: 'row' };
    const sw = f.querySelector('.ant-tree-switcher');
    const svg = f.querySelector('.ant-tree-iconEle .dh-dbi');
    const cyl = f.querySelector('.ant-tree-iconEle .dh-dbcyl');
    const an = f.querySelector('.ant-tree-iconEle .anticon');
    const ttl = f.querySelector('.node-title');
    const r2 = (el) => el.getBoundingClientRect();
    const ico = svg || cyl || an;
    return {
      swRight: Math.round(r2(sw).right), icoLeft: ico ? Math.round(r2(ico).left) : null, icoRight: ico ? Math.round(r2(ico).right) : null,
      ttlLeft: Math.round(r2(ttl).left), dbt: svg ? svg.getAttribute('data-dh-dbt') : null,
      cyl: !!cyl, cylColor: cyl ? getComputedStyle(cyl).color : null,
      color: svg ? getComputedStyle(svg).color : null, hasAnticon: !!an,
    };
  })()`);
  const posOf = (title) => ev(`(() => {
    const rows = [...document.querySelectorAll('.tree-wrap .ant-tree-treenode')].filter((r) => r.querySelector('.node-title') && r.getBoundingClientRect().height > 0);
    const f = rows.find((r) => r.querySelector('.node-title').textContent === ${JSON.stringify(title)});
    if (!f) return null;
    const t = f.querySelector('.node-title').getBoundingClientRect();
    return { x: Math.round(t.x + t.width / 2), y: Math.round(t.y + t.height / 2) };
  })()`);

  await sleep(2500);
  // S0 版本
  const ver = await ev(`(() => { const s = document.querySelector('.statusbar'); return s ? s.textContent : ''; })()`);
  if (/v0927.53/.test(String(ver))) pass('S0 状态栏 v0927.53'); else fail('S0 状态栏 v0927.53', String(ver).slice(0, 120));

  // A1 sqlite 连接行品牌图标（回归）
  const a1 = await rowGeom('演示 SQLite 库');
  if (a1 && a1.dbt === 'sqlite' && a1.color === 'rgb(15, 128, 204)' && !a1.hasAnticon) pass('A1 连接行品牌图标保持'); else fail('A1 连接行品牌图标保持', JSON.stringify(a1));
  // A2 箭头→图标→标题 间距收紧（1~8px）+ 垂直居中（图标中心 vs 标题中心 ≤2px）
  if (a1 && a1.icoLeft != null) {
    const gapArrow = a1.icoLeft - a1.swRight;
    const gapTitle = a1.ttlLeft - a1.icoRight;
    if (gapArrow >= 1 && gapArrow <= 8 && gapTitle >= 1 && gapTitle <= 8) pass(`A2 间距收紧（箭头→图标 ${gapArrow}px、图标→标题 ${gapTitle}px）`);
    else fail('A2 间距收紧', `gapArrow=${gapArrow} gapTitle=${gapTitle}`);
  } else fail('A2 间距收紧', 'no icon rect');
  const a3 = await ev(`(() => {
    const rows = [...document.querySelectorAll('.tree-wrap .ant-tree-treenode')].filter((r) => r.querySelector('.node-title') && r.getBoundingClientRect().height > 0);
    const out = [];
    for (const t of ['演示 SQLite 库', '1']) {
      const f = rows.find((r) => r.querySelector('.node-title').textContent === t);
      if (!f) { out.push({ t, miss: true }); continue; }
      const svg = f.querySelector('.ant-tree-iconEle .dh-dbi');
      const ttl = f.querySelector('.node-title');
      if (!svg) { out.push({ t, missSvg: true }); continue; }
      const s = svg.getBoundingClientRect(); const n = ttl.getBoundingClientRect();
      out.push({ t, dIcon: Math.round(s.y + s.height / 2 - (n.y + n.height / 2)), icoCy: Math.round(s.y + s.height / 2), ttlCy: Math.round(n.y + n.height / 2) });
    }
    return out;
  })()`);
  const bad = (a3 || []).filter((x) => x.miss || x.missSvg || Math.abs(x.dIcon) > 2);
  if (!bad.length) pass(`A3 图标与文字垂直居中（偏差 ${a3.map((x) => x.t + ':' + x.dIcon + 'px').join(' / ')}）`);
  else fail('A3 图标与文字垂直居中', JSON.stringify(bad));

  // B1 展开 sqlite 连接 → 分类行仍是 antd 文件夹（品牌/圆柱 svg 不进分类；连击后重试等待子级）
  const p0 = await posOf('演示 SQLite 库');
  if (!p0) { fail('B1 分类行保持文件夹图标', 'no conn row'); } else {
    await dblclick(p0.x, p0.y);
    let b1 = { miss: 'row' };
    for (let i = 0; i < 8 && b1 && b1.miss === 'row'; i += 1) {
      b1 = await ev(`(() => {
        const rows = [...document.querySelectorAll('.tree-wrap .ant-tree-treenode')].filter((r) => r.querySelector('.node-title') && r.getBoundingClientRect().height > 0);
        const f = rows.find((r) => r.querySelector('.node-title').textContent === '表');
        if (!f) return { miss: 'row' };
        const ie = f.querySelector('.ant-tree-iconEle');
        return { anticon: !!(ie && ie.querySelector('.anticon')), dbi: !!f.querySelector('.dh-dbi'), dbcyl: !!f.querySelector('.dh-dbcyl') };
      })()`);
      if (b1 && b1.miss === 'row') await sleep(700);
    }
    if (b1 && b1.anticon && !b1.dbi && !b1.dbcyl) pass('B1 分类行保持文件夹图标'); else fail('B1 分类行保持文件夹图标', JSON.stringify(b1));
  }

  // B2 展开 mssql 连接（只读浏览库列表）→ master 库行用圆柱数据库图标
  // 注：B1 刚展开完会触发树重排，立即双击可能两次点击落点错位 → 先稳定一拍，master 未出现再补一次双击
  await sleep(1200);
  const p1 = await posOf('1');
  if (!p1) { fail('B2 master 库行品牌图标', 'no conn row'); } else {
    await dblclick(p1.x, p1.y);
    let b2 = { miss: 'master' };
    // i===4 的补双击只在连接仍收起时才补：子级已载入（已 -open）时再双击=断开会话并收起树（#89 陷阱），master 永不出现
    for (let i = 0; i < 16 && b2 && b2.miss === 'master'; i += 1) {
      b2 = await rowGeom('master');
      if (b2 && b2.miss === 'master') {
        if (i === 4) {
          const isOpen = await ev(`(() => { const ts = [...document.querySelectorAll('.tree-wrap .node-title')].filter((x) => x.textContent === '1'); const t = ts[0]; const w = t && t.closest('.ant-tree-node-content-wrapper'); return !!(w && w.className.includes('-open')); })()`);
          if (isOpen !== true) { const pp = await posOf('1'); if (pp) await dblclick(pp.x, pp.y); }
        } else await sleep(800);
      }
    }
    if (b2 && b2.cyl && b2.cylColor === 'rgb(212, 136, 6)' && !b2.dbt && !b2.hasAnticon) pass('B2 master 库行用圆柱数据库图标（非品牌/非文件夹）');
    else fail('B2 master 库行用圆柱数据库图标（非品牌/非文件夹）', JSON.stringify(b2));
  }

  // S5 无渲染错误
  await sleep(600);
  if (!errors.length) pass('S5 无控制台错误'); else fail('S5 无控制台错误', errors.slice(0, 3).join(' | '));
  await client.close();
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
