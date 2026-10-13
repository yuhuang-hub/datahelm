'use strict';
// v0927.52 同步比较进度条验证（9230 新实例；夹具 scripts/fx/fx-w48 stage1：w48-src 61 表、前 30 张各 8000 行；w48-dst employees 王五漂移+30 同构（t001 一行 qty 差异）+extra）：
//  T1 工具栏「结构同步」→ 页签
//  T2 源/目标选 W48 两库
//  T3 结构比较：完成态（success + 「比较完成 · 61 张表」）+ 逐表事件流 DH-SYNC-PROG 61 条（i=1..61 首尾表正确）
//  T4 结构结果：新建 30（默认全勾）/一致 31/目标独有 1（不勾）
//  T5 工具栏「数据同步」→ 同库比较 → live DOM 帧捕获（正在比较：表名 n/N，8000 行/表保证 ~1s live 窗口）+ 完成态 + DH-DSYNC-PROG 61 条
//  T6 数据结果：有差异 2（employees、w48_t001 各 1 更新，默认勾选）/一致 29/目标缺表 30
//  S5 无控制台错误
// 注：结构比较走 sqlite 元数据（61 表整簇 ~10ms）——live DOM 帧不可轮询捕获，其逐表进度以日志事件流为准
const CDP = require('chrome-remote-interface');
const fs = require('fs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LOG = 'D:/DataHelm/.tmp-ud7/ui-debug.log';

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
  const lclick = async (x, y) => { await press(x.x !== undefined ? x.x : x, x.y !== undefined ? x.y : y, 'left', 1); await sleep(300); };
  const posOf = async (expr) => {
    const p = await ev(`(() => { const el = ${expr}; if (!el) return null; el.scrollIntoView({ block: 'nearest' }); const r = el.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
    return p && !p.err ? p : null;
  };
  const pass = (n) => console.log('PASS', n);
  const fail = (n, d) => { console.log('FAIL', n, d || ''); process.exitCode = 1; };
  const logFilter = (kw) => { try { return fs.readFileSync(LOG, 'utf8').split('\n').filter((l) => l.includes(kw)); } catch { return []; } };

  // 等主窗揭示
  let ok = false;
  for (let i = 0; i < 40 && !ok; i += 1) {
    ok = await ev("!!document.querySelector('.top-toolbar .tb-btn')");
    if (!ok) await sleep(500);
  }

  // S0 版本
  const ver = await ev("(() => { const s = document.querySelector('.statusbar'); return s ? s.textContent : ''; })()");
  /v0927\.52/.test(ver) ? pass('S0 版本 v0927.52') : fail('S0 版本', String(ver).slice(0, 120));

  // ---- antd Select 选择（round27 同款：等旧下拉收起 → mousedown 打开 → 点选项 → 校验面板文本）----
  const openSelect = async (attr, panel, idx) => {
    for (let w = 0; w < 12; w += 1) {
      const n = await ev("document.querySelectorAll('.ant-select-dropdown:not(.ant-select-dropdown-hidden)').length");
      if (!n) break;
      await sleep(300);
    }
    let p = null;
    for (let i = 0; i < 10 && !p; i += 1) {
      p = await posOf(`[...document.querySelectorAll('[data-dh-${attr}="${panel}"] .ant-select')][${idx}].querySelector('.ant-select-selector')`);
      if (!p) await sleep(400);
    }
    if (!p) return false;
    await press(p.x, p.y, 'left', 1);
    await sleep(450);
    return true;
  };
  const pickOption = async (title, tries = 16) => {
    for (let i = 0; i < tries; i += 1) {
      const p = await posOf(`[...document.querySelectorAll('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option')].find((o) => o.getAttribute('title') === ${JSON.stringify(title)} || o.textContent.trim() === ${JSON.stringify(title)})`);
      if (p) { await lclick(p.x, p.y); return true; }
      await sleep(400);
    }
    return false;
  };
  const sideHas = (attr, panel, label) => ev(`(() => { const d = document.querySelector('[data-dh-${attr}="${panel}"]'); return !!(d && d.textContent.includes(${JSON.stringify(label)})); })()`);
  const setSide = async (attr, panel, connLabel) => {
    for (let a = 0; a < 3; a += 1) {
      if (await openSelect(attr, panel, 0)) {
        if (await pickOption(connLabel)) {
          await sleep(700);
          if (await sideHas(attr, panel, connLabel)) return true;
        }
      }
    }
    return false;
  };

  // 结果表行 {name, status, checked, cells}
  const rowsOf = (attr) => ev(`(() => {
    const rows = [...document.querySelectorAll('[data-dh-${attr}="table"] .ant-table-row')];
    return rows.map((r) => ({
      name: r.getAttribute('data-row-key'),
      status: (r.querySelector('.ant-tag') || { textContent: '' }).textContent.trim(),
      checked: !!r.querySelector('.ant-checkbox-checked'),
      cells: [...r.querySelectorAll('td')].map((c) => c.textContent.trim()),
    }));
  })()`);
  const waitRowsCount = async (attr, want, tries = 40) => {
    for (let i = 0; i < tries; i += 1) {
      const rs = await rowsOf(attr);
      if (rs && rs.length === want) return rs;
      await sleep(600);
    }
    return null;
  };
  const waitCompareIdle = async (attr, tries = 60) => {
    for (let i = 0; i < tries; i += 1) {
      const busy = await ev(`(document.querySelector('[data-dh-${attr}="compare"]') || { className: '' }).className.includes('ant-btn-loading')`);
      if (!busy) return true;
      await sleep(300);
    }
    return false;
  };
  // 进度 live 帧文本
  const liveText = (attr) => ev(`(() => { const s = document.querySelector('[data-dh-${attr}-prog="live"]'); return s ? s.textContent : null; })()`);
  const doneText = (attr) => ev(`(() => { const s = document.querySelector('[data-dh-${attr}-prog="done"]'); return s ? s.textContent : null; })()`);
  const barOk = (attr) => ev(`(() => { const b = document.querySelector('[data-dh-${attr}="prog"] .dh-sync-prog-bar'); if (!b) return null; return { success: b.className.includes('ant-progress-status-success'), icon: !!b.querySelector('.ant-progress-text .anticon-check-circle'), w: (b.querySelector('.ant-progress-bg') || { style: {} }).style.width }; })()`);
  // 比较 + 捕获 live 帧（busy 期间持续轮询）
  const compareWithProg = async (attr, logKw) => {
    const base = logFilter(logKw).length;
    const btn = await posOf(`document.querySelector('[data-dh-${attr}="compare"]')`);
    if (!btn) return { err: 'compare 按钮未找到' };
    await lclick(btn.x, btn.y);
    const frames = [];
    let sawWrap = false;
    for (let i = 0; i < 120; i += 1) {
      const busy = await ev(`(document.querySelector('[data-dh-${attr}="compare"]') || { className: '' }).className.includes('ant-btn-loading')`);
      if (await ev(`!!document.querySelector('[data-dh-${attr}="prog"]` + `')`)) sawWrap = true;
      const t = await liveText(attr);
      if (t) {
        const m = t.match(/正在比较：(\S+)（(\d+)\/(\d+)/);
        if (m) frames.push({ table: m[1], i: Number(m[2]), n: Number(m[3]) });
      }
      if (!busy && i > 2) break;
      await sleep(40);
    }
    await waitCompareIdle(attr);
    await sleep(700); // 迟到尾事件（乱序）+ 延迟退订落日志的余量
    const lines = logFilter(logKw).slice(base).map((l) => {
      const m = l.match(/t=(\S+) i=(\d+) n=(\d+)/);
      return m ? { table: m[1], i: Number(m[2]), n: Number(m[3]) } : null;
    }).filter(Boolean);
    return { frames, sawWrap, lines, base };
  };

  // ---- T1 工具栏结构同步 ----
  const t1 = await posOf(`[...document.querySelectorAll('.top-toolbar .tb-btn')].find((b) => b.textContent.replace(/\\s+/g, '') === '结构同步')`);
  if (!t1) fail('T1 定位工具栏按钮', '未找到');
  else {
    await lclick(t1.x, t1.y);
    let root = null;
    for (let i = 0; i < 10 && !root; i += 1) { root = await ev("!!document.querySelector('[data-dh-sync=\"root\"]')"); if (!root) await sleep(400); }
    const tabOk = await ev(`(() => { const t = [...document.querySelectorAll('.main-tabs .ant-tabs-tab')].find((x) => x.textContent.includes('结构同步')); return !!t && t.className.includes('ant-tabs-tab-active'); })()`);
    root && tabOk ? pass('T1 工具栏打开结构同步页签') : fail('T1 页签', JSON.stringify({ root: !!root, tabOk }));
  }

  // ---- T2 选源/目标 ----
  const s1 = await setSide('sync', '源', 'W48源库（SQLite）');
  const s2 = await setSide('sync', '目标', 'W48目标库（SQLite）');
  s1 && s2 ? pass('T2 源/目标选择') : fail('T2 源/目标选择', JSON.stringify({ s1, s2 }));

  // ---- T3 结构比较进度 ----
  // 结构比较走 sqlite 元数据（61 表整簇 ~10ms）——live DOM 帧不可轮询捕获，
  // 逐表事件流以 DH-SYNC-PROG 日志为准（每表开工一条，i=1..61 连续）；DOM 断言完成态
  const r3 = await compareWithProg('sync', 'DH-SYNC-PROG');
  if (r3.err) fail('T3 比较', r3.err);
  else {
    const dt = await doneText('sync');
    const bar = await barOk('sync');
    dt === '比较完成 · 61 张表' ? pass('T3 完成态「比较完成 · 61 张表」') : fail('T3 完成态', String(dt));
    bar && bar.success && (bar.icon || bar.w === '100%') ? pass('T3 进度条完成态 success（check 图标 / 100% 宽）') : fail('T3 进度条', JSON.stringify(bar));
    const ls = r3.lines;
    const asc = ls.length === 61 && ls.every((x, k) => x.i === k + 1 && x.n === 61 && x.table);
    const ends = ls.length && ls[0].table === 'employees' && ls[ls.length - 1].table === 'w48_t060';
    asc && ends ? pass('T3 逐表事件流 DH-SYNC-PROG 61 条（i=1..61、首表 employees、末表 w48_t060）') : fail('T3 事件流', JSON.stringify({ n: ls.length, first: ls[0], last: ls[ls.length - 1] }));
  }

  // ---- T4 结构结果行 ----
  const rs4 = await waitRowsCount('sync', 62);
  if (!rs4) fail('T4 结果行', '62 行未出现');
  else {
    const cnt = (st) => rs4.filter((r) => r.status === st).length;
    const emp = rs4.find((r) => r.name === 'employees');
    const t031 = rs4.find((r) => r.name === 'w48_t031');
    const extra = rs4.find((r) => r.name === 'w48_extra');
    cnt('新建') === 30 && cnt('一致') === 31 && cnt('目标独有') === 1
      ? pass('T4 状态分布：新建 30 / 一致 31 / 目标独有 1')
      : fail('T4 状态分布', JSON.stringify({ create: cnt('新建'), same: cnt('一致'), extra: cnt('目标独有') }));
    rs4.filter((r) => r.checked).length === 30 && emp && emp.status === '一致' && !emp.checked && t031 && t031.status === '新建' && t031.checked && extra && !extra.checked
      ? pass('T4 默认勾选（新建 30 勾、一致/目标独有不勾）')
      : fail('T4 默认勾选', JSON.stringify({ checked: rs4.filter((r) => r.checked).length, emp: emp && emp.status, t031: t031 && t031.status }));
  }

  // ---- T5 数据同步 ----
  const t5 = await posOf(`[...document.querySelectorAll('.top-toolbar .tb-btn')].find((b) => b.textContent.replace(/\\s+/g, '') === '数据同步')`);
  if (!t5) fail('T5 定位工具栏按钮', '未找到');
  else {
    await lclick(t5.x, t5.y);
    let root5 = null;
    for (let i = 0; i < 10 && !root5; i += 1) { root5 = await ev("!!document.querySelector('[data-dh-dsync=\"root\"]')"); if (!root5) await sleep(400); }
    if (!root5) fail('T5 页签', 'dsync root 未出现');
    else {
      const d1 = await setSide('dsync', '源', 'W48源库（SQLite）');
      const d2 = await setSide('dsync', '目标', 'W48目标库（SQLite）');
      if (!(d1 && d2)) fail('T5 源/目标选择', JSON.stringify({ d1, d2 }));
      else {
        pass('T5 页签 + 源/目标选择');
        const r5 = await compareWithProg('dsync', 'DH-DSYNC-PROG');
        if (r5.err) fail('T5 比较', r5.err);
        else {
          const dt = await doneText('dsync');
          const bar = await barOk('dsync');
          dt === '比较完成 · 61 张表' ? pass('T5 完成态「比较完成 · 61 张表」') : fail('T5 完成态', String(dt));
          bar && bar.success && (bar.icon || bar.w === '100%') ? pass('T5 进度条完成态 success') : fail('T5 进度条', JSON.stringify(bar));
          // 数据比较每表两侧全量拉 8000 行 → live 窗口 ~1s，DOM 轮询可稳定捕获「正在比较：表名（n/N）」
          r5.frames.length >= 1 && r5.frames.every((f) => f.table && f.n === 61 && f.i >= 1 && f.i <= 61)
            ? pass('T5 live 帧捕获 ' + r5.frames.length + ' 帧（首帧 ' + r5.frames[0].table + ' ' + r5.frames[0].i + '/' + r5.frames[0].n + '）')
            : fail('T5 live 帧', JSON.stringify({ n: r5.frames.length, first: r5.frames[0] }));
          const ls = r5.lines;
          const asc = ls.length === 61 && ls.every((x, k) => x.i === k + 1 && x.n === 61 && x.table);
          asc ? pass('T5 逐表事件流 DH-DSYNC-PROG 61 条 i=1..61') : fail('T5 事件流', JSON.stringify({ n: ls.length, first: ls[0], last: ls[ls.length - 1] }));
        }
      }
    }
  }

  // ---- T6 数据结果行 ----
  const rs6 = await waitRowsCount('dsync', 61);
  if (!rs6) fail('T6 结果行', '61 行未出现');
  else {
    const cnt = (st) => rs6.filter((r) => r.status === st).length;
    const emp = rs6.find((r) => r.name === 'employees');
    const t001 = rs6.find((r) => r.name === 'w48_t001');
    const upd = (r) => (r && r.cells[4] ? r.cells[4] : '');
    cnt('有差异') === 2 && cnt('一致') === 29 && cnt('目标缺表') === 30
      ? pass('T6 状态分布：差异 2 / 一致 29 / 缺表 30')
      : fail('T6 状态分布', JSON.stringify({ diff: cnt('有差异'), same: cnt('一致'), miss: cnt('目标缺表') }));
    emp && emp.status === '有差异' && upd(emp) === '1' && t001 && t001.status === '有差异' && upd(t001) === '1' && rs6.filter((r) => r.checked).length === 2
      ? pass('T6 差异明细（employees 1 更新、w48_t001 1 更新，默认勾选 2）')
      : fail('T6 差异明细', JSON.stringify({ emp: emp && { st: emp.status, upd: upd(emp) }, t001: t001 && { st: t001.status, upd: upd(t001) }, checked: rs6.filter((r) => r.checked).length }));
  }

  // S5 控制台错误
  await sleep(600);
  errors.length === 0 ? pass('S5 无控制台错误') : fail('S5 控制台错误', errors.slice(0, 4).join(' | ').slice(0, 300));

  console.log('ROUND48-DONE');
  try { await client.close(); } catch {}
  process.exit(process.exitCode || 0);
})().catch((e) => {
  console.error('FATAL', e.message);
  process.exit(1);
});
