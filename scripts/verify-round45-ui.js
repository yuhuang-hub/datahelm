'use strict';
// v0927.52 深色查询编辑器修复：主题按钮浅色态太阳图标（原为数据库图标）；
// dark 由 App 直传 QueryTab/ObjEditTab → SqlEditor 套 oneDark（此前 document.body.closest('.dark')
// 恒 null → 深色下编辑器仍白底、补全弹层白底白字不可读）。本套件用计算值锁定：
// 浅色 编辑器 #fff/图标 anticon-sun；深色 编辑器 #282c34+象牙 #abb2bf、槽同底、占位符 #5c6370、
// 分隔线 #2a2f36、弹层 #353a42 底（选中 #2c313a 象牙字、未选中白字）、弹层滚动条占位 11px（v0927.52 回归）、
// ObjEditTab（新建视图模板）同样深底；切回浅色还原白底 + 太阳图标。
// S0 版本；U0 sqlite 新建查询；T9 前树展开走 switcher（会话已开时双击连接=断开会话并关页签）。
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
  const dblclick = async (x, y) => { await press(x, y, 'left', 2); await sleep(700); };
  const posOf = async (expr) => {
    const p = await ev(`(() => { const el = ${expr}; if (!el) return null; el.scrollIntoView({ block: 'nearest' }); const r = el.getBoundingClientRect(); return r.height > 0 || r.width > 0 ? { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } : null; })()`);
    return p && !p.err ? p : null;
  };
  const pass = (n) => console.log('PASS', n);
  const fail = (n, d) => { console.log('FAIL', n, d || ''); process.exitCode = 1; };
  const DBG = !!process.env.DBG45;
  const titlePos = (t) => posOf(`(() => { const rows = [...document.querySelectorAll('.tree-wrap .ant-tree-treenode')].filter((r) => r.querySelector('.node-title') && r.getBoundingClientRect().height > 0); const f = rows.find((r) => r.querySelector('.node-title').textContent.trim() === ${JSON.stringify(t)}); return f ? f.querySelector('.node-title') : null; })()`);

  // 等主窗揭示
  let ok = false;
  for (let i = 0; i < 40 && !ok; i += 1) {
    ok = await ev("!!document.querySelector('.top-toolbar .tb-btn')");
    if (!ok) await sleep(500);
  }

  // S0 版本
  const ver = await ev("(() => { const s = document.querySelector('.statusbar'); return s ? s.textContent : ''; })()");
  String(ver).includes('v0927.52') ? pass('S0 版本 v0927.52') : fail('S0 版本', String(ver).slice(0, 120));

  // ---- U0 打开 sqlite 新建查询（右键连接菜单，不动树展开态）----
  const connPos = await titlePos('演示 SQLite 库');
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

  const edInfo = () => ev(`(() => {
    const e = document.querySelector('.ant-tabs-tabpane-active .query-editor-wrap .cm-editor');
    if (!e) return null;
    const c = e.querySelector('.cm-content');
    const g = e.querySelector('.cm-gutters');
    const w = document.querySelector('.ant-tabs-tabpane-active .query-editor-wrap');
    return { bg: getComputedStyle(e).backgroundColor, fg: c ? getComputedStyle(c).color : null,
             gut: g ? getComputedStyle(g).backgroundColor : null, border: w ? getComputedStyle(w).borderBottomColor : null };
  })()`);

  // ---- T1 浅色主题按钮图标 = 太阳（修复前是数据库图标）----
  const sunIcon = await ev(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.title === '切换深色'); if (!b) return null; const i = b.querySelector('.anticon'); return i ? i.className : ''; })()`);
  (sunIcon && String(sunIcon).includes('anticon-sun'))
    ? pass('T1 浅色主题按钮图标为太阳 anticon-sun')
    : fail('T1 浅色图标', String(sunIcon));

  // ---- T2 浅色编辑器白底 ----
  await sleep(400);
  const li0 = await edInfo();
  if (DBG) console.log('DBG T2', JSON.stringify(li0));
  li0 && !li0.err && li0.bg === 'rgb(255, 255, 255)'
    ? pass('T2 浅色编辑器白底 rgb(255,255,255)')
    : fail('T2 浅色编辑器', JSON.stringify(li0).slice(0, 200));

  // ---- T3 切深色：编辑器 oneDark #282c34 底 + 象牙 #abb2bf 字 + 槽同底 ----
  const darkBtn = await posOf(`[...document.querySelectorAll('button')].find((b) => b.title === '切换深色')`);
  if (!darkBtn) fail('T3 暗色按钮', '未找到');
  else {
    await lclick(darkBtn.x, darkBtn.y);
    let dark = false;
    for (let i = 0; i < 15 && !dark; i += 1) { dark = await ev("!!document.querySelector('.app-shell.dark')"); if (!dark) await sleep(400); }
    if (!dark) fail('T3 进入暗色', '.app-shell.dark 未出现');
    else {
      await sleep(700);
      const di = await edInfo();
      if (DBG) console.log('DBG T3', JSON.stringify(di));
      di && !di.err && di.bg === 'rgb(40, 44, 52)' && di.fg === 'rgb(171, 178, 191)'
        ? pass('T3 深色编辑器 #282c34 底 + 象牙 #abb2bf 字（oneDark 生效，修复前白底）')
        : fail('T3 深色编辑器', JSON.stringify(di).slice(0, 200));
      di && !di.err && di.gut === 'rgb(40, 44, 52)'
        ? pass('T3 深色行号槽同 #282c34 底')
        : fail('T3 行号槽', JSON.stringify(di && di.gut));

      // ---- T4 深色占位符 #5c6370：新建页有种子注释文本，先清空文档占位符才出现 ----
      let ph = null;
      {
        const fp = await posOf(`document.querySelector('.ant-tabs-tabpane-active .query-editor-wrap .cm-content')`);
        if (!fp) fail('T4 聚焦编辑器', '未找到');
        else {
          await lclick(fp.x, fp.y);
          await Input.dispatchKeyEvent({ type: 'rawKeyDown', modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
          await Input.dispatchKeyEvent({ type: 'keyUp', modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
          await sleep(150);
          await Input.dispatchKeyEvent({ type: 'rawKeyDown', key: 'Delete', windowsVirtualKeyCode: 46 });
          await Input.dispatchKeyEvent({ type: 'keyUp', key: 'Delete', windowsVirtualKeyCode: 46 });
          for (let a = 0; a < 4 && !ph; a += 1) {
            await sleep(350);
            ph = await ev(`(() => { const el = document.querySelector('.ant-tabs-tabpane-active .cm-placeholder'); return el ? getComputedStyle(el).color : null; })()`);
          }
        }
      }
      if (DBG) console.log('DBG T4 ph', ph);
      ph === 'rgb(92, 99, 112)'
        ? pass('T4 深色占位符 #5c6370（清空文档后显示）')
        : fail('T4 占位符', String(ph));

      // ---- T5 深色补全弹层：FROM i → 8 项（INSERT/INTO/IS/IN/INDEX/INNER + ins/ij 片段）→ #353a42 深底 ----
      const focus = async () => {
        const p = await posOf(`document.querySelector('.ant-tabs-tabpane-active .query-editor-wrap .cm-content')`);
        if (!p) return false;
        await lclick(p.x, p.y);
        await Input.dispatchKeyEvent({ type: 'rawKeyDown', modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
        await Input.dispatchKeyEvent({ type: 'keyUp', modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
        await sleep(150);
        return true;
      };
      if (!(await focus())) fail('T5 聚焦编辑器', '失败');
      else {
        await Input.insertText({ text: 'FROM i' });
        await sleep(350);
        // 主题切换会重配编辑器扩展 → insertText 不再自动触发补全，显式 Ctrl+Space
        await Input.dispatchKeyEvent({ type: 'rawKeyDown', modifiers: 2, key: ' ', code: 'Space', windowsVirtualKeyCode: 32 });
        await Input.dispatchKeyEvent({ type: 'keyUp', modifiers: 2, key: ' ', code: 'Space', windowsVirtualKeyCode: 32 });
        let pop = null;
        for (let i = 0; i < 30 && !pop; i += 1) {
          const p = await ev(`(() => {
            const tip = document.querySelector('.ant-tabs-tabpane-active .cm-tooltip-autocomplete');
            if (!tip) return null;
            const ul = tip.querySelector('ul'); if (!ul) return null;
            const sel = ul.querySelector('li[aria-selected]');
            const norm = ul.querySelector('li:not([aria-selected])');
            const sc = document.querySelector('.ant-tabs-tabpane-active .cm-scroller');
            return { tipBg: getComputedStyle(tip).backgroundColor, lis: ul.querySelectorAll('li').length,
                     selBg: sel ? getComputedStyle(sel).backgroundColor : null, selFg: sel ? getComputedStyle(sel).color : null,
                     normFg: norm ? getComputedStyle(norm).color : null,
                     ow: ul.offsetWidth, cw: ul.clientWidth, sh: ul.scrollHeight, ch: ul.clientHeight,
                     edOw: sc ? sc.offsetWidth : -1, edCw: sc ? sc.clientWidth : -1 };
          })()`);
          if (p && !p.err && p.lis >= 8) pop = p; else await sleep(400);
        }
        if (DBG) console.log('DBG T5', JSON.stringify(pop));
        if (!pop) fail('T5 弹层', '未打开或不足 8 项');
        else {
          pop.tipBg === 'rgb(53, 58, 66)'
            ? pass('T5 深色弹层 #353a42 底（oneDark，修复前白底白字）· ' + pop.lis + ' 项')
            : fail('T5 弹层底色', pop.tipBg);
          (pop.selBg === 'rgb(44, 49, 58)' && pop.selFg === 'rgb(171, 178, 191)' && pop.normFg === 'rgb(255, 255, 255)')
            ? pass('T5 选中项 #2c313a+象牙字，未选中项白字（深底可读）')
            : fail('T5 选项配色', JSON.stringify({ s: pop.selBg, f: pop.selFg, n: pop.normFg }));

          // ---- T6 弹层滚动条占位 11px == 编辑器（v0927.52 回归守卫）----
          const delta = pop.ow - pop.cw;
          const edDelta = pop.edOw - pop.edCw;
          pop.sh > pop.ch && delta === 11
            ? pass('T6 弹层 ' + pop.lis + ' 项溢出滚动，占位 ' + delta + 'px（经典常显回归）')
            : fail('T6 弹层占位', JSON.stringify({ delta, sh: pop.sh, ch: pop.ch }));
          delta === 11 && edDelta === 11
            ? pass('T6 弹层占位宽 == 编辑器滚动条占位宽（11 == 11）')
            : fail('T6 同宽比对', JSON.stringify({ delta, edDelta }));
        }
        await Input.dispatchKeyEvent({ type: 'rawKeyDown', key: 'Escape', windowsVirtualKeyCode: 27 });
        await Input.dispatchKeyEvent({ type: 'keyUp', key: 'Escape', windowsVirtualKeyCode: 27 });
        await sleep(300);
      }

      // ---- T7 深色编辑区分隔线 #2a2f36 + 暗色态月亮图标 ----
      const bi = await edInfo();
      const moonIcon = await ev(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.title === '切换浅色'); if (!b) return null; const i = b.querySelector('.anticon'); return i ? i.className : ''; })()`);
      bi && !bi.err && bi.border === 'rgb(42, 47, 54)'
        ? pass('T7 深色编辑区分隔线 #2a2f36')
        : fail('T7 分隔线', JSON.stringify(bi && bi.border));
      moonIcon && String(moonIcon).includes('anticon-moon')
        ? pass('T7 暗色态按钮图标为月亮 anticon-moon')
        : fail('T7 月亮图标', String(moonIcon));

      // ---- T8 ObjEditTab（新建视图模板页）深色编辑器 #282c34 ----
      // 树展开走 switcher（会话已开时双击连接=断开会话并关页签）
      const swPos = await ev(`(() => {
        const rows = [...document.querySelectorAll('.tree-wrap .ant-tree-treenode')].filter((r) => r.querySelector('.node-title') && r.getBoundingClientRect().height > 0);
        const f = rows.find((r) => r.querySelector('.node-title').textContent.trim() === '演示 SQLite 库');
        if (!f) return null;
        const sw = f.querySelector('.ant-tree-switcher'); if (!sw) return null;
        const r = sw.getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), open: sw.className.includes('-open') || sw.className.includes('open') };
      })()`);
      if (!swPos) fail('T8 连接节点', 'switcher 未找到');
      else {
        if (!swPos.open) { await lclick(swPos.x, swPos.y); await sleep(700); }
        let vpos = null;
        for (let i = 0; i < 10 && !vpos; i += 1) { vpos = await titlePos('视图'); if (!vpos) await sleep(400); }
        if (!vpos) fail('T8 视图分类', '树上未出现');
        else {
          await press(vpos.x, vpos.y, 'right', 1);
          await sleep(500);
          const nm = await posOf(`[...document.querySelectorAll('.ant-menu-item')].find((m) => m.textContent.trim() === '新建视图')`);
          if (!nm) fail('T8 右键菜单', '新建视图 项未找到');
          else {
            await lclick(nm.x, nm.y);
            let oe = null;
            for (let i = 0; i < 15 && !oe; i += 1) { oe = await ev(`(() => { const e = document.querySelector('.ant-tabs-tabpane-active .query-editor-wrap .cm-editor'); return e ? getComputedStyle(e).backgroundColor : null; })()`); if (!oe) await sleep(400); }
            if (DBG) console.log('DBG T8 objedit bg', oe);
            oe === 'rgb(40, 44, 52)'
              ? pass('T8 ObjEditTab（新建视图模板）深色编辑器 #282c34（dark 直传修复）')
              : fail('T8 ObjEditTab', String(oe));
          }
        }
      }

      // ---- T9 切回浅色：白底还原 + 太阳图标回归 ----
      const qTab = await posOf(`[...document.querySelectorAll('.ant-tabs-tab')].find((t) => t.textContent.includes('查询'))`);
      if (qTab) { await lclick(qTab.x, qTab.y); await sleep(500); }
      const lightBtn = await posOf(`[...document.querySelectorAll('button')].find((b) => b.title === '切换浅色')`);
      if (!lightBtn) fail('T9 浅色按钮', '切换浅色 未找到');
      else {
        await lclick(lightBtn.x, lightBtn.y);
        let light = false;
        for (let i = 0; i < 15 && !light; i += 1) { light = !(await ev("!!document.querySelector('.app-shell.dark')")); if (!light) await sleep(400); }
        if (!light) fail('T9 退回浅色', '.app-shell.dark 仍在');
        else {
          let lb = null;
          for (let i = 0; i < 10 && !lb; i += 1) { const x = await edInfo(); if (x && !x.err && x.bg) lb = x; else await sleep(400); }
          if (DBG) console.log('DBG T9', JSON.stringify(lb));
          lb && lb.bg === 'rgb(255, 255, 255)'
            ? pass('T9 切回浅色编辑器还原白底')
            : fail('T9 浅色还原', JSON.stringify(lb && lb.bg));
          const sun2 = await ev(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.title === '切换深色'); if (!b) return null; const i = b.querySelector('.anticon'); return i ? i.className : ''; })()`);
          sun2 && String(sun2).includes('anticon-sun')
            ? pass('T9 浅色态按钮图标回归太阳')
            : fail('T9 图标回归', String(sun2));
        }
      }
    }
  }

  // S5 无控制台错误
  const errs = errors.filter((x) => !/favicon|DevTools/.test(x));
  errs.length ? fail('S5 控制台错误', JSON.stringify(errs.slice(0, 3))) : pass('S5 无控制台错误');

  await client.close();
})().catch((e) => { console.error('SUITE-ERR', e.message); process.exit(1); });
