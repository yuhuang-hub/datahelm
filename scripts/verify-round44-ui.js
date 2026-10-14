'use strict';
// v0927.53 补全弹层滚动条统一：查询页提示弹框（CM6 .cm-tooltip-autocomplete > ul）滚动条
// 与查询页编辑器同款 —— 11px 经典常显（占布局宽 offsetWidth-clientWidth=11，修复前悬浮条占 0）、
// 圆角灰 thumb #c3cbd4 / hover #98a4b0 / active #7d8a96、暗色 #39414b 系（CSSOM 规则比对一致性）。
// 注：Chromium 的 getComputedStyle(el,'::-webkit-scrollbar') 返回空，故宽度断言用布局占位、
// 颜色断言用 document.styleSheets 规则 token 比对（弹层规则 vs .cm-scroller 同名规则相等）。
// S0 版本；U0 sqlite 新建查询；T1 弹层打开；T2 CSSOM 一致性（明/暗全变体）；T3 Esc 关 + Ctrl+Space 重开；
// T4 mssql FROM d → 8 项（DeleteLog 表+6 关键字+del 片段）溢出 130px → 占位 11px == 编辑器；
// T5 暗色下同样占位 11px + 切回浅色；S5 无控制台错误。
const CDP = require('chrome-remote-interface');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const client = await CDP({ port: Number(process.env.CDP_PORT || 9227) });
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
  const DBG = !!process.env.DBG44;

  // 等主窗揭示
  let ok = false;
  for (let i = 0; i < 40 && !ok; i += 1) {
    ok = await ev("!!document.querySelector('.top-toolbar .tb-btn')");
    if (!ok) await sleep(500);
  }

  // S0 版本
  const ver = await ev("(() => { const s = document.querySelector('.statusbar'); return s ? s.textContent : ''; })()");
  String(ver).includes('v0927.53') ? pass('S0 版本 v0927.53') : fail('S0 版本', String(ver).slice(0, 120));

  // 编辑器整体替换输入（点击 → Ctrl+A → insertText，带落地校验重试）
  const setSql = async (text) => {
    for (let i = 0; i < 3; i += 1) {
      const p = await posOf(`document.querySelector('.ant-tabs-tabpane-active .query-editor-wrap .cm-content')`);
      if (!p) return false;
      await lclick(p.x, p.y);
      await Input.dispatchKeyEvent({ type: 'rawKeyDown', modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
      await Input.dispatchKeyEvent({ type: 'keyUp', modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
      await sleep(200);
      await Input.insertText({ text });
      await sleep(300);
      const got = await ev(`[...document.querySelectorAll('.ant-tabs-tabpane-active .cm-content .cm-line')].map((l) => l.textContent).join('\\n')`);
      if (DBG) console.log('DBG setSql got=', String(got).slice(0, 140));
      if (got && got.includes(text.split('\\n')[0].slice(0, 12)) && got.includes(text.trim().slice(-12))) return true;
    }
    return false;
  };

  // 补全弹层信息：选项数 / 选中项 / 滚动几何（offsetWidth-clientWidth = 竖向滚动条占位宽）
  const popupInfo = () => ev(`(() => {
    const tip = document.querySelector('.ant-tabs-tabpane-active .cm-tooltip-autocomplete');
    if (!tip) return null;
    const ul = tip.querySelector('ul');
    if (!ul) return null;
    const sc = document.querySelector('.ant-tabs-tabpane-active .cm-scroller');
    return {
      lis: ul.querySelectorAll('li').length,
      sel: ul.querySelectorAll('li[aria-selected]').length,
      sh: ul.scrollHeight, ch: ul.clientHeight,
      ow: ul.offsetWidth, cw: ul.clientWidth,
      edOw: sc ? sc.offsetWidth : -1, edCw: sc ? sc.clientWidth : -1,
    };
  })()`);
  const waitPopup = async (minLis, tries) => {
    for (let i = 0; i < (tries || 25); i += 1) {
      const p = await popupInfo();
      if (p && !p.err && p.lis >= minLis) return p;
      await sleep(400);
    }
    return null;
  };

  // ---- U0 打开 sqlite 新建查询 ----
  const connPos = await ev(`(() => {
    const rows = [...document.querySelectorAll('.tree-wrap .ant-tree-treenode')].filter((r) => r.querySelector('.node-title') && r.getBoundingClientRect().height > 0);
    const f = rows.find((r) => r.querySelector('.node-title').textContent.trim() === '演示 SQLite 库');
    if (!f) return null;
    f.scrollIntoView({ block: 'nearest' });
    const t = f.querySelector('.node-title').getBoundingClientRect();
    return { x: Math.round(t.x + t.width / 2), y: Math.round(t.y + t.height / 2) };
  })()`);
  if (!connPos) fail('U0 定位连接节点', '未找到');
  else {
    await press(connPos.x, connPos.y, 'right', 1);
    await sleep(500);
    const mi = await posOf(`[...document.querySelectorAll('.ant-menu-item')].find((m) => m.textContent.trim() === '新建查询')`);
    if (!mi) fail('U0 右键菜单', '新建查询 项未找到');
    else {
      await lclick(mi.x, mi.y);
      let editor = null;
      for (let i = 0; i < 15 && !editor; i += 1) { editor = await posOf(`document.querySelector('.ant-tabs-tabpane-active .query-editor-wrap .cm-content')`); if (!editor) await sleep(400); }
      editor ? pass('U0 连接右键新建查询 → 编辑器就绪') : fail('U0 查询页', '编辑器未出现');
    }
  }

  // ---- T1 输入触发词 → 补全弹层打开 ----
  if (!(await setSql('SELECT d'))) fail('T1 输入 SQL', '落地失败');
  else {
    const p = await waitPopup(6, 20);
    if (DBG) console.log('DBG T1', JSON.stringify(p));
    p && p.lis >= 6 && p.sel >= 1
      ? pass('T1 补全弹层打开：' + p.lis + ' 个选项，1 项选中（' + p.sel + '）')
      : fail('T1 弹层', JSON.stringify(p).slice(0, 300));
  }

  // ---- T2 CSSOM 一致性：弹层规则 token == .cm-scroller 同名规则 ----
  const cssOm = () => ev(`(() => {
    const find = (frag, exact) => {
      for (const sh of document.styleSheets) {
        let rules; try { rules = sh.cssRules; } catch (e) { continue; }
        for (const r of rules) {
          if (!r.selectorText) continue;
          const hit = exact ? r.selectorText === frag : r.selectorText.includes(frag);
          if (!hit) continue;
          const o = { sel: r.selectorText };
          for (const p of ['width', 'height', 'background-color', 'border-radius', 'border-top-width', 'min-height']) {
            const v = r.style.getPropertyValue(p);
            if (v) o[p] = v.trim();
          }
          return o;
        }
      }
      return null;
    };
    return {
      barNew: find('.cm-tooltip-autocomplete > ul::-webkit-scrollbar', true),
      barEd: find('.cm-scroller::-webkit-scrollbar', false),
      thumbNew: find('.cm-tooltip-autocomplete > ul::-webkit-scrollbar-thumb', true),
      thumbEd: find('.cm-scroller::-webkit-scrollbar-thumb', false),
      hoverNew: find('.cm-tooltip-autocomplete > ul::-webkit-scrollbar-thumb:hover', true),
      hoverEd: find('.cm-scroller::-webkit-scrollbar-thumb:hover', false),
      activeNew: find('.cm-tooltip-autocomplete > ul::-webkit-scrollbar-thumb:active', true),
      activeEd: find('.cm-scroller::-webkit-scrollbar-thumb:active', false),
      darkNew: find('.dark .cm-tooltip-autocomplete > ul::-webkit-scrollbar-thumb', true),
      darkEd: find('.dark .cm-scroller::-webkit-scrollbar-thumb', false),
    };
  })()`);
  const C = await cssOm();
  if (DBG) console.log('DBG T2', JSON.stringify(C));
  const same = (a, b, k) => !!(a && b && a[k] && a[k] === b[k]);
  C && C.barNew && C.barNew['width'] === '11px' && same(C.barNew, C.barEd, 'width')
    && C.thumbNew && C.thumbNew['background-color'] === 'rgb(195, 203, 212)' && same(C.thumbNew, C.thumbEd, 'background-color')
    && C.thumbNew['border-top-width'] === '2px' && C.thumbNew['border-radius'] === '6px'
    ? pass('T2 基础同款：弹层条 11px == 编辑器 11px；thumb #c3cbd4 一致 + 2px 透明边 + 6px 圆角')
    : fail('T2 基础规则', JSON.stringify({ barNew: C && C.barNew, thumbNew: C && C.thumbNew, thumbEd: C && C.thumbEd }).slice(0, 400));
  same(C.hoverNew, C.hoverEd, 'background-color') && same(C.activeNew, C.activeEd, 'background-color')
    && C.darkNew && same(C.darkNew, C.darkEd, 'background-color') && C.darkNew['background-color'] === 'rgb(57, 65, 75)'
    ? pass('T2 变体同款：hover/active/暗色 thumb 颜色与编辑器全部相等（暗 #39414b）')
    : fail('T2 变体规则', JSON.stringify({ hN: C && C.hoverNew, hE: C && C.hoverEd, aN: C && C.activeNew, aE: C && C.activeEd, dN: C && C.darkNew, dE: C && C.darkEd }).slice(0, 400));

  // ---- T3 Esc 关闭 + Ctrl+Space 重开 ----
  await Input.dispatchKeyEvent({ type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await Input.dispatchKeyEvent({ type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  let closed = false;
  for (let i = 0; i < 10 && !closed; i += 1) { closed = !(await popupInfo()); if (!closed) await sleep(300); }
  if (!closed) fail('T3 Esc 关闭', '弹层仍在');
  else {
    await Input.dispatchKeyEvent({ type: 'rawKeyDown', modifiers: 2, key: ' ', code: 'Space', windowsVirtualKeyCode: 32 });
    await Input.dispatchKeyEvent({ type: 'keyUp', modifiers: 2, key: ' ', code: 'Space', windowsVirtualKeyCode: 32 });
    const p = await waitPopup(6, 15);
    p ? pass('T3 Esc 关闭弹层 + Ctrl+Space 重开（' + p.lis + ' 项）') : fail('T3 重开', '弹层未回来');
  }

  // ---- T4 mssql：FROM d → DeleteLog 表 + 6 个 d 关键字 + del 片段 = 8 项 > 10em(130px) 溢出 ----
  const connSel = await posOf(`document.querySelector('.ant-tabs-tabpane-active .q-conn-select .ant-select-selector')`);
  if (!connSel) fail('T4 连接下拉', '未找到');
  else {
    await press(connSel.x, connSel.y, 'left', 1);
    await sleep(450);
    const opt = await posOf(`[...document.querySelectorAll('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option')].find((o) => o.getAttribute('title') === '1' || o.textContent.trim() === '1')`);
    if (!opt) fail('T4 选择连接', '选项未找到');
    else {
      await lclick(opt.x, opt.y);
      let dbSel = null;
      for (let i = 0; i < 30 && !dbSel; i += 1) { dbSel = await posOf(`document.querySelector('.ant-tabs-tabpane-active .q-db-select .ant-select-selector')`); if (!dbSel) await sleep(500); }
      if (!dbSel) fail('T4 库下拉', '未出现');
      else {
        let dbopt = null;
        for (let i = 0; i < 6 && !dbopt; i += 1) {
          await sleep(1000);
          await press(dbSel.x, dbSel.y, 'left', 1);
          await sleep(450);
          dbopt = await posOf(`[...document.querySelectorAll('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option')].find((o) => (o.getAttribute('title') || o.textContent.trim()) === 'master')`);
          if (!dbopt) await press(dbSel.x, dbSel.y, 'left', 1);
        }
        if (!dbopt) fail('T4 选择库', 'master 未找到');
        else {
          // 切连接本身即自动连接（QueryTab 绑定未打开连接时 onConnect），无需树操作——
          // 树上再双击连接会走 disconnect 分支并关掉本查询页签（App.disconnect 按连接清页签）。
          // master 用户表 DeleteLog + 6 个 d 关键字 + del 片段 = 8 项 > 10em(130px)，必溢出滚动
          await lclick(dbopt.x, dbopt.y);
          await sleep(600);
          const okSql = await setSql('FROM d');
          if (!okSql) fail('T4 输入 FROM d', '落地失败');
          else {
            const p = await waitPopup(8, 30);
            if (DBG) console.log('DBG T4', JSON.stringify(p));
            const delta = p ? p.ow - p.cw : -1;
            const edDelta = p ? p.edOw - p.edCw : -1;
            p && p.lis >= 8 && p.sh > p.ch && delta === 11
              ? pass('T4 弹层 ' + p.lis + ' 项溢出滚动（' + p.sh + '>' + p.ch + '），竖条占位 ' + delta + 'px（经典常显）')
              : fail('T4 占位', JSON.stringify({ p, delta, edDelta }).slice(0, 300));
            delta === 11 && edDelta === 11
              ? pass('T4 占位宽 == 编辑器滚动条占位宽（11px == 11px，完全同款非悬浮）')
              : fail('T4 同宽比对', JSON.stringify({ delta, edDelta }));
          }
        }
      }
    }
  }

  // ---- T5 暗色：同样 11px 占位；切回浅色 ----
  const darkBtn = await posOf(`[...document.querySelectorAll('button')].find((b) => b.title === '切换深色')`);
  if (!darkBtn) fail('T5 暗色按钮', '未找到');
  else {
    await lclick(darkBtn.x, darkBtn.y);
    let dark = false;
    for (let i = 0; i < 15 && !dark; i += 1) { dark = await ev("!!document.querySelector('.app-shell.dark')"); if (!dark) await sleep(400); }
    if (!dark) fail('T5 进入暗色', '.app-shell.dark 未出现');
    else if (!(await setSql('FROM d'))) fail('T5 输入 FROM d', '落地失败');
    else {
      // 主题切换会重配编辑器扩展，insertText 不再自动激活补全 → 显式 Ctrl+Space 打开
      await Input.dispatchKeyEvent({ type: 'rawKeyDown', modifiers: 2, key: ' ', code: 'Space', windowsVirtualKeyCode: 32 });
      await Input.dispatchKeyEvent({ type: 'keyUp', modifiers: 2, key: ' ', code: 'Space', windowsVirtualKeyCode: 32 });
      const p = await waitPopup(8, 25);
      const delta = p ? p.ow - p.cw : -1;
      p && delta === 11
        ? pass('T5 暗色下弹层滚动条仍占位 11px（' + p.lis + ' 项）')
        : fail('T5 暗色占位', JSON.stringify({ p, delta }).slice(0, 300));
      const backBtn = await posOf(`[...document.querySelectorAll('button')].find((b) => b.title === '切换浅色')`);
      if (!backBtn) fail('T5 切回按钮', '未找到');
      else {
        await lclick(backBtn.x, backBtn.y);
        let light = false;
        for (let i = 0; i < 15 && !light; i += 1) { light = await ev("!!document.querySelector('.app-shell:not(.dark)')"); if (!light) await sleep(400); }
        light ? pass('T5 切回浅色') : fail('T5 切回', '仍为暗色');
      }
    }
  }

  // ---- S5 控制台错误 ----
  await sleep(600);
  errors.length === 0 ? pass('S5 无控制台错误') : fail('S5 控制台', JSON.stringify(errors.slice(0, 4)).slice(0, 300));
  await client.close();
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
