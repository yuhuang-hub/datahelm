'use strict';
// v0927.52 MSSQL 列拖拽排序（重建表法）验证：
//  D1 mssql 设计器：3 字段行 + 每行拖拽手柄（w55_reo：id/nm/qty）
//  D2 合成拖拽（真实 mousedown 点亮 armed + 合成 dragstart/dragover/drop，同 round7）：
//     id 行拖到 nm 之后 → 设计器顺序 nm,id,qty
//  D3 SQL 预览：重建表语句（w55_reo__rebuild + CREATE TABLE + INSERT INTO + sp_rename + 索引复原 ix_w55_qty）
//  D4 保存 → 执行重建 → 设计器重载（首列 nm）
//  D5 fx-w55 check1：列顺序 nm,id,qty（sys.columns column_id）+ 3 行数据保留 + ix_w55_qty 存活 + 无 __rebuild 残留
//  S0 版本 v0927.52 / S5 无控制台错误
// 前置：套件自跑 fx-w55 stage1（幂等）；结尾 fx-w55 cleanup。运行于独立新实例（battery 保证无实例占用）。
const { execFileSync } = require('child_process');
const CDP = require('chrome-remote-interface');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fx55 = (mode) => String(execFileSync('node', ['D:/DataHelm/scripts/fx/fx-w55.js', mode], { encoding: 'utf8' }));
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

  // ---- 夹具 stage1（幂等）----
  try {
    const out = fx55('stage1');
    out.indexOf('W55-STAGE1-OK') >= 0 ? pass('D0 夹具 stage1（w55_reo + ix_w55_qty + 3 行）') : fail('D0 stage1', out.slice(0, 120));
  } catch (e) {
    fail('D0 stage1', String(e.message).slice(0, 160));
  }

  // ---- 展开连接 1 → master → 表 → w55_reo（可重入逐级展开）----
  let wantAfter = null; // 本轮拖拽后的期望列序（D2 计算，D4b/D5 消费）
  let p = null;
  for (let i = 0; i < 16 && !p; i += 1) {
    p = await treePos('w55_reo');
    if (p) break;
    const tb = await treePos('表');
    if (tb) { await dblclick(tb.x, tb.y); await sleep(900); continue; }
    const master = await treePos('master');
    if (master) { await dblclick(master.x, master.y); await sleep(1100); continue; }
    const c1 = await treePos('1');
    if (c1) { await dblclick(c1.x, c1.y); await sleep(1300); }
    await sleep(400);
  }
  if (!p) { fail('前置', '未找到 w55_reo'); }
  else {
    await rclick(p.x, p.y);
    if (!(await clickMenu('设计表'))) { fail('前置', '菜单无 设计表'); }
    else {
      await sleep(3200); // mssql 设计器加载较慢

      // ---- D1 字段行 + 拖拽手柄 ----
      const orderRead = () => ev(`(() => {
        const pane = document.querySelector('.ant-tabs-tabpane-active');
        const rows = pane ? [...pane.querySelectorAll('.design-table .ant-table-tbody tr.ant-table-row')] : [];
        return {
          order: rows.map((tr) => { const i = [...tr.querySelectorAll('input')].find((x) => x.placeholder === '字段名'); return i ? i.value : '?'; }),
          handles: pane ? pane.querySelectorAll('.design-table .drag-handle').length : 0,
        };
      })()`);
      let st = null;
      for (let i = 0; i < 10 && !st; i += 1) {
        const s = await orderRead();
        if (s && s.order.length === 3 && !s.order.includes('?')) st = s;
        else await sleep(700);
      }
      const wantBefore = ['id', 'nm', 'qty'];
      // 可重入：设计器标签按表去重复用——上一轮已保存重排的标签会保留旧顺序，
      // 断言按集合等价 + 拖拽交换语义（当前首行拖到次行后）动态计算期望
      st && st.handles === 3 && JSON.stringify([...st.order].sort()) === JSON.stringify([...wantBefore].sort())
        ? pass('D1 mssql 设计器 3 字段行 + 拖拽手柄（当前顺序 ' + st.order.join(',') + '）')
        : fail('D1 设计器行', JSON.stringify(st));

      // ---- D2 合成拖拽：id 拖到 nm 之后（同 round7 手法）----
      const hp = await ev(`(() => {
        const h = document.querySelector('.ant-tabs-tabpane-active .design-table .ant-table-tbody tr.ant-table-row .drag-handle');
        if (!h) return null;
        const r = h.getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      })()`);
      if (!hp) fail('D2 手柄定位', '未找到');
      else {
        const beforeOrder = (await orderRead()).order;
        const from = beforeOrder[0];
        const to = beforeOrder[1];
        wantAfter = [to, from, beforeOrder[2]];
        await Input.dispatchMouseEvent({ type: 'mousePressed', x: hp.x, y: hp.y, button: 'left', clickCount: 1 });
        await sleep(250); // 等 armed=true 重渲染（行 draggable）
        await ev(`(() => {
          const pane = document.querySelector('.ant-tabs-tabpane-active');
          const rows = [...pane.querySelectorAll('.design-table .ant-table-tbody tr.ant-table-row')];
          const tr0 = rows[0], tr1 = rows[1];
          const dt = new DataTransfer();
          tr0.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
          const r1 = tr1.getBoundingClientRect();
          const y = Math.round(r1.y + r1.height * 0.75); // 下一半 → 插到其后
          tr1.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, clientX: Math.round(r1.x + 50), clientY: y, dataTransfer: dt }));
          tr1.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, clientX: Math.round(r1.x + 50), clientY: y, dataTransfer: dt }));
          return true;
        })()`);
        await Input.dispatchMouseEvent({ type: 'mouseReleased', x: hp.x, y: hp.y, button: 'left', clickCount: 1 });
        await sleep(350);
        const after = await orderRead();
        JSON.stringify(after.order) === JSON.stringify(wantAfter)
          ? pass('D2 拖拽生效（' + from + ' 拖到 ' + to + ' 后：' + after.order.join(',') + '）')
          : fail('D2 拖拽', JSON.stringify(after));
      }

      // ---- D3 SQL 预览：重建表语句 ----
      const innerTab = await ev(`(() => { const t = [...document.querySelectorAll('.design-tabs .ant-tabs-tab')].find((x) => x.textContent.trim() === 'SQL 预览'); if (!t) return null; const r = t.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
      if (!innerTab) {
        fail('D3 前置', 'SQL 预览页签未找到');
      } else {
        await lclick(innerTab.x, innerTab.y);
        let preview = null;
        for (let i = 0; i < 14 && !preview; i += 1) {
          await sleep(500);
          preview = await ev(`(() => { const p = document.querySelector('.sql-preview'); const t = p ? p.textContent : ''; return t && t !== '-- 没有检测到变更' ? t : null; })()`);
        }
        preview && /w55_reo__rebuild/.test(preview) && /CREATE TABLE/.test(preview) && /INSERT INTO/.test(preview) && /sp_rename/.test(preview) && /ix_w55_qty/.test(preview)
          ? pass('D3 预览生成重建表 SQL（__rebuild + CREATE + INSERT + sp_rename + 索引复原 ix_w55_qty）')
          : fail('D3 预览 SQL', (preview || 'null').slice(0, 300));

        // ---- D4 保存 → 执行 → 重载 ----
        const saveBtn = await ev(`(() => {
          const pane = document.querySelector('.ant-tabs-tabpane-active');
          const b = [...pane.querySelectorAll('.tab-toolbar .ant-btn')].find((x) => x.textContent.includes('保存'));
          if (!b) return null;
          const r = b.getBoundingClientRect();
          return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
        })()`);
        if (!saveBtn) {
          fail('D4 前置', '保存按钮未找到');
        } else {
          await lclick(saveBtn.x, saveBtn.y);
          let back = false;
          for (let i = 0; i < 26 && !back; i += 1) {
            await sleep(500);
            back = await ev(`(() => { const t = document.querySelector('.design-tabs .ant-tabs-tab-active'); return t ? t.textContent.trim() === '字段' : false; })()`);
          }
          back ? pass('D4a 保存执行完成（回到字段页）') : fail('D4a 保存', '未回到字段页');
          await sleep(1500);
          const after = await orderRead();
          let reloaded = null;
          for (let i = 0; i < 8 && !reloaded; i += 1) {
            const s = await orderRead();
            if (s && s.order.length === 3 && !s.order.includes('?')) reloaded = s;
            else await sleep(800);
          }
          reloaded && wantAfter && JSON.stringify(reloaded.order) === JSON.stringify(wantAfter)
            ? pass('D4b 执行后设计器重载（顺序 ' + reloaded.order.join(',') + '）')
            : fail('D4b 重载顺序', JSON.stringify({ got: reloaded, want: wantAfter }));
        }
      }
    }
  }

  // ---- D5 库端核验（sys.columns 顺序 / 数据 / 索引 / 残留）----
  try {
    const out = fx55('check1');
    const line = (out.split('\n').find((l) => l.indexOf('CHECK-JSON') === 0) || '').slice(11);
    const info = JSON.parse(line);
    const ok = wantAfter && JSON.stringify(info.cols) === JSON.stringify(wantAfter) && info.indexAlive === true && info.rows === 3 && info.leftover.length === 0;
    ok ? pass('D5 库端核验：列序 ' + info.cols.join(',') + ' · 3 行保留 · ix_w55_qty 存活 · 无 __rebuild 残留')
      : fail('D5 库端核验', JSON.stringify({ info, want: wantAfter }));
  } catch (e) {
    fail('D5 库端核验', String(e.message).slice(0, 160));
  }

  // ---- 清理 ----
  try {
    const out = fx55('cleanup');
    out.indexOf('W55-CLEANUP-OK') >= 0 ? pass('D6 夹具 cleanup') : fail('D6 cleanup', out.slice(0, 120));
  } catch (e) {
    fail('D6 cleanup', String(e.message).slice(0, 160));
  }

  errors.length === 0 ? pass('S5 无控制台错误') : fail('S5 无控制台错误', errors.slice(0, 3).join(' || '));
  await client.close();
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
