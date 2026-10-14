'use strict';
// v0927.53 补全设置面板：SQL 片段自定义（新建/编辑/删除/恢复默认）+ 片段/关键字补全开关，
// localStorage(dh_completion_v1) 持久化并经 dh-completion-change 广播——编辑器已挂载时开关/增删
// 即时生效（弹层打开时经 ref 读最新配置，不重建 CodeMirror 扩展）。
// 入口：状态栏齿轮(data-dh-cs=open) + 查询编辑器右键「补全设置…」。内置 7 片段与此前硬编码一致。
// U9 终态恢复默认：套件幂等 + 后续套件（round45 的 FROM i→8 项）依赖 7 片段全开。
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

  // ---- 补全设置弹窗：面板状态读取（锁定可见 wrap 内的 .acset-bar，关闭态 wrap 隐藏）----
  const acInfo = () => ev(`(() => {
    const w = [...document.querySelectorAll('.ant-modal-wrap')].find((x) => getComputedStyle(x).display !== 'none' && x.querySelector('.acset-bar'));
    if (!w) return null;
    const rows = [...w.querySelectorAll('.acset-row')];
    const sw = (a) => { const el = w.querySelector('[data-dh-cs="' + a + '"]'); return !!(el && el.classList.contains('ant-switch-checked')); };
    return { n: rows.length,
      builtin: rows.filter((r) => r.querySelector('[data-dh-cs="src-builtin"]')).length,
      custom: rows.filter((r) => r.querySelector('[data-dh-cs="src-custom"]')).length,
      snipOn: sw('snip-switch'), kwOn: sw('kw-switch'),
      labels: rows.map((r) => r.getAttribute('data-label')) };
  })()`);
  const mSel = (sel) => `(() => { const w = [...document.querySelectorAll('.ant-modal-wrap')].find((x) => getComputedStyle(x).display !== 'none' && x.querySelector('.acset-bar')); return w ? w.querySelector('${sel}') : null; })()`;
  const openAc = async () => {
    const p = await posOf(`document.querySelector('.statusbar [data-dh-cs="open"]')`);
    if (!p) return false;
    await lclick(p.x, p.y);
    for (let i = 0; i < 12; i += 1) { const st = await acInfo(); if (st && !st.err) return true; await sleep(300); }
    return false;
  };
  const closeAc = async () => {
    const p = await posOf(mSel('.ant-modal-close'));
    if (!p) return false;
    await lclick(p.x, p.y);
    for (let i = 0; i < 12; i += 1) { const st = await acInfo(); if (!st) return true; await sleep(250); }
    return false;
  };
  const waitAcCond = async (cond, tries) => {
    let last = null;
    for (let i = 0; i < (tries || 15); i += 1) {
      const st = await acInfo();
      if (st && !st.err) { last = st; if (cond(st)) return st; }
      await sleep(300);
    }
    return null;
  };
  const lsCfg = () => ev("(() => { try { const o = JSON.parse(localStorage.getItem('dh_completion_v1') || 'null'); return o ? { n: (o.snippets || []).length, kw: o.keywordsOn !== false, sn: o.snippetsOn !== false, hasCnt: JSON.stringify(o).includes('cnt') } : null; } catch (e) { return { err: String(e) }; } })()");

  // ---- U1 状态栏齿轮 → 弹窗打开：7 内置片段、双开关均开 ----
  const gearTitle = await ev("(() => { const b = document.querySelector('.statusbar [data-dh-cs=\"open\"]'); return b ? b.title : null; })()");
  if (!gearTitle || !String(gearTitle).includes('补全设置')) fail('U1 齿轮按钮', String(gearTitle));
  else {
    pass('U1a 状态栏齿轮存在（title 含 补全设置）');
    if (!(await openAc())) fail('U1b 打开弹窗', '.acset-bar 未出现');
    else {
      const st = await waitAcCond((s) => s.n === 7);
      st && st.n === 7 && st.builtin === 7 && st.custom === 0
        ? pass('U1b 弹窗打开：内置 7 片段（sel/ssf/ins/up/del/ij/lj）全部标记 内置')
        : fail('U1b 默认清单', JSON.stringify(st));
      const st2 = await acInfo();
      st2 && st2.snipOn === true && st2.kwOn === true
        ? pass('U1c 片段补全/关键字补全开关默认均开')
        : fail('U1c 默认开关', JSON.stringify(st2));
    }
  }

  // ---- U2 删除内置 del → 6 行；新建 cnt → 7 行含 自定义 标记；localStorage 落盘；恢复默认 ----
  {
    const delBtn = await posOf(mSel('.acset-row[data-label="del"] .acset-rowbtns .ant-btn-dangerous'));
    if (!delBtn) fail('U2 删除按钮', 'del 行未找到');
    else {
      await lclick(delBtn.x, delBtn.y);
      const st = await waitAcCond((s) => s.n === 6);
      st && st.n === 6 && !st.labels.includes('del')
        ? pass('U2a 删除内置片段 del → 清单 6 行')
        : fail('U2a 删除', JSON.stringify(st));
    }
    const nb = await posOf(mSel('[data-dh-cs="snip-new"]'));
    if (!nb) fail('U2b 新建按钮', '未找到');
    else {
      await lclick(nb.x, nb.y);
      const li = await posOf(mSel('[data-dh-cs="label-input"]'));
      const ti = await posOf(mSel('[data-dh-cs="tpl-input"]'));
      if (!li || !ti) fail('U2b 编辑区', '前缀/模板输入框未出现');
      else {
        await lclick(li.x, li.y);
        await Input.insertText({ text: 'cnt' });
        await lclick(ti.x, ti.y);
        await Input.insertText({ text: 'SELECT COUNT(*) FROM ' + '$' + '{1:t}' });
        const sv = await posOf(mSel('[data-dh-cs="save"]'));
        if (!sv) fail('U2b 保存按钮', '未找到');
        else {
          await lclick(sv.x, sv.y);
          const st = await waitAcCond((s) => s.n === 7 && s.labels.includes('cnt'));
          st && st.n === 7 && st.custom === 1 && st.labels.includes('cnt')
            ? pass('U2b 新建片段 cnt → 清单 7 行（1 个标记 自定义）')
            : fail('U2b 新建', JSON.stringify(st));
          const ls = await lsCfg();
          ls && ls.hasCnt === true && ls.n === 7
            ? pass('U2c localStorage dh_completion_v1 已落盘（含 cnt，共 7 片段）')
            : fail('U2c 持久化', JSON.stringify(ls));
        }
      }
    }
    // 恢复默认挪到 U3 之后：cnt 要先在编辑器里验过再删
    await closeAc();
  }

  // ---- U3 编辑器集成：右键连接新建查询 → 输 cn → 弹层仅 cnt → 点击展开模板 ----
  const titlePos = (t) => posOf(`(() => { const rows = [...document.querySelectorAll('.tree-wrap .ant-tree-treenode')].filter((r) => r.querySelector('.node-title') && r.getBoundingClientRect().height > 0); const f = rows.find((r) => r.querySelector('.node-title').textContent.trim() === ${JSON.stringify(t)}); return f ? f.querySelector('.node-title') : null; })()`);
  const tipLabels = () => ev(`(() => {
    const tip = document.querySelector('.ant-tabs-tabpane-active .cm-tooltip-autocomplete');
    if (!tip) return null;
    const ul = tip.querySelector('ul'); if (!ul) return null;
    return [...ul.querySelectorAll('li')].map((li) => (li.querySelector('.cm-completionLabel') || li).textContent.trim());
  })()`);
  const waitTip = async (tries) => {
    for (let i = 0; i < (tries || 15); i += 1) {
      const t = await tipLabels();
      if (Array.isArray(t)) return t;
      await sleep(300);
    }
    return null;
  };
  const esc = async () => {
    await Input.dispatchKeyEvent({ type: 'rawKeyDown', key: 'Escape', windowsVirtualKeyCode: 27 });
    await Input.dispatchKeyEvent({ type: 'keyUp', key: 'Escape', windowsVirtualKeyCode: 27 });
    await sleep(250);
  };
  const ctrlSpace = async () => {
    await Input.dispatchKeyEvent({ type: 'rawKeyDown', modifiers: 2, key: ' ', code: 'Space', windowsVirtualKeyCode: 32 });
    await Input.dispatchKeyEvent({ type: 'keyUp', modifiers: 2, key: ' ', code: 'Space', windowsVirtualKeyCode: 32 });
  };
  const focusEd = async () => {
    const p = await posOf(`document.querySelector('.ant-tabs-tabpane-active .query-editor-wrap .cm-content')`);
    if (!p) return false;
    await lclick(p.x, p.y);
    await Input.dispatchKeyEvent({ type: 'rawKeyDown', modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
    await Input.dispatchKeyEvent({ type: 'keyUp', modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
    await sleep(150);
    return true;
  };
  const docText = () => ev("(() => { const c = document.querySelector('.ant-tabs-tabpane-active .query-editor-wrap .cm-content'); return c ? c.textContent : null; })()");

  {
    const cp = await titlePos('演示 SQLite 库');
    if (!cp) fail('U3 连接节点', '未找到');
    else {
      await press(cp.x, cp.y, 'right', 1);
      for (let i = 0; i < 10; i += 1) { if ((await ev("!!document.querySelector('.ctx-menu')")) === true) break; await sleep(300); }
      const mi = await posOf(`(() => { const m = document.querySelector('.ctx-menu'); return m ? [...m.querySelectorAll('.ant-dropdown-menu-item, .ant-menu-item')].find((x) => x.textContent.trim() === '新建查询') : null; })()`);
      if (!mi) fail('U3 右键菜单', '新建查询 未命中');
      else {
        await lclick(mi.x, mi.y);
        let ed = null;
        for (let i = 0; i < 15 && !ed; i += 1) { ed = await posOf(`document.querySelector('.ant-tabs-tabpane-active .query-editor-wrap .cm-content')`); if (!ed) await sleep(400); }
        ed ? pass('U3a 右键连接新建查询 → 编辑器就绪') : fail('U3a 查询页', '编辑器未出现');
        if (ed && (await focusEd())) {
          await Input.insertText({ text: 'cn' });
          await sleep(350);
          await ctrlSpace();
          const labs = await waitTip(15);
          labs && labs.length === 1 && labs[0] === 'cnt'
            ? pass('U3b 输 cn → 弹层仅 1 项：自定义片段 cnt')
            : fail('U3b 弹层', JSON.stringify(labs));
          // CM6 补全项的鼠标接纳对合成点击事件无效（点击落点命中 cm-completionDetail 也不触发），
          // 键盘 Enter 接纳确定性生效；弹层刚开时 Enter 会被吞——先稳 600ms，未展开则重触发一次再 Enter
          const enterKey = async () => {
            await Input.dispatchKeyEvent({ type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
            await Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
          };
          await sleep(600);
          await enterKey();
          let txt = null;
          for (let i = 0; i < 10 && !txt; i += 1) { txt = await docText(); if (!txt || String(txt).indexOf('SELECT COUNT(*)') < 0) { txt = null; await sleep(300); } }
          if (!txt) {
            await ctrlSpace();
            await sleep(600);
            await enterKey();
            for (let i = 0; i < 10 && !txt; i += 1) { txt = await docText(); if (!txt || String(txt).indexOf('SELECT COUNT(*)') < 0) { txt = null; await sleep(300); } }
          }
          txt && String(txt).indexOf('SELECT COUNT(*) FROM t') >= 0
            ? pass('U3c Enter 接纳 cnt → 展开模板 SELECT COUNT(*) FROM t（含 1 号占位符）')
            : fail('U3c 展开', JSON.stringify(String(txt || '').slice(0, 80)));
        }
      }
    }
  }

  // ---- U2d/U2e 编辑器验证完 cnt 后再恢复默认（重开弹窗操作）----
  {
    if (!(await openAc())) fail('U2d 打开弹窗', '失败');
    else {
      const rb = await posOf(mSel('[data-dh-cs="reset"]'));
      if (!rb) fail('U2d 恢复默认按钮', '未找到');
      else {
        await lclick(rb.x, rb.y);
        const st = await waitAcCond((s) => s.n === 7 && s.builtin === 7 && !s.labels.includes('cnt'));
        st && st.custom === 0 && st.snipOn === true && st.kwOn === true
          ? pass('U2d 恢复默认 → 7 内置片段全回归，开关复位全开')
          : fail('U2d 恢复默认', JSON.stringify(st));
        const ls = await lsCfg();
        ls && ls.n === 7 && ls.hasCnt === false && ls.kw === true && ls.sn === true
          ? pass('U2e 恢复默认已写回 localStorage（7 片段 + 双开关开）')
          : fail('U2e 写回', JSON.stringify(ls));
      }
      await closeAc();
    }
  }

  // ---- U4 关键字补全关闭：SE 无弹层（无任何匹配项）；emp 仍有表名 employees ----
  {
    if (!(await openAc())) fail('U4 打开弹窗', '失败');
    else {
      const sw = await posOf(mSel('[data-dh-cs="kw-switch"]'));
      if (!sw) fail('U4 开关', 'kw-switch 未找到');
      else {
        await lclick(sw.x, sw.y);
        const st = await waitAcCond((s) => s.kwOn === false);
        st && st.kwOn === false ? pass('U4a 关键字补全开关拨至关（清单不变 7 片段）') : fail('U4a 拨开关', JSON.stringify(st));
      }
      await closeAc();
      if (await focusEd()) {
        await Input.insertText({ text: 'SE' });
        await sleep(350);
        await ctrlSpace();
        await sleep(900);
        const labs = await tipLabels();
        (labs === null || labs === undefined || labs.err !== undefined || !labs.includes('SELECT'))
          ? pass('U4b 输 SE → 无 SELECT 关键字项（关键字补全已关，弹层不出现或不含 SELECT）')
          : fail('U4b SE 弹层', JSON.stringify(labs));
        await esc();
        if (await focusEd()) {
          await Input.insertText({ text: 'emp' });
          await sleep(350);
          await ctrlSpace();
          const labs2 = await waitTip(15);
          labs2 && labs2.includes('employees')
            ? pass('U4c 输 emp → 仍有表名 employees（表名补全不受开关影响）')
            : fail('U4c 表名补全', JSON.stringify(labs2));
          await esc();
        } else fail('U4c 聚焦', '失败');
      } else fail('U4b 聚焦', '失败');
      // U4d 立即复原关键字开关：不让「关」态跨越步骤存活（套件中途被杀也不会给后续套件留毒状态）
      if (await openAc()) {
        const stx = await acInfo();
        if (stx && stx.kwOn === false) {
          const sw2 = await posOf(mSel('[data-dh-cs="kw-switch"]'));
          if (sw2) { await lclick(sw2.x, sw2.y); await waitAcCond((s) => s.kwOn === true); }
        }
        const stf = await acInfo();
        stf && stf.kwOn === true ? pass('U4d 关键字开关即时复原为开') : fail('U4d 复原', JSON.stringify(stf));
        await closeAc();
      } else fail('U4d 复原', '弹窗未开');
    }
  }

  // ---- U5 片段补全关闭（关键字复开）：sel 无片段项、SELECT 关键字项在 ----
  {
    if (!(await openAc())) fail('U5 打开弹窗', '失败');
    else {
      const ksw = await posOf(mSel('[data-dh-cs="kw-switch"]'));
      const ssw = await posOf(mSel('[data-dh-cs="snip-switch"]'));
      if (!ksw || !ssw) fail('U5 开关', '未找到');
      else {
        const st0 = await acInfo();
        if (st0 && st0.kwOn !== true) await lclick(ksw.x, ksw.y);
        await sleep(250);
        const st1 = await acInfo();
        if (st1 && st1.snipOn === true) { await lclick(ssw.x, ssw.y); }
        const st = await waitAcCond((s) => s.kwOn === true && s.snipOn === false);
        st ? pass('U5a 开关复位：关键字开 + 片段关') : fail('U5a 开关组合', JSON.stringify(st));
      }
      await closeAc();
      if (await focusEd()) {
        await Input.insertText({ text: 'sel' });
        await sleep(350);
        await ctrlSpace();
        const labs = await waitTip(15);
        labs && labs.includes('SELECT') && !labs.includes('sel')
          ? pass('U5b 输 sel → SELECT 关键字在、sel 片段项消失（片段补全已关）')
          : fail('U5b sel 弹层', JSON.stringify(labs));
        await esc();
      } else fail('U5b 聚焦', '失败');
      // U5c 立即复原片段开关（同 U4d 防毒态 rationale）
      if (await openAc()) {
        const stx = await acInfo();
        if (stx && stx.snipOn === false) {
          const sw3 = await posOf(mSel('[data-dh-cs="snip-switch"]'));
          if (sw3) { await lclick(sw3.x, sw3.y); await waitAcCond((s) => s.snipOn === true); }
        }
        const stf = await acInfo();
        stf && stf.snipOn === true && stf.kwOn === true ? pass('U5c 片段开关即时复原为开') : fail('U5c 复原', JSON.stringify(stf));
        await closeAc();
      } else fail('U5c 复原', '弹窗未开');
    }
  }

  // ---- U8 编辑器右键菜单「补全设置…」→ 弹窗 ----
  {
    const ep = await posOf(`document.querySelector('.ant-tabs-tabpane-active .query-editor-wrap')`);
    if (!ep) fail('U8 编辑区', '未找到');
    else {
      await press(ep.x, ep.y, 'right', 1);
      for (let i = 0; i < 10; i += 1) { if ((await ev("!!document.querySelector('.ctx-menu')")) === true) break; await sleep(300); }
      const mi = await posOf(`(() => { const m = document.querySelector('.ctx-menu'); return m ? [...m.querySelectorAll('.ant-dropdown-menu-item, .ant-menu-item')].find((x) => x.textContent.trim() === '补全设置…') : null; })()`);
      if (!mi) fail('U8 右键菜单', '补全设置… 未命中');
      else {
        await lclick(mi.x, mi.y);
        const st = await waitAcCond(() => true);
        st ? pass('U8 编辑器右键「补全设置…」→ 弹窗打开') : fail('U8 弹窗', '未出现');
      }
    }
  }

  // ---- U9 终态恢复默认（幂等 + 后续套件依赖）----
  {
    const st0 = await acInfo();
    // 任一开关偏离默认都要恢复：只看 snipOn 会让 keywordsOn=false + snippetsOn=true 的
    // 毒态（U4a 拨关 + 强杀实例时 localStorage 提交抽签）从 else 分支假通过溜过去
    if (st0 && (st0.snipOn === false || st0.kwOn === false)) {
      const rb = await posOf(mSel('[data-dh-cs="reset"]'));
      if (rb) {
        await lclick(rb.x, rb.y);
        const st = await waitAcCond((s) => s.n === 7 && s.builtin === 7 && s.kwOn === true && s.snipOn === true);
        st ? pass('U9 终态恢复默认：7 内置片段 + 双开关开（round45 FROM i→8 项依赖）') : fail('U9 恢复', JSON.stringify(st));
      } else fail('U9 恢复按钮', '未找到');
    } else {
      pass('U9 终态已是默认（7 片段全开）');
    }
    // U9b 落盘读回：电池在套件退出后数秒内强杀实例，LevelDB 尾写可能丢失——
    // 读回非默认就再恢复一次；确认默认后多留 2.5s 给落盘
    for (let a = 0; a < 3; a += 1) {
      const ls = await lsCfg();
      if (ls && ls.n === 7 && ls.hasCnt === false && ls.kw === true && ls.sn === true) {
        pass('U9b localStorage 读回确认默认态（第 ' + (a + 1) + ' 拍）');
        break;
      }
      const rb2 = await posOf(mSel('[data-dh-cs="reset"]'));
      if (rb2) {
        await lclick(rb2.x, rb2.y);
        await waitAcCond((s) => s.n === 7 && s.builtin === 7 && s.kwOn === true && s.snipOn === true);
      }
      await sleep(500);
      if (a === 2) fail('U9b 读回', JSON.stringify(await lsCfg()));
    }
    const cls = await posOf(mSel('.ant-modal-close'));
    if (cls) await lclick(cls.x, cls.y);
    await sleep(2500);
  }

  // S5 控制台零错误
  await sleep(600);
  const errs = errors.filter((x) => !/favicon|DevTools/.test(x));
  errs.length === 0 ? pass('S5 控制台零错误') : fail('S5 控制台', errs.slice(0, 3).join(' | '));

  await client.close();
})().catch((e) => { console.error('SUITE-ERROR', e && e.message); process.exit(1); });
