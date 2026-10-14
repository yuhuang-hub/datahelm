'use strict';
// v0927.53 树表两级展开验证（9229 新实例，sqlite 演示库；夹具 scripts/fx/fx-w26：demo-test 重置 + dh_w26_t 15 列宽表 + dh_w26_rich 富结构表）：
//  T1 树表节点有展开箭头（非叶子）
//  T1b 展开出六个结构分组（字段/索引/外键/唯一键/检查/触发器，按序）；T1c 展开「字段」→ 列名+类型+主键金钥匙图标
//  T2 字段节点点选 → 工具栏上下文归到所属表（ER 图可用）
//  T3 字段节点右键 → 复制字段名 菜单
//  T4 富结构表 dh_w26_rich：索引/唯一键/外键/检查/触发器 五分组各展开出正确明细
//  D1 对象列表 employees 行展开：字段组每行高度 >= 17（修复前 24 列表被压到 5px）
//  D2 dh_w26_t（15 列）行展开：15 行全部 >= 17 且列表出现滚动（scrollHeight > clientHeight）
//  V1 视图设计器添加长表名后「已添加」不折行（单行高度 <= 20）且表名省略号生效
//  V2 视图设计器卡片列清单不压缩（15 个 checkbox 全高 >= 20）
//  S5 无控制台错误
const CDP = require('chrome-remote-interface');
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
  const lclick = async (x, y) => { await press(x.x !== undefined ? x.x : x, x.y !== undefined ? x.y : y, 'left', 1); await sleep(280); };
  const dblclick = async (x, y) => { await press(x.x !== undefined ? x.x : x, x.y !== undefined ? x.y : y, 'left', 1); await sleep(80); await press(x.x !== undefined ? x.x : x, x.y !== undefined ? x.y : y, 'left', 2); await sleep(1300); };
  const rclick = async (x, y) => { await press(x.x !== undefined ? x.x : x, x.y !== undefined ? x.y : y, 'right', 1); await sleep(450); };
  const pass = (n) => console.log('PASS', n);
  const fail = (n, d) => { console.log('FAIL', n, d || ''); process.exitCode = 1; };
  const treePos = async (title, idx = 0) => ev(`(() => { const ts = [...document.querySelectorAll('.tree-wrap .node-title')].filter((x) => x.textContent === ${JSON.stringify(title)}); const t = ts[${idx}]; if (!t) return null; t.scrollIntoView({ block: 'nearest' }); const r = t.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
  const waitTree = async (title, idx = 0, tries = 14) => {
    for (let i = 0; i < tries; i += 1) { const p = await treePos(title, idx); if (p) return p; await sleep(500); }
    return null;
  };
  const tbBtn = (kw) => `(() => { const b = [...document.querySelectorAll('.top-toolbar .tb-btn')].find((x) => x.textContent.replace(/\\s+/g, '') === ${JSON.stringify(kw)}); return b ? { dis: b.disabled, title: b.getAttribute('title') || '' } : null; })()`;
  const tbPos = async (kw) => {
    const p = await ev(`(() => { const b = [...document.querySelectorAll('.top-toolbar .tb-btn')].find((x) => x.textContent.replace(/\\s+/g, '') === ${JSON.stringify(kw)}); if (!b || b.disabled) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
    return p;
  };

  // ---- 等主窗揭示 ----
  let ok = false;
  for (let i = 0; i < 40 && !ok; i += 1) {
    ok = await ev("!!document.querySelector('.top-toolbar .tb-btn')");
    if (!ok) await sleep(500);
  }

  // S0 版本
  const ver = await ev("(() => { const s = document.querySelector('.statusbar'); return s ? s.textContent : ''; })()");
  /v0927.53/.test(ver) ? pass('S0 版本 v0927.53') : fail('S0 版本', String(ver).slice(0, 120));

  // ---- T1 树表两级展开：sqlite → 表 → employees 有箭头 → 六分组 → 字段明细 ----
  // 可见树行按 DOM 序：{i, title, leaf}（leaf=无展开箭头）
  const treeRows = () => ev(`(() => {
    const rs = [...document.querySelectorAll('.tree-wrap .ant-tree-treenode')].filter((r) => { const t = r.querySelector('.node-title'); return t && r.getBoundingClientRect().height > 0; });
    return rs.map((r, i) => { const t = r.querySelector('.node-title'); const sw = r.querySelector('.ant-tree-switcher'); return { i, title: t.textContent, leaf: !sw || sw.className.includes('noop') }; });
  })()`);
  const rowClickPos = (idx, part) => ev(`(() => {
    const rs = [...document.querySelectorAll('.tree-wrap .ant-tree-treenode')].filter((r) => { const t = r.querySelector('.node-title'); return t && r.getBoundingClientRect().height > 0; });
    const r = rs[${idx}];
    if (!r) return null;
    r.scrollIntoView({ block: 'nearest' });
    const el = ${part === 'sw' ? "r.querySelector('.ant-tree-switcher')" : "r.querySelector('.node-title')"};
    const b = el.getBoundingClientRect();
    return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) };
  })()`);
  const CATS = ['字段', '索引', '外键', '唯一键', '检查', '触发器'];
  let p = await waitTree('演示 SQLite 库', 0, 10);
  if (!p) fail('T1 前置', 'sqlite 连接行未找到');
  else {
    await dblclick(p.x, p.y);
    p = await waitTree('表', 0, 10);
    if (!p) fail('T1 展开', '表分类未出现');
    else {
      await dblclick(p.x, p.y);
      p = await waitTree('employees', 0, 10);
      if (!p) fail('T1 展开', 'employees 未出现');
      else {
        // 展开箭头：非叶子节点的 switcher 不带 noop
        const sw = await ev(`(() => { const ts = [...document.querySelectorAll('.tree-wrap .node-title')].filter((x) => x.textContent === 'employees'); const t = ts[0]; if (!t) return null; const sw = t.closest('.ant-tree-treenode').querySelector('.ant-tree-switcher'); return { noop: !sw || sw.className.includes('noop') }; })()`);
        sw && sw.noop === false ? pass('T1a employees 节点有展开箭头（非叶子）') : fail('T1a 展开箭头', JSON.stringify(sw));
        // 点击箭头展开 → 六个结构分组
        const empIdx = async () => { const rs = await treeRows(); const f = rs.find((r) => r.title === 'employees'); return f ? f.i : -1; };
        const ei = await empIdx();
        const swp = await rowClickPos(ei, 'sw');
        await lclick(swp.x, swp.y);
        let cats = null;
        for (let i = 0; i < 14 && !cats; i += 1) {
          const rs = await treeRows();
          const ei2 = rs.findIndex((r) => r.title === 'employees');
          if (ei2 >= 0 && rs[ei2 + 1] && rs[ei2 + 1].title === '字段') cats = rs.slice(ei2 + 1, ei2 + 7);
          if (!cats) await sleep(500);
        }
        cats && cats.length === 6 && JSON.stringify(cats.map((c) => c.title)) === JSON.stringify(CATS) && cats.every((c) => !c.leaf)
          ? pass('T1b employees 展开六分组：' + cats.map((c) => c.title).join('/'))
          : fail('T1b 六分组', JSON.stringify(cats).slice(0, 200));
        // 展开「字段」分组 → 列明细
        if (cats) {
          const fi = (await treeRows()).findIndex((r) => r.title === '字段');
          const fsw = await rowClickPos(fi, 'sw');
          await lclick(fsw.x, fsw.y);
        }
        let cols = null;
        for (let i = 0; i < 14 && !cols; i += 1) {
          cols = await ev(`(() => {
            const rows = [...document.querySelectorAll('.tree-wrap .ant-tree-treenode')];
            const colRows = rows.filter((r) => { const t = r.querySelector('.node-title .node-dt'); return t && r.getBoundingClientRect().height > 0; });
            if (!colRows.length) return null;
            return colRows.map((r) => {
              const title = r.querySelector('.node-title');
              const dt = title.querySelector('.node-dt');
              const key = !!r.querySelector('.col-ic-pk');
              return { name: title.childNodes[0].textContent, dt: dt ? dt.textContent : '', key };
            });
          })()`);
          if (!cols) await sleep(500);
        }
        const want = [
          { name: 'id', dt: 'INTEGER', key: true },
          { name: 'name', dt: 'TEXT', key: false },
          { name: 'dept', dt: 'VARCHAR(80)', key: false },
          { name: 'salary', dt: 'DECIMAL(10,2)', key: false },
          { name: 'hired', dt: 'DATE', key: false },
        ];
        cols && !cols.err && JSON.stringify(cols) === JSON.stringify(want)
          ? pass('T1c 「字段」分组展开 5 个字段（列名+类型，id 主键金钥匙）')
          : fail('T1c 字段清单', JSON.stringify(cols).slice(0, 300));

        // ---- T2 点选字段 name → ER 图可用（上下文归到 employees）----
        const nameCol = await ev(`(() => { const rows = [...document.querySelectorAll('.tree-wrap .ant-tree-treenode')].filter((r) => { const t = r.querySelector('.node-title .node-dt'); return t && t.parentElement.childNodes[0].textContent === 'name' && r.getBoundingClientRect().height > 0; }); const f = rows[0]; if (!f) return null; f.scrollIntoView({ block: 'nearest' }); const t = f.querySelector('.node-title'); const r = t.getBoundingClientRect(); return { x: Math.round(r.x + 30), y: Math.round(r.y + r.height / 2) }; })()`);
        if (!nameCol) fail('T2 前置', '字段 name 未找到');
        else {
          await lclick(nameCol.x, nameCol.y);
          let er = null;
          for (let i = 0; i < 8; i += 1) { er = await ev(tbBtn('ER图')); if (er && er.dis === false) break; await sleep(400); }
          er && er.dis === false ? pass('T2 选中字段 name → ER 图可用（字段归到所属表上下文）') : fail('T2 ER 图', JSON.stringify(er));
        }

        // ---- T3 字段右键 → 复制字段名 ----
        const r3 = await ev(`(() => { const rows = [...document.querySelectorAll('.tree-wrap .ant-tree-treenode')].filter((r) => { const t = r.querySelector('.node-title .node-dt'); return t && t.parentElement.childNodes[0].textContent === 'salary'; }); const f = rows[0]; if (!f) return null; f.scrollIntoView({ block: 'nearest' }); const t = f.querySelector('.node-title'); const r = t.getBoundingClientRect(); return { x: Math.round(r.x + 40), y: Math.round(r.y + r.height / 2) }; })()`);
        if (!r3) fail('T3 前置', '字段 salary 未找到');
        else {
          await rclick(r3.x, r3.y);
          let item = null;
          for (let i = 0; i < 8 && !item; i += 1) { item = await ev(`(() => { const m = document.querySelector('.ctx-menu'); return m && m.textContent.includes('复制字段名') && m.textContent.includes('复制类型') ? 1 : null; })()`); if (!item) await sleep(300); }
          item ? pass('T3 字段右键菜单：复制字段名 + 复制类型') : fail('T3 右键菜单', '菜单项缺失');
          // ESC 关闭
          await Input.dispatchKeyEvent({ type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
          await Input.dispatchKeyEvent({ type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
          await sleep(300);
        }

        // ---- T4 富结构表 dh_w26_rich：五个分组各展开出正确明细 ----
        let ri = -1;
        for (let i = 0; i < 12 && ri < 0; i += 1) { const rs = await treeRows(); const f = rs.find((r) => r.title === 'dh_w26_rich'); if (f) ri = f.i; else await sleep(400); }
        if (ri < 0) fail('T4 前置', 'dh_w26_rich 未出现');
        else {
          const rsw = await rowClickPos(ri, 'sw');
          await lclick(rsw.x, rsw.y);
          let richCats = null;
          for (let i = 0; i < 14 && !richCats; i += 1) {
            const rs = await treeRows();
            const i2 = rs.findIndex((r) => r.title === 'dh_w26_rich');
            if (i2 >= 0 && rs[i2 + 1] && rs[i2 + 1].title === '字段') richCats = rs.slice(i2 + 1, i2 + 7);
            if (!richCats) await sleep(500);
          }
          richCats && JSON.stringify(richCats.map((c) => c.title)) === JSON.stringify(CATS)
            ? pass('T4a dh_w26_rich 展开六分组')
            : fail('T4a 六分组', JSON.stringify(richCats).slice(0, 200));
          const expect = [
            ['索引', ['dh_w26_rix']],
            ['唯一键', ['sqlite_autoindex_dh_w26_rich_1']],
            ['外键', ['fk_0']],
            ['检查', ['CHECK_1']],
            ['触发器', ['dh_w26_rtg']],
          ];
          for (const [label, wantNames] of expect) {
            let ci = -1;
            for (let i = 0; i < 12 && ci < 0; i += 1) {
              const rs = await treeRows();
              const base = rs.findIndex((r) => r.title === 'dh_w26_rich');
              const f = base >= 0 ? rs.findIndex((r) => r.i > base && r.title === label) : -1;
              if (f >= 0) ci = rs[f].i; else await sleep(400);
            }
            if (ci < 0) { fail(`T4 ${label} 分组`, '行未找到'); continue; }
            const cp = await rowClickPos(ci, 'sw');
            await lclick(cp.x, cp.y);
            let names = null;
            for (let i = 0; i < 12 && !names; i += 1) {
              const rs = await treeRows();
              const base = rs.findIndex((r) => r.title === 'dh_w26_rich');
              const ci2 = base >= 0 ? rs.findIndex((r) => r.i > base && r.title === label) : -1;
              if (ci2 >= 0) {
                const out = [];
                for (let j = ci2 + 1; j < rs.length && rs[j].leaf; j += 1) out.push(rs[j].title);
                if (out.length) names = out;
              }
              if (!names) await sleep(400);
            }
            names && JSON.stringify(names) === JSON.stringify(wantNames)
              ? pass(`T4 ${label} → ${names.join(', ')}`)
              : fail(`T4 ${label} 明细`, JSON.stringify(names));
          }
        }
      }
    }
  }

  // ---- D1/D2 对象列表结构面板行高 ----
  const tp = await tbPos('表');
  if (!tp) fail('D1 前置', '工具栏表按钮不可用');
  else {
    await lclick(tp.x, tp.y);
    for (let i = 0; i < 15; i += 1) { if (await ev(`!!document.querySelector('[data-dh-objs] tbody tr')`)) break; await sleep(400); }
    const expandAndGet = async (table) => {
      const ip = await ev(`(() => { const rows = [...document.querySelectorAll('[data-dh-objs] tbody tr')]; const row = rows.find((x) => { const n = x.querySelector('.objs-name'); return n && n.textContent === ${JSON.stringify(table)}; }); if (!row) return null; row.scrollIntoView({ block: 'center' }); const ic = row.querySelector('.ant-table-row-expand-icon'); if (!ic) return null; const r = ic.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
      if (!ip) return null;
      await lclick(ip.x, ip.y);
      for (let i = 0; i < 15; i += 1) { if (await ev(`!!document.querySelector('[data-dh-detail=${JSON.stringify(table)}] .objs-dg-item`)) break; await sleep(400); }
      return ev(`(() => {
        const d = document.querySelector('[data-dh-detail=${JSON.stringify(table)}]');
        if (!d) return null;
        const g = d.querySelector('[data-dh-dg="字段"]');
        const items = [...g.querySelectorAll('.objs-dg-item')];
        const hs = items.map((x) => Math.round(x.getBoundingClientRect().height));
        const list = g.querySelector('.objs-dg-list');
        return { n: items.length, minH: Math.min(...hs), maxH: Math.max(...hs), scroll: list.scrollHeight, client: list.clientHeight };
      })()`);
    };
    const d1 = await expandAndGet('employees');
    d1 && d1.n === 5 && d1.minH >= 17 && d1.maxH - d1.minH <= 1
      ? pass('D1 employees 字段 5 行，行高 ' + d1.minH + 'px（>=17，无压缩）')
      : fail('D1 employees 行高', JSON.stringify(d1));
    const d2 = await expandAndGet('dh_w26_t');
    d2 && d2.n === 15 && d2.minH >= 17 && d2.maxH - d2.minH <= 1 && d2.scroll > d2.client + 100
      ? pass('D2 dh_w26_t 15 行全部 >=17px（min ' + d2.minH + '），列表滚动生效（' + d2.scroll + '>' + d2.client + '）')
      : fail('D2 宽表行高/滚动', JSON.stringify(d2));
  }

  // ---- V1/V2 视图设计器 ----
  const vp = await tbPos('视图');
  if (!vp) fail('V1 前置', '工具栏视图按钮不可用');
  else {
    await lclick(vp.x, vp.y);
    for (let i = 0; i < 15; i += 1) { if (await ev(`!!document.querySelector('[data-dh-objs] [data-dh-new]')`)) break; await sleep(400); }
    const nb = await ev(`(() => { const b = document.querySelector('[data-dh-objs] [data-dh-new]'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
    await lclick(nb.x, nb.y);
    let vd = false;
    for (let i = 0; i < 15 && !vd; i += 1) { vd = !!(await ev(`!!document.querySelector('.dh-vd-tabs .dh-vd-side-list')`)); if (!vd) await sleep(400); }
    if (!vd) fail('V1 前置', '视图设计器未打开');
    else {
      // 添加长表名表 + 宽表
      const add = async (t) => { const a = await ev(`(() => { const b = document.querySelector('[data-dh-vd-add=${JSON.stringify(t)}]'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`); if (a) await lclick(a.x, a.y); return !!a; };
      const LONG = 'base_data_containmtlcarel';
      const a1 = await add(LONG);
      const a2 = await add('dh_w26_t');
      await sleep(600);
      // V1 侧栏行：长表名省略号 + 已添加单行
      const v1 = await ev(`(() => {
        const row = [...document.querySelectorAll('.dh-vd-side-row')].find((r) => { const nm = r.querySelector('.nm'); return nm && nm.textContent === ${JSON.stringify(LONG)}; });
        if (!row) return null;
        const nm = row.querySelector('.nm');
        const okEl = row.querySelector('.ok');
        const cs = okEl ? getComputedStyle(okEl) : null;
        return {
          truncated: nm.scrollWidth > nm.clientWidth,
          okText: okEl ? okEl.textContent : null,
          okH: okEl ? Math.round(okEl.getBoundingClientRect().height) : null,
          okWrap: cs ? cs.whiteSpace : null,
        };
      })()`);
      v1 && v1.truncated && v1.okText === '已添加' && v1.okH <= 20 && v1.okWrap === 'nowrap'
        ? pass('V1 长表名省略号生效，「已添加」单行 ' + v1.okH + 'px 不折行')
        : fail('V1 已添加折行', JSON.stringify(v1));
      // V2 卡片列清单：dh_w26_t 15 个 checkbox 全高
      const v2 = await ev(`(() => {
        const card = document.querySelector('[data-dh-vd-card="dh_w26_t"]');
        if (!card) return null;
        const boxes = [...card.querySelectorAll('.dh-vd-card-cols .ant-checkbox-wrapper')];
        const hs = boxes.map((b) => Math.round(b.getBoundingClientRect().height));
        const list = card.querySelector('.dh-vd-card-cols');
        return { n: boxes.length, minH: Math.min(...hs), scroll: list.scrollHeight, client: list.clientHeight };
      })()`);
      v2 && v2.n === 15 && v2.minH >= 20 && v2.scroll > v2.client
        ? pass('V2 宽表卡片 15 个字段 checkbox 全高 ' + v2.minH + 'px，滚动生效')
        : fail('V2 卡片列清单', JSON.stringify(v2));
      // 关闭视图设计器（脏 → 放弃并关闭）
      const x = await ev(`(() => { const tabs = [...document.querySelectorAll('.main-tabs .ant-tabs-tab')]; const t = tabs.find((k) => k.textContent.includes('新建视图')); if (!t) return null; const b = t.querySelector('.ant-tabs-tab-remove'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
      if (x) {
        await lclick(x.x, x.y);
        let ab = null;
        for (let i = 0; i < 8 && !ab; i += 1) { ab = await ev(`(() => { const ws = [...document.querySelectorAll('.ant-modal-wrap')].filter((w) => getComputedStyle(w).display !== 'none'); const c = ws[ws.length - 1] && ws[ws.length - 1].querySelector('.ant-modal-confirm'); const b = c && [...c.querySelectorAll('.ant-btn')].find((k) => k.textContent.replace(/\\s+/g, '') === '放弃并关闭'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`); if (!ab) await sleep(400); }
        if (ab) await lclick(ab.x, ab.y);
        await sleep(500);
      }
    }
  }

  // ---- S5 无控制台错误 ----
  await sleep(600);
  if (!errors.length) pass('S5 无控制台错误'); else fail('S5 无控制台错误', errors.slice(0, 3).join(' | '));

  await client.close();
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
