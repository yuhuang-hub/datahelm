'use strict';
// v0927.53 电子绕核 Splash + Ctrl+S 保存 + 关窗未保存确认（DH_SPLASH_MS=8000 实例，9228）：
//  SP1 Splash 无背景原子：轨道/核静止、三颗电子 offset-path 绕核运动（无文字/无背景）
//  SP2 dhSplashClose → 原子放大淡出 → 窗口自然销毁；日志 shown→closed ≥800ms
//  K1 Ctrl+S 未命名查询 → 弹「保存查询」→ 命名保存成功
//  K2 Ctrl+S 已保存查询 → 直接快存（不弹窗）
//  W1 有脏标签关窗 → 「有未保存的修改」确认；取消 → 应用存活
//  W2 关闭脏页签（放弃并关闭）→ 无脏后再关窗 → 应用直接退出（端口释放）
const CDP = require('chrome-remote-interface');
const fs = require('fs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const pass = (n) => console.log('PASS', n);
  const fail = (n, d) => { console.log('FAIL', n, d || ''); process.exitCode = 1; };

  // ---- Splash 阶段（独立 target；ws 偶发拒绝，重试几次）----
  // List/target 都做轮询重试：起套件太早 ws 会 CLOSE（readyState 3），太晚会错过 8s Splash 窗口
  let list = [];
  for (let i = 0; i < 12 && !(list.length && list.some((t) => t.type === 'page' && t.url.includes('splash.html'))); i += 1) {
    try { list = await CDP.List({ port: 9228 }); } catch { await sleep(600); }
    if (!(list.length && list.some((t) => t.type === 'page' && t.url.includes('splash.html')))) await sleep(500);
  }
  let splashT = list.find((t) => t.type === 'page' && t.url.includes('splash.html'));
  if (!splashT) { fail('SP1 电子绕核原子动画', 'no splash target'); }
  else {
    let sc = null;
    for (let i = 0; i < 4 && !sc; i += 1) {
      try { sc = await CDP({ target: splashT.webSocketDebuggerUrl }); } catch { await sleep(600); }
    }
    if (!sc) { fail('SP1 电子绕核原子动画', 'splash ws refused x4'); sc = null; }
    else {
    const { Page, Runtime } = sc;
    await Page.enable();
    await Runtime.enable();
    await sleep(1200);
    const snap = () => Runtime.evaluate({
      expression: `(() => {
        const atom = document.querySelector('.atom');
        const body = document.body;
        const svg = atom ? atom.querySelector('svg') : null;
        const els = [...document.querySelectorAll('.electron')];
        const nuc = atom ? atom.querySelector('circle') : null;
        return {
          hasAtom: !!atom,
          noPlate: svg ? !svg.querySelector('rect') : null,
          orbits: svg ? svg.querySelectorAll('ellipse').length : 0,
          eCount: els.length,
          eMoving: els.length ? els.map((e) => { const c = getComputedStyle(e); return { op: c.offsetPath, an: c.animationName }; }) : [],
          atomSize: atom ? Math.round(atom.getBoundingClientRect().width) : 0,
          bgAtom: atom ? getComputedStyle(atom).backgroundColor : null,
          text: body.innerText.trim(),
          bgStage: getComputedStyle(document.querySelector('.stage')).backgroundColor,
          nucPos: nuc ? (() => { const r = nuc.getBoundingClientRect(); return Math.round(r.x) + ',' + Math.round(r.y); })() : null,
          ePos: els.map((e) => { const r = e.getBoundingClientRect(); return Math.round(r.x) + ',' + Math.round(r.y); }),
        };
      })()`,
      returnByValue: true,
    }).then((x) => x.result.value);
    // 电子绕核判定用「相对核的偏移」：窗口刚显示时整体位置可能仍在屏幕上漂移，相对坐标不受影响
    const st = await snap();
    await sleep(700);
    const st2 = await snap();
    const rel = (st) => st.ePos.map((p) => {
      const [ex, ey] = p.split(',').map(Number);
      const [nx, ny] = String(st.nucPos).split(',').map(Number);
      return Math.round(ex - nx) + ',' + Math.round(ey - ny);
    });
    const r1 = rel(st); const r2 = rel(st2);
    const moved = r1.filter((p, i) => p !== (r2[i] || '')).length;
    if (st.hasAtom && st.noPlate && st.orbits === 3 && st.eCount === 3
      && st.eMoving.every((m) => /path\(/.test(String(m.op)) && m.an === 'dh-orbit')
      && st.text === '' && st.bgStage === 'rgba(0, 0, 0, 0)' && st.bgAtom === 'rgba(0, 0, 0, 0)' && st.atomSize >= 100) {
      pass(`SP1 Splash 无背景原子：3 电子 offset-path 绕核（无文字/透明，${st.atomSize}px）`);
    } else fail('SP1 原子结构与样式', JSON.stringify(st));
    if (moved >= 2) pass(`SP1b 电子绕核运动（相对核 ${moved}/3 颗轨道位置变化）`);
    else fail('SP1b 电子绕核运动', JSON.stringify({ moved, r1, r2 }));
    await Runtime.evaluate({ expression: 'window.dhSplashClose()' });
    await sleep(300);
    const zw = await Runtime.evaluate({
      expression: `(() => { const z = document.getElementById('zw'); const c = getComputedStyle(z);
        return { tf: c.transform, op: c.opacity }; })()`,
      returnByValue: true,
    }).then((x) => x.result.value);
    const m = /matrix\(([-\d.]+),/.test(String(zw.tf)) ? Number(RegExp.$1) : 1;
    if (m > 1.5 && Number(zw.op) < 0.9) pass(`SP2 原子放大淡出（scale=${m.toFixed(2)}，opacity=${zw.op}）`);
    else fail('SP2 原子放大淡出', JSON.stringify(zw));
    await sc.close();
    let gone = false;
    const t0 = Date.now();
    while (Date.now() - t0 < 11000) {
      const l2 = await CDP.List({ port: 9228 });
      if (!l2.find((t) => t.url.includes('splash.html'))) { gone = true; break; }
      await sleep(500);
    }
    if (gone) pass('SP2b Splash 窗口自然销毁'); else fail('SP2b Splash 窗口自然销毁', 'alive >11s');
    try {
      const log = fs.readFileSync('D:/DataHelm/.tmp-ud7/ui-debug.log', 'utf8');
      const ts = (l) => Date.parse(l.slice(0, 24));
      const sh = log.split('\n').filter((l) => l.includes('DH-SPLASH shown v0927.53')).pop();
      const cl = log.split('\n').filter((l) => l.includes('DH-SPLASH closed')).pop();
      if (sh && cl && ts(cl) - ts(sh) >= 800) pass(`SP2c 日志 shown→closed（${ts(cl) - ts(sh)}ms）`);
      else fail('SP2c 日志时序', `shown=${!!sh} closed=${!!cl}`);
    } catch (e) { fail('SP2c 日志时序', e.message); }
    }
  }

  // ---- 主窗口阶段 ----
  let mainT = null;
  for (let i = 0; i < 10 && !mainT; i += 1) {
    try { list = await CDP.List({ port: 9228 }); } catch { await sleep(600); }
    mainT = list.find((t) => t.type === 'page' && !t.url.includes('splash.html'));
    if (!mainT) await sleep(500);
  }
  if (!mainT) { fail('K1 Ctrl+S', 'no main target'); process.exit(1); }
  let client = null;
  for (let i = 0; i < 6 && !client; i += 1) {
    try { client = await CDP({ target: mainT.webSocketDebuggerUrl }); } catch { await sleep(600); }
  }
  if (!client) { fail('K1 Ctrl+S', 'main ws refused x6'); process.exit(1); }
  const { Input, Runtime, Log } = client;
  await Runtime.enable();
  await Log.enable();
  const errors = [];
  Log.entryAdded(({ entry }) => { if (entry.level === 'error') errors.push(entry.text.slice(0, 200)); });
  const ev = async (x) => { const r = await Runtime.evaluate({ expression: x, returnByValue: true }); return r.result.value; };
  const press = async (x, y) => {
    await Input.dispatchMouseEvent({ type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await Input.dispatchMouseEvent({ type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  };
  const dblclick = async (x, y) => { await press(x, y); await sleep(80); await Input.dispatchMouseEvent({ type: 'mousePressed', x, y, button: 'left', clickCount: 2 }); await Input.dispatchMouseEvent({ type: 'mouseReleased', x, y, button: 'left', clickCount: 2 }); await sleep(1800); };
  const rightclick = async (x, y) => {
    await Input.dispatchMouseEvent({ type: 'mousePressed', x, y, button: 'right', clickCount: 1 });
    await Input.dispatchMouseEvent({ type: 'mouseReleased', x, y, button: 'right', clickCount: 1 });
  };
  const ctrlS = async () => {
    await Input.dispatchKeyEvent({ type: 'keyDown', key: 's', code: 'KeyS', windowsVirtualKeyCode: 83, modifiers: 2 });
    await Input.dispatchKeyEvent({ type: 'keyUp', key: 's', code: 'KeyS', windowsVirtualKeyCode: 83, modifiers: 2 });
    await sleep(400);
  };
  const posOf = (title) => ev(`(() => {
    const rows = [...document.querySelectorAll('.tree-wrap .ant-tree-treenode')].filter((r) => r.querySelector('.node-title') && r.getBoundingClientRect().height > 0);
    const f = rows.find((r) => r.querySelector('.node-title').textContent === ${JSON.stringify(title)});
    if (!f) return null;
    const t = f.querySelector('.node-title').getBoundingClientRect();
    return { x: Math.round(t.x + t.width / 2), y: Math.round(t.y + t.height / 2) };
  })()`);
  const clickMenu = async (txt) => {
    await sleep(400);
    const p = await ev(`(() => {
      const items = [...document.querySelectorAll('.ctx-menu .ant-menu-item')].filter((el) => el.getBoundingClientRect().height > 0);
      const f = items.find((el) => el.textContent.includes(${JSON.stringify(txt)}));
      if (!f) return null;
      const r = f.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    })()`);
    if (!p) return false;
    await press(p.x, p.y);
    await sleep(900);
    return true;
  };
  const modalBtn = async (kw) => {
    const b = await ev(`(() => {
      const w = [...document.querySelectorAll('.ant-modal-wrap')].find((x) => { const m = x.querySelector('.ant-modal'); return m && !/ant-zoom-leave/.test(m.className) && x.getBoundingClientRect().height > 0; });
      if (!w) return null;
      const b = [...w.querySelectorAll('.ant-btn')].find((x) => { const r = x.getBoundingClientRect(); return r.width > 0 && x.textContent.replace(/\\s+/g, '').includes(${JSON.stringify(kw)}); });
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), title: (w.querySelector('.ant-modal-title') || {}).textContent || '' };
    })()`);
    if (!b) return null;
    await press(b.x, b.y);
    return b;
  };

  await sleep(1500);
  const ver = await ev(`document.querySelector('.statusbar').textContent`);
  if (/v0927.53/.test(String(ver))) pass('S0 状态栏 v0927.53'); else fail('S0 状态栏 v0927.53', String(ver).slice(0, 100));

  // 打开查询页：sqlite 展开 → 表分类右键 新建查询
  let p = await posOf('演示 SQLite 库');
  if (!p) fail('K1 前置', '无连接行');
  else {
    await dblclick(p.x, p.y);
    p = null;
    for (let i = 0; i < 10 && !p; i += 1) { p = await posOf('表'); if (!p) await sleep(700); }
    await rightclick(p.x, p.y);
    if (!(await clickMenu('新建查询'))) fail('K1 前置', '表分类无 新建查询');
    else {
      await sleep(1200);
      // 编辑器输入 SQL
      const ed = await ev(`(() => { const e = document.querySelector('.ant-tabs-tabpane-active .query-editor-wrap .cm-content'); if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.x + 80), y: Math.round(r.y + 25) }; })()`);
      await press(ed.x, ed.y);
      await Input.dispatchKeyEvent({ type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
      await Input.dispatchKeyEvent({ type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
      await sleep(150);
      await Input.insertText({ text: 'SELECT 1' });
      await sleep(300);
      // K1 Ctrl+S → 保存查询弹窗 → 命名 → 保存
      await ctrlS();
      const title = await ev(`(() => { const w = [...document.querySelectorAll('.ant-modal-wrap')].find((x) => x.getBoundingClientRect().height > 0); return w ? (w.querySelector('.ant-modal-title') || {}).textContent : null; })()`);
      if (title === '保存查询') {
        const inp = await ev(`(() => { const w = [...document.querySelectorAll('.ant-modal-wrap')].find((x) => x.getBoundingClientRect().height > 0); const i = w && w.querySelector('input'); if (!i) return null; const r = i.getBoundingClientRect(); return { x: Math.round(r.x + 60), y: Math.round(r.y + r.height / 2) }; })()`);
        await press(inp.x, inp.y);
        await Input.insertText({ text: 'dh_r17_q' });
        await sleep(250);
        await modalBtn('保存');
        // 异步保存 → onClose 有滞后：轮询至 toast 出现且弹窗收起（最多 4s）
        let msg = '';
        let stillOpen = true;
        for (let i = 0; i < 10; i += 1) {
          await sleep(400);
          msg = await ev(`[...document.querySelectorAll('.ant-message-notice-content')].map((m) => m.textContent).join(' | ')`);
          stillOpen = await ev(`!![...document.querySelectorAll('.ant-modal-wrap')].find((x) => x.getBoundingClientRect().height > 0 && (x.querySelector('.ant-modal-title') || {}).textContent === '保存查询')`);
          if (/查询已保存：dh_r17_q/.test(String(msg)) && !stillOpen) break;
        }
        if (/查询已保存：dh_r17_q/.test(String(msg)) && !stillOpen) pass('K1 Ctrl+S 未命名查询弹窗命名保存');
        else fail('K1 Ctrl+S 保存', `msg=${msg} stillOpen=${stillOpen}`);
      } else fail('K1 Ctrl+S 弹窗', 'title=' + title);

      // K2 再改文本 → Ctrl+S 快存（不弹窗）
      await press(ed.x, ed.y);
      await Input.insertText({ text: ' + 1' });
      await sleep(300);
      await ctrlS();
      await sleep(900);
      const msg2 = await ev(`[...document.querySelectorAll('.ant-message-notice-content')].map((m) => m.textContent).join(' | ')`);
      const anySaveModal = await ev(`!![...document.querySelectorAll('.ant-modal-wrap')].find((x) => x.getBoundingClientRect().height > 0 && (x.querySelector('.ant-modal-title') || {}).textContent === '保存查询')`);
      if (/查询已保存/.test(String(msg2)) && !anySaveModal) pass('K2 Ctrl+S 已保存查询直接快存（不弹窗）');
      else fail('K2 Ctrl+S 快存', `msg=${msg2} modal=${anySaveModal}`);
    }
  }

  // W1 有脏（快存后基线已同步，先再改一次文本）→ 关窗请求 → 确认框 → 取消 → 存活
  {
    const edW = await ev(`(() => { const e = document.querySelector('.ant-tabs-tabpane-active .query-editor-wrap .cm-content'); if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.x + 80), y: Math.round(r.y + 25) }; })()`);
    if (edW) { await press(edW.x, edW.y); await Input.insertText({ text: ' -- dirty' }); await sleep(300); }
  }
  await ev(`window.api.app.requestClose()`);
  await sleep(800);
  const w1 = await modalBtn('取消');
  if (w1 && w1.title === '有未保存的修改') {
    await sleep(500);
    const alive = await ev('1 + 1');
    if (alive === 2) pass('W1 关窗未保存确认（取消后应用存活）'); else fail('W1 取消后存活', 'evaluate dead');
  } else fail('W1 关窗未保存确认', JSON.stringify(w1 && w1.title));

  // W2 关闭脏查询页（放弃并关闭）→ 无脏 → 关窗直接退出
  const rm = await ev(`(() => { const i = document.querySelector('.main-tabs .ant-tabs-tab-active .ant-tabs-tab-remove'); if (!i) return null; const r = i.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
  if (rm) {
    await press(rm.x, rm.y);
    await sleep(700);
    const w2 = await modalBtn('放弃并关闭');
    if (!w2 || !/未保存的修改/.test(String(w2.title))) fail('W2 前置', 'tab close confirm missing: ' + JSON.stringify(w2 && w2.title));
  } else fail('W2 前置', 'no tab remove btn');
  await sleep(700);
  const tabsLeft = await ev(`document.querySelectorAll('.main-tabs .ant-tabs-tab').length`);
  if (tabsLeft === 0) pass('W2 前置 脏查询页已关闭'); else fail('W2 前置 页签未清', 'tabs=' + tabsLeft);

  if (!errors.length) pass('S5 无控制台错误'); else fail('S5 无控制台错误', errors.slice(0, 3).join(' | '));

  // W2b 无脏关窗 → 应用退出（连接随进程消亡；端口随后释放）
  await ev(`window.api.app.requestClose()`);
  await sleep(1200);
  let exited = false;
  try {
    await Runtime.evaluate({ expression: '1' });
    await sleep(1500);
    try { await Runtime.evaluate({ expression: '1' }); } catch { exited = true; }
  } catch { exited = true; }
  if (exited) pass('W2b 无脏关窗直接退出（应用进程结束）');
  else {
    // 兜底看端口
    const l3 = await CDP.List({ port: 9228 }).catch(() => []);
    if (!l3.length) pass('W2b 无脏关窗直接退出（端口释放）'); else fail('W2b 无脏关窗退出', 'renderer still alive');
  }
  try { await client.close(); } catch {}
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
