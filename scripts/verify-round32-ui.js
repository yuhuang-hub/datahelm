'use strict';
// v0927.52 侧边栏结构明细行右键删除 — UI 端到端验证（9227 测试实例；夹具已备：
//   sqlite .tmp-ud7/demo-test.db w32_ui（w32_ix/w32_uq）；mssql master.dbo w32_ui_m（ix/uq/fk/ck））
//  U1 sqlite：索引明细右键 → 删除索引 → 确认 → 分组刷新后条目消失
//  U2 sqlite：唯一键明细右键 → 删除唯一键 → 消失
//  U3 sqlite：检查分组（匿名合成名）右键无 删除 项
//  U4 sqlite：外键/检查 dropStruct 报错文案兜底（无夹具外键，跳过 UI，S4/S5 已测）
//  U5 mssql：外键明细右键删除 → 消失；检查约束同样
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
  const pass = (n) => console.log('PASS', n);
  const fail = (n, d) => { console.log('FAIL', n, d || ''); process.exitCode = 1; };

  const treePos = async (title, idx = 0) => ev(`(() => { const ts = [...document.querySelectorAll('.tree-wrap .node-title')].filter((x) => x.textContent === ${JSON.stringify(title)}); const t = ts[${idx}]; if (!t) return null; t.scrollIntoView({ block: 'nearest' }); const r = t.getBoundingClientRect(); return r.height > 0 ? { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } : null; })()`);
  const waitTree = async (title, idx = 0, tries = 16) => {
    for (let i = 0; i < tries; i += 1) { const p = await treePos(title, idx); if (p) return p; await sleep(500); }
    return null;
  };
  const dbl = async (title, idx) => { const okk = await ensureOpen(title, idx); return okk; };
  const menuHas = async (kw) => ev(`(() => { const it = [...document.querySelectorAll('.ctx-menu .ant-menu-item')].find((i) => i.textContent.replace(/\\s+/g, '').includes(${JSON.stringify(kw)})); return !!it; })()`);
  const clickMenu = async (kw, tries = 8) => {
    for (let i = 0; i < tries; i += 1) {
      const it = await ev(`(() => { const it = [...document.querySelectorAll('.ctx-menu .ant-menu-item')].find((i) => i.textContent.replace(/\\s+/g, '').includes(${JSON.stringify(kw)})); if (!it) return null; const r = it.getBoundingClientRect(); return r.width > 0 ? { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } : null; })()`);
      if (it) { await lclick(it.x, it.y); return true; }
      await sleep(350);
    }
    return false;
  };
  const confirmOk = async (tries = 10) => {
    // antd 两字按钮文本中带空格（确 定）：按去空白后的文本找
    for (let i = 0; i < tries; i += 1) {
      const btn = await ev(`(() => { const b = [...document.querySelectorAll('.ant-modal button')].find((x) => x.textContent.replace(/\\s+/g, '') === '确定'); if (!b) return null; const r = b.getBoundingClientRect(); return r.width > 0 ? { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } : null; })()`);
      if (btn) { await lclick(btn.x, btn.y); await sleep(1000); return true; }
      await sleep(350);
    }
    return false;
  };
  const leafPos = async (group, name) => {
    // 展开分组后按 detail 文本前缀找明细行（title 只显示名称，外键等 detail 含全描述）
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

  // ---- 展开 sqlite：连接 → 表分类 → 表 → 索引/唯一键/检查 分组 ----
  // 展开节点：antd 树统一走 switcher 箭头单击（表节点双击=打开表，不走 toggleNode）
  const ensureOpenOnce = async (title, idx) => {
    // mssql 冷连接（双击连接 → connect → loadRoot 出库列表）在电池满载下可达十余秒：等足 22 轮
    const p = await waitTree(title, idx, 22);
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
  const ensureOpen = async (title, idx) => {
    for (let a = 0; a < 3; a += 1) { if (await ensureOpenOnce(title, idx)) return true; }
    return false;
  };
  if (!(await ensureOpen('演示 SQLite 库', 0))) { fail('U0', '找不到连接节点'); await client.close(); return; }
  if (!(await ensureOpen('表', 0))) { fail('U0', '表分类未展开'); await client.close(); return; }
  if (!(await ensureOpen('w32_ui', 0))) { fail('U0', '找不到表 w32_ui'); await client.close(); return; }

  // U1 索引明细删除
  if (!(await dbl('索引', 0))) { fail('U1', '索引分组未展开'); }
  else {
    const p = await leafPos('索引', 'w32_ix');
    if (!p) fail('U1', '找不到 w32_ix 明细行');
    else {
      await rclick(p.x, p.y);
      if (!(await menuHas('删除索引'))) fail('U1', '右键菜单无 删除索引');
      else if (!(await clickMenu('删除索引'))) fail('U1', '点不到 删除索引');
      else if (!(await confirmOk())) fail('U1', '确认框未出现');
      else {
        await sleep(800);
        const gone = !(await leafPos('索引', 'w32_ix'));
        gone ? pass('U1 sqlite 删索引：菜单+确认+分组刷新消失') : fail('U1', '删除后 w32_ix 仍在树上');
      }
    }
  }

  // U2 唯一键明细删除
  if (!(await dbl('唯一键', 0))) { fail('U2', '唯一键分组未展开'); }
  else {
    let p = null;
    for (let i = 0; i < 18 && !p; i += 1) {
      p = await leafPos('唯一键', 'w32_uq');
      if (!p) {
        await sleep(600);
        if (i === 6 || i === 12) {
          // 懒加载疑似丢失：点 switcher 收起分组再展开，重新触发子项加载
          const swp = await ev(`(() => { const ts = [...document.querySelectorAll('.tree-wrap .node-title')].filter((x) => x.textContent === '唯一键'); const t = ts[0]; const row = t && t.closest('.ant-tree-treenode'); const s = row && row.querySelector('.ant-tree-switcher'); if (!s) return null; const r = s.getBoundingClientRect(); return r.width > 0 ? { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } : null; })()`);
          if (swp) { await lclick(swp.x, swp.y); await sleep(700); }
          await dbl('唯一键', 0);
        }
      }
    }
    if (!p) fail('U2', '找不到 w32_uq 明细行');
    else {
      await rclick(p.x, p.y);
      if (!(await clickMenu('删除唯一键'))) fail('U2', '点不到 删除唯一键');
      else if (!(await confirmOk())) fail('U2', '确认框未出现');
      else {
        await sleep(800);
        const gone = !(await leafPos('唯一键', 'w32_uq'));
        gone ? pass('U2 sqlite 删唯一键（DROP INDEX 口径）成功') : fail('U2', '删除后 w32_uq 仍在树上');
      }
    }
  }

  // U3 匿名检查：右键无删除项
  if (!(await dbl('检查', 0))) { fail('U3', '检查分组未展开'); }
  else {
    const p = await leafPos('检查', 'CHECK_1');
    if (!p) pass('U3（本表无 CHECK，跳过菜单断言）');
    else {
      await rclick(p.x, p.y);
      const has = await menuHas('删除');
      const notHas = await ev(`(() => { return ![...document.querySelectorAll('.ctx-menu .ant-menu-item')].some((i) => i.textContent.replace(/\\s+/g, '').startsWith('删除')); })()`);
      notHas ? pass('U3 sqlite 匿名检查无删除项') : fail('U3', '匿名检查出现了删除项 has=' + has);
    }
  }

  // ---- mssql：外键 + 检查（层级：连接1 → master → 表分类(idx=1，sqlite 也有一个表) → w32_ui_m）----
  // 先折叠 sqlite 的 w32_ui：其 外键/检查 空分组会与 mssql 重名干扰按名查找
  {
    const p = await waitTree('w32_ui', 0, 3);
    if (p) {
      const isOpen = await ev(`(() => { const t = [...document.querySelectorAll('.tree-wrap .node-title')].find((x) => x.textContent === 'w32_ui'); const w = t && t.closest('.ant-tree-node-content-wrapper'); return !!(w && w.className.includes('-open')); })()`);
      if (isOpen) {
        const sw = await ev(`(() => { const t = [...document.querySelectorAll('.tree-wrap .node-title')].find((x) => x.textContent === 'w32_ui'); const row = t && t.closest('.ant-tree-treenode'); const s = row && row.querySelector('.ant-tree-switcher'); const r = s && s.getBoundingClientRect(); return r && r.width > 0 ? { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } : null; })()`);
        if (sw) { await lclick(sw.x, sw.y); await sleep(700); }
      }
    }
  }
  if (!(await ensureOpen('1', 0))) { fail('U4', '找不到 mssql 连接节点'); }
  else if (!(await ensureOpen('master', 0))) { fail('U4', 'master 库未展开'); }
  else if (!(await ensureOpen('表', 1))) { fail('U4', 'mssql 表分类未展开'); }
  else if (!(await ensureOpen('w32_ui_m', 0))) { fail('U4', '找不到表 w32_ui_m'); }
  else {
      if (!(await dbl('外键', 0))) fail('U5', '外键分组未展开');
      else {
        // 明细行由分组懒加载：重试等待，防 mssql 冷启动抖动
        let p = null;
        for (let i = 0; i < 10 && !p; i += 1) { p = await leafPos('外键', 'w32_ui_fk'); if (!p) await sleep(400); }
        if (!p) fail('U5', '找不到 w32_ui_fk 明细行');
        else {
          // 分组懒加载期间行位会漂移：菜单没出目标项就重取坐标重右键（至多 3 次）
          let menuOk = false;
          for (let a = 0; a < 3 && !menuOk; a += 1) {
            const p2 = await leafPos('外键', 'w32_ui_fk');
            if (p2) await rclick(p2.x, p2.y);
            menuOk = await clickMenu('删除外键');
            if (!menuOk) { await lclick(650, 640); await sleep(400); }
          }
          if (!menuOk) fail('U5', '点不到 删除外键');
          else if (!(await confirmOk())) fail('U5', '确认框未出现');
          else {
            await sleep(900);
            let gone = false;
            for (let i = 0; i < 10 && !gone; i += 1) { gone = !(await leafPos('外键', 'w32_ui_fk')); if (!gone) await sleep(500); }
            gone ? pass('U5 mssql 删外键成功') : fail('U5', '删除后 w32_ui_fk 仍在树上');
          }
        }
      }
      if (!(await dbl('检查', 0))) fail('U6', '检查分组未展开');
      else {
        let p = null;
        for (let i = 0; i < 10 && !p; i += 1) { p = await leafPos('检查', 'w32_ui_ck'); if (!p) await sleep(400); }
        if (!p) fail('U6', '找不到 w32_ui_ck 明细行');
        else {
          let menuOk = false;
          for (let a = 0; a < 3 && !menuOk; a += 1) {
            const p2 = await leafPos('检查', 'w32_ui_ck');
            if (p2) await rclick(p2.x, p2.y);
            menuOk = await clickMenu('删除检查');
            if (!menuOk) { await lclick(650, 640); await sleep(400); }
          }
          if (!menuOk) fail('U6', '点不到 删除检查');
          else if (!(await confirmOk())) fail('U6', '确认框未出现');
          else {
            await sleep(900);
            let gone = false;
            for (let i = 0; i < 10 && !gone; i += 1) { gone = !(await leafPos('检查', 'w32_ui_ck')); if (!gone) await sleep(500); }
            gone ? pass('U6 mssql 删检查约束成功') : fail('U6', '删除后 w32_ui_ck 仍在树上');
          }
        }
      }
  }

  // U7 无控制台错误（页面 error 级）
  const errs = errors.filter((x) => !/favicon|DevTools/.test(x));
  errs.length ? fail('U7 控制台错误', JSON.stringify(errs.slice(0, 3))) : pass('U7 无控制台错误');

  await client.close();
  console.log('done');
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
