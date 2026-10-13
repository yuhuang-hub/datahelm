'use strict';
// v0927.52 表行展开结构 + 树「索引」分类移除 验证（9229 新实例，sqlite 演示库 + mssql master；夹具 scripts/fx/fx-add）：
//  T0 sqlite 树无「索引」分类（表/视图/触发器 仍在）
//  E1 employees 展开：6 组齐全；字段 5 项含 id·INTEGER·主键 / name；索引/外键/唯一键/检查/触发器 全为「无」（PK 后备索引不列）
//  E2 dh_det（富结构夹具）展开：六组全非空 —— 索引 dh_det_ix（nm）、外键 fk_0：mgr → employees(id)、唯一键含 nm、检查 id >= 0、触发器 dh_det_tg
//  E3 收起：再点展开图标 → 明细消失
//  E4 视图 dh_det_v 展开：只有「字段」一组（视图不展示索引/外键等）
//  E5 mssql master 跟随 → 展开 dh_ix_t：索引 dh_ix_a（nm）+ 6 组
//  B1/S5 无边界误触发 / 无控制台错误；S0 版本 v0927.52
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
  const press = async (x, y, cnt) => {
    await Input.dispatchMouseEvent({ type: 'mousePressed', x, y, button: 'left', clickCount: cnt });
    await Input.dispatchMouseEvent({ type: 'mouseReleased', x, y, button: 'left', clickCount: cnt });
  };
  const lclick = async (x, y) => { await press(x, y, 1); await sleep(350); };
  const dblclick = async (x, y) => { await press(x, y, 1); await sleep(80); await press(x, y, 2); await sleep(1300); };
  const pass = (n) => console.log('PASS', n);
  const fail = (n, d) => { console.log('FAIL', n, d || ''); process.exitCode = 1; };
  const treePos = (title, idx = 0) => ev(`(() => {
    const rows = [...document.querySelectorAll('.tree-wrap .ant-tree-treenode')].filter((r) => r.querySelector('.node-title') && r.getBoundingClientRect().height > 0);
    const hits = rows.filter((r) => r.querySelector('.node-title').textContent === ${JSON.stringify(title)});
    const f = hits[${idx}];
    if (!f) return null;
    f.scrollIntoView({ block: 'nearest' });
    const t = f.querySelector('.node-title').getBoundingClientRect();
    return { x: Math.round(t.x + t.width / 2), y: Math.round(t.y + t.height / 2) };
  })()`);
  const waitTree = async (title, idx = 0, tries = 24) => {
    for (let i = 0; i < tries; i += 1) { const p = await treePos(title, idx); if (p) return p; await sleep(500); }
    return null;
  };
  const topBtn = async (kw) => {
    const p = await ev(`(() => { const b = [...document.querySelectorAll('.top-toolbar .tb-btn')].find((x) => x.textContent.replace(/\\s+/g, '') === ${JSON.stringify(kw)}); if (!b || b.disabled) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
    if (!p) return false;
    await lclick(p.x, p.y);
    return true;
  };
  const segTo = async (kw) => {
    await ev(`(() => { const it = [...document.querySelectorAll('[data-dh-kind] .ant-segmented-item')].find((x) => x.textContent.trim() === ${JSON.stringify(kw)}); if (it) it.click(); return !!it; })()`);
    await sleep(600);
  };
  // 找到列表行并返回展开图标坐标
  const rowIcon = (name) => ev(`(() => {
    const t = [...document.querySelectorAll('[data-dh-objs] tbody tr')].find((x) => { const n = x.querySelector('.objs-name'); return n && n.textContent === ${JSON.stringify(name)}; });
    if (!t || !t.querySelector('.ant-table-row-expand-icon')) return null;
    const r = t.querySelector('.ant-table-row-expand-icon').getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`);
  const waitIcon = async (name, tries = 20) => {
    for (let i = 0; i < tries; i += 1) { const p = await rowIcon(name); if (p) return p; await sleep(400); }
    return null;
  };
  // 读某表明细里指定组的条目文本
  const dgItems = (table, group) => ev(`(() => {
    const d = document.querySelector('[data-dh-detail=${JSON.stringify(table)}] [data-dh-dg=${JSON.stringify(group)}]');
    return d ? [...d.querySelectorAll('.objs-dg-item')].map((x) => x.textContent).join(';') : null;
  })()`);
  const dgCount = (table, group) => ev(`(() => {
    const d = document.querySelector('[data-dh-detail=${JSON.stringify(table)}] [data-dh-dg=${JSON.stringify(group)}]');
    return d ? d.querySelectorAll('.objs-dg-item').length : -1;
  })()`);
  const dgEmpty = (table, group) => ev(`(() => {
    const d = document.querySelector('[data-dh-detail=${JSON.stringify(table)}] [data-dh-dg=${JSON.stringify(group)}]');
    return d ? !!d.querySelector('.objs-dg-empty') : null;
  })()`);
  const dgGroupN = (table) => ev(`document.querySelectorAll('[data-dh-detail=${JSON.stringify(table)}] .objs-dg').length`);

  // ---- S0 版本 ----
  const ver = await ev(`document.querySelector('.statusbar').textContent`);
  if (/v0927\.52/.test(String(ver))) pass('S0 状态栏 v0927.52'); else fail('S0 状态栏 v0927.52', String(ver).slice(0, 80));

  // ---- T0 树无「索引」分类 ----
  let p = await waitTree('演示 SQLite 库', 0, 10);
  if (!p) fail('T0 前置', 'sqlite 连接行未找到');
  else {
    await dblclick(p.x, p.y);
    const cats = await ev(`[...document.querySelectorAll('.tree-wrap .node-title')].map((x) => x.textContent)`);
    const has = (t) => Array.isArray(cats) && cats.includes(t);
    !has('索引') && has('表') && has('视图') && has('触发器')
      ? pass('T0 sqlite 树分类 = 表/视图/触发器（索引已移除）')
      : fail('T0 树分类', JSON.stringify(cats));

    // ---- E1/E2 sqlite 表行展开 ----
    p = await waitTree('表', 0);
    if (!p) fail('E1 前置', '表分类未找到');
    else {
      await lclick(p.x, p.y); // 工具栏上下文 = sqlite
      if (await topBtn('表')) {
        let icon = await waitIcon('employees');
        if (!icon) fail('E1 前置', 'employees 行/展开图标未找到');
        else {
          await lclick(icon.x, icon.y);
          let n6 = 0;
          for (let i = 0; i < 20 && !n6; i += 1) { n6 = await dgGroupN('employees'); if (!n6) await sleep(400); }
          const colTxt = await dgItems('employees', '字段');
          const empties = [];
          for (const g of ['索引', '外键', '唯一键', '检查', '触发器']) empties.push(await dgEmpty('employees', g));
          n6 === 6 && /id.*INTEGER.*主键/.test(String(colTxt)) && /name/.test(String(colTxt)) && empties.every(Boolean)
            ? pass('E1 employees 展开：6 组 + 字段 5 项（id·主键）+ 其余组全「无」')
            : fail('E1 employees 展开', JSON.stringify({ n6, colTxt: String(colTxt).slice(0, 120), empties }).slice(0, 240));

          // E2 dh_det 富结构
          icon = await waitIcon('dh_det');
          if (!icon) fail('E2 前置', 'dh_det 行未找到');
          else {
            await lclick(icon.x, icon.y);
            let ok = false;
            for (let i = 0; i < 20 && !ok; i += 1) { ok = (await dgGroupN('dh_det')) === 6 && (await dgCount('dh_det', '字段')) > 0; if (!ok) await sleep(400); }
            const iIdx = await dgItems('dh_det', '索引');
            const iFk = await dgItems('dh_det', '外键');
            const iUq = await dgItems('dh_det', '唯一键');
            const iCk = await dgItems('dh_det', '检查');
            const iTg = await dgItems('dh_det', '触发器');
            ok && /dh_det_ix（nm）/.test(String(iIdx)) && /mgr → employees\(id\)/.test(String(iFk)) && /nm/.test(String(iUq)) && /id >= 0/.test(String(iCk)) && /dh_det_tg/.test(String(iTg))
              ? pass('E2 dh_det 展开：六组全非空（索引/外键/唯一键/检查/触发器）')
              : fail('E2 dh_det 展开', JSON.stringify({ ok, iIdx, iFk, iUq, iCk, iTg }).slice(0, 260));

            // E3 收起（antd 收起后明细行留 DOM 但 display:none —— 判可见性而非存在性）
            const ic2 = await rowIcon('dh_det');
            if (ic2) {
              await lclick(ic2.x, ic2.y);
              let gone = false;
              for (let i = 0; i < 10 && !gone; i += 1) {
                gone = !(await ev(`(() => { const d = document.querySelector('[data-dh-detail="dh_det"]'); if (!d) return false; const tr = d.closest('tr'); return !!(tr && getComputedStyle(tr).display !== 'none' && tr.getBoundingClientRect().height > 0); })()`));
                if (!gone) await sleep(400);
              }
              gone ? pass('E3 再点图标收起：明细不可见') : fail('E3 收起', '明细仍可见');
            } else fail('E3 前置', 'dh_det 图标丢失');

            // E4 视图 dh_det_v：只有字段组
            await segTo('视图');
            const vIcon = await waitIcon('dh_det_v');
            if (!vIcon) fail('E4 前置', 'dh_det_v 行未找到');
            else {
              await lclick(vIcon.x, vIcon.y);
              let vn = 0;
              for (let i = 0; i < 20 && !vn; i += 1) { vn = await dgGroupN('dh_det_v'); if (!vn) await sleep(400); }
              const vCol = await dgItems('dh_det_v', '字段');
              vn === 1 && /id/.test(String(vCol)) && /nm/.test(String(vCol))
                ? pass('E4 视图 dh_det_v 展开：仅「字段」一组（id/nm）')
                : fail('E4 视图展开', JSON.stringify({ vn, vCol }).slice(0, 160));
            }
          }
        }
      } else fail('E1 工具栏表按钮', '不可用');
    }
  }

  // ---- E5 mssql master 跟随 → 展开 dh_ix_t ----
  p = await waitTree('1', 0, 10);
  if (!p) fail('E5 前置', 'mssql 连接行未找到');
  else {
    await dblclick(p.x, p.y);
    p = await waitTree('master');
    if (!p) fail('E5 展开', 'master 未出现');
    else {
      const noIdx = !(await ev(`[...document.querySelectorAll('.tree-wrap .node-title')].some((x) => x.textContent === '索引')`));
      noIdx ? pass('E5a mssql 树无「索引」分类') : fail('E5a mssql 树索引分类', '仍存在');
      await lclick(p.x, p.y); // 对象列表跟随 master
      await segTo('表');
      const icon = await waitIcon('dh_ix_t', 24);
      if (!icon) fail('E5 前置', 'master 列表 dh_ix_t 行未找到');
      else {
        await lclick(icon.x, icon.y);
        let iIdx = null;
        for (let i = 0; i < 20 && !iIdx; i += 1) { iIdx = await dgItems('dh_ix_t', '索引'); if (!iIdx) await sleep(400); }
        const n = await dgGroupN('dh_ix_t');
        iIdx && /dh_ix_a（nm）/.test(String(iIdx)) && n === 6
          ? pass('E5 mssql dh_ix_t 展开：索引 dh_ix_a（nm）+ 6 组')
          : fail('E5 mssql 展开', JSON.stringify({ iIdx, n }).slice(0, 200));
      }
    }
  }

  // ---- B1 / S5 ----
  const b1 = await ev("!!document.querySelector('.dh-err-boundary')");
  !b1 ? pass('B1 无错误边界误触发') : fail('B1 边界误触发', 'unexpected fallback');
  await sleep(600);
  if (!errors.length) pass('S5 无控制台错误'); else fail('S5 无控制台错误', errors.slice(0, 3).join(' | '));

  await client.close();
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
