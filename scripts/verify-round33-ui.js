'use strict';
// v0927.52 结构明细行「编辑」定位 — UI 端到端验证（9227 测试实例；夹具已备：
//   sqlite .tmp-ud7/demo-test.db w33_ui（w33_ix 索引 / w33_uq 唯一 / w33_tg 触发器）；
//   mssql master.dbo w33_ref + w33_ui_m（ix/uq/fk/ck））
//  U1 sqlite：索引明细行双击 → 设计页签打开 · 内部「索引」页签激活 · 该行高亮(row-focus)
//  U1b 手动切到「字段」后再次双击同一明细 → 重新跳回「索引」并高亮（重复定位）
//  U2 sqlite：唯一键明细行双击 → 「唯一键」页签 + 高亮
//  U3 sqlite：触发器明细行双击 → DDL 源码页签（源码含 CREATE TRIGGER）
//  U4 mssql：外键明细行右键「编辑外键」→ 设计器「外键」页签 + 高亮
//  U5 mssql：检查明细行双击 → 「检查」页签 + 高亮
//  U6 无控制台错误
const CDP = require('chrome-remote-interface');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const client = await CDP({ port: Number(process.env.CDP_PORT || 9227) });
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
  const rclick = async (x, y) => { await press(x.x !== undefined ? x.x : x, x.y !== undefined ? x.y : y, 'right', 1); await sleep(500); };
  // 双击：两次按压（第二次 clickCount=2 触发 dblclick）
  const dblAt = async (p) => { await press(p.x, p.y, 'left', 1); await sleep(90); await press(p.x, p.y, 'left', 2); await sleep(700); };
  const pass = (n) => console.log('PASS', n);
  const fail = (n, d) => { console.log('FAIL', n, d || ''); process.exitCode = 1; };

  const treePos = async (title, idx = 0) => ev(`(() => { const ts = [...document.querySelectorAll('.tree-wrap .node-title')].filter((x) => x.textContent === ${JSON.stringify(title)}); const t = ts[${idx}]; if (!t) return null; t.scrollIntoView({ block: 'nearest' }); const r = t.getBoundingClientRect(); return r.height > 0 ? { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } : null; })()`);
  const waitTree = async (title, idx = 0, tries = 16) => {
    for (let i = 0; i < tries; i += 1) { const p = await treePos(title, idx); if (p) return p; await sleep(500); }
    return null;
  };
  const ensureOpenOnce = async (title, idx = 0) => {
    const p = await waitTree(title, idx, 10);
    if (!p) return false;
    const isOpen = await ev(`(() => { const ts = [...document.querySelectorAll('.tree-wrap .node-title')].filter((x) => x.textContent === ${JSON.stringify(title)}); const t = ts[${idx}]; const w = t && t.closest('.ant-tree-node-content-wrapper'); return !!(w && w.className.includes('-open')); })()`);
    if (isOpen) return true;
    const sw = await ev(`(() => { const ts = [...document.querySelectorAll('.tree-wrap .node-title')].filter((x) => x.textContent === ${JSON.stringify(title)}); const t = ts[${idx}]; const row = t && t.closest('.ant-tree-treenode'); const s = row && row.querySelector('.ant-tree-switcher'); if (!s) return null; const r = s.getBoundingClientRect(); return r.width > 0 ? { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } : null; })()`);
    if (!sw) return false;
    await lclick(sw.x, sw.y);
    await sleep(1200);
    // 点击可能未生效：回读展开态，未展开视为失败（外层重试）
    return !!(await ev(`(() => { const ts = [...document.querySelectorAll('.tree-wrap .node-title')].filter((x) => x.textContent === ${JSON.stringify(title)}); const t = ts[${idx}]; const w = t && t.closest('.ant-tree-node-content-wrapper'); return !!(w && w.className.includes('-open')); })()`));
  };
  const ensureOpen = async (title, idx = 0) => {
    for (let a = 0; a < 3; a += 1) { if (await ensureOpenOnce(title, idx)) return true; }
    return false;
  };
  const leafPos = async (name) => {
    const p = await ev(`(() => {
      // 前缀匹配：明细行的 detail 后缀（如 唯一键“（uk）”）异步补载后 textContent 会带后缀
      const rows = [...document.querySelectorAll('.tree-wrap .node-title')].filter((x) => x.textContent.startsWith(${JSON.stringify(name)}));
      const r = rows[0];
      if (!r) return null;
      r.scrollIntoView({ block: 'nearest' });
      const b = r.getBoundingClientRect();
      return b.height > 0 ? { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) } : null;
    })()`);
    return p;
  };
  const clickMenu = async (kw, tries = 8) => {
    for (let i = 0; i < tries; i += 1) {
      const it = await ev(`(() => { const it = [...document.querySelectorAll('.ctx-menu .ant-menu-item')].find((i) => i.textContent.replace(/\\s+/g, '').includes(${JSON.stringify(kw)})); if (!it) return null; const r = it.getBoundingClientRect(); return r.width > 0 ? { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } : null; })()`);
      if (it) { await lclick(it.x, it.y); return true; }
      await sleep(350);
    }
    return false;
  };
  // 外层激活页签标题（排除设计器内层 design-tabs）
  const outerActive = async () => ev(`(() => { const t = [...document.querySelectorAll('.ant-tabs-tab-active')].filter((x) => !x.closest('.design-tabs'))[0]; return t ? t.textContent.replace(/\\s+/g, '') : ''; })()`);
  // 可见设计器状态：内部激活页签 + row-focus 行（首个 input 值 = 名称列）
  const designState = async () => ev(`(() => {
    const ps = [...document.querySelectorAll('.ant-tabs-tabpane-active')].filter((x) => x.querySelector && x.querySelector('.design-tabs'));
    const p = ps[0];
    if (!p) return { open: false };
    const t = p.querySelector('.design-tabs .ant-tabs-tab-active');
    const f = p.querySelector('.design-tabs .row-focus');
    const fi = f && f.querySelector('input');
    return { open: true, sec: t ? t.textContent.replace(/\\s+/g, '') : '', focus: !!f, fv: fi ? fi.value : '' };
  })()`);
  const paneText = async () => ev(`(() => { const ps = [...document.querySelectorAll('.ant-tabs-tabpane-active')].filter((x) => !x.querySelector('.design-tabs')); return ps.length ? ps.map((x) => x.textContent).join(' ').slice(0, 800) : ''; })()`);

  // ---- 等主窗揭示 + S0 版本 ----
  let ok = false;
  for (let i = 0; i < 40 && !ok; i += 1) { ok = await ev("!!document.querySelector('.top-toolbar .tb-btn')"); if (!ok) await sleep(500); }
  const ver = await ev("(() => { const s = document.querySelector('.statusbar'); return s ? s.textContent : ''; })()");
  /v0927\.52/.test(ver) ? pass('S0 版本 v0927.52') : fail('S0 版本', String(ver).slice(0, 120));

  // ---- 展开 sqlite：连接 → 表分类 → w33_ui ----
  if (!(await ensureOpen('演示 SQLite 库', 0))) { fail('U0', '找不到连接节点'); await client.close(); return; }
  if (!(await ensureOpen('表', 0))) { fail('U0', '表分类未展开'); await client.close(); return; }
  if (!(await ensureOpen('w33_ui', 0))) { fail('U0', '找不到表 w33_ui'); await client.close(); return; }

  // U1 索引明细行双击 → 设计器定位
  if (!(await ensureOpen('索引', 0))) fail('U1', '索引分组未展开');
  else {
    const p = await leafPos('w33_ix');
    if (!p) fail('U1', '找不到 w33_ix 明细行');
    else {
      await dblAt(p);
      await sleep(400);
      const oa = await outerActive();
      const st = await designState();
      oa === '设计w33_ui' && st.open && st.sec === '索引' && st.focus && st.fv === 'w33_ix'
        ? pass('U1 双击索引明细 → 设计页签 · 索引页签 · 行高亮')
        : fail('U1', JSON.stringify({ oa, st }));
    }
  }

  // U1b 手动切「字段」→ 再次双击 → 跳回索引并高亮（重复定位能力）
  {
    const tabP = await ev(`(() => { const t = [...document.querySelectorAll('.design-tabs .ant-tabs-tab')].find((x) => x.textContent.trim() === '字段'); if (!t) return null; const r = t.getBoundingClientRect(); return r.width > 0 ? { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } : null; })()`);
    if (!tabP) fail('U1b', '字段页签未找到');
    else {
      await lclick(tabP.x, tabP.y);
      await sleep(400);
      let mid = await designState();
      if (!mid.open || mid.sec !== '字段') fail('U1b', '切字段页签失败 ' + JSON.stringify(mid));
      else {
        const p = await leafPos('w33_ix');
        if (!p) fail('U1b', 'w33_ix 行丢失');
        else {
          await dblAt(p);
          await sleep(400);
          const st = await designState();
          st.open && st.sec === '索引' && st.focus && st.fv === 'w33_ix'
            ? pass('U1b 再次双击同一明细 → 重新定位索引页签并高亮')
            : fail('U1b', JSON.stringify(st));
        }
      }
    }
  }

  // U2 唯一键明细行双击 → 唯一键页签
  if (!(await ensureOpen('唯一键', 0))) fail('U2', '唯一键分组未展开');
  else {
    let p = null;
    for (let i = 0; i < 18 && !p; i += 1) {
      p = await leafPos('w33_uq');
      if (!p) {
        await sleep(700);
        if (i === 6 || i === 12) {
          // 懒加载疑似丢失：收起分组再展开，重新触发子项加载
          const swp = await ev(`(() => { const ts = [...document.querySelectorAll('.tree-wrap .node-title')].filter((x) => x.textContent === '唯一键'); const t = ts[0]; const row = t && t.closest('.ant-tree-treenode'); const s = row && row.querySelector('.ant-tree-switcher'); if (!s) return null; const r = s.getBoundingClientRect(); return r.width > 0 ? { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } : null; })()`);
          if (swp) { await lclick(swp.x, swp.y); await sleep(700); }
          await ensureOpen('唯一键', 0);
        }
      }
    }
    if (!p) fail('U2', '找不到 w33_uq 明细行');
    else {
      await dblAt(p);
      await sleep(400);
      const oa = await outerActive();
      const st = await designState();
      oa === '设计w33_ui' && st.open && st.sec === '唯一键' && st.focus && st.fv === 'w33_uq'
        ? pass('U2 双击唯一键明细 → 唯一键页签 + 行高亮')
        : fail('U2', JSON.stringify({ oa, st }));
    }
  }

  // U3 触发器明细行双击 → DDL 源码页签
  if (!(await ensureOpen('触发器', 0))) fail('U3', '触发器分组未展开');
  else {
    const p = await leafPos('w33_tg');
    if (!p) fail('U3', '找不到 w33_tg 明细行');
    else {
      await dblAt(p);
      await sleep(900);
      const oa = await outerActive();
      const txt = await paneText();
      oa === 'w33_tg' && /CREATE\s+TRIGGER/i.test(txt) && txt.includes('w33_tg')
        ? pass('U3 双击触发器明细 → DDL 源码页签（含 CREATE TRIGGER）')
        : fail('U3', JSON.stringify({ oa, txt: String(txt).slice(0, 160) }));
    }
  }

  // ---- mssql：外键右键编辑 + 检查双击（先折叠 sqlite w33_ui 避免分组重名）----
  {
    const p = await waitTree('w33_ui', 0, 3);
    if (p) {
      const isOpen = await ev(`(() => { const t = [...document.querySelectorAll('.tree-wrap .node-title')].find((x) => x.textContent === 'w33_ui'); const w = t && t.closest('.ant-tree-node-content-wrapper'); return !!(w && w.className.includes('-open')); })()`);
      if (isOpen) {
        const sw = await ev(`(() => { const t = [...document.querySelectorAll('.tree-wrap .node-title')].find((x) => x.textContent === 'w33_ui'); const row = t && t.closest('.ant-tree-treenode'); const s = row && row.querySelector('.ant-tree-switcher'); const r = s && s.getBoundingClientRect(); return r && r.width > 0 ? { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } : null; })()`);
        if (sw) { await lclick(sw.x, sw.y); await sleep(700); }
      }
    }
  }
  if (!(await ensureOpen('1', 0))) fail('U4', '找不到 mssql 连接节点');
  else if (!(await ensureOpen('master', 0))) fail('U4', 'master 库未展开');
  else if (!(await ensureOpen('表', 1))) fail('U4', 'mssql 表分类未展开');
  else if (!(await ensureOpen('w33_ui_m', 0))) fail('U4', '找不到表 w33_ui_m');
  else {
    if (!(await ensureOpen('外键', 0))) fail('U4', '外键分组未展开');
    else {
      // 明细行由分组懒加载：重试等待，防 mssql 冷启动抖动
      let p = null;
      for (let i = 0; i < 10 && !p; i += 1) { p = await leafPos('w33_fk'); if (!p) await sleep(400); }
      if (!p) fail('U4', '找不到 w33_fk 明细行');
      else {
        // 右键可能落在过期坐标上（懒加载刷新节点位移）：整体重取坐标+重右键，最多 3 次
        let menuOk = false;
        for (let a = 0; a < 3 && !menuOk; a += 1) {
          const p2 = await leafPos('w33_fk');
          if (p2) await rclick(p2.x, p2.y);
          menuOk = await clickMenu('编辑外键');
          if (!menuOk) await sleep(450);
        }
        if (!menuOk) fail('U4', '点不到 编辑外键');
        else {
          // 设计器先落「字段」再异步跳目标分区：轮询等定位完成
          let st = null;
          let oa = '';
          for (let i = 0; i < 12; i += 1) {
            await sleep(400);
            oa = await outerActive();
            st = await designState();
            if (st && st.sec === '外键' && st.focus) break;
          }
          oa === '设计w33_ui_m' && st.open && st.sec === '外键' && st.focus && st.fv === 'w33_fk'
            ? pass('U4 mssql 右键编辑外键 → 设计器外键页签 + 行高亮')
            : fail('U4', JSON.stringify({ oa, st }));
        }
      }
    }
    if (!(await ensureOpen('检查', 0))) fail('U5', '检查分组未展开');
    else {
      let p = null;
      for (let i = 0; i < 10 && !p; i += 1) { p = await leafPos('w33_ck'); if (!p) await sleep(400); }
      if (!p) fail('U5', '找不到 w33_ck 明细行');
      else {
        await dblAt(p);
        // 双击后设计器先落「字段」页签再跳目标分区（跳转有异步滞后）：轮询等待定位完成
        let st = null;
        let oa = '';
        for (let i = 0; i < 12; i += 1) {
          await sleep(400);
          oa = await outerActive();
          st = await designState();
          if (st && st.sec === '检查' && st.focus) break;
        }
        oa === '设计w33_ui_m' && st.open && st.sec === '检查' && st.focus && st.fv === 'w33_ck'
          ? pass('U5 mssql 双击检查明细 → 检查页签 + 行高亮')
          : fail('U5', JSON.stringify({ oa, st }));
      }
    }
  }

  // U6 无控制台错误
  const errs = errors.filter((x) => !/favicon|DevTools/.test(x));
  errs.length ? fail('U6 控制台错误', JSON.stringify(errs.slice(0, 3))) : pass('U6 无控制台错误');

  await client.close();
  console.log('done');
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
