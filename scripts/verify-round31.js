'use strict';
// v0927.52 索引可视化设计器验证（9229 新实例；夹具 fx-w31：sqlite + mssql master.dbo dh_w31_t）：
//  A sqlite：索引面板 表达式键 LOWER(nm) + nm 降序 + 部分索引 WHERE qty>0 → 保存 → DDL 落库
//  B round-trip：重开设计器回读三项 → 原样「保存」→ 没有检测到变更（canon 稳定不重建）
//  C 编辑 WHERE qty>5 → 保存 → DDL 更新
//  E 键排序：下移/上移按钮交换键序（不保存）
//  D mssql：面板无 表达式键 按钮（不支持）+ 筛选索引 WHERE qty>0 → 保存 → has_filter=1；
//    重开回读规范化谓词 → 原样「保存」→ 没有检测到变更
//  S5 无控制台错误
const CDP = require('chrome-remote-interface');
const fs = require('fs');
const { execFileSync } = require('child_process');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const client = await CDP({ port: Number(process.env.CDP_PORT || 9229) });
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
  const rclick = async (x, y) => { await press(x.x !== undefined ? x.x : x, x.y !== undefined ? x.y : y, 'right', 1); await sleep(450); };
  const dblclick = async (x, y) => { await press(x.x !== undefined ? x.x : x, x.y !== undefined ? x.y : y, 'left', 1); await sleep(80); await press(x.x !== undefined ? x.x : x, x.y !== undefined ? x.y : y, 'left', 2); await sleep(1300); };
  const ctrlA = async () => {
    await Input.dispatchKeyEvent({ type: 'rawKeyDown', modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
    await Input.dispatchKeyEvent({ type: 'keyUp', modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
    await sleep(150);
  };
  const insertText = (t) => Input.insertText({ text: t });
  const pass = (n) => console.log('PASS', n);
  const fail = (n, d) => { console.log('FAIL', n, d || ''); process.exitCode = 1; };
  const DBG = !!process.env.DBG31;

  const treePos = async (title, idx = 0) => ev(`(() => { const ts = [...document.querySelectorAll('.tree-wrap .node-title')].filter((x) => x.textContent === ${JSON.stringify(title)}); const t = ts[${idx}]; if (!t) return null; t.scrollIntoView({ block: 'nearest' }); const r = t.getBoundingClientRect(); return r.height > 0 ? { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } : null; })()`);
  const waitTree = async (title, idx = 0, tries = 14) => {
    for (let i = 0; i < tries; i += 1) { const p = await treePos(title, idx); if (p) return p; await sleep(500); }
    return null;
  };
  const clickMenu = async (kw, tries = 6) => {
    for (let i = 0; i < tries; i += 1) {
      const it = await ev(`(() => { const it = [...document.querySelectorAll('.ctx-menu .ant-menu-item')].find((i) => i.textContent.replace(/\\s+/g, '').includes(${JSON.stringify(kw)})); if (!it) return null; const r = it.getBoundingClientRect(); return r.width > 0 ? { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } : null; })()`);
      if (it) { await lclick(it.x, it.y); return true; }
      await sleep(350);
    }
    return false;
  };

  // ---- 设计器辅助：全部 p 作用域（活跃主标签的外层 pane；隐藏设计器的 DOM 不可见也不会被选中）----
  const dEv = (js) => ev(`(() => { const ps = [...document.querySelectorAll('.ant-tabs-tabpane-active')].filter((x) => x.querySelector('.design-tabs')); const p = ps[0]; return p ? (${js}) : null; })()`);
  const designTabByName = async (name) => {
    const t = await dEv(`(() => { const t = [...p.querySelectorAll('.design-tabs .ant-tabs-tab')].find((x) => x.getBoundingClientRect().width > 0 && x.textContent.trim() === ${JSON.stringify(name)}); if (!t) return null; const r = t.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
    if (!t) return false;
    await lclick(t.x, t.y);
    await sleep(450);
    return true;
  };
  const clickDesignBtn = async (kw) => {
    const b = await dEv(`(() => { const b = [...p.querySelectorAll('.ant-btn')].find((x) => { const r = x.getBoundingClientRect(); return r.width > 0 && r.height > 0 && x.textContent.replace(/\\s+/g, '').includes(${JSON.stringify(kw)}); }); if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
    if (!b) return false;
    await lclick(b.x, b.y);
    return true;
  };
  const waitFields = async (tries = 18) => {
    for (let i = 0; i < tries; i += 1) {
      const n = await dEv(`[...p.querySelectorAll('.design-table .ant-table-tbody tr.ant-table-row')].filter((r) => r.getBoundingClientRect().height > 0).length`);
      if (n > 0) return true;
      await sleep(500);
    }
    return false;
  };
  const waitRows = async (tries = 14) => {
    for (let i = 0; i < tries; i += 1) {
      const n = await dEv(`[...p.querySelectorAll('.design-tabs .ant-tabs-tabpane-active .obj-table .ant-table-tbody tr.ant-table-row')].filter((r) => r.getBoundingClientRect().height > 0).length`);
      if (n > 0) return true;
      await sleep(500);
    }
    return false;
  };
  const objRow = (body) => dEv(`(() => { const row = p.querySelector('.design-tabs .ant-tabs-tabpane-active .obj-table .ant-table-tbody tr.ant-table-row'); if (!row) return null; return (${body}); })()`);
  const clickRowInput = async (placeholder) => {
    const q = await objRow(`(() => { const i = [...row.querySelectorAll('input')].find((x) => x.placeholder === ${JSON.stringify(placeholder)}); if (!i) return null; const r = i.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
    if (!q) return false;
    await lclick(q.x, q.y);
    return true;
  };
  const closeAllDropdowns = async () => {
    for (let i = 0; i < 4; i += 1) {
      if (!(await ev(`!!document.querySelector('.ant-select-dropdown:not(.ant-select-dropdown-hidden)')`))) break;
      await press(400, 320, 'left', 1);
      await sleep(400);
    }
  };
  const clickRowSelect = async (n) => {
    await closeAllDropdowns();
    const q = await objRow(`(() => { const s = [...row.querySelectorAll('.ant-select')].filter((x) => x.getBoundingClientRect().width > 0)${n}; if (!s) return null; const r = s.getBoundingClientRect(); return { x: Math.round(r.x + Math.min(r.width / 2, 70)), y: Math.round(r.y + r.height / 2) }; })()`);
    if (!q) return false;
    await lclick(q.x, q.y);
    await sleep(500);
    return true;
  };
  const pickOption = async (optText, { search = null, exact = true, tries = 6 } = {}) => {
    for (let i = 0; i < tries; i += 1) {
      if (search != null) { await insertText(search); await sleep(350); }
      const o = await ev(`(() => {
        const dd = '.ant-select-dropdown:not(.ant-select-dropdown-hidden)';
        const live = [...document.querySelectorAll(dd)].filter((d) => !/ant-slide-up-leave/.test(d.className));
        const list = live.length ? live : [...document.querySelectorAll(dd)];
        const o = list.flatMap((d) => [...d.querySelectorAll('.ant-select-item-option')]).find((x) => { const t = x.textContent.replace(/\\s+/g, ''); return ${exact ? `t === ${JSON.stringify(optText)}` : `t.includes(${JSON.stringify(optText)})`}; });
        if (!o) return null;
        const r = o.getBoundingClientRect();
        if (r.width < 20 || r.height < 16) return { bad: true };
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      })()`);
      if (o && !o.bad && o.x != null) { await lclick(o.x, o.y); await sleep(320); return true; }
      await sleep(400);
    }
    return false;
  };
  // 面板键列表：{col=普通列名, expr=表达式输入值, dir}
  const dirItems = () => dEv(`(() => {
    const items = [...p.querySelectorAll('.design-tabs .ant-tabs-tabpane-active .bar-panel:not(.hint) .dir-item')];
    return items.map((it) => ({
      col: ((it.querySelector('code') || {}).textContent) || '',
      expr: it.querySelector('input[data-dh-idx="expr"]') ? it.querySelector('input[data-dh-idx="expr"]').value : null,
      dir: ((it.querySelector('.ant-select-selection-item') || {}).textContent || '').replace(/\\s+/g, ''),
    }));
  })()`);
  const whereValue = () => dEv(`(() => { const i = p.querySelector('.design-tabs .ant-tabs-tabpane-active [data-dh-idx="where"]'); return i ? i.value : null; })()`);
  const posInPanel = async (sel) => {
    const q = await dEv(`(() => { const el = [...p.querySelectorAll(${JSON.stringify(sel)})].find((x) => x.getBoundingClientRect().height > 0); if (!el) return null; el.scrollIntoView({ block: 'nearest' }); const r = el.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
    return q && !q.err ? q : null;
  };
  // 保存 = 直接执行；完成信号 = 内层页签回到「字段」
  const saveAndExecute = async () => {
    if (!(await clickDesignBtn('保存'))) return { err: 'no-save-btn' };
    let back = false;
    for (let i = 0; i < 26 && !back; i += 1) {
      await sleep(450);
      if (i >= 2) back = await dEv(`(() => { const t = p.querySelector('.design-tabs .ant-tabs-tab-active'); return t ? t.textContent.trim() === '字段' : false; })()`);
    }
    await sleep(1500);
    return { ok: back };
  };
  const waitMsgText = async (kw, tries = 20) => {
    for (let i = 0; i < tries; i += 1) {
      const t = await ev(`[...document.querySelectorAll('.ant-message-notice-content')].some((x) => x.textContent.includes(${JSON.stringify(kw)}))`);
      if (t) return true;
      await sleep(300);
    }
    return false;
  };
  const waitMsgGone = async (tries = 20) => {
    for (let i = 0; i < tries; i += 1) {
      if (!(await ev(`!!document.querySelector('.ant-message-notice')`))) return true;
      await sleep(300);
    }
    return false;
  };
  const fx = (st) => execFileSync('node', ['D:/DataHelm/scripts/fx/fx-w31.js', st], { cwd: 'D:/DataHelm', encoding: 'utf8' });
  const fxJson = (st, tag) => {
    const out = fx(st);
    const line = out.split('\n').find((l) => l.startsWith(tag + ' '));
    return line ? JSON.parse(line.slice(tag.length + 1)) : null;
  };

  // ---- 等主窗揭示 ----
  let ok = false;
  for (let i = 0; i < 40 && !ok; i += 1) {
    ok = await ev("!!document.querySelector('.top-toolbar .tb-btn')");
    if (!ok) await sleep(500);
  }
  const ver = await ev("(() => { const s = document.querySelector('.statusbar'); return s ? s.textContent : ''; })()");
  /v0927\.52/.test(ver) ? pass('S0 版本 v0927.52') : fail('S0 版本', String(ver).slice(0, 120));

  // ================= A：sqlite 表达式键 + 降序 + 部分索引 =================
  let p = await waitTree('演示 SQLite 库', 0, 10);
  if (!p) fail('A1 前置', 'sqlite 连接行未找到');
  else {
    await dblclick(p.x, p.y);
    p = await waitTree('表');
    if (p) await dblclick(p.x, p.y);
    p = await waitTree('dh_w31_t');
    if (!p) fail('A1 前置', 'dh_w31_t 未出现');
    else {
      await rclick(p.x, p.y);
      if (!(await clickMenu('设计表'))) fail('A1 前置', '设计表菜单未找到');
      else if (!(await waitFields())) fail('A1 前置', '字段未加载');
      else {
        const opened = await designTabByName('索引');
        if (!opened) fail('A1 前置', '索引页签未找到');
        else if (!(await clickDesignBtn('添加索引'))) fail('A1 添加索引', '按钮未找到');
        else {
          await sleep(350);
          const named = await clickRowInput('idx_name');
          if (named) await insertText('dh_w31_ix1');
          const picked = await clickRowSelect('[0]');
          if (picked) { await insertText('nm'); await pickOption('nm'); }
          await closeAllDropdowns();
          await clickRowInput('idx_name'); // 触发行选中 → 面板
          await sleep(350);
          named && picked ? pass('A1 新索引 dh_w31_ix1 + 字段 nm') : fail('A1 新索引', JSON.stringify({ named, picked }));
        }
      }
    }
  }

  // A2 面板：nm 设降序
  const dirSel = await posInPanel('.bar-panel:not(.hint) .dir-item .ant-select');
  if (!dirSel) fail('A2 前置', '排序面板未出现');
  else {
    await lclick(dirSel.x, dirSel.y);
    await sleep(450);
    if (await pickOption('降序')) {
      await closeAllDropdowns();
      let items = await dirItems();
      if (DBG) console.log('DBG A2 items=', JSON.stringify(items));
      items && items[0] && items[0].col === 'nm' && items[0].dir === '降序' ? pass('A2 面板设置 nm=降序') : fail('A2 降序', JSON.stringify(items));
    } else fail('A2 降序选项', '未找到');
  }

  // A3 表达式键
  const addExpr = await posInPanel('[data-dh-idx="addexpr"]');
  if (!addExpr) fail('A3 前置', '+ 表达式键 按钮未找到');
  else {
    await lclick(addExpr.x, addExpr.y);
    await sleep(350);
    let items = await dirItems();
    if (DBG) console.log('DBG A3 items=', JSON.stringify(items));
    const added = items && items.length === 2 && items[1].expr === '';
    const inp = await posInPanel('.dir-item input[data-dh-idx="expr"]');
    if (added && inp) {
      await lclick(inp.x, inp.y);
      await insertText('LOWER(nm)');
      await sleep(250);
      items = await dirItems();
      items && items[1] && items[1].expr === 'LOWER(nm)' ? pass('A3 添加表达式键 LOWER(nm)') : fail('A3 表达式落地', JSON.stringify(items));
    } else fail('A3 表达式键', JSON.stringify({ added, items }));
  }

  // A4 部分索引 WHERE
  const wIn = await posInPanel('[data-dh-idx="where"]');
  if (!wIn) fail('A4 前置', 'WHERE 输入未找到（sqlite 应支持）');
  else {
    await lclick(wIn.x, wIn.y);
    await insertText('qty > 0');
    await sleep(250);
    const v = await whereValue();
    v === 'qty > 0' ? pass('A4 部分索引 WHERE qty > 0') : fail('A4 WHERE', JSON.stringify(v));
  }

  // A5 保存 → 落库 DDL 校验
  const s1 = await saveAndExecute();
  if (!s1.ok) fail('A5 保存', '未回到字段页 ' + JSON.stringify(s1));
  else {
    const js = fxJson('verify-s', 'JSON-S');
    if (DBG) console.log('DBG A5 JSON-S=', JSON.stringify(js));
    const ix = (js || []).find((x) => x.name === 'dh_w31_ix1');
    const sql = ix ? String(ix.sql || '') : '';
    sql.includes('"nm" DESC') && sql.includes('LOWER(nm)') && /WHERE\s+qty\s*>\s*0/.test(sql)
      ? pass('A5 DDL 落库：nm DESC + LOWER(nm) + WHERE qty > 0')
      : fail('A5 DDL', sql.slice(0, 220) || JSON.stringify(js));
  }

  // ================= B：round-trip 回读 + 原样保存无假差异 =================
  let bOk = false;
  if (await designTabByName('索引')) {
    if (await waitRows()) {
      await clickRowInput('idx_name');
      await sleep(350);
      const items = await dirItems();
      const wv = await whereValue();
      if (DBG) console.log('DBG B1 items=', JSON.stringify(items), 'where=', wv);
      items && items.length === 2 && items[0].col === 'nm' && items[0].dir === '降序' && items[1].expr === 'LOWER(nm)' && wv === 'qty > 0'
        ? pass('B1 回读：nm(降序) + LOWER(nm) + WHERE qty > 0')
        : fail('B1 回读', JSON.stringify({ items, wv }));
      bOk = true;
    } else fail('B1 前置', '索引行未出现');
  } else fail('B1 前置', '索引页签未找到');

  if (bOk) {
    if (await clickDesignBtn('保存')) {
      const t = await waitMsgText('没有检测到变更');
      t ? pass('B2 原样保存：没有检测到变更（canon 稳定不重建）') : fail('B2 无假差异', 'toast 未出现');
      await waitMsgGone();
      const still = await dEv(`(() => { const x = p.querySelector('.design-tabs .ant-tabs-tab-active'); return x ? x.textContent.trim() : null; })()`);
      still === '索引' ? pass('B2b 停留索引页（未触发执行路径）') : fail('B2b 页签', String(still));
    } else fail('B2 前置', '保存按钮未找到');
  }

  // ================= C：编辑 WHERE =================
  const wIn2 = await posInPanel('[data-dh-idx="where"]');
  if (!wIn2) fail('C1 前置', 'WHERE 输入未找到');
  else {
    await lclick(wIn2.x, wIn2.y);
    await ctrlA();
    await insertText('qty > 5');
    await sleep(250);
    const s2 = await saveAndExecute();
    if (!s2.ok) fail('C1 保存', '未回到字段页');
    else {
      const js = fxJson('verify-s', 'JSON-S');
      const ix = (js || []).find((x) => x.name === 'dh_w31_ix1');
      const sql = ix ? String(ix.sql || '') : '';
      /WHERE\s+qty\s*>\s*5/.test(sql) && !/qty\s*>\s*0/.test(sql)
        ? pass('C1 WHERE 编辑为 qty > 5 → 重建落库')
        : fail('C1 DDL', sql.slice(0, 220));
    }
  }

  // ================= E：键排序（下移/上移）=================
  let eOk = false;
  if (await designTabByName('索引')) {
    if (await waitRows()) {
      await clickRowInput('idx_name');
      await sleep(350);
      const before = await dirItems();
      if (DBG) console.log('DBG E before=', JSON.stringify(before));
      eOk = before && before.length === 2 && before[0].col === 'nm';
      if (!eOk) fail('E 前置', JSON.stringify(before));
    } else fail('E 前置', '索引行未出现');
  } else fail('E 前置', '索引页签未找到');
  if (eOk) {
    const down = await posInPanel('.dir-item [data-dh-idx="movedown"]:not([disabled])');
    if (!down) fail('E1 前置', '下移按钮未找到');
    else {
      await lclick(down.x, down.y);
      await sleep(300);
      const after = await dirItems();
      if (DBG) console.log('DBG E after-down=', JSON.stringify(after));
      after && after[0] && after[0].expr === 'LOWER(nm)' && after[1] && after[1].col === 'nm'
        ? pass('E1 下移：键序 [nm, LOWER(nm)] → [LOWER(nm), nm]')
        : fail('E1 键序', JSON.stringify(after));
      const ups = await dEv(`(() => { const bs = [...p.querySelectorAll('.design-tabs .ant-tabs-tabpane-active .dir-item [data-dh-idx="moveup"]:not([disabled])')]; return bs.map((b) => { const r = b.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; }); })()`);
      if (ups && ups.length) {
        await lclick(ups[ups.length - 1].x, ups[ups.length - 1].y);
        await sleep(300);
        const back = await dirItems();
        back && back[0] && back[0].col === 'nm' && back[1] && back[1].expr === 'LOWER(nm)'
          ? pass('E2 上移还原键序 [nm, LOWER(nm)]（未保存）')
          : fail('E2 键序', JSON.stringify(back));
      } else fail('E2 前置', '上移按钮未找到');
    }
  }

  // ================= D：mssql 筛选索引 =================
  // 收起 sqlite 连接，避免同名 dh_w31_t/表 分组干扰定位
  let cp = await waitTree('演示 SQLite 库', 0, 6);
  if (cp) {
    await dblclick(cp.x, cp.y);
    for (let i = 0; i < 12; i += 1) {
      const gone = await ev(`![...document.querySelectorAll('.tree-wrap .node-title')].some((x) => x.textContent === 'employees' && x.getBoundingClientRect().height > 0)`);
      if (gone) break;
      await sleep(400);
    }
  }
  p = await waitTree('1', 0, 10);
  if (!p) fail('D1 前置', 'mssql 连接行未找到');
  else {
    await dblclick(p.x, p.y);
    p = await waitTree('master');
    if (p) { await dblclick(p.x, p.y); p = await waitTree('表'); }
    if (p) { await dblclick(p.x, p.y); p = await waitTree('dh_w31_t'); }
    if (!p) fail('D1 前置', 'mssql dh_w31_t 未出现');
    else {
      await rclick(p.x, p.y);
      if (!(await clickMenu('设计表'))) fail('D1 前置', '设计表菜单未找到');
      else if (!(await waitFields())) fail('D1 前置', '字段未加载（mssql）');
      else if (!(await designTabByName('索引'))) fail('D1 前置', '索引页签未找到（mssql）');
      else if (!(await clickDesignBtn('添加索引'))) fail('D1 前置', '添加索引未找到');
      else {
        await sleep(350);
        const named = await clickRowInput('idx_name');
        if (named) await insertText('dh_w31_mix');
        const picked = await clickRowSelect('[0]');
        if (picked) { await insertText('nm'); await pickOption('nm'); }
        await closeAllDropdowns();
        await clickRowInput('idx_name');
        await sleep(350);
        if (!named || !picked) fail('D1 新索引', JSON.stringify({ named, picked }));
        else {
          // D2a mssql 不支持表达式键：无 + 表达式键 按钮；筛选索引 WHERE 输入存在
          const hasAdd = await dEv(`(() => { const b = p.querySelector('.design-tabs .ant-tabs-tabpane-active [data-dh-idx="addexpr"]'); return !!b; })()`);
          const wIn3 = await posInPanel('[data-dh-idx="where"]');
          !hasAdd && !!wIn3 ? pass('D2a mssql：无表达式键按钮 + WHERE（筛选索引）输入存在') : fail('D2a 方言能力', JSON.stringify({ hasAdd, where: !!wIn3 }));
          // D2b 填 WHERE → 保存 → has_filter=1
          if (wIn3) {
            await lclick(wIn3.x, wIn3.y);
            await insertText('qty > 0');
            await sleep(250);
            const s3 = await saveAndExecute();
            if (!s3.ok) fail('D2b 保存', '未回到字段页');
            else {
              const jm = fxJson('verify-m', 'JSON-M');
              if (DBG) console.log('DBG D2b JSON-M=', JSON.stringify(jm));
              const row = (jm || []).find((r) => r[0] === 'dh_w31_mix');
              row && Number(row[1]) === 1 && String(row[2]).includes('qty') && String(row[3]) === 'nm'
                ? pass('D2b 筛选索引落库：has_filter=1 · 谓词含 qty · 键=nm')
                : fail('D2b has_filter', JSON.stringify(row || jm));
            }
          }
        }
      }
    }
  }

  // D3/D4 mssql 规范化谓词回读 + 原样保存无假差异
  if (await designTabByName('索引')) {
    if (await waitRows()) {
      await clickRowInput('idx_name');
      await sleep(350);
      const wv = await whereValue();
      if (DBG) console.log('DBG D3 where=', JSON.stringify(wv));
      wv && wv.includes('qty')
        ? pass('D3 回读筛选谓词（mssql 规范化文本：' + String(wv).slice(0, 30) + '）')
        : fail('D3 回读', JSON.stringify(wv));
      if (await clickDesignBtn('保存')) {
        const t = await waitMsgText('没有检测到变更');
        t ? pass('D4 原样保存：没有检测到变更（规范化文本 canon 稳定）') : fail('D4 无假差异', 'toast 未出现');
        await waitMsgGone();
      } else fail('D4 前置', '保存按钮未找到');
    } else fail('D3 前置', '索引行未出现');
  } else fail('D3 前置', '索引页签未找到');

  // S5 控制台错误
  await sleep(600);
  errors.length === 0 ? pass('S5 无控制台错误') : fail('S5 控制台错误', errors.slice(0, 4).join(' | ').slice(0, 300));

  console.log('ROUND31-DONE');
  try { await client.close(); } catch {}
  process.exit(process.exitCode || 0);
})().catch((e) => {
  console.error('FATAL', e.message);
  process.exit(1);
});
