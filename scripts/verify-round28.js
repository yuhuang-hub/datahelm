'use strict';
// v0927.52 数据同步验证（9229 新实例；夹具 fx-w28：sqlite dh_w28_t/nopk + mssql master.dbo dh_w28_t/nopk）：
//  T1 工具栏「数据同步」→ 页签打开
//  T2 sqlite→mssql 比较：dh_w28_t=有差异(+2/≠1/-1 默认勾选)、dh_w28_nopk=无主键(禁勾)、employees=目标缺表
//  T3 SQL 预览含 INSERT/UPDATE/DELETE + N'' 字面量
//  T4 应用 → 日志 插入 2、更新 1、删除 1 → mssql 侧 verify-a 数据逐行一致
//  T5 应用后自动重比较 → dh_w28_t=一致
//  T6 stage2 漂移（sqlite id1 qty→11、mssql 加 id6）→ 关「删除」应用 → verify-b：qty 已更新但 id6 保留
//  T7 重开「删除」→ 应用 → verify-c：id6 删除、四行与源完全一致
//  T8 源/目标面板标记 + 底部说明
//  S5 无控制台错误
const CDP = require('chrome-remote-interface');
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
  const posOf = async (expr) => {
    const p = await ev(`(() => { const el = ${expr}; if (!el) return null; el.scrollIntoView({ block: 'nearest' }); const r = el.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
    return p && !p.err ? p : null;
  };
  const pass = (n) => console.log('PASS', n);
  const fail = (n, d) => { console.log('FAIL', n, d || ''); process.exitCode = 1; };
  const FX_STAGES = ['stage1', 'stage2', 'verify-a', 'verify-b', 'verify-c', 'cleanup'];
  const fx = (stage) => {
    if (!FX_STAGES.includes(stage)) throw new Error('unknown fx stage');
    return execFileSync('node', ['D:/DataHelm/scripts/fx/fx-w28.js', stage], { cwd: 'D:/DataHelm', encoding: 'utf8' });
  };
  const fxJson = (stage, marker) => {
    const out = fx(stage);
    const line = out.split('\n').find((l) => l.startsWith(marker));
    return line ? JSON.parse(line.slice(marker.length).trim()) : null;
  };

  // ---- 等主窗揭示 ----
  let ok = false;
  for (let i = 0; i < 40 && !ok; i += 1) {
    ok = await ev("!!document.querySelector('.top-toolbar .tb-btn')");
    if (!ok) await sleep(500);
  }

  // S0 版本
  const ver = await ev("(() => { const s = document.querySelector('.statusbar'); return s ? s.textContent : ''; })()");
  /v0927\.52/.test(ver) ? pass('S0 版本 v0927.52') : fail('S0 版本', String(ver).slice(0, 120));

  // ---- antd Select：mousedown 打开下拉，点选项 ----
  const DBG = !!process.env.DBG28;
  const openSelect = async (panel, idx) => {
    // antd Select 选中后下拉收起可滞后数百 ms：先等现有下拉全收起，防双下拉同开时
    // pickOption 按文档序命中旧下拉里的同名选项（与 round27 同源加固）；选择器晚出也重试
    for (let w = 0; w < 12; w += 1) {
      const n = await ev("document.querySelectorAll('.ant-select-dropdown:not(.ant-select-dropdown-hidden)').length");
      if (!n) break;
      await sleep(300);
    }
    let p = null;
    for (let i = 0; i < 10 && !p; i += 1) {
      p = await posOf(`[...document.querySelectorAll('[data-dh-dsync="${panel}"] .ant-select')][${idx}].querySelector('.ant-select-selector')`);
      if (!p) await sleep(400);
    }
    if (DBG) console.log('DBG openSelect', panel, idx, JSON.stringify(p));
    if (!p) return false;
    await press(p.x, p.y, 'left', 1);
    await sleep(450);
    return true;
  };
  const pickOption = async (title, tries = 16) => {
    for (let i = 0; i < tries; i += 1) {
      const p = await posOf(`[...document.querySelectorAll('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option')].find((o) => o.getAttribute('title') === ${JSON.stringify(title)} || o.textContent.trim() === ${JSON.stringify(title)})`);
      if (DBG) console.log('DBG pickOption try', i, title, JSON.stringify(p));
      if (p) { await lclick(p.x, p.y); return true; }
      await sleep(400);
    }
    return false;
  };
  // 点击可能落在下拉渲染竞速上（onChange 未触发）——选中后校验面板文本，未生效整体重试
  const sideHas = (panel, label) => ev(`(() => { const d = document.querySelector('[data-dh-dsync="${panel}"]'); return !!(d && d.textContent.includes(${JSON.stringify(label)})); })()`);
  const setSide = async (panel, connLabel, dbName) => {
    let connOk = false;
    for (let a = 0; a < 3 && !connOk; a += 1) {
      if (await openSelect(panel, 0)) {
        if (await pickOption(connLabel)) {
          await sleep(700);
          connOk = await sideHas(panel, connLabel);
        }
      }
    }
    if (!connOk) return false;
    if (dbName != null) {
      let dbOk = false;
      // 目标=冷连接 mssql：连接选中后 treeRoot 库清单要数秒才到，3 次重试偶发不够（run3 T2 即此）
      for (let a = 0; a < 6 && !dbOk; a += 1) {
        await sleep(a === 0 ? 1500 : 500);
        if (await openSelect(panel, 1)) {
          if (await pickOption(dbName)) {
            await sleep(700);
            dbOk = await sideHas(panel, dbName);
          }
        }
      }
      return dbOk;
    }
    return true;
  };

  // 结果表行：{name, status, cells(含列文本), checked, disabled}（cells[0]=选择列）
  const syncRows = () => ev(`(() => {
    const rows = [...document.querySelectorAll('[data-dh-dsync="table"] .ant-table-row')];
    return rows.map((r) => ({
      name: r.getAttribute('data-row-key'),
      status: (r.querySelector('.ant-tag') || { textContent: '' }).textContent.trim(),
      cells: [...r.cells].map((c) => c.textContent.trim()),
      checked: !!r.querySelector('.ant-checkbox-checked'),
      disabled: !!r.querySelector('.ant-checkbox-disabled'),
    }));
  })()`);
  const waitRows = async (wants, tries = 40) => {
    for (let i = 0; i < tries; i += 1) {
      const rs = await syncRows();
      if (rs && rs.length && wants.every((w) => rs.find((r) => r.name === w.name && r.status === w.status))) return rs;
      await sleep(600);
    }
    return null;
  };
  const compareBtn = () => posOf(`document.querySelector('[data-dh-dsync="compare"]')`);
  const applyBtn = () => posOf(`document.querySelector('[data-dh-dsync="apply"]')`);
  const doCompare = async () => {
    const p = await compareBtn();
    if (!p) return false;
    await lclick(p.x, p.y);
    return true;
  };
  const doApply = async () => {
    const p = await applyBtn();
    if (!p) return false;
    await lclick(p.x, p.y);
    await sleep(600);
    const okBtn = await posOf(`[...document.querySelectorAll('.ant-modal-confirm-btns .ant-btn')].find((b) => b.textContent.replace(/\\s+/g, '') === '应用')`);
    if (!okBtn) return false;
    await lclick(okBtn.x, okBtn.y);
    return true;
  };
  const waitLogs = async (kw, tries = 50) => {
    for (let i = 0; i < tries; i += 1) {
      const ls = await ev(`[...document.querySelectorAll('[data-dh-dsync="logs"] [data-dh-dsync-log]')].map((x) => x.textContent)`);
      if (ls && ls.some((t) => t.includes(kw))) return ls;
      await sleep(500);
    }
    return null;
  };
  const waitCompareIdle = async (tries = 50) => {
    for (let i = 0; i < tries; i += 1) {
      const busy = await ev(`(document.querySelector('[data-dh-dsync="compare"]') || { className: '' }).className.includes('ant-btn-loading')`);
      if (!busy) return true;
      await sleep(500);
    }
    return false;
  };
  const sqlText = () => ev(`(document.querySelector('[data-dh-dsync="sql"]') || { textContent: '' }).textContent`);
  // 操作开关（插入/更新/删除）：应用按钮所在的工具行里的 Checkbox
  const setOp = async (label, wantChecked) => {
    const box = await ev(`(() => { const row = document.querySelector('[data-dh-dsync="apply"]').closest('div'); const w = [...row.querySelectorAll('.ant-checkbox-wrapper')].find((x) => x.textContent.trim() === ${JSON.stringify(label)}); return w ? { checked: !!w.querySelector('.ant-checkbox-checked') } : null; })()`);
    if (!box) return false;
    if (box.checked !== wantChecked) {
      const p = await posOf(`document.querySelector('[data-dh-dsync="apply"]').closest('div').querySelectorAll('.ant-checkbox-wrapper')[${label === '插入' ? 0 : label === '更新' ? 1 : 2}]`);
      if (!p) return false;
      await lclick(p.x, p.y);
      await sleep(300);
    }
    return true;
  };

  // ---- T1 工具栏入口 ----
  const t1 = await posOf(`[...document.querySelectorAll('.top-toolbar .tb-btn')].find((b) => b.textContent.replace(/\\s+/g, '') === '数据同步')`);
  if (!t1) fail('T1 定位工具栏按钮', '未找到');
  else {
    await lclick(t1.x, t1.y);
    let root = null;
    for (let i = 0; i < 10 && !root; i += 1) { root = await ev("!!document.querySelector('[data-dh-dsync=\"root\"]')"); if (!root) await sleep(400); }
    const tabOk = await ev(`(() => { const t = [...document.querySelectorAll('.main-tabs .ant-tabs-tab')].find((x) => x.textContent.includes('数据同步')); return !!t && t.className.includes('ant-tabs-tab-active'); })()`);
    root && tabOk ? pass('T1 工具栏打开数据同步页签') : fail('T1 页签', JSON.stringify({ root: !!root, tabOk }));
  }

  // ---- T2 sqlite → mssql 比较 ----
  if (!(await setSide('源', '演示 SQLite 库（SQLite）', null))) fail('T2 选择源', 'sqlite 连接未选中');
  if (!(await setSide('目标', '1（SQL Server）', 'master'))) fail('T2 选择目标', 'mssql/master 未选中');
  else if (await doCompare()) {
    const rs = await waitRows([
      { name: 'dh_w28_t', status: '有差异' },
      { name: 'dh_w28_nopk', status: '无主键' },
      { name: 'employees', status: '目标缺表' },
    ]);
    if (!rs) fail('T2 比较结果', JSON.stringify((await syncRows()) || []).slice(0, 300));
    else {
      const t = rs.find((r) => r.name === 'dh_w28_t');
      const nopk = rs.find((r) => r.name === 'dh_w28_nopk');
      // cells: [选择列, 表, 状态, 插入, 更新, 删除, 说明]
      const counts = t ? [t.cells[3], t.cells[4], t.cells[5]] : [];
      const countsOk = counts.join(',') === '2,1,1';
      countsOk ? pass('T2 dh_w28_t 计数 +2/≠1/-1') : fail('T2 计数', JSON.stringify(t && t.cells));
      t && t.checked === true ? pass('T2 差异表默认勾选') : fail('T2 默认勾选', JSON.stringify(t && t.checked));
      nopk && nopk.checked === false && nopk.disabled === true
        ? pass('T2 无主键表禁勾')
        : fail('T2 无主键', JSON.stringify(nopk));
    }
  } else fail('T2 比较', '按钮不可用或未点击');

  // ---- T3 SQL 预览 ----
  const st = await sqlText();
  ['INSERT INTO', 'UPDATE ', ' SET ', 'DELETE FROM', "N'丙'", "N'丁'"].every((k) => st.includes(k))
    ? pass('T3 SQL 预览含 INSERT/UPDATE/DELETE 与 N 前缀字面量')
    : fail('T3 SQL 预览', String(st).slice(0, 300));

  // ---- T4 应用 → mssql 侧逐行校验 ----
  if (await doApply()) {
    const ls = await waitLogs('结束');
    const okLog = ls && ls.some((t) => t.includes('dh_w28_t') && t.includes('插入 2、更新 1、删除 1')) && ls.some((t) => t.includes('成功 1、跳过 0、失败 0'));
    okLog ? pass('T4 应用日志（插入 2、更新 1、删除 1）') : fail('T4 应用日志', JSON.stringify(ls || []).slice(0, 300));
    const A = fxJson('verify-a', 'JSON-A');
    try {
      const want = [
        { id: 1, nm: '甲', qty: 10, price: 5.5 },
        { id: 2, nm: '乙', qty: 20, price: 3.25 },
        { id: 3, nm: '丙', qty: 30, price: 8 },
        { id: 4, nm: '丁', qty: 40, price: 1.1 },
      ];
      JSON.stringify(A) === JSON.stringify(want)
        ? pass('T4 mssql 侧数据与源逐行一致（含 DECIMAL 字符串归一）')
        : fail('T4 mssql 校验', JSON.stringify(A).slice(0, 400));
    } catch (e) {
      fail('T4 mssql 校验解析', e.message + ' ' + JSON.stringify(A).slice(0, 200));
    }
  } else fail('T4 应用', '确认弹窗未出现');

  // ---- T5 应用后自动重比较 → 一致 ----
  let same = null;
  for (let i = 0; i < 30 && same === null; i += 1) {
    const rs = await syncRows();
    const t = rs && rs.find((r) => r.name === 'dh_w28_t');
    if (t && t.status === '一致') same = true;
    else await sleep(600);
  }
  same === true ? pass('T5 应用后重比较 dh_w28_t=一致') : fail('T5 重比较', JSON.stringify((await syncRows()) || []).slice(0, 300));

  // ---- T6 漂移 + 关「删除」应用：更新生效、多出行保留 ----
  fx('stage2');
  await waitCompareIdle();
  await sleep(800);
  if (await doCompare()) {
    const rs = await waitRows([{ name: 'dh_w28_t', status: '有差异' }]);
    const t = rs && rs.find((r) => r.name === 'dh_w28_t');
    const counts = t ? [t.cells[3], t.cells[4], t.cells[5]] : [];
    counts.join(',') === '—,1,1' ? pass('T6 漂移检测 +0/≠1/-1') : fail('T6 漂移计数', JSON.stringify(t && t.cells));
    if (!(await setOp('删除', false))) fail('T6 关闭删除开关', '未找到');
    else if (await doApply()) {
      const ls = await waitLogs('结束');
      ls && ls.some((t2) => t2.includes('dh_w28_t') && t2.includes('插入 0、更新 1、删除 0'))
        ? pass('T6 应用日志（删除开关关闭：删除 0）')
        : fail('T6 应用日志', JSON.stringify(ls || []).slice(0, 300));
      const B = fxJson('verify-b', 'JSON-B');
      try {
        const q1 = B && B.find((r) => r.id === 1);
        const has6 = B && B.some((r) => r.id === 6);
        q1 && q1.nm === '甲' && q1.qty === 10 && has6 === true
          ? pass('T6 mssql：id1 nm 已按源恢复、id6 保留（删除关闭）')
          : fail('T6 mssql 校验', JSON.stringify(B).slice(0, 400));
      } catch (e) {
        fail('T6 mssql 校验解析', e.message);
      }
    } else fail('T6 应用', '弹窗未出现');
  } else fail('T6 重比较', '失败');

  // ---- T7 重开「删除」→ 应用 → 目标与源完全一致 ----
  await waitCompareIdle();
  await sleep(800);
  if (!(await setOp('删除', true))) fail('T7 打开删除开关', '未找到');
  else if (await doApply()) {
    const ls = await waitLogs('结束');
    ls && ls.some((t2) => t2.includes('dh_w28_t') && t2.includes('插入 0、更新 0、删除 1'))
      ? pass('T7 应用日志（删除 1）')
      : fail('T7 应用日志', JSON.stringify(ls || []).slice(0, 300));
    const C = fxJson('verify-c', 'JSON-C');
    try {
      const want = [
        { id: 1, nm: '甲', qty: 10, price: 5.5 },
        { id: 2, nm: '乙', qty: 20, price: 3.25 },
        { id: 3, nm: '丙', qty: 30, price: 8 },
        { id: 4, nm: '丁', qty: 40, price: 1.1 },
      ];
      JSON.stringify(C) === JSON.stringify(want)
        ? pass('T7 mssql 侧与源完全一致（id6 已删）')
        : fail('T7 mssql 校验', JSON.stringify(C).slice(0, 400));
    } catch (e) {
      fail('T7 mssql 校验解析', e.message);
    }
  } else fail('T7 应用', '弹窗未出现');

  // ---- T8 面板标记 + 底部说明 ----
  const panels = await ev(`(() => ({
    src: !!document.querySelector('[data-dh-dsync="源"]'),
    dst: !!document.querySelector('[data-dh-dsync="目标"]'),
    footer: (document.querySelector('[data-dh-dsync="root"] > div:last-child') || { textContent: '' }).textContent,
  }))()`);
  panels && panels.src && panels.dst && panels.footer.includes('按主键') && panels.footer.includes('参数化')
    ? pass('T8 源/目标面板与底部说明')
    : fail('T8 面板', JSON.stringify(panels));

  // S5 控制台错误
  await sleep(600);
  errors.length === 0 ? pass('S5 无控制台错误') : fail('S5 控制台错误', errors.slice(0, 4).join(' | ').slice(0, 300));

  console.log('ROUND28-DONE');
  try { await client.close(); } catch {}
  process.exit(process.exitCode || 0);
})().catch((e) => {
  console.error('FATAL', e.message);
  process.exit(1);
});
