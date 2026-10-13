'use strict';
// v0927.52 运行 SQL 文件/还原备份 验证（9229 新实例；夹具 fx-w29：backups 目录 3 个测试 sql + mssql master.dbo dh_w29_*）：
//  T1 连接右键「运行 SQL 文件…」→ 页签打开 + preset 连接已选（sqlite）
//  T2 选 w29-restore.sql → 运行 → 结果 语句 4 · 成功 4 · 失败 0（分号/转义引号/UPDATE 均原样执行）
//  T3 sqlite 侧 verify-a：dh_w29_t 两行与脚本预期完全一致（且已落盘）
//  T4 切换目标 1/mssql/master + w29-restore-mssql.sql（GO 分批）→ 成功 3 → verify-b 逐行一致
//  T5 w29-bad.sql 默认遇错继续 → 成功 3 失败 1 + 错误明细面板 + verify-c 只含 id 2/3
//  T6 取消「遇到错误时继续」→ 重跑 → 首句失败即停 成功 0 失败 1 + verify-c 不变
//  T7 备份计划页签 →「还原备份」→ 聚焦运行 SQL 文件页签
//  T8 底部说明 + 日志面板 + ui-debug DH-RESTORE 标记
//  S5 无控制台错误
const CDP = require('chrome-remote-interface');
const { execFileSync } = require('child_process');
const fs = require('fs');
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
  const FX_STAGES = ['stage1', 'verify-a', 'verify-b', 'verify-c', 'cleanup'];
  const fx = (stage) => {
    if (!FX_STAGES.includes(stage)) throw new Error('unknown fx stage');
    return execFileSync('node', ['D:/DataHelm/scripts/fx/fx-w29.js', stage], { cwd: 'D:/DataHelm', encoding: 'utf8' });
  };
  const fxJson = (stage, marker) => {
    const out = fx(stage);
    const line = out.split('\n').find((l) => l.startsWith(marker));
    return line ? JSON.parse(line.slice(marker.length).trim()) : null;
  };
  const logHas = (kw) => {
    try { return fs.readFileSync('D:/DataHelm/.tmp-ud7/ui-debug.log', 'utf8').includes(kw); } catch { return false; }
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

  // ---- antd Select：mousedown 打开下拉；选项按标题前缀/全等匹配 ----
  const DBG = !!process.env.DBG29;
  const openSelect = async (marker, idx) => {
    const p = await posOf(`[...document.querySelectorAll('[data-dh-restore="${marker}"] .ant-select')][${idx}].querySelector('.ant-select-selector')`);
    if (DBG) console.log('DBG openSelect', marker, idx, JSON.stringify(p));
    if (!p) return false;
    await press(p.x, p.y, 'left', 1);
    await sleep(450);
    return true;
  };
  const pickOption = async (title, tries = 16) => {
    for (let i = 0; i < tries; i += 1) {
      const p = await posOf(`[...document.querySelectorAll('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option')].find((o) => (o.getAttribute('title') || o.textContent.trim()) === ${JSON.stringify(title)})`);
      if (DBG) console.log('DBG pickOption', title, JSON.stringify(p));
      if (p) { await lclick(p.x, p.y); return true; }
      await sleep(400);
    }
    return false;
  };
  const pickOptionPrefix = async (prefix, tries = 16) => {
    for (let i = 0; i < tries; i += 1) {
      const p = await posOf(`[...document.querySelectorAll('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option')].find((o) => (o.getAttribute('title') || o.textContent.trim()).startsWith(${JSON.stringify(prefix)}))`);
      if (DBG) console.log('DBG pickOptionPrefix', prefix, JSON.stringify(p));
      if (p) { await lclick(p.x, p.y); return true; }
      await sleep(400);
    }
    return false;
  };
  const selValue = (marker, idx) => ev(`(() => { const s = [...document.querySelectorAll('[data-dh-restore="${marker}"] .ant-select')][${idx}]; const t = s && s.querySelector('.ant-select-selection-item'); return t ? t.textContent.trim() : null; })()`);

  const doRun = async () => {
    const p = await posOf(`document.querySelector('[data-dh-restore="run"]')`);
    if (!p || !p.x) return false;
    await lclick(p.x, p.y);
    await sleep(600);
    const okBtn = await posOf(`[...document.querySelectorAll('.ant-modal-confirm-btns .ant-btn')].find((b) => b.textContent.replace(/\\s+/g, '') === '运行')`);
    if (!okBtn) return false;
    await lclick(okBtn.x, okBtn.y);
    return true;
  };
  const resultText = () => ev(`(() => { const r = document.querySelector('[data-dh-restore="result"]'); if (!r) return null; return { stats: (r.querySelector('div') || { textContent: '' }).textContent.replace(/\\s+/g, ' ').trim(), errs: [...r.querySelectorAll('[data-dh-restore="errline"]')].map((x) => x.textContent.trim()) }; })()`);
  const waitResult = async (kws, tries = 40) => {
    for (let i = 0; i < tries; i += 1) {
      const r = await resultText();
      if (r && kws.every((k) => r.stats.includes(k))) return r;
      await sleep(500);
    }
    return null;
  };
  const setContinueOnErr = async (wantChecked) => {
    const box = await ev(`(() => { const w = document.querySelector('[data-dh-restore="opts"] .ant-checkbox-wrapper'); return w ? { checked: !!w.querySelector('.ant-checkbox-checked') } : null; })()`);
    if (!box) return false;
    if (box.checked !== wantChecked) {
      const p = await posOf(`document.querySelector('[data-dh-restore="opts"] .ant-checkbox-wrapper')`);
      if (!p) return false;
      await lclick(p.x, p.y);
      await sleep(300);
    }
    return true;
  };

  // ---- T1 连接右键 → 运行 SQL 文件… ----
  const connPos = await ev(`(() => {
    const rows = [...document.querySelectorAll('.tree-wrap .ant-tree-treenode')].filter((r) => r.querySelector('.node-title') && r.getBoundingClientRect().height > 0);
    const f = rows.find((r) => r.querySelector('.node-title').textContent.trim() === '演示 SQLite 库');
    if (!f) return null;
    f.scrollIntoView({ block: 'nearest' });
    const t = f.querySelector('.node-title').getBoundingClientRect();
    return { x: Math.round(t.x + t.width / 2), y: Math.round(t.y + t.height / 2) };
  })()`);
  if (!connPos) fail('T1 定位连接节点', '演示 SQLite 库 未找到');
  else {
    await press(connPos.x, connPos.y, 'right', 1);
    await sleep(500);
    const mi = await posOf(`[...document.querySelectorAll('.ant-menu-item')].find((m) => m.textContent.trim() === '运行 SQL 文件…')`);
    if (!mi) fail('T1 右键菜单', '未找到「运行 SQL 文件…」项');
    else {
      await lclick(mi.x, mi.y);
      let root = null;
      for (let i = 0; i < 12 && !root; i += 1) { root = await ev("!!document.querySelector('[data-dh-restore=\"root\"]')"); if (!root) await sleep(400); }
      const tabOk = await ev(`(() => { const t = [...document.querySelectorAll('.main-tabs .ant-tabs-tab')].find((x) => x.textContent.includes('运行 SQL 文件')); return !!t && t.className.includes('ant-tabs-tab-active'); })()`);
      const presetConn = await selValue('conn', 0);
      root && tabOk ? pass('T1 连接右键「运行 SQL 文件…」打开页签') : fail('T1 页签', JSON.stringify({ root: !!root, tabOk }));
      presetConn === '演示 SQLite 库（SQLite）' ? pass('T1 preset：目标连接已预选 sqlite') : fail('T1 preset', String(presetConn));
    }
  }

  // ---- T2 选文件并运行（sqlite）----
  if (!(await openSelect('file', 0))) fail('T2 打开文件下拉', '未找到');
  else if (!(await pickOptionPrefix('w29-restore.sql'))) fail('T2 选择文件', 'w29-restore.sql 不在下拉');
  else if (await doRun()) {
    const r = await waitResult(['语句 4', '成功 4', '失败 0']);
    r ? pass('T2 sqlite 运行：语句 4 · 成功 4 · 失败 0') : fail('T2 结果', JSON.stringify((await resultText()) || null).slice(0, 300));
  } else fail('T2 运行', '确认弹窗未出现');

  // ---- T3 sqlite 侧逐行校验（文件已落盘）----
  const A = fxJson('verify-a', 'JSON-A');
  try {
    const want = [
      { id: 1, nm: '甲;分号', qty: 10 },
      { id: 2, nm: "引'号", qty: 33 },
    ];
    JSON.stringify(A) === JSON.stringify(want)
      ? pass('T3 sqlite 落盘校验：分号字符串/转义引号/UPDATE 全部原样生效')
      : fail('T3 sqlite 校验', JSON.stringify(A).slice(0, 300));
  } catch (e) {
    fail('T3 解析', e.message + ' ' + JSON.stringify(A).slice(0, 200));
  }

  // ---- T4 切换 mssql/master + GO 分批脚本 ----
  if (!(await openSelect('conn', 0))) fail('T4 打开连接下拉', '未找到');
  else if (!(await pickOption('1（SQL Server）'))) fail('T4 选择连接', '1（SQL Server）未选中');
  else {
    await sleep(800); // loadRoot → db 下拉出现
    if (!(await openSelect('db', 0))) fail('T4 打开库下拉', '未找到');
    else if (!(await pickOption('master'))) fail('T4 选择库', 'master 未选中');
    else if (!(await openSelect('file', 0))) fail('T4 打开文件下拉', '未找到');
    else if (!(await pickOptionPrefix('w29-restore-mssql.sql'))) fail('T4 选择文件', 'mssql 脚本不在下拉');
    else if (await doRun()) {
      const r = await waitResult(['语句 3', '成功 3', '失败 0']);
      r ? pass('T4 mssql 运行（GO 分批）：语句 3 · 成功 3 · 失败 0') : fail('T4 结果', JSON.stringify((await resultText()) || null).slice(0, 300));
      const B = fxJson('verify-b', 'JSON-B');
      try {
        const want = [
          { id: 1, nm: '甲', qty: 10 },
          { id: 2, nm: '乙', qty: 20 },
        ];
        JSON.stringify(B) === JSON.stringify(want) ? pass('T4 mssql 逐行校验（NVARCHAR/INT）') : fail('T4 mssql 校验', JSON.stringify(B).slice(0, 300));
      } catch (e) {
        fail('T4 解析', e.message);
      }
    } else fail('T4 运行', '确认弹窗未出现');
  }

  // ---- T5 默认遇错继续 ----
  if (!(await openSelect('file', 0))) fail('T5 打开文件下拉', '未找到');
  else if (!(await pickOptionPrefix('w29-bad.sql'))) fail('T5 选择文件', 'w29-bad.sql 不在下拉');
  else if (await doRun()) {
    const r = await waitResult(['语句 4', '成功 3', '失败 1']);
    if (!r) fail('T5 结果', JSON.stringify((await resultText()) || null).slice(0, 300));
    else {
      const errOk = r.errs.length >= 1 && r.errs[0].length > 4;
      errOk ? pass('T5 遇错继续：成功 3 失败 1 + 错误明细面板') : fail('T5 错误明细', JSON.stringify(r.errs).slice(0, 200));
    }
    const C = fxJson('verify-c', 'JSON-C');
    try {
      const want = [
        { id: 2, nm: 'y' },
        { id: 3, nm: 'z' },
      ];
      JSON.stringify(C) === JSON.stringify(want) ? pass('T5 mssql：坏句跳过，id 2/3 已插入、id 1 无') : fail('T5 mssql 校验', JSON.stringify(C).slice(0, 300));
    } catch (e) {
      fail('T5 解析', e.message);
    }
  } else fail('T5 运行', '确认弹窗未出现');

  // ---- T6 取消「遇到错误时继续」→ 首错即停 ----
  if (!(await setContinueOnErr(false))) fail('T6 取消遇错继续', '复选框未找到');
  else if (await doRun()) {
    const r = await waitResult(['语句 1', '成功 0', '失败 1']);
    r ? pass('T6 首错即停：语句 1 · 成功 0 · 失败 1') : fail('T6 结果', JSON.stringify((await resultText()) || null).slice(0, 300));
    const C = fxJson('verify-c', 'JSON-C');
    try {
      const want = [
        { id: 2, nm: 'y' },
        { id: 3, nm: 'z' },
      ];
      JSON.stringify(C) === JSON.stringify(want) ? pass('T6 mssql：坏句未再执行（表已存在即停）') : fail('T6 mssql 校验', JSON.stringify(C).slice(0, 300));
    } catch (e) {
      fail('T6 解析', e.message);
    }
  } else fail('T6 运行', '确认弹窗未出现');

  // ---- T7 备份计划 → 还原备份 → 聚焦本页签 ----
  // 先等上一个确认弹窗完全关闭（onOk 里还有 onChanged 刷树，遮罩未撤时点击会被吞），
  // 再等 message toast 消失（成功/警告提示悬停在顶部工具栏上方，会挡住「备份」按钮的点击）
  for (let i = 0; i < 20; i += 1) {
    const clear = await ev("![...document.querySelectorAll('.ant-modal-wrap')].some((w) => getComputedStyle(w).display !== 'none') && !document.querySelector('.ant-message-notice')");
    if (clear) break;
    await sleep(400);
  }
  let t7ok = false;
  for (let i = 0; i < 4 && !t7ok; i += 1) {
    // 每次点击前都等弹窗/toast 清空（toast 悬停会挡住顶部工具栏按钮的点击）
    for (let w = 0; w < 20; w += 1) {
      const clear = await ev("![...document.querySelectorAll('.ant-modal-wrap')].some((x) => getComputedStyle(x).display !== 'none') && !document.querySelector('.ant-message-notice')");
      if (clear) break;
      await sleep(400);
    }
    const bk = await posOf(`[...document.querySelectorAll('.top-toolbar .tb-btn')].find((b) => b.textContent.replace(/\\s+/g, '') === '备份')`);
    if (!bk) { await sleep(600); continue; }
    await lclick(bk.x, bk.y);
    await sleep(1000);
    t7ok = !!(await ev(`(() => { const t = [...document.querySelectorAll('.main-tabs .ant-tabs-tab')].find((x) => x.textContent.includes('备份计划')); return !!t; })()`));
  }
  if (!t7ok) fail('T7 打开备份计划', '页签未出现');
  else {
    let btn = null;
    for (let i = 0; i < 12 && !btn; i += 1) { btn = await posOf(`[...document.querySelectorAll('.ant-tabs-tabpane-active .tab-toolbar button')].find((b) => b.textContent.replace(/\\s+/g, '') === '还原备份')`); if (!btn) await sleep(400); }
    if (!btn) fail('T7 还原备份按钮', '未找到');
    else {
      await lclick(btn.x, btn.y);
      await sleep(600);
      const tabOk = await ev(`(() => { const t = [...document.querySelectorAll('.main-tabs .ant-tabs-tab')].find((x) => x.textContent.includes('运行 SQL 文件')); return !!t && t.className.includes('ant-tabs-tab-active'); })()`);
      tabOk ? pass('T7 备份计划 →「还原备份」聚焦运行 SQL 文件页签') : fail('T7 页签聚焦', JSON.stringify(tabOk));
    }
  }

  // ---- T8 说明 + 日志 + DH-RESTORE ----
  const misc = await ev(`(() => ({
    footer: (document.querySelector('[data-dh-restore="root"] > div:last-child') || { textContent: '' }).textContent,
    logs: [...document.querySelectorAll('[data-dh-restore="logs"] [data-dh-restore-log]')].map((x) => x.textContent),
  }))()`);
  const footerOk = misc && misc.footer.includes('原样执行') && misc.footer.includes('遇到错误继续');
  const logOk = misc && misc.logs.some((t) => t.includes('语句') && t.includes('成功') && t.includes('失败') && t.includes('耗时'));
  const dbgOk = logHas('DH-RESTORE run ok=');
  footerOk && logOk && dbgOk ? pass('T8 底部说明 + 执行日志 + DH-RESTORE 调试标记') : fail('T8', JSON.stringify({ footerOk, logOk, dbgOk, logs: misc && misc.logs.slice(0, 3) }));

  // S5 控制台错误
  await sleep(600);
  errors.length === 0 ? pass('S5 无控制台错误') : fail('S5 控制台错误', errors.slice(0, 4).join(' | ').slice(0, 300));

  console.log('ROUND29-DONE');
  try { await client.close(); } catch {}
  process.exit(process.exitCode || 0);
})().catch((e) => {
  console.error('FATAL', e.message);
  process.exit(1);
});
