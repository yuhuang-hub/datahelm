'use strict';
// v0927.53 结构同步验证（9229 新实例；夹具 fx-w27：sqlite dh_w27_a/b + mssql master.dbo dh_w27_m/m2）：
//  T1 工具栏「结构同步」→ 页签打开
//  T2 sqlite→mssql 比较：employees=新建(默认勾选)、dh_w27_a/b=新建、dh_w27_m/m2=目标独有(默认不勾)；SQL 预览含建表/索引/CHECK/DECIMAL(10,2)
//  T3 取消勾选 employees → 应用（确认弹窗）→ 日志 2 项建表 → mssql 侧 verify-a 类型断言（BIGINT/NVARCHAR/DECIMAL + 索引 + CHECK）
//  T4 mssql→sqlite 反向：只勾 dh_w27_m/m2 → 应用 → sqlite 侧 verify-b（列/索引/外键/CHECK/表清单）
//  T5 夹具 stage2（mssql 加列 extra2 + 索引 dh_w27_mix2）→ 重比较 → dh_w27_m=有差异（+列 extra2 +索引 dh_w27_mix2）→ 应用 → verify-b 6 列
//  T6 勾选 employees（目标独有）→ 应用（弹窗含删除表）→ employees 从 sqlite 删除，重比较后不再出现
//  T7 源=目标=同一 sqlite → 比较 → 全部「一致」
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
  // 夹具调用：参数数组 + shell=false（stage 为内部常量白名单）
  const FX_STAGES = ['stage1', 'stage2', 'verify-a', 'verify-b', 'cleanup'];
  const fx = (stage) => {
    if (!FX_STAGES.includes(stage)) throw new Error('unknown fx stage');
    return execFileSync('node', ['D:/DataHelm/scripts/fx/fx-w27.js', stage], { cwd: 'D:/DataHelm', encoding: 'utf8' });
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
  /v0927.53/.test(ver) ? pass('S0 版本 v0927.53') : fail('S0 版本', String(ver).slice(0, 120));

  // ---- antd Select：mousedown 打开下拉，点选项 ----
  const DBG = !!process.env.DBG27;
  const openSelect = async (panel, idx) => {
    // antd Select 选中后下拉收起可滞后数百 ms（选中连接触发 connect/刷树重渲染排队）：
    // 先等现有下拉全部收起，否则双下拉同开时 pickOption 会按文档序命中旧下拉里的同名选项
    for (let w = 0; w < 12; w += 1) {
      const n = await ev("document.querySelectorAll('.ant-select-dropdown:not(.ant-select-dropdown-hidden)').length");
      if (!n) break;
      await sleep(300);
    }
    // mssql 冷启动时库下拉会晚出：posOf 重试（10×400ms），防时序抖动
    let p = null;
    for (let i = 0; i < 10 && !p; i += 1) {
      p = await posOf(`[...document.querySelectorAll('[data-dh-sync="${panel}"] .ant-select')][${idx}].querySelector('.ant-select-selector')`);
      if (!p) await sleep(400);
    }
    if (DBG) console.log('DBG openSelect', panel, idx, JSON.stringify(p));
    if (!p) return false;
    await press(p.x, p.y, 'left', 1);
    await sleep(450);
    if (DBG) {
      const dd = await ev(`(() => ({ n: document.querySelectorAll('.ant-select-dropdown').length, open: document.querySelectorAll('.ant-select-dropdown:not(.ant-select-dropdown-hidden)').length }))()`);
      console.log('DBG dropdowns', JSON.stringify(dd));
    }
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
  // 源/目标：连接 +（mssql 侧还有库下拉）；点击可能落在下拉渲染竞速上（onChange 未触发）——
  // 选中后校验面板文本，未生效整体重试（最多 3 轮）
  const sideHas = (panel, label) => ev(`(() => { const d = document.querySelector('[data-dh-sync="${panel}"]'); return !!(d && d.textContent.includes(${JSON.stringify(label)})); })()`);
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
      for (let a = 0; a < 3 && !dbOk; a += 1) {
        await sleep(500);
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

  // 结果表行：{name, status, changes, checked}（data-row-key 由 rowKey=table 生成）
  const syncRows = () => ev(`(() => {
    const rows = [...document.querySelectorAll('[data-dh-sync="table"] .ant-table-row')];
    return rows.map((r) => ({
      name: r.getAttribute('data-row-key'),
      status: (r.querySelector('.ant-tag') || { textContent: '' }).textContent.trim(),
      changes: (r.cells[r.cells.length - 1] || { textContent: '' }).textContent.trim(),
      checked: !!r.querySelector('.ant-checkbox-checked'),
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
  const rowCheckbox = async (name) => posOf(`[...document.querySelectorAll('[data-dh-sync="table"] .ant-table-row')].find((r) => r.getAttribute('data-row-key') === ${JSON.stringify(name)}).querySelector('.ant-checkbox')`);
  const onlyCheck = async (names) => {
    const rs = await syncRows();
    for (const r of rs || []) {
      if (names.includes(r.name) !== r.checked) {
        const p = await rowCheckbox(r.name);
        if (p) { await lclick(p.x, p.y); await sleep(250); }
      }
    }
    await sleep(400);
  };
  const compareBtn = () => posOf(`document.querySelector('[data-dh-sync="compare"]')`);
  const applyBtn = () => posOf(`document.querySelector('[data-dh-sync="apply"]')`);
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
    // antd 两字按钮自动插空格：'应 用' → 归一化后比较
    const okBtn = await posOf(`[...document.querySelectorAll('.ant-modal-confirm-btns .ant-btn')].find((b) => b.textContent.replace(/\\s+/g, '') === '应用')`);
    if (!okBtn) return false;
    await lclick(okBtn.x, okBtn.y);
    return true;
  };
  const waitLogs = async (kw, tries = 50) => {
    for (let i = 0; i < tries; i += 1) {
      const ls = await ev(`[...document.querySelectorAll('[data-dh-sync="logs"] [data-dh-sync-log]')].map((x) => x.textContent)`);
      if (ls && ls.some((t) => t.includes(kw))) return ls;
      await sleep(500);
    }
    return null;
  };
  // 应用后的自动重比较会重置默认勾选：等比较按钮退出 loading 再操作勾选
  const waitCompareIdle = async (tries = 50) => {
    for (let i = 0; i < tries; i += 1) {
      const busy = await ev(`(document.querySelector('[data-dh-sync="compare"]') || { className: '' }).className.includes('ant-btn-loading')`);
      if (!busy) return true;
      await sleep(500);
    }
    return false;
  };
  const sqlText = () => ev(`(document.querySelector('[data-dh-sync="sql"]') || { textContent: '' }).textContent`);

  // ---- T1 工具栏入口 ----
  const t1 = await posOf(`[...document.querySelectorAll('.top-toolbar .tb-btn')].find((b) => b.textContent.replace(/\\s+/g, '') === '结构同步')`);
  if (!t1) fail('T1 定位工具栏按钮', '未找到');
  else {
    await lclick(t1.x, t1.y);
    let root = null;
    for (let i = 0; i < 10 && !root; i += 1) { root = await ev("!!document.querySelector('[data-dh-sync=\"root\"]')"); if (!root) await sleep(400); }
    const tabOk = await ev(`(() => { const t = [...document.querySelectorAll('.main-tabs .ant-tabs-tab')].find((x) => x.textContent.includes('结构同步')); return !!t && t.className.includes('ant-tabs-tab-active'); })()`);
    root && tabOk ? pass('T1 工具栏打开结构同步页签') : fail('T1 页签', JSON.stringify({ root: !!root, tabOk }));
  }

  // ---- T2 sqlite → mssql 比较 ----
  if (!(await setSide('源', '演示 SQLite 库（SQLite）', null))) fail('T2 选择源', 'sqlite 连接未选中');
  if (!(await setSide('目标', '1（SQL Server）', 'master'))) fail('T2 选择目标', 'mssql/master 未选中');
  else if (await doCompare()) {
    const rs = await waitRows([
      { name: 'employees', status: '新建' },
      { name: 'dh_w27_a', status: '新建' },
      { name: 'dh_w27_b', status: '新建' },
      { name: 'dh_w27_m', status: '目标独有' },
      { name: 'dh_w27_m2', status: '目标独有' },
    ]);
    if (!rs) fail('T2 比较结果', JSON.stringify((await syncRows()) || []).slice(0, 300));
    else {
      const emp = rs.find((r) => r.name === 'employees');
      const a = rs.find((r) => r.name === 'dh_w27_a');
      const m = rs.find((r) => r.name === 'dh_w27_m');
      emp.checked === true && a.checked === true && m.checked === false
        ? pass('T2 状态/默认勾选（新建勾选、目标独有不勾）')
        : fail('T2 默认勾选', JSON.stringify({ emp: emp.checked, a: a.checked, m: m.checked }));
      const st = await sqlText();
      const has = ['dh_w27_a', 'dh_w27_ix', 'dh_w27_ck', 'DECIMAL(10,2)', 'dh_w27_b'].every((k) => st.includes(k));
      has ? pass('T2 SQL 预览含建表/索引/CHECK/类型映射') : fail('T2 SQL 预览', String(st).slice(0, 260));
    }
  } else fail('T2 比较', '按钮不可用或未点击');

  // ---- T3 取消 employees 勾选 → 应用 → mssql 侧校验 ----
  await onlyCheck(['dh_w27_a', 'dh_w27_b']);
  if (await doApply()) {
    const ls = await waitLogs('结束');
    const okLog = ls && ls.filter((t) => t.includes('已建表')).length === 2 && ls.some((t) => t.includes('成功 2、失败 0'));
    okLog ? pass('T3 应用 2 项建表') : fail('T3 应用日志', JSON.stringify(ls || []).slice(0, 300));
    let notCreate = false;
    for (let i = 0; i < 30 && !notCreate; i += 1) {
      const rs = await syncRows();
      const a = rs && rs.find((r) => r.name === 'dh_w27_a');
      if (a && a.status !== '新建') notCreate = true;
      else await sleep(600);
    }
    notCreate ? pass('T3 应用后重比较 dh_w27_a 不再是新建') : fail('T3 重比较', '仍是新建');
    const A = fxJson('verify-a', 'JSON-A');
    try {
      // mssqlExec 把多个查询的行打平返回：前 5 行是 dh_w27_a 的列（6 字段），后 3 行是单值计数
      const col = (n) => A.find((r) => Array.isArray(r) && r.length >= 6 && r[0] === n);
      const counts = A.filter((r) => Array.isArray(r) && r.length === 1).map((r) => r[0]);
      const idRow = col('id');
      const nmRow = col('nm');
      const prRow = col('price');
      idRow && String(idRow[1]).toUpperCase() === 'BIGINT' && nmRow && String(nmRow[1]).toUpperCase() === 'NVARCHAR' && Number(nmRow[2]) === -1 && prRow && String(prRow[1]).toUpperCase() === 'DECIMAL' && Number(prRow[3]) === 10 && Number(prRow[4]) === 2 && counts.length === 3 && counts.every((v) => v === 1)
        ? pass('T3 mssql 侧类型/索引/CHECK（id BIGINT、nm NVARCHAR(MAX)、price DECIMAL(10,2)）')
        : fail('T3 mssql 校验', JSON.stringify(A).slice(0, 400));
    } catch (e) {
      fail('T3 mssql 校验解析', e.message + ' ' + JSON.stringify(A).slice(0, 200));
    }
  } else fail('T3 应用', '确认弹窗未出现');

  // ---- T4 反向 mssql → sqlite：只勾 m/m2 建到 sqlite ----
  if (await setSide('源', '1（SQL Server）', 'master')) {
    if (await setSide('目标', '演示 SQLite 库（SQLite）', null)) {
      if (await doCompare()) {
        const rs = await waitRows([
          { name: 'dh_w27_m', status: '新建' },
          { name: 'dh_w27_m2', status: '新建' },
          { name: 'employees', status: '目标独有' },
        ]);
        if (!rs) fail('T4 反向比较', JSON.stringify((await syncRows()) || []).slice(0, 300));
        else {
          await onlyCheck(['dh_w27_m', 'dh_w27_m2']);
          if (await doApply()) {
            const ls = await waitLogs('结束');
            ls && ls.filter((t) => t.includes('已建表')).length === 2 && ls.some((t) => t.includes('失败 0'))
              ? pass('T4 sqlite 侧建 m/m2 两表')
              : fail('T4 应用日志', JSON.stringify(ls || []).slice(0, 300));
            const B = fxJson('verify-b', 'JSON-B');
            try {
              const names = B.cols.map((c) => c[1]);
              const six = ['id', 'mgr', 'nm', 'qty', 'price'].every((n) => names.includes(n));
              const hasMix = B.idx.some((x) => x[0] === 'dh_w27_mix');
              const tablesOk = B.tables.includes('dh_w27_m') && B.tables.includes('dh_w27_m2') && B.tables.includes('employees');
              six && hasMix && B.hasFk && B.hasCk && tablesOk
                ? pass('T4 sqlite 侧列/索引/外键/CHECK 齐全')
                : fail('T4 sqlite 校验', JSON.stringify(B).slice(0, 400));
            } catch (e) {
              fail('T4 sqlite 校验解析', e.message);
            }
          } else fail('T4 应用', '弹窗未出现');
        }
      } else fail('T4 比较', '未完成');
    } else fail('T4 目标切换', 'sqlite 未选中');
  } else fail('T4 源切换', 'mssql 未选中');

  // ---- T5 stage2 差异同步：mssql 加列 extra2 + 索引 dh_w27_mix2 ----
  fx('stage2');
  if (await doCompare()) {
    let row = null;
    for (let i = 0; i < 40 && !row; i += 1) {
      const rs = await syncRows();
      const m = rs && rs.find((r) => r.name === 'dh_w27_m' && r.status === '有差异');
      if (m && m.changes.includes('extra2') && m.changes.includes('dh_w27_mix2')) row = m;
      else await sleep(600);
    }
    if (!row) fail('T5 差异检测', JSON.stringify((await syncRows()) || []).slice(0, 300));
    else {
      pass('T5 差异明细（+列 extra2、+索引 dh_w27_mix2）');
      const st = await sqlText();
      st.includes('ALTER TABLE') ? pass('T5 SQL 预览含 ALTER TABLE') : fail('T5 SQL 预览', String(st).slice(0, 200));
      await onlyCheck(['dh_w27_m']);
      if (await doApply()) {
        const ls = await waitLogs('结束');
        ls && ls.some((t) => t.includes('已执行') && t.includes('dh_w27_m')) && ls.some((t) => t.includes('失败 0'))
          ? pass('T5 差异应用成功')
          : fail('T5 应用日志', JSON.stringify(ls || []).slice(0, 300));
        const B = fxJson('verify-b', 'JSON-B');
        const names = B ? B.cols.map((c) => c[1]) : [];
        const hasMix2 = B && B.idx.some((x) => x[0] === 'dh_w27_mix2');
        names.includes('extra2') && hasMix2
          ? pass('T5 sqlite 侧补齐 extra2 列 + dh_w27_mix2 索引')
          : fail('T5 sqlite 校验', JSON.stringify(B).slice(0, 300));
      } else fail('T5 应用', '弹窗未出现');
    }
  } else fail('T5 重比较', '比较失败');
  await sleep(2500);

  // ---- T6 删除目标独有表 employees ----
  await waitCompareIdle();
  await sleep(800);
  await onlyCheck(['employees']);
  if (await doApply()) {
    const modalTxt = await ev(`(document.querySelector('.ant-modal-confirm-content') || { textContent: '' }).textContent`);
    const ls = await waitLogs('结束');
    const delOk = ls && ls.some((t) => t.includes('employees') && t.includes('已删除')) && ls.some((t) => t.includes('失败 0'));
    delOk ? pass('T6 删除目标独有表 employees（确认弹窗：' + String(modalTxt).slice(0, 18) + '…）') : fail('T6 应用日志', JSON.stringify(ls || []).slice(0, 300));
    let gone = null;
    for (let i = 0; i < 30 && !gone; i += 1) {
      const B = fxJson('verify-b', 'JSON-B');
      if (B && !B.tables.includes('employees')) gone = true;
      else await sleep(800);
    }
    gone ? pass('T6 sqlite 侧 employees 已删除') : fail('T6 sqlite 校验', 'employees 仍存在');
  } else fail('T6 应用', '弹窗未出现');

  // ---- T7 自比较：源=目标=同一 sqlite → 全部一致 ----
  // T6 应用后会触发自动重比较（comparing 遮挡会吃掉下拉点击）：先等比较空闲
  await waitCompareIdle();
  await sleep(800);
  if (await setSide('源', '演示 SQLite 库（SQLite）', null)) {
    if (await doCompare()) {
      let allSame = null;
      for (let i = 0; i < 30 && allSame === null; i += 1) {
        const rs = await syncRows();
        if (rs && rs.length) allSame = rs.every((r) => r.status === '一致');
        else await sleep(600);
      }
      allSame === true ? pass('T7 同库自比较全部一致') : fail('T7 自比较', JSON.stringify((await syncRows()) || []).slice(0, 300));
    } else fail('T7 比较', '失败');
  } else fail('T7 源切换', '失败');

  // S5 控制台错误
  await sleep(600);
  errors.length === 0 ? pass('S5 无控制台错误') : fail('S5 控制台错误', errors.slice(0, 4).join(' | ').slice(0, 300));

  console.log('ROUND27-DONE');
  try { await client.close(); } catch {}
  process.exit(process.exitCode || 0);
})().catch((e) => {
  console.error('FATAL', e.message);
  process.exit(1);
});
