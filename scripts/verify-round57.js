'use strict';
// v0927.52 五合一特性验证（夹具 dh_w57：w57s.w57_ord + dbo.w57_cfg + dbo.w57_log(FK→w57_ord)）：
//  ① T1 工具栏「表」→ 对象列表页默认全部架构：w57_ord（架构列=w57s）与 w57_cfg/w57_log（dbo）都在列，ctx 含「全部架构」
//     T2 架构下拉切 w57s → 仅 w57_ord、无架构列；T3 切回全部 → 行「打开」w57_ord → 2 行（甲/乙）
//  ② T4 树右键 w57_ord 重命名→w57_ord2 → 树出刷新 + 数据 2 行（纯点分 sp_rename 端到端）
//  ③ T5 对比弹窗多快照：固定为基准（快照1）→ 跑倒序查询 → 存为快照「倒序」→ 快照下拉切换/删除，capA/stats 随动
//  ⑤ T6 历史弹窗：搜索过滤（w57_ord2 关键词）；星标收藏 + 只看收藏开/关（无匹配空态）
//  ④ T7 设计器拖拽列序 → SQL 预览含 __rebuild + 他表 FK 引用横幅（w57_log）
//  D0/D8 夹具 stage1/check1；S0 版本 v0927.52；S5 无控制台错误；D9 cleanup 放最后
// 前置：套件自跑 fx-w57 stage1（幂等：整库删建）；结尾 fx-w57 cleanup。运行于独立新实例（battery 保证无实例占用）。
const { execFileSync } = require('child_process');
const CDP = require('chrome-remote-interface');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fx57 = (mode) => String(execFileSync('node', ['D:/DataHelm/scripts/fx/fx-w57.js', mode], { encoding: 'utf8' }));
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
  /v0927\.52/.test(sb) ? pass('S0 状态栏 v0927.52') : fail('S0 状态栏 v0927.52', sb);

  // ---- D0 夹具 stage1 ----
  try {
    const out = fx57('stage1');
    out.indexOf('W57-STAGE1-OK') >= 0 ? pass('D0 夹具 stage1（dh_w57：w57s.w57_ord + dbo.w57_cfg + dbo.w57_log FK）') : fail('D0 stage1', out.slice(0, 120));
  } catch (e) {
    fail('D0 stage1', String(e.message).slice(0, 160));
  }

  // ---- 树展开到 dh_w57 表节点可见（conn 1 → dh_w57 → 表分类）----
  let p = null;
  for (let i = 0; i < 18 && !p; i += 1) {
    p = await treePos('w57_ord');
    if (p) break;
    const tb = await treePos('表');
    if (tb) { await dblclick(tb.x, tb.y); await sleep(900); continue; }
    const dbNode = await treePos('dh_w57');
    if (dbNode) { await dblclick(dbNode.x, dbNode.y); await sleep(1100); continue; }
    const c1 = await treePos('1');
    if (c1) { await dblclick(c1.x, c1.y); await sleep(1300); }
    await sleep(400);
  }
  if (!p) fail('前置', '树上 w57_ord 节点未找到');

  // ---- ① T1 工具栏「表」→ 对象列表页（默认全部架构）----
  const objsInfo = () => ev(`(() => {
    const pane = document.querySelector('.ant-tabs-tabpane-active [data-dh-objs]');
    if (!pane) return null;
    const rows = [...pane.querySelectorAll('tbody tr.ant-table-row')];
    const rowOf = (nm) => rows.find((r) => { const n = r.querySelector('.objs-name'); return n && n.textContent === nm; });
    const schOf = (nm) => { const r = rowOf(nm); return r && r.cells[2] ? r.cells[2].textContent.trim() : null; }; // cells[0]=展开钮 cells[1]=名称 cells[2]=架构
    const ctx = pane.querySelector('.ctx');
    return {
      names: rows.map((r) => { const n = r.querySelector('.objs-name'); return n ? n.textContent : '?'; }),
      hasSchCol: !!pane.querySelector('thead th') && [...pane.querySelectorAll('thead th')].some((h) => h.textContent.trim() === '架构'),
      schOrd: schOf('w57_ord'), schCfg: schOf('w57_cfg'), schLog: schOf('w57_log'),
      ctx: ctx ? ctx.textContent.replace(/\\s+/g, '') : '',
    };
  })()`);
  const tbBtn = await ev(`(() => { const b = [...document.querySelectorAll('.top-toolbar .tb-btn')].find((x) => x.textContent.replace(/\\s+/g, '') === '表'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), dis: b.disabled }; })()`);
  if (!tbBtn || tbBtn.dis) {
    fail('T1 前置', tbBtn ? '表按钮禁用' : '未找到');
  } else {
    await lclick(tbBtn.x, tbBtn.y);
    let o = null;
    for (let i = 0; i < 20 && !o; i += 1) { await sleep(500); o = await objsInfo(); }
    o && o.ctx.indexOf('dh_w57') >= 0 && o.ctx.indexOf('全部架构') >= 0 && o.hasSchCol
      && ['w57_ord', 'w57_cfg', 'w57_log'].every((n) => o.names.includes(n))
      && o.schOrd === 'w57s' && o.schCfg === 'dbo' && o.schLog === 'dbo'
      ? pass('T1 对象列表页默认全部架构（' + o.names.length + ' 表：w57_ord=w57s，w57_cfg/w57_log=dbo，架构列在）')
      : fail('T1 全部架构', JSON.stringify(o).slice(0, 400));
  }

  // ---- ① T2 架构下拉切 w57s ----
  const pickSch = async (label) => {
    const pos = await ev(`(() => {
      const s = document.querySelector('[data-dh-objs] [data-dh-sch] .ant-select-selector');
      if (!s) return null;
      const r = s.getBoundingClientRect();
      s.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: r.x + 10, clientY: r.y + 10 }));
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    })()`);
    if (!pos) return false;
    await sleep(600);
    const opt = await ev(`(() => {
      const ds = [...document.querySelectorAll('.ant-select-dropdown')].filter((x) => !x.className.includes('ant-select-dropdown-hidden') && getComputedStyle(x).display !== 'none');
      const dd = ds[ds.length - 1];
      if (!dd) return null;
      const o = [...dd.querySelectorAll('.ant-select-item-option')].find((x) => x.textContent.trim() === ${JSON.stringify(label)});
      if (!o) return null;
      const r = o.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    })()`);
    if (!opt) return false;
    await lclick(opt.x, opt.y);
    return true;
  };
  let t2 = null;
  if (await pickSch('w57s')) {
    for (let i = 0; i < 16 && !t2; i += 1) {
      await sleep(500);
      const o = await objsInfo();
      if (o && o.names.length === 1 && o.names[0] === 'w57_ord') t2 = o;
    }
  }
  t2 && t2.hasSchCol === false && t2.ctx.indexOf('全部架构') < 0
    ? pass('T2 架构下拉切 w57s：仅 w57_ord、无架构列')
    : fail('T2 切架构', JSON.stringify(t2).slice(0, 300));

  // ---- ① T3 切回全部架构 → 行「打开」w57_ord ----
  let t3ok = false;
  if (await pickSch('全部架构')) {
    let rowBtn = null;
    for (let i = 0; i < 16 && !rowBtn; i += 1) {
      await sleep(500);
      rowBtn = await ev(`(() => {
        const pane = document.querySelector('.ant-tabs-tabpane-active [data-dh-objs]');
        if (!pane) return null;
        const r = [...pane.querySelectorAll('tbody tr.ant-table-row')].find((x) => { const n = x.querySelector('.objs-name'); return n && n.textContent === 'w57_ord'; });
        if (!r) return null;
        const b = [...r.querySelectorAll('button')].find((x) => x.textContent.trim() === '打开');
        if (!b) return null;
        const rr = b.getBoundingClientRect();
        return { x: Math.round(rr.x + rr.width / 2), y: Math.round(rr.y + rr.height / 2) };
      })()`);
    }
    if (!rowBtn) fail('T3 前置', 'w57_ord 行打开按钮未找到');
    else {
      await lclick(rowBtn.x, rowBtn.y);
      let g = null;
      for (let i = 0; i < 26 && !g; i += 1) {
        await sleep(500);
        g = await ev(`(() => {
          const pane = document.querySelector('.ant-tabs-tabpane-active');
          if (!pane || !pane.querySelector('.grid-area')) return null;
          const rows = [...pane.querySelectorAll('.grid-area .ant-table-row')];
          if (!rows.length) return null;
          return { text: rows.map((r) => r.textContent).join('|') };
        })()`);
      }
      const badToast = await ev(`(() => { const m = [...document.querySelectorAll('.ant-message *')].map((x) => x.textContent).join('|'); return /Invalid object name/i.test(m) ? m : ''; })()`);
      t3ok = !!g && g.text.indexOf('甲') >= 0 && g.text.indexOf('乙') >= 0 && !badToast;
      t3ok ? pass('T3 全部架构下行「打开」非 dbo 表（2 行 甲/乙，无报错）') : fail('T3 打开', JSON.stringify({ g, badToast }).slice(0, 300));
    }
  } else fail('T3 前置', '切回全部架构失败');

  // ---- ② T4 树右键重命名 w57_ord → w57_ord2 ----
  const p4 = await treePos('w57_ord');
  if (!p4) {
    fail('T4 前置', '树上 w57_ord 节点未找到');
  } else {
    await rclick(p4.x, p4.y);
    if (!(await clickMenu('重命名'))) {
      fail('T4 前置', '菜单无 重命名');
    } else {
      const inp = await ev(`(() => {
        const m = [...document.querySelectorAll('.ant-modal-wrap')].find((x) => getComputedStyle(x).display !== 'none' && x.textContent.indexOf('重命名表') >= 0);
        if (!m) return null;
        const i = m.querySelector('input');
        if (!i) return null;
        const r = i.getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      })()`);
      if (!inp) fail('T4 前置', '重命名弹窗输入框未找到');
      else {
        await lclick(inp.x, inp.y);
        await sleep(200);
        await ctrlA();
        await Input.insertText({ text: 'w57_ord2' });
        await sleep(300);
        const okB = await ev(`(() => {
          const m = [...document.querySelectorAll('.ant-modal-wrap')].find((x) => getComputedStyle(x).display !== 'none' && x.textContent.indexOf('重命名表') >= 0);
          if (!m) return null;
          const b = [...m.querySelectorAll('button')].find((x) => x.textContent.trim() === '确 定');
          if (!b) return null;
          const r = b.getBoundingClientRect();
          return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
        })()`);
        if (okB) { await lclick(okB.x, okB.y); }
        let renamed = null;
        for (let i = 0; i < 20 && !renamed; i += 1) {
          await sleep(600);
          renamed = await treePos('w57_ord2');
        }
        renamed ? pass('T4 重命名 w57_ord → w57_ord2（树刷新出节点，纯点分 sp_rename）') : fail('T4 重命名', 'w57_ord2 节点未出现');
      }
    }
  }

  // ---- ③ T5 对比弹窗多快照（先建查询页：树右键 w57_ord2 → 新建查询）----
  const p5 = await treePos('w57_ord2');
  if (!p5) {
    fail('T5 前置', '树上 w57_ord2 节点未找到');
  } else {
    await rclick(p5.x, p5.y);
    if (!(await clickMenu('新建查询'))) {
      fail('T5 前置', '菜单无 新建查询');
    } else {
      await sleep(900);
      const edPos = await ev(`(() => {
        const e = document.querySelector('.ant-tabs-tabpane-active .query-editor-wrap .cm-content');
        if (!e) return null;
        const r = e.getBoundingClientRect();
        return { x: Math.round(r.x + 80), y: Math.round(r.y + 25) };
      })()`);
      const docText = async () => ev(`[...document.querySelectorAll('.ant-tabs-tabpane-active .query-editor-wrap .cm-content .cm-line')].map((l) => l.textContent).join('\\n')`);
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
          await sleep(500);
        }
        return false;
      };
      const waitGrid = async (kw) => {
        for (let i = 0; i < 20; i += 1) {
          const t = await ev(`(() => {
            const pane = [...document.querySelectorAll('.ant-tabs-tabpane-active')].find((x) => x.querySelector(':scope > .tab-body') && x.querySelector('.query-editor-wrap'));
            if (!pane) return '';
            return pane.textContent;
          })()`);
          if (t && t.indexOf(kw) >= 0) return true;
          await sleep(500);
        }
        return false;
      };
      const cmpModal = () => ev(`(() => {
        const m = [...document.querySelectorAll('.ant-modal-wrap')].find((x) => getComputedStyle(x).display !== 'none' && x.querySelector('[data-dh-cmp="modal"]'));
        return m || null;
      })()`);
      const cmpInfo = () => ev(`(() => {
        const m = [...document.querySelectorAll('.ant-modal-wrap')].find((x) => getComputedStyle(x).display !== 'none' && x.querySelector('[data-dh-cmp="modal"]'));
        if (!m) return null;
        const snapSel = m.querySelector('[data-dh-cmp="snap"] .ant-select-selection-item');
        return {
          stats: (m.querySelector('[data-dh-cmp="stats"]') || {}).textContent || '',
          capA: (m.querySelector('[data-dh-cmp="capA"]') || {}).textContent || '',
          snapText: snapSel ? snapSel.textContent : '',
          hasSnapName: !!m.querySelector('[data-dh-cmp="snapname"]'),
          snapDelDis: m.querySelector('[data-dh-cmp="snapdel"]') ? m.querySelector('[data-dh-cmp="snapdel"]').disabled : null,
        };
      })()`);
      const cmpBtn = async (attr) => {
        const b = await ev(`(() => {
          const m = [...document.querySelectorAll('.ant-modal-wrap')].find((x) => getComputedStyle(x).display !== 'none' && x.querySelector('[data-dh-cmp="modal"]'));
          if (!m) return null;
          const t = m.querySelector('[data-dh-cmp=' + ${JSON.stringify(attr)} + ']');
          if (!t || t.disabled) return null;
          if (t.tagName === 'BUTTON') { const r = t.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; }
          const s = t.querySelector('.ant-select-selector');
          if (!s) return null;
          const r = s.getBoundingClientRect();
          s.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: r.x + 10, clientY: r.y + 10 }));
          return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), sel: 1 };
        })()`);
        return b;
      };
      const cmpOpt = async (label) => {
        const o = await ev(`(() => {
          const ds = [...document.querySelectorAll('.ant-select-dropdown')].filter((x) => !x.className.includes('ant-select-dropdown-hidden') && getComputedStyle(x).display !== 'none');
          const dd = ds[ds.length - 1];
          if (!dd) return null;
          const o = [...dd.querySelectorAll('.ant-select-item-option')].find((x) => x.textContent.replace(/\\s+/g, '').indexOf(${JSON.stringify(label)}.replace(/\\s+/g, '')) >= 0);
          if (!o) return null;
          const r = o.getBoundingClientRect();
          return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
        })()`);
        if (!o) return false;
        await lclick(o.x, o.y);
        return true;
      };
      // 跑第一条（升序）→ 固定为基准（自动名 快照1）
      await paste('SELECT id, nm FROM w57s.w57_ord2 ORDER BY id');
      const r1 = await clickRun();
      const grid1 = r1 && (await waitGrid('甲'));
      let t5a = null;
      if (grid1) {
        const ob = await ev(`(() => { const b = [...document.querySelectorAll('.ant-tabs-tabpane-active .tab-body button')].find((x) => x.textContent.trim() === '对比'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
        if (ob) await lclick(ob.x, ob.y);
        await sleep(700);
        const pin = await cmpBtn('pin');
        if (pin) { await lclick(pin.x, pin.y); await sleep(500); }
        t5a = await cmpInfo();
      }
      t5a && t5a.capA.indexOf('快照1') >= 0 && t5a.snapText.indexOf('快照1') >= 0 && t5a.stats.indexOf('完全一致') >= 0
        ? pass('T5a 固定为基准 → 快照1（capA/下拉/stats 完全一致）')
        : fail('T5a 固定基准', JSON.stringify(t5a).slice(0, 300));
      // 跑第二条（倒序）→ 重开弹窗（A=快照1 vs B=倒序：不同 2 格）→ 存为快照「倒序」（A 切到倒序：完全一致）
      let t5b = null;
      if (t5a) {
        const closeB = await ev(`(() => {
          const m = [...document.querySelectorAll('.ant-modal-wrap')].find((x) => getComputedStyle(x).display !== 'none' && x.querySelector('[data-dh-cmp="modal"]'));
          if (!m) return null;
          const c = m.querySelector('.ant-modal-close');
          const r = c.getBoundingClientRect();
          return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
        })()`);
        if (closeB) { await lclick(closeB.x, closeB.y); await sleep(500); }
        await paste('SELECT id, nm FROM w57s.w57_ord2 ORDER BY id DESC');
        const r2 = await clickRun();
        const grid2 = r2 && (await waitGrid('乙'));
        if (grid2) {
          const ob = await ev(`(() => { const b = [...document.querySelectorAll('.ant-tabs-tabpane-active .tab-body button')].find((x) => x.textContent.trim() === '对比'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
          if (ob) await lclick(ob.x, ob.y);
          await sleep(700);
          const mid = await cmpInfo(); // A=快照1（升序） vs B=倒序
          // 命名快照：输入「倒序」点 存为快照
          const ni = await ev(`(() => {
            const m = [...document.querySelectorAll('.ant-modal-wrap')].find((x) => getComputedStyle(x).display !== 'none' && x.querySelector('[data-dh-cmp="modal"]'));
            if (!m) return null;
            const i = m.querySelector('[data-dh-cmp="snapname"]');
            if (!i) return null;
            const r = i.getBoundingClientRect();
            return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
          })()`);
          if (ni) {
            await lclick(ni.x, ni.y);
            await sleep(200);
            await Input.insertText({ text: '倒序' });
            await sleep(300);
            const addB = await cmpBtn('snapadd');
            if (addB) { await lclick(addB.x, addB.y); await sleep(500); }
          }
          const saved = await cmpInfo();
          t5b = { mid, saved };
        }
      }
      t5b && t5b.mid.capA.indexOf('快照1') >= 0 && t5b.mid.stats.indexOf('不同 4 格') >= 0
        && t5b.saved.capA.indexOf('倒序') >= 0 && t5b.saved.stats.indexOf('完全一致') >= 0
        ? pass('T5b 存为命名快照「倒序」：存前 vs 快照1 不同 4 格（2 行全错位），存后 A=倒序 完全一致')
        : fail('T5b 命名快照', JSON.stringify(t5b).slice(0, 400));
      // 快照下拉切回 快照1 → capA 回到快照1；删两个快照 → 未固定
      let t5c = null;
      if (t5b) {
        const sel = await cmpBtn('snap');
        if (sel && sel.sel) { await sleep(500); await cmpOpt('快照1'); }
        await sleep(500);
        const info1 = await cmpInfo();
        // 删除当前（快照1）→ 剩 倒序
        const d1 = await cmpBtn('snapdel');
        if (d1) { await lclick(d1.x, d1.y); await sleep(400); }
        const afterDel = await cmpInfo();
        // 再删 → 空
        const d2 = await cmpBtn('snapdel');
        if (d2) { await lclick(d2.x, d2.y); await sleep(400); }
        const afterDel2 = await cmpInfo();
        t5c = { info1, afterDel, afterDel2 };
      }
      t5c && t5c.info1.capA.indexOf('快照1') >= 0
        && t5c.afterDel.snapText.indexOf('倒序') >= 0
        && t5c.afterDel2.capA.indexOf('未固定') >= 0 && t5c.afterDel2.snapDelDis === true
        ? pass('T5c 快照下拉切换 + 逐个删除（回到未固定）')
        : fail('T5c 切换/删除', JSON.stringify(t5c).slice(0, 400));
      // 收尾：关掉对比弹窗
      const closeB2 = await ev(`(() => {
        const m = [...document.querySelectorAll('.ant-modal-wrap')].find((x) => getComputedStyle(x).display !== 'none' && x.querySelector('[data-dh-cmp="modal"]'));
        if (!m) return null;
        const c = m.querySelector('.ant-modal-close');
        const r = c.getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      })()`);
      if (closeB2) { await lclick(closeB2.x, closeB2.y); await sleep(400); }
    }
  }

  // ---- ⑤ T6 历史弹窗：搜索 + 收藏 ----
  const histBtn = await ev(`(() => { const b = [...document.querySelectorAll('.ant-tabs-tabpane-active .tab-body button')].find((x) => x.textContent.trim() === '历史'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
  if (!histBtn) {
    fail('T6 前置', '历史按钮未找到');
  } else {
    await lclick(histBtn.x, histBtn.y);
    await sleep(700);
    const histInfo = () => ev(`(() => {
      const m = [...document.querySelectorAll('.ant-modal-wrap')].find((x) => getComputedStyle(x).display !== 'none' && x.textContent.indexOf('查询历史') >= 0);
      if (!m) return null;
      const rows = [...m.querySelectorAll('[data-dh-hist="row"]')];
      return {
        n: rows.length,
        sqls: rows.map((r) => r.textContent.replace(/\\s+/g, ' ')),
        firstFav: rows.length && rows[0].querySelector('[data-dh-hist="fav"]') ? rows[0].querySelector('[data-dh-hist="fav"]').className : null,
        empty: (m.textContent.match(/无匹配结果|暂无历史/) || [''])[0],
        hasSearch: !!m.querySelector('[data-dh-hist="search"]'),
        favOnlyOn: !!m.querySelector('[data-dh-hist="favonly"].ant-btn-primary'),
      };
    })()`);
    const base = await histInfo();
    // 搜索本套件第二条 SQL 的独有片段：只命中倒序那条
    const sIn = await ev(`(() => {
      const m = [...document.querySelectorAll('.ant-modal-wrap')].find((x) => getComputedStyle(x).display !== 'none' && x.textContent.indexOf('查询历史') >= 0);
      if (!m) return null;
      const i = m.querySelector('[data-dh-hist="search"]');
      if (!i) return null;
      const r = i.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    })()`);
    let t6a = null;
    const KW = 'w57_ord2 ORDER BY id DESC';
    if (sIn) {
      await lclick(sIn.x, sIn.y);
      await sleep(200);
      await ctrlA();
      await Input.dispatchKeyEvent({ type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
      await Input.dispatchKeyEvent({ type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
      await sleep(200);
      await Input.insertText({ text: KW });
      await sleep(500);
      const filtered = await histInfo();
      // 同一 SQL 每轮重跑都会入史（历史不去重）——期望值按"输入前含该片段的行数"动态算
      const want = base && base.sqls ? base.sqls.filter((s) => s.indexOf('w57_ord2 ORDER BY id DESC') >= 0).length : -1;
      t6a = { base: base && base.n, filtered: filtered && filtered.n, want, hasSearch: filtered && filtered.hasSearch };
    }
    t6a && t6a.base >= 2 && t6a.want >= 1 && t6a.want < t6a.base && t6a.filtered === t6a.want && t6a.hasSearch
      ? pass('T6a 历史搜索（全部 ' + t6a.base + ' 条 → 过滤后 ' + t6a.filtered + ' 条=实际含片段数）')
      : fail('T6a 搜索', JSON.stringify(t6a).slice(0, 200));
    // 清空搜索 → 星标首条（若上轮残留已收藏则跳过首击，避免翻转成取消）→ 只看收藏 → 1 条；取消星标 → 无匹配
    let t6b = null;
    if (t6a) {
      await ctrlA();
      await Input.dispatchKeyEvent({ type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
      await Input.dispatchKeyEvent({ type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
      await sleep(400);
      const starPos = () => ev(`(() => {
        const m = [...document.querySelectorAll('.ant-modal-wrap')].find((x) => getComputedStyle(x).display !== 'none' && x.textContent.indexOf('查询历史') >= 0);
        if (!m) return null;
        const s = m.querySelector('[data-dh-hist="row"] [data-dh-hist="fav"]');
        if (!s) return null;
        const r = s.getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      })()`);
      const pre = await histInfo();
      if (pre && !/on/.test(String(pre.firstFav))) {
        const s1 = await starPos();
        if (s1) { await lclick(s1.x, s1.y); await sleep(400); }
      }
      const favOn = await histInfo();
      const foB = await ev(`(() => {
        const m = [...document.querySelectorAll('.ant-modal-wrap')].find((x) => getComputedStyle(x).display !== 'none' && x.textContent.indexOf('查询历史') >= 0);
        if (!m) return null;
        const b = m.querySelector('[data-dh-hist="favonly"]');
        if (!b) return null;
        const r = b.getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      })()`);
      if (foB) { await lclick(foB.x, foB.y); await sleep(400); }
      const only = await histInfo();
      // 再点星取消 → 只看收藏 0 条
      const s2 = await starPos();
      if (s2) { await lclick(s2.x, s2.y); await sleep(400); }
      const afterOff = await histInfo();
      t6b = { favCls: favOn && favOn.firstFav, onlyN: only && only.n, onlyOn: only && only.favOnlyOn, afterOff };
    }
    t6b && /on/.test(String(t6b.favCls)) && t6b.onlyN === 1 && t6b.onlyOn
      && t6b.afterOff && t6b.afterOff.n === 0 && t6b.afterOff.empty === '无匹配结果'
      ? pass('T6b 收藏星标 + 只看收藏（1 条 → 取消星标后无匹配）')
      : fail('T6b 收藏', JSON.stringify(t6b).slice(0, 300));
    // 收尾：关掉历史弹窗（顺带取消只看收藏留给下轮初始态由新实例保证）
    const hClose = await ev(`(() => {
      const m = [...document.querySelectorAll('.ant-modal-wrap')].find((x) => getComputedStyle(x).display !== 'none' && x.textContent.indexOf('查询历史') >= 0);
      if (!m) return null;
      const c = m.querySelector('.ant-modal-close');
      const r = c.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    })()`);
    if (hClose) { await lclick(hClose.x, hClose.y); await sleep(400); }
  }

  // ---- ④ T7 设计器拖拽列序 → SQL 预览 __rebuild + FK 横幅 ----
  const p7 = await treePos('w57_ord2');
  if (!p7) {
    fail('T7 前置', '树上 w57_ord2 节点未找到');
  } else {
    await rclick(p7.x, p7.y);
    if (!(await clickMenu('设计表'))) {
      fail('T7 前置', '菜单无 设计表');
    } else {
      await sleep(1400);
      // 定位含 design-table 的激活 pane：同屏可能还有查询页的内层激活 pane（结果/消息），querySelector 首个命中会错
      const designPane = () => ev(`(() => {
        const panes = [...document.querySelectorAll('.ant-tabs-tabpane-active')];
        return panes.find((x) => x.querySelector('.design-table')) || null;
      })()`);
      const orderRead = async () => ev(`(() => {
        const pane = [...document.querySelectorAll('.ant-tabs-tabpane-active')].find((x) => x.querySelector('.design-table'));
        if (!pane) return null;
        const rows = [...pane.querySelectorAll('.design-table .ant-table-tbody tr.ant-table-row')];
        return { order: rows.map((tr) => { const i = [...tr.querySelectorAll('input')].find((x) => x.placeholder === '字段名'); return i ? i.value : '?'; }) };
      })()`);
      let st = null;
      for (let i = 0; i < 10 && !st; i += 1) {
        const s = await orderRead();
        if (s && s.order.length === 3 && !s.order.includes('?')) st = s;
        else await sleep(700);
      }
      const hp = await ev(`(() => {
        const pane = [...document.querySelectorAll('.ant-tabs-tabpane-active')].find((x) => x.querySelector('.design-table'));
        if (!pane) return null;
        const h = pane.querySelector('.design-table .ant-table-tbody tr.ant-table-row .drag-handle');
        if (!h) return null;
        const r = h.getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      })()`);
      if (!st || !hp) {
        fail('T7 前置', '设计器行/手柄未找到 ' + JSON.stringify(st));
      } else {
        await Input.dispatchMouseEvent({ type: 'mousePressed', x: hp.x, y: hp.y, button: 'left', clickCount: 1 });
        await sleep(250); // 等 armed=true 重渲染（行 draggable）
        await ev(`(() => {
          const pane = [...document.querySelectorAll('.ant-tabs-tabpane-active')].find((x) => x.querySelector('.design-table'));
          if (!pane) return false;
          const rows = [...pane.querySelectorAll('.design-table .ant-table-tbody tr.ant-table-row')];
          const tr0 = rows[0], tr1 = rows[1];
          const dt = new DataTransfer();
          tr0.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
          const r1 = tr1.getBoundingClientRect();
          const y = Math.round(r1.y + r1.height * 0.75);
          tr1.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, clientX: Math.round(r1.x + 50), clientY: y, dataTransfer: dt }));
          tr1.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, clientX: Math.round(r1.x + 50), clientY: y, dataTransfer: dt }));
          return true;
        })()`);
        await Input.dispatchMouseEvent({ type: 'mouseReleased', x: hp.x, y: hp.y, button: 'left', clickCount: 1 });
        await sleep(350);
        const after = await orderRead();
        const dragged = JSON.stringify(after.order) !== JSON.stringify(st.order);
        // 切 SQL 预览 内层页签
        const sqlTab = await ev(`(() => {
          const pane = [...document.querySelectorAll('.ant-tabs-tabpane-active')].find((x) => x.querySelector('.design-table'));
          if (!pane) return null;
          const t = [...pane.querySelectorAll('.design-tabs .ant-tabs-tab')].find((x) => x.textContent.replace(/\\s+/g, '') === 'SQL预览');
          if (!t) return null;
          const r = t.getBoundingClientRect();
          return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
        })()`);
        if (!sqlTab) {
          fail('T7 前置', 'SQL 预览页签未找到');
        } else {
          await lclick(sqlTab.x, sqlTab.y);
          let info = null;
          for (let i = 0; i < 16 && !info; i += 1) {
            await sleep(600);
            info = await ev(`(() => {
              const pane = [...document.querySelectorAll('.ant-tabs-tabpane-active')].find((x) => x.querySelector('.design-tabs') || x.querySelector('.sql-preview'));
              if (!pane) return null;
              const w = pane.querySelector('[data-dh-fkwarn]');
              const pv = pane.querySelector('.sql-preview');
              return { warn: w ? w.textContent : '', rebuild: pv ? pv.textContent.indexOf('__rebuild') >= 0 : false };
            })()`);
            if (info && !info.warn && !info.rebuild) info = null; // 预览尚未刷新完成
          }
          dragged && info && info.rebuild && info.warn.indexOf('w57_log') >= 0 && info.warn.indexOf('外键') >= 0
            ? pass('T7 重建路径 FK 提示（拖拽 ' + st.order.join(',') + ' → ' + after.order.join(',') + '；预览含 __rebuild，横幅列 w57_log）')
            : fail('T7 FK 提示', JSON.stringify({ dragged, info: info || null }).slice(0, 300));
        }
      }
    }
  }

  // ---- D8 库端核验 ----
  try {
    const out = fx57('check1');
    const line = (out.split('\n').find((l) => l.indexOf('CHECK-JSON') === 0) || '').slice(11);
    const info = JSON.parse(line);
    info.ordRows === 2 && info.cfgRows === 1 && info.logFks === 1
      ? pass('D8 库端核验：ord 2 行（改名后）、cfg 1 行、FK 引用 1 条随改名跟随')
      : fail('D8 库端核验', JSON.stringify(info));
  } catch (e) {
    fail('D8 库端核验', String(e.message).slice(0, 160));
  }

  errors.length === 0 ? pass('S5 无控制台错误') : fail('S5 无控制台错误', errors.slice(0, 3).join(' || '));

  // ---- D9 清理（放最后：cleanup 会踢掉实例占用的 dh_w57 会话，可能触发后续连接错误日志）----
  try {
    const out = fx57('cleanup');
    out.indexOf('W57-CLEANUP-OK') >= 0 ? pass('D9 夹具 cleanup（SINGLE_USER 踢会话后 drop dh_w57 整库）') : fail('D9 cleanup', out.slice(0, 120));
  } catch (e) {
    fail('D9 cleanup', String(e.message).slice(0, 160));
  }

  await client.close();
})().catch((e) => {
  console.error('FATAL', e.message);
  process.exit(1);
});
