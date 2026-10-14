'use strict';
// v0927.53 树分组右键与收展悬浮修复：①antd 收展悬浮底板固定 24×24，本应用开关列窄化 16px →
// 底板右溢 8px 压住行首图标；覆盖为 14×16 居中（::before 计算值 14/16/1/4，底板右缘 < 图标左缘），
// 深色下补可见底板 rgba(255,255,255,.09)。②表展开的结构分组（字段/索引/外键/唯一键/检查）右键新增
// 「新建X」直达表设计器对应分区并追加空白行（触发器分组 → SQL 模板 ObjEditTab）。
// 树展开一律走 switcher 单击（会话已开时双击连接=断开会话并关页签）；sqlite 在 mssql 前（表 idx）。
// S0 版本；S5 控制台零错误。
const CDP = require('chrome-remote-interface');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // 钉主窗口目标（启动早期第一个 page 是闪屏窗，绑错目标会随闪屏关闭断连）
  let client = null;
  for (let i = 0; i < 20 && !client; i += 1) {
    try {
      const list = await CDP.List({ port: Number(process.env.CDP_PORT || 9227) });
      const tgt = list.find((t) => t.url.includes('dist/index.html'));
      if (tgt) client = await CDP({ target: tgt.webSocketDebuggerUrl });
    } catch {}
    if (!client) await sleep(500);
  }
  if (!client) { console.log('FAIL S-CONN 主窗口目标未找到'); process.exit(1); }
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
  const lclick = async (x, y) => { await press(x.x !== undefined ? x.x : x, x.y !== undefined ? x.y : y, 'left', 1); await sleep(300); };
  const posOf = async (expr) => {
    const p = await ev(`(() => { const el = ${expr}; if (!el) return null; el.scrollIntoView({ block: 'nearest' }); const r = el.getBoundingClientRect(); return r.height > 0 || r.width > 0 ? { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } : null; })()`);
    return p && !p.err ? p : null;
  };
  const pass = (n) => console.log('PASS', n);
  const fail = (n, d) => { console.log('FAIL', n, d || ''); process.exitCode = 1; };

  // 等主窗揭示
  let ok = false;
  for (let i = 0; i < 40 && !ok; i += 1) {
    ok = await ev("!!document.querySelector('.top-toolbar .tb-btn')");
    if (!ok) await sleep(500);
  }

  // S0 版本
  const ver = await ev("(() => { const s = document.querySelector('.statusbar'); return s ? s.textContent : ''; })()");
  String(ver).includes('v0927.53') ? pass('S0 版本 v0927.53') : fail('S0 版本', String(ver).slice(0, 120));

  // ---- 树展开（33ui 成熟打法：node-title 定位 + switcher 真实单击 + -open 回读，外层重试）----
  const waitTree = async (title, idx, tries) => {
    for (let i = 0; i < tries; i += 1) {
      const p = await posOf(`(() => { const ts = [...document.querySelectorAll('.tree-wrap .node-title')].filter((x) => x.textContent.trim() === ${JSON.stringify(title)}); const t = ts[${idx || 0}]; return t || null; })()`);
      if (p) return p;
      await sleep(400);
    }
    return null;
  };
  const isOpenEv = (title, idx) => ev(`(() => { const ts = [...document.querySelectorAll('.tree-wrap .node-title')].filter((x) => x.textContent.trim() === ${JSON.stringify(title)}); const t = ts[${idx || 0}]; const w = t && t.closest('.ant-tree-node-content-wrapper'); return !!(w && w.className.includes('-open')); })()`);
  const ensureOpenOnce = async (title, idx) => {
    const p = await waitTree(title, idx, 10);
    if (!p) return false;
    if (await isOpenEv(title, idx)) return true;
    // 注意：switcher 表达式本身返回坐标 {x,y}（非元素）——必须用 ev 直取，不能套 posOf（会对坐标对象调 scrollIntoView 抛错）
    let sw = null;
    for (let i = 0; i < 6 && !sw; i += 1) {
      const s = await ev(`(() => { const ts = [...document.querySelectorAll('.tree-wrap .node-title')].filter((x) => x.textContent.trim() === ${JSON.stringify(title)}); const t = ts[${idx || 0}]; const row = t && t.closest('.ant-tree-treenode'); const s2 = row && row.querySelector('.ant-tree-switcher'); if (!s2) return null; const r = s2.getBoundingClientRect(); return r.width > 0 ? { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } : null; })()`);
      if (s && !s.err && s.x !== undefined) sw = s;
      else await sleep(300);
    }
    if (!sw) return false;
    await lclick(sw.x, sw.y);
    await sleep(1200);
    return !!(await isOpenEv(title, idx));
  };
  const ensureOpen = async (title, idx) => {
    for (let a = 0; a < 3; a += 1) { if (await ensureOpenOnce(title, idx)) return true; }
    return false;
  };

  // 行序快照：doc 顺序 [title]（分组右键定位 + 叶子计数用）
  const rowTitles = () => ev("(() => [...document.querySelectorAll('.tree-wrap .ant-tree-treenode')].filter((r) => r.getBoundingClientRect().height > 0).map((r) => (r.querySelector('.node-title') || { textContent: '' }).textContent.trim()))()");
  const leafCount = async (fromTitle, toTitle) => {
    const ts = await rowTitles();
    if (!Array.isArray(ts)) return -1;
    const a = ts.findIndex((t) => t === fromTitle);
    const b = ts.findIndex((t, i) => i > a && t === toTitle);
    if (a < 0) return -1;
    const end = b > a ? b : ts.length;
    return end - a - 1;
  };

  // ---- U1 sqlite 展开链：连接 → 表 → employees → 字段/索引/外键/唯一键 ----
  let u1 = await ensureOpen('演示 SQLite 库', 0);
  u1 = u1 && (await ensureOpen('表', 0));
  u1 = u1 && (await ensureOpen('employees', 0));
  const empIdx = Array.isArray(await rowTitles()) ? (await rowTitles()).findIndex((t) => t === 'employees') : -1;
  u1 = u1 && empIdx > 0;
  const gOpen = {};
  for (const g of ['字段', '索引', '外键', '唯一键']) gOpen[g] = await ensureOpen(g, 0);
  u1 = u1 && gOpen['字段'] && gOpen['索引'] && gOpen['外键'] && gOpen['唯一键'];
  u1 ? pass('U1 sqlite 树展开链 连接→表→employees→四分组') : fail('U1 树展开', JSON.stringify(gOpen));

  // ---- T1 收展按钮悬浮底板几何：14×16 居中且不越过开关列右缘（旧 antd 24×24 右溢 8px）----
  {
    const g = await ev("(() => { const ts = [...document.querySelectorAll('.tree-wrap .node-title')].filter((x) => x.textContent.trim() === 'employees'); const t = ts[0]; const row = t && t.closest('.ant-tree-treenode'); const sw = row && row.querySelector('.ant-tree-switcher'); const ic = row && row.querySelector('.ant-tree-iconEle'); if (!sw || !ic) return null; const cs = getComputedStyle(sw, '::before'); const sr = sw.getBoundingClientRect(); const ir = ic.getBoundingClientRect(); return { w: cs.width, h: cs.height, l: cs.left, t: cs.top, swW: Math.round(sr.width), swEnd: Math.round(sr.right), icX: Math.round(ir.x) }; })()");
    if (!g || g.err) fail('T1 悬浮底板', JSON.stringify(g));
    else {
      // ::before 计算值 w/h/l/t 相对开关盒（含块）：14×16 落在 16px 开关列内（1+14=15<16 不右溢）；
      // 开关盒右缘不越过行图标左缘（旧 24×24 底板右溢 8px 压图标）
      const okGeo = g.w === '14px' && g.h === '16px' && g.l === '1px' && g.t === '4px' && g.swW === 16 && g.swEnd <= g.icX + 1;
      okGeo ? pass('T1 悬浮底板 14×16 于 16px 开关列内，开关右缘 ' + g.swEnd + ' ≤ 图标左缘 ' + g.icX + ' 不再压图标') : fail('T1 悬浮底板', JSON.stringify(g));
    }
    // 深色底板规则存在（styles.css 静态表）
    const dark = await ev("(() => { for (const sh of document.styleSheets) { let rs; try { rs = sh.cssRules; } catch (e) { continue; } for (const r of rs) { if (r.selectorText && r.selectorText.indexOf('dark') >= 0 && r.selectorText.indexOf('switcher') >= 0 && r.selectorText.indexOf('hover') >= 0) return true; } } return false; })()");
    dark === true ? pass('T1b 深色收展悬浮底板规则已注入') : fail('T1b 深色底板', '规则未找到');
  }

  // ---- 分组右键菜单 + 新建直达设计器 ----
  const ctxAt = async (title, idx) => {
    const p = await posOf(`(() => { const ts = [...document.querySelectorAll('.tree-wrap .node-title')].filter((x) => x.textContent.trim() === ${JSON.stringify(title)}); const t = ts[${idx || 0}]; return t || null; })()`);
    if (!p) return null;
    await press(p.x, p.y, 'right', 1);
    for (let i = 0; i < 10; i += 1) {
      const has = await ev("!!document.querySelector('.ctx-menu')");
      if (has === true) break;
      await sleep(300);
    }
    const items = await ev("(() => { const m = document.querySelector('.ctx-menu'); if (!m) return null; return [...m.querySelectorAll('.ant-dropdown-menu-item, .ant-menu-item')].map((x) => x.textContent.trim()); })()");
    return Array.isArray(items) ? items : null;
  };
  const ctxClick = async (label) => {
    const p = await posOf(`(() => { const m = document.querySelector('.ctx-menu'); if (!m) return null; const it = [...m.querySelectorAll('.ant-dropdown-menu-item, .ant-menu-item')].find((x) => x.textContent.trim() === ${JSON.stringify(label)}); return it || null; })()`);
    if (!p) return false;
    await lclick(p.x, p.y);
    return true;
  };
  const closeCtx = async () => { await ev("(() => { document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); return true; })()"); await sleep(400); };
  const designState = () => ev(`(() => {
    const main = [...document.querySelectorAll('.ant-tabs-tab-active')].filter((x) => !x.closest('.design-tabs'))[0];
    const pane = [...document.querySelectorAll('.ant-tabs-tabpane-active')].filter((p) => p.querySelector && p.querySelector('.design-tabs'))[0];
    const act = pane ? pane.querySelector('.design-tabs .ant-tabs-tab-active') : null;
    const rows = pane ? pane.querySelectorAll('.design-tabs .ant-tabs-tabpane-active .ant-table-row') : [];
    const lastInputs = rows.length ? [...rows[rows.length - 1].querySelectorAll('input')].map((i) => i.value) : [];
    return { main: main ? main.textContent.replace(/\\s+/g, '') : '', sec: act ? act.textContent.trim() : '', n: rows.length, last: lastInputs.slice(0, 3) };
  })()`);
  // 条件轮询（设计页刚开时内省/追加行未落完，早捕获会读到中间态；冷连接下 mssql 内省需数秒）
  const waitDesignCond = async (cond, tries) => {
    let last = null;
    for (let i = 0; i < (tries || 25); i += 1) {
      const d = await designState();
      if (d && !d.err) { last = d; if (cond(d)) return d; }
      await sleep(400);
    }
    return last ? { timeout: true, ...last } : null;
  };

  // U2 字段分组菜单
  {
    const items = await ctxAt('字段', 0);
    JSON.stringify(items) === JSON.stringify(['新建字段', '新建查询', '刷新']) ? pass('U2 字段分组右键菜单 [新建字段/新建查询/刷新]') : fail('U2 字段菜单', JSON.stringify(items));
    // U3 新建字段 → 设计器字段分区 + 1 空行
    const nCols = await leafCount('字段', '索引');
    if (!(await ctxClick('新建字段'))) fail('U3 点击', '新建字段 未命中');
    else {
      const st = await waitDesignCond((d) => d.main.includes('employees') && d.sec === '字段' && d.n === nCols + 1 && d.last.includes(''));
      st && !st.timeout
        ? pass('U3 新建字段 → 设计 employees·字段分区 ' + st.n + ' 行（原 ' + nCols + ' + 新空行）')
        : fail('U3 新建字段', JSON.stringify(st) + ' nCols=' + nCols);
    }
  }

  // U4 索引分组：菜单 + 新建索引 → 同设计器切索引分区 + 空行
  {
    const items = await ctxAt('索引', 0);
    JSON.stringify(items) === JSON.stringify(['新建索引', '新建查询', '刷新']) ? pass('U4 索引分组菜单 [新建索引/新建查询/刷新]') : fail('U4 索引菜单', JSON.stringify(items));
    const nIdx = await leafCount('索引', '外键');
    if (!(await ctxClick('新建索引'))) fail('U4 新建', '新建索引 未命中');
    else {
      const st = await waitDesignCond((d) => d.sec === '索引' && d.n === nIdx + 1 && d.last.includes(''));
      st && !st.timeout
        ? pass('U4 新建索引 → 索引分区 ' + st.n + ' 行（原 ' + nIdx + ' + 新空行）')
        : fail('U4 新建索引', JSON.stringify(st) + ' nIdx=' + nIdx);
    }
  }

  // U5 外键分组（sqlite）：菜单 + 新建外键 → 外键分区 + 空行
  {
    const items = await ctxAt('外键', 0);
    JSON.stringify(items) === JSON.stringify(['新建外键', '新建查询', '刷新']) ? pass('U5 外键分组菜单 [新建外键/新建查询/刷新]') : fail('U5 外键菜单', JSON.stringify(items));
    const nFk = await leafCount('外键', '唯一键');
    if (!(await ctxClick('新建外键'))) fail('U5 新建', '新建外键 未命中');
    else {
      const st = await waitDesignCond((d) => d.sec === '外键' && d.n === nFk + 1 && d.last.includes(''));
      st && !st.timeout
        ? pass('U5 新建外键 → 外键分区 ' + st.n + ' 行（原 ' + nFk + ' + 新空行，SQLite 重建表口径）')
        : fail('U5 新建外键', JSON.stringify(st) + ' nFk=' + nFk);
    }
  }

  // U6 唯一键（点击直达）+ 检查（菜单在）
  {
    const itemsU = await ctxAt('唯一键', 0);
    JSON.stringify(itemsU) === JSON.stringify(['新建唯一键', '新建查询', '刷新']) ? pass('U6a 唯一键分组菜单 [新建唯一键/新建查询/刷新]') : fail('U6a 唯一键菜单', JSON.stringify(itemsU));
    const nUq = await leafCount('唯一键', '检查');
    if (!(await ctxClick('新建唯一键'))) fail('U6b 新建', '新建唯一键 未命中');
    else {
      const st = await waitDesignCond((d) => d.sec === '唯一键' && d.n === nUq + 1);
      st && !st.timeout ? pass('U6b 新建唯一键 → 唯一键分区 ' + st.n + ' 行（原 ' + nUq + ' + 新空行）') : fail('U6b 新建唯一键', JSON.stringify(st) + ' nUq=' + nUq);
    }
    const itemsC = await ctxAt('检查', 0);
    Array.isArray(itemsC) && itemsC[0] === '新建检查' && itemsC.includes('新建查询') && itemsC.includes('刷新')
      ? pass('U6c 检查分组菜单首项 [新建检查]')
      : fail('U6c 检查菜单', JSON.stringify(itemsC));
    await closeCtx();
  }

  // U7 触发器分组（employees 子级：doc 序在连接级 触发器 之前 → idx 0）→ SQL 模板
  {
    const items = await ctxAt('触发器', 0);
    JSON.stringify(items) === JSON.stringify(['新建触发器', '新建查询', '刷新']) ? pass('U7 触发器分组菜单 [新建触发器/新建查询/刷新]') : fail('U7 触发器菜单', JSON.stringify(items));
    if (!(await ctxClick('新建触发器'))) fail('U7 新建', '新建触发器 未命中');
    else {
      let st = null;
      for (let i = 0; i < 15 && !st; i += 1) {
        const t = await ev("(() => { const main = [...document.querySelectorAll('.ant-tabs-tab-active')].filter((x) => !x.closest('.design-tabs'))[0]; const cm = document.querySelector('.ant-tabs-tabpane-active .cm-content'); return { main: main ? main.textContent.replace(/\\s+/g, '') : '', sql: cm ? cm.textContent : '' }; })()");
        if (t && !t.err && t.main.includes('新建触发器')) st = t;
        else await sleep(400);
      }
      st && /TRIGGER/i.test(st.sql)
        ? pass('U7 新建触发器 → ObjEditTab 模板含 CREATE TRIGGER')
        : fail('U7 触发器模板', JSON.stringify(st && { main: st.main, sql: String(st.sql).slice(0, 80) }));
    }
  }

  // ---- U8 mssql：连接 1 → master → 表(idx1) → w46_ui_m → 外键分组新建外键 ----
  {
    let u8 = await ensureOpen('1', 0);
    u8 = u8 && (await ensureOpen('master', 0));
    u8 = u8 && (await ensureOpen('表', 1));
    u8 = u8 && (await ensureOpen('w46_ui_m', 0));
    if (!u8) fail('U8 mssql 树展开', '连接/master/表/w46_ui_m 链失败');
    else {
      const items = await ctxAt('外键', 1); // 第 2 个 外键 = mssql w46_ui_m 的（sqlite employees 的在前）
      Array.isArray(items) && items[0] === '新建外键' && items.includes('新建查询') && items.includes('刷新')
        ? pass('U8a mssql 外键分组菜单首项 [新建外键]')
        : fail('U8a mssql 菜单', JSON.stringify(items));
      if (items && items[0] === '新建外键') {
        if (!(await ctxClick('新建外键'))) fail('U8b 新建', '新建外键 未命中');
        else {
          // 冷连接下 mssql 内省需数秒：等 外键分区 + 2 行（w46_fk 1 条 + 新空行）
          const st = await waitDesignCond((d) => d.main.includes('w46_ui_m') && d.sec === '外键' && d.n === 2, 30);
          st && !st.timeout
            ? pass('U8b mssql 新建外键 → 设计 w46_ui_m·外键分区 2 行（w46_fk + 新空行）')
            : fail('U8b mssql 新建外键', JSON.stringify(st));
        }
      }
    }
  }

  // S5 控制台零错误
  await sleep(600);
  errors.length === 0 ? pass('S5 控制台零错误') : fail('S5 控制台', errors.slice(0, 3).join(' | '));

  await client.close();
})().catch((e) => { console.error('SUITE-ERROR', e && e.message); process.exit(1); });
