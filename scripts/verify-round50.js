'use strict';
// v0927.52 查询耗时历史/慢查询标记验证：
//  T1 快查询：消息面板 ✓ [Nms] 耗时着色 span 存在且无慢档类名
//  T2 历史弹窗：条目含耗时 chip（含行数），点击行载入编辑器并关弹窗
//  T3 慢查询（15M 递归 CTE，实测 ~2.6s）：消息面板耗时 span 标橙 dh-ms-slow；历史 chip 带 · 慢
//  T4 失败语句入史：✗ 失败 标记；统计行 计时 N 次 · 最慢 Xms
//  T5 清空历史：暂无历史 + localStorage dh_hist_* 键清空 + 清空按钮禁用
//  S0 版本 v0927.52 / S5 无控制台错误
//  前置 T0：清空历史（可重入；localStorage 跨实例共享，上轮套件可能留有条目）
const CDP = require('chrome-remote-interface');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const client = await CDP({ port: Number(process.env.CDP_PORT || 9230) });
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
  const dblclick = async (x, y) => { await press(x, y, 'left', 1); await sleep(80); await press(x, y, 'left', 2); await sleep(1300); };
  const ctrlA = async () => {
    await Input.dispatchKeyEvent({ type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
    await Input.dispatchKeyEvent({ type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
    await sleep(120);
  };
  const treePos = (title) => ev(`(() => {
    const rows = [...document.querySelectorAll('.tree-wrap .ant-tree-treenode')].filter((r) => r.querySelector('.node-title') && r.getBoundingClientRect().height > 0);
    const f = rows.find((r) => r.querySelector('.node-title').textContent === ${JSON.stringify(title)});
    if (!f) return null;
    const t = f.querySelector('.node-title').getBoundingClientRect();
    return { x: Math.round(t.x + t.width / 2), y: Math.round(t.y + t.height / 2) };
  })()`);
  const clickMenu = async (kw, tries = 5) => {
    for (let i = 0; i < tries; i += 1) {
      const it = await ev(`(() => {
        const it = [...document.querySelectorAll('.ctx-menu .ant-menu-item')].find((i) => i.textContent.replace(/\\s+/g, '').includes(${JSON.stringify(kw)}));
        if (!it) return null;
        const r = it.getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      })()`);
      if (it) { await lclick(it.x, it.y); return true; }
      await sleep(350);
    }
    return false;
  };
  const pass = (n) => console.log('PASS', n);
  const fail = (n, d) => { console.log('FAIL', n, d || ''); process.exitCode = 1; };

  // ---- S0 版本 ----
  const sb = await ev(`document.querySelector('.statusbar').textContent.replace(/\\s+/g, '')`);
  if (!/v0927\.52/.test(sb)) fail('S0 状态栏 v0927.52', sb);
  else pass('S0 状态栏 v0927.52');

  // ---- 打开 sqlite → employees → 新建查询（可重入，同 round49）----
  let p = null;
  for (let i = 0; i < 10 && !p; i += 1) {
    p = await treePos('employees');
    if (p) break;
    const tb = await treePos('表');
    if (tb) { await dblclick(tb.x, tb.y); await sleep(700); continue; }
    const lib = await treePos('演示 SQLite 库');
    if (lib) { await dblclick(lib.x, lib.y); await sleep(800); }
    await sleep(400);
  }
  if (!p) { fail('前置', '未找到 employees'); await client.close(); return; }
  await rclick(p.x, p.y);
  if (!(await clickMenu('新建查询'))) { fail('前置', '菜单无 新建查询'); await client.close(); return; }
  await sleep(900);
  const edPos = await ev(`(() => {
    const e = document.querySelector('.ant-tabs-tabpane-active .query-editor-wrap .cm-content');
    const r = e.getBoundingClientRect();
    return { x: Math.round(r.x + 80), y: Math.round(r.y + 25) };
  })()`);
  await lclick(edPos.x, edPos.y);
  // paste 自带「点编辑器 → Ctrl+A → 插入」全流程（T0 弹窗交互会把焦点带离编辑器，
  // 不能假设前置点击仍然有效——round49 没有中间交互所以没踩）+ 落地校验重试
  const paste = async (sql) => {
    for (let i = 0; i < 3; i += 1) {
      await lclick(edPos.x, edPos.y);
      await sleep(150);
      await ctrlA();
      await Input.insertText({ text: sql });
      await sleep(400);
      const d = await docText();
      if (d === sql || d.includes(sql.slice(0, 24))) return true;
    }
    return false;
  };
  const docText = async () => ev(`[...document.querySelectorAll('.ant-tabs-tabpane-active .query-editor-wrap .cm-content .cm-line')].map((l) => l.textContent).join('\\n')`);

  // ---- 运行按钮（激活查询面板内 data-dh-q=run，点不到重试）----
  const clickRun = async () => {
    for (let i = 0; i < 6; i += 1) {
      const b = await ev(`(() => {
        const pane = [...document.querySelectorAll('.ant-tabs-tabpane-active')].find((x) => x.querySelector(':scope > .tab-body') && x.querySelector('.query-editor-wrap'));
        const btn = pane ? pane.querySelector('[data-dh-q="run"]') : null;
        if (!btn) return null;
        const r = btn.getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      })()`);
      if (b) { await lclick(b.x, b.y); return true; }
      await sleep(400);
    }
    return false;
  };
  // 激活「消息」内层页签：rc-tabs 惰性挂载——从未激活过的 pane 不在 DOM。
  // 成功运行的查询页自动切到 结果1（setTabKey('r0')），消息 pane 根本没挂载，
  // 必须先点开才能读到消息面板（错误运行才会自动落回消息页签——T4 无需此步）
  const clickMsgTab = async () => {
    for (let i = 0; i < 6; i += 1) {
      const t = await ev(`(() => {
        const pane = [...document.querySelectorAll('.ant-tabs-tabpane-active')].find((x) => x.querySelector(':scope > .tab-body') && x.querySelector('.query-editor-wrap'));
        if (!pane) return null;
        const tab = [...pane.querySelectorAll('.ant-tabs-nav .ant-tabs-tab')].find((x) => x.textContent.trim().indexOf('消息') === 0);
        if (!tab) return null;
        const r = tab.getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      })()`);
      if (t) { await lclick(t.x, t.y); return true; }
      await sleep(400);
    }
    return false;
  };
  // 等待含 marker 的消息 + 其耗时 span（单次 evaluate 原子读——分两次读会跨 pane 切换
  // 重渲染的过渡窗，且 marker 每轮唯一，杜绝上一轮套件残留消息的假命中）
  const waitFresh = async (marker, tries = 40) => {
    for (let i = 0; i < tries; i += 1) {
      const st = await ev(`(() => {
        const panes = [...document.querySelectorAll('.ant-tabs-tabpane-active')];
        const pane = panes.find((x) => x.querySelector(':scope > .tab-body') && x.querySelector('.query-editor-wrap') && x.querySelector('.msg-pane'));
        if (!pane) return null;
        const msgs = [...pane.querySelectorAll('.msg-pane .msg')];
        const m = msgs.find((x) => x.textContent.includes(${JSON.stringify(marker)}));
        const s = m ? m.querySelector('.dh-ms') : null;
        return m && s ? { msg: m.textContent.slice(0, 120), ms: s.textContent, cls: s.className } : null;
      })()`);
      if (st) return st;
      await sleep(500);
    }
    // 诊断 dump：全景 pane 状态（排查假 null）
    const dump = await ev(`(() => {
      const panes = [...document.querySelectorAll('.ant-tabs-tabpane-active')];
      return panes.map((x) => ({
        tb: !!x.querySelector(':scope > .tab-body'),
        ed: !!x.querySelector('.query-editor-wrap'),
        mp: !!x.querySelector('.msg-pane'),
        n: x.querySelectorAll('.msg-pane .msg').length,
        first: (x.querySelector('.msg-pane .msg') || {}).textContent ? x.querySelector('.msg-pane .msg').textContent.slice(0, 70) : null,
      }));
    })()`);
    console.log('WAITFRESH-DUMP marker=' + marker + ' panes=' + JSON.stringify(dump));
    return null;
  };

  // ---- 历史弹窗三件套 ----
  const openHist = async () => {
    for (let i = 0; i < 6; i += 1) {
      const b = await ev(`(() => {
        const pane = [...document.querySelectorAll('.ant-tabs-tabpane-active')].find((x) => x.querySelector(':scope > .tab-body') && x.querySelector('.query-editor-wrap'));
        if (!pane) return null;
        const btn = [...pane.querySelectorAll('.tab-toolbar .ant-btn')].find((x) => x.textContent.trim() === '历史');
        if (!btn) return null;
        const r = btn.getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      })()`);
      if (b) { await lclick(b.x, b.y); break; }
      await sleep(400);
    }
    for (let i = 0; i < 10; i += 1) {
      const open = await ev(`(() => {
        const m = [...document.querySelectorAll('.ant-modal-wrap')].find((x) => getComputedStyle(x).display !== 'none' && x.textContent.indexOf('查询历史') >= 0);
        return !!m;
      })()`);
      if (open) return true;
      await sleep(350);
    }
    return false;
  };
  const histInfo = () => ev(`(() => {
    const m = [...document.querySelectorAll('.ant-modal-wrap')].find((x) => getComputedStyle(x).display !== 'none' && x.textContent.indexOf('查询历史') >= 0);
    if (!m) return null;
    const rows = [...m.querySelectorAll('[data-dh-hist="row"]')];
    const stats = m.querySelector('[data-dh-hist="stats"]');
    const clearBtn = m.querySelector('[data-dh-hist="clear"]');
    return {
      n: rows.length,
      first: rows.length ? {
        chip: rows[0].querySelector('[data-dh-hist="ms"]') ? rows[0].querySelector('[data-dh-hist="ms"]').textContent : '',
        cls: rows[0].querySelector('[data-dh-hist="ms"]') ? rows[0].querySelector('[data-dh-hist="ms"]').className : '',
        err: !!rows[0].querySelector('.dh-hist-err'),
      } : null,
      stats: stats ? stats.textContent : '',
      clearDisabled: clearBtn ? clearBtn.disabled : null,
    };
  })()`);
  const closeHist = async () => {
    const x = await ev(`(() => {
      const m = [...document.querySelectorAll('.ant-modal-wrap')].find((x) => getComputedStyle(x).display !== 'none' && x.textContent.indexOf('查询历史') >= 0);
      if (!m) return null;
      const c = m.querySelector('.ant-modal-close');
      if (!c) return null;
      const r = c.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    })()`);
    if (x) { await lclick(x.x, x.y); await sleep(500); }
  };
  const clearHistVia = async () => {
    const b = await ev(`(() => {
      const m = [...document.querySelectorAll('.ant-modal-wrap')].find((x) => getComputedStyle(x).display !== 'none' && x.textContent.indexOf('查询历史') >= 0);
      if (!m) return null;
      const btn = m.querySelector('[data-dh-hist="clear"]');
      if (!btn || btn.disabled) return null;
      const r = btn.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    })()`);
    if (!b) return false;
    await lclick(b.x, b.y);
    for (let i = 0; i < 10; i += 1) {
      const ok = await ev(`(() => {
        const m = [...document.querySelectorAll('.ant-modal-wrap')].find((x) => getComputedStyle(x).display !== 'none' && x.textContent.indexOf('清空当前连接的查询历史') >= 0);
        if (!m) return null;
        const btn = [...m.querySelectorAll('.ant-btn')].find((x) => x.textContent.replace(/\\s+/g, '') === '清空');
        if (!btn) return null;
        const r = btn.getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      })()`);
      if (ok) {
        await lclick(ok.x, ok.y);
        await sleep(600);
        return true;
      }
      await sleep(350);
    }
    return false;
  };

  // ---- T0 清空历史（幂等；跨实例共享 localStorage 可能有上轮条目）----
  if (await openHist()) {
    const info = await histInfo();
    if (info && info.n > 0) { await clearHistVia(); }
    await closeHist();
    pass('T0 历史已清空（可重入前置）');
  } else fail('T0 历史弹窗', '未打开');

  // ---- T1 快查询：消息面板耗时 span（无慢档类名）----
  if (!(await paste('SELECT COUNT(*) AS n_r50a FROM employees'))) fail('T1 粘贴', '未落地');
  else if (!(await clickRun())) fail('T1 运行按钮', '未找到');
  else {
    await clickMsgTab();
    const st = await waitFresh('n_r50a');
    const m = st && /^✓ \[\d+ms\]/.test(st.ms) ? (st.ms.match(/(\d+)ms/) || [])[1] : null;
    m !== null && st.cls.indexOf('dh-ms-slow') < 0 && st.cls.indexOf('dh-ms-vslow') < 0
      ? pass('T1 消息面板耗时 ✓ [' + m + 'ms]，快查询无慢档着色')
      : fail('T1 耗时 span', JSON.stringify(st));
  }

  // ---- T2 历史条目 + 点击载入 ----
  if (await openHist()) {
    const info = await histInfo();
    const ok1 = info && info.n >= 1 && info.first && /ms$|ms /.test(info.first.chip) && info.first.chip.includes('1 行');
    ok1 ? pass('T2 历史条目含耗时 chip + 行数（' + (info.first ? info.first.chip : '') + '）') : fail('T2 历史 chip', JSON.stringify(info));
    const rowPos = await ev(`(() => {
      const m = [...document.querySelectorAll('.ant-modal-wrap')].find((x) => getComputedStyle(x).display !== 'none' && x.textContent.indexOf('查询历史') >= 0);
      const r0 = m ? m.querySelector('[data-dh-hist="row"]') : null;
      if (!r0) return null;
      const r = r0.getBoundingClientRect();
      return { x: Math.round(r.x + 60), y: Math.round(r.y + r.height / 2) };
    })()`);
    if (rowPos) {
      await lclick(rowPos.x, rowPos.y);
      await sleep(700);
      const doc = await docText();
      const closed = await ev(`(() => {
        const m = [...document.querySelectorAll('.ant-modal-wrap')].find((x) => getComputedStyle(x).display !== 'none' && x.textContent.indexOf('查询历史') >= 0);
        return !m;
      })()`);
      doc === 'SELECT COUNT(*) AS n_r50a FROM employees' && closed
        ? pass('T2b 点击历史行 → 载入编辑器 + 弹窗关闭')
        : fail('T2b 载入', JSON.stringify({ doc: String(doc).slice(0, 80), closed }));
    } else fail('T2b 行定位', '未找到');
  } else fail('T2 历史弹窗', '未打开');

  // ---- T3 慢查询（15M 递归 CTE，本机实测 ~2.6s）----
  if (!(await paste('WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM c WHERE n < 15000000) SELECT COUNT(*) AS cnt_r50c FROM c'))) fail('T3 粘贴', '未落地');
  else if (!(await clickRun())) fail('T3 运行按钮', '未找到');
  else {
    await clickMsgTab();
    const st = await waitFresh('cnt_r50c');
    st && st.cls.indexOf('dh-ms-slow') >= 0
      ? pass('T3a 慢查询耗时标橙（' + st.ms + ' cls=' + st.cls + '）')
      : fail('T3a 慢查询着色', JSON.stringify(st));
    if (await openHist()) {
      const info = await histInfo();
      const ok = info && info.first && info.first.cls.indexOf('dh-ms-slow') >= 0 && info.first.chip.includes('慢');
      ok ? pass('T3b 历史 chip 慢标记（' + info.first.chip + '）') : fail('T3b 历史 chip', JSON.stringify(info));
      await closeHist();
    } else fail('T3b 历史弹窗', '未打开');
  }

  // ---- T4 失败语句入史 + 统计行 ----
  if (!(await paste('SELECT * FROM no_such_table_r50d'))) fail('T4 粘贴', '未落地');
  else await clickRun();
  const errmsg = await waitFresh('no_such_table_r50d', 20);
  errmsg && errmsg.msg.includes('✗') ? pass('T4a 失败语句消息面板 ✗') : fail('T4a 失败消息', JSON.stringify(errmsg).slice(0, 200));
  if (await openHist()) {
    const info = await histInfo();
    const okA = info && info.first && info.first.err === true;
    okA ? pass('T4b 历史首条带 ✗ 失败 标记') : fail('T4b 失败标记', JSON.stringify(info));
    const st = info ? info.stats : '';
    const okB = /计时 \d+ 次/.test(st) && st.includes('最慢');
    okB ? pass('T4c 统计行（' + st.trim() + '）') : fail('T4c 统计行', JSON.stringify(st));
  } else fail('T4 历史弹窗', '未打开');

  // ---- T5 清空 ----
  const cleared = await clearHistVia();
  await sleep(400);
  const info5 = await histInfo();
  // 清空只清当前连接（设计如此）：断言 sqlite 种子连接键已删（dh_hist_c-mssql-1 是
  // 旧版套件留下的他连接历史，与本功能无关，不清也不为过）
  const lsKey = await ev(`localStorage.getItem('dh_hist_c-sqlite-demo')`);
  cleared && info5 && info5.n === 0 && info5.clearDisabled === true && lsKey === null
    ? pass('T5 清空：暂无历史 + 清空按钮禁用 + 当前连接 dh_hist 键删除')
    : fail('T5 清空', JSON.stringify({ cleared, info: info5, lsKey }));
  await closeHist();

  errors.length === 0 ? pass('S5 无控制台错误') : fail('S5 无控制台错误', errors.slice(0, 3).join(' || '));
  await client.close();
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
