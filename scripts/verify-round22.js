'use strict';
// v0927.53 ER「选择表」弹层修复 + 根错误边界 验证（9229 新实例，sqlite 演示库 + mssql master）：
//  P1 sqlite ER → 点「选择表」→ 弹层打开（修复前 <Input.AllowClear> 此处 React #130 白屏）
//  P2 弹层搜索过滤：empl → 命中；zzz → 无匹配表
//  P3 勾选联动：取消 employees → 按钮计数 0/1；恢复 → 1/1
//  P4 ESC 关闭弹层 + 关闭 ER 页签
//  P5 mssql master（用户崩溃路径：ER → 选择表）弹层可开可关
//  B1 正常运行时无 .dh-err-boundary 误触发
//  B2 边界功能：__dhThrowRender=1 → 触发重渲染 → 兜底 UI + DH-ERR-BOUNDARY 落盘 → 重新加载恢复
//  S0 版本 v0927.53 / S5 无控制台错误（B2 之前）
const CDP = require('chrome-remote-interface');
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
  const logHas = (kw) => {
    try { return fs.readFileSync('D:/DataHelm/.tmp-ud7/ui-debug.log', 'utf8').includes(kw); } catch { return false; }
  };
  const logTail = (kw) => {
    try {
      const l = fs.readFileSync('D:/DataHelm/.tmp-ud7/ui-debug.log', 'utf8');
      const ls = l.split('\n').filter((x) => x.includes(kw));
      return ls.length ? ls[ls.length - 1].slice(0, 260) : null;
    } catch { return null; }
  };
  // ui-debug.log 跨运行持久：本套件 B2 会故意触发一次崩溃并合法落盘 DH-ERR-BOUNDARY，
  // 下一次运行不能把历史条目误判为本次崩溃 —— 启动时记数，只认"新增"
  const preErrCount = (() => { try { return fs.readFileSync('D:/DataHelm/.tmp-ud7/ui-debug.log', 'utf8').split('\n').filter((x) => x.includes('DH-ERR')).length; } catch { return 0; } })();
  const errCount = () => { try { return fs.readFileSync('D:/DataHelm/.tmp-ud7/ui-debug.log', 'utf8').split('\n').filter((x) => x.includes('DH-ERR')).length; } catch { return 0; } };
  const noNewErr = () => errCount() <= preErrCount;
  const newErrTail = () => (errCount() > preErrCount ? logTail('DH-ERR') : null);
  const topBtn = async (kw) => {
    // 选中表后 ER 按钮启用有滞后（树选中→App 上下文状态）：带重试等待按钮可用
    let p = null;
    for (let i = 0; i < 10 && !p; i += 1) {
      p = await ev(`(() => { const b = [...document.querySelectorAll('.top-toolbar .tb-btn')].find((x) => x.textContent.replace(/\\s+/g, '') === ${JSON.stringify(kw)}); if (!b || b.disabled) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
      if (!p) await sleep(400);
    }
    if (!p) return false;
    await lclick(p.x, p.y);
    return true;
  };
  const pickBtn = () => ev(`(() => { const b = [...document.querySelectorAll('.ant-tabs-tabpane-active .tab-toolbar button')].find((x) => x.textContent.includes('选择表')); if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), label: b.textContent.replace(/\\s+/g, '') }; })()`);
  const closeTabByX = async () => {
    for (let i = 0; i < 6; i += 1) {
      const done = await ev(`(() => { const t = [...document.querySelectorAll('.main-tabs .ant-tabs-tab')].find((x) => x.className.includes('ant-tabs-tab-active')); if (!t) return true; const x = t.querySelector('.ant-tabs-tab-remove'); if (!x) return false; x.click(); return true; })()`);
      const p = await ev(`(() => { const ws = [...document.querySelectorAll('.ant-modal-wrap')].filter((x) => getComputedStyle(x).display !== 'none'); const w = ws[ws.length - 1]; if (!w) return null; const c = w.querySelector('.ant-modal-confirm'); if (!c) return null; const b = [...c.querySelectorAll('.ant-btn')].find((x) => x.textContent.replace(/\\s+/g, '').includes('放弃并关闭')); if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
      if (p) await lclick(p.x, p.y);
      if (done) return true;
      await sleep(500);
    }
    return false;
  };

  // ---- S0 版本 ----
  let ver = await ev(`document.querySelector('.statusbar').textContent`);
  if (/v0927.53/.test(String(ver))) pass('S0 状态栏 v0927.53'); else fail('S0 状态栏 v0927.53', String(ver).slice(0, 80));

  // ---- P1-P4 sqlite ER 选择表 ----
  let p = await waitTree('演示 SQLite 库', 0, 10);
  if (!p) fail('P1 前置', 'sqlite 连接行未找到');
  else {
    await dblclick(p.x, p.y);
    p = await waitTree('表', 0);
    if (!p) fail('P1 展开', 'sqlite 表分类未找到');
    else {
      await dblclick(p.x, p.y);
      p = await waitTree('employees');
      if (!p) fail('P1 前置', 'employees 未出现');
      else {
        await lclick(p.x, p.y); // 选中表 → ER 可用
        if (await topBtn('ER图')) {
          let ok = false;
          for (let i = 0; i < 20 && !ok; i += 1) { ok = !!await ev("!!document.querySelector('.ant-tabs-tabpane-active .er-canvas')"); if (!ok) await sleep(400); }
          if (!ok) fail('P1 ER 打开', '画布未出现');
          else {
            let b = null;
            for (let i = 0; i < 12 && !b; i += 1) { b = await pickBtn(); if (!b) await sleep(400); }
            if (!b) fail('P1 选择表按钮', '未找到');
            else {
              await lclick(b.x, b.y);
              let pop = null;
              for (let i = 0; i < 12 && !pop; i += 1) { pop = await ev("!![...document.querySelectorAll('.ant-popover')].find((p) => !p.className.includes('ant-popover-hidden') && getComputedStyle(p).display !== 'none' && getComputedStyle(p).pointerEvents !== 'none' && p.querySelector('.er-pick-list'))"); if (!pop) await sleep(300); }
              if (pop && noNewErr()) pass('P1 选择表弹层打开且无渲染崩溃（Input.AllowClear 修复）');
              else fail('P1 选择表弹层', JSON.stringify({ pop, err: newErrTail() }));

              // P2 搜索过滤
              const typed = await ev(`(() => {
                const i = document.querySelector('.ant-popover input[placeholder="搜索表名"]');
                if (!i) return false;
                const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
                set.call(i, 'empl');
                i.dispatchEvent(new Event('input', { bubbles: true }));
                return true;
              })()`);
              await sleep(500);
              const n1 = await ev(`document.querySelectorAll('.ant-popover .er-pick-list .ant-checkbox-wrapper').length`);
              await ev(`(() => {
                const i = document.querySelector('.ant-popover input[placeholder="搜索表名"]');
                if (!i) return false;
                const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
                set.call(i, 'zzz');
                i.dispatchEvent(new Event('input', { bubbles: true }));
                return true;
              })()`);
              await sleep(500);
              const n2 = await ev(`document.querySelectorAll('.ant-popover .er-pick-list .ant-checkbox-wrapper').length`);
              const nomatch = await ev(`!!([...document.querySelectorAll('.ant-popover .er-pick-list div')].find((d) => d.textContent === '无匹配表'))`);
              typed && n1 === 1 && n2 === 0 && nomatch
                ? pass('P2 搜索过滤 empl→1 / zzz→无匹配')
                : fail('P2 搜索过滤', JSON.stringify({ typed, n1, n2, nomatch }));

              // P3 勾选联动：先恢复搜索，再取消勾选 employees
              await ev(`(() => {
                const i = document.querySelector('.ant-popover input[placeholder="搜索表名"]');
                if (!i) return false;
                const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
                set.call(i, '');
                i.dispatchEvent(new Event('input', { bubbles: true }));
                return true;
              })()`);
              await sleep(400);
              const cb = await ev(`(() => { const c = document.querySelector('.ant-popover .er-pick-list .ant-checkbox-input'); if (!c) return null; const r = c.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
              if (!cb) fail('P3 前置', '复选框未找到');
              else {
                await lclick(cb.x, cb.y); // 取消勾选
                let lbl0 = null;
                for (let i = 0; i < 10 && !lbl0; i += 1) { const b2 = await pickBtn(); if (b2 && b2.label.includes('0/1')) lbl0 = b2.label; else await sleep(300); }
                await lclick(cb.x, cb.y); // 恢复勾选（弹层仍开着，按钮 label 实时更新）
                let lbl1 = null;
                for (let i = 0; i < 10 && !lbl1; i += 1) { const b2 = await pickBtn(); if (b2 && b2.label.includes('1/1')) lbl1 = b2.label; else await sleep(300); }
                lbl0 && lbl1 ? pass('P3 勾选联动 0/1 ↔ 1/1') : fail('P3 勾选联动', JSON.stringify({ lbl0, lbl1 }));
              }

              // P4 点弹层外（状态栏空白）关闭 + 关页签（高负载下收起可滞后：重试三次）
              let closed = false;
              for (let t = 0; t < 3 && !closed; t += 1) {
                await lclick(700, 655);
                await sleep(1000);
                closed = !(await ev("!![...document.querySelectorAll('.ant-popover')].find((p) => !p.className.includes('ant-popover-hidden') && getComputedStyle(p).display !== 'none' && getComputedStyle(p).pointerEvents !== 'none' && p.querySelector('.er-pick-list'))"));
              }
              if (!closed) {
                // 诊断：外点失效时，触发按钮 toggle 是否还能关（区分外点监听器失效 vs open 态卡死）
                const pb = await pickBtn();
                if (pb) { await lclick(pb.x, pb.y); await sleep(900); }
                closed = !(await ev("!![...document.querySelectorAll('.ant-popover')].find((p) => !p.className.includes('ant-popover-hidden') && getComputedStyle(p).display !== 'none' && getComputedStyle(p).pointerEvents !== 'none' && p.querySelector('.er-pick-list'))"));
                if (closed) fail('P4 关闭弹层', '外点失效·按钮toggle可关（监听器级缺陷）');
              }
              await closeTabByX();
              closed ? pass('P4 点击外部关闭弹层 + ER 页签已关') : fail('P4 关闭弹层', 'popover still open');
            }
          }
        } else fail('P1 ER 按钮', '不可用');
      }
    }
  }

  // ---- P5 mssql master（用户崩溃路径）----
  p = await waitTree('1', 0, 10);
  if (!p) fail('P5 前置', 'mssql 连接行未找到');
  else {
    await dblclick(p.x, p.y);
    p = await waitTree('master');
    if (!p) fail('P5 展开', 'master 未出现');
    else {
      await dblclick(p.x, p.y);
      p = await waitTree('表', 1);
      if (!p) fail('P5 分类', 'mssql 表分类未找到');
      else {
        await dblclick(p.x, p.y);
        const firstTbl = await ev(`(() => {
          const rows = [...document.querySelectorAll('.tree-wrap .ant-tree-treenode')].filter((r) => r.querySelector('.node-title') && r.getBoundingClientRect().height > 0);
          const i = rows.map((r) => r.querySelector('.node-title').textContent).lastIndexOf('master');
          const catI = rows.map((r) => r.querySelector('.node-title').textContent).lastIndexOf('表');
          const f = rows[catI + 1];
          if (!f) return null;
          f.scrollIntoView({ block: 'nearest' });
          const t = f.querySelector('.node-title').getBoundingClientRect();
          return { x: Math.round(t.x + t.width / 2), y: Math.round(t.y + t.height / 2) };
        })()`);
        if (!firstTbl) fail('P5 前置', 'master 表行未找到');
        else {
          await lclick(firstTbl.x, firstTbl.y);
          if (await topBtn('ER图')) {
            let ok = false;
            for (let i = 0; i < 24 && !ok; i += 1) { ok = !!await ev("!!document.querySelector('.ant-tabs-tabpane-active .er-canvas')"); if (!ok) await sleep(500); }
            let b = null;
            for (let i = 0; i < 15 && !b; i += 1) { b = await pickBtn(); if (!b) await sleep(500); }
            if (!ok || !b) fail('P5 ER 打开', JSON.stringify({ ok, btn: !!b }));
            else {
              await lclick(b.x, b.y);
              let pop = null;
              for (let i = 0; i < 12 && !pop; i += 1) { pop = await ev("!![...document.querySelectorAll('.ant-popover')].find((p) => !p.className.includes('ant-popover-hidden') && getComputedStyle(p).display !== 'none' && getComputedStyle(p).pointerEvents !== 'none' && p.querySelector('.er-pick-list'))"); if (!pop) await sleep(300); }
              let shut = false;
              for (let t = 0; t < 3 && !shut; t += 1) {
                await lclick(700, 655);
                await sleep(1000);
                shut = !(await ev("!![...document.querySelectorAll('.ant-popover')].find((p) => !p.className.includes('ant-popover-hidden') && getComputedStyle(p).display !== 'none' && getComputedStyle(p).pointerEvents !== 'none' && p.querySelector('.er-pick-list'))"));
              }
              const noErr = noNewErr();
              pop && shut && noErr ? pass('P5 mssql master ER → 选择表 弹层可开可关无崩溃') : fail('P5 mssql 选择表', JSON.stringify({ pop, shut, err: newErrTail() }));
              await closeTabByX();
            }
          } else fail('P5 ER 按钮', '不可用');
        }
      }
    }
  }

  // ---- B1 正常运行无误触发边界 ----
  const b1 = await ev("!!document.querySelector('.dh-err-boundary')");
  !b1 ? pass('B1 正常运行时无错误边界兜底误触发') : fail('B1 边界误触发', 'unexpected fallback');

  // ---- S5 控制台错误（B2 之前测）----
  await sleep(600);
  if (!errors.length) pass('S5 无控制台错误'); else fail('S5 无控制台错误', errors.slice(0, 3).join(' | '));

  // ---- B2 边界功能：注入渲染错误 → 兜底 UI → 重新加载恢复 ----
  await ev('window.__dhThrowRender = 1');
  // 触发一次 App 重渲染（单击树行）
  p = await waitTree('演示 SQLite 库', 0, 6);
  if (p) await lclick(p.x, p.y);
  let fb = null;
  for (let i = 0; i < 12 && !fb; i += 1) { fb = await ev("(() => { const d = document.querySelector('.dh-err-boundary'); return d && d.getBoundingClientRect().height > 0 ? d.textContent.slice(0, 60) : null; })()"); if (!fb) await sleep(400); }
  const logB = logTail('DH-ERR-BOUNDARY');
  fb && logB && logB.includes('STACK') ? pass('B2 渲染错误 → 兜底 UI + DH-ERR-BOUNDARY 落盘（含 STACK）') : fail('B2 边界兜底', JSON.stringify({ fb, logB: String(logB).slice(0, 120) }));
  const rl = await ev(`(() => { const b = [...document.querySelectorAll('.dh-err-boundary button')].find((x) => x.textContent.includes('重新加载')); if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
  if (rl) {
    await lclick(rl.x, rl.y);
    let back = false;
    for (let i = 0; i < 24 && !back; i += 1) { back = !!await ev("(function(){ const s = document.querySelector('.statusbar'); return !!(s && /v0927\\.53/.test(s.textContent) && document.querySelectorAll('.tree-wrap .node-title').length); })()"); if (!back) await sleep(500); }
    back ? pass('B3 重新加载后应用恢复（v0927.53 状态栏 + 树在）') : fail('B3 重新加载恢复', 'app not back');
  } else fail('B3 重新加载按钮', '未找到');

  await client.close();
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
