'use strict';
// v0927.53 修复「库节点右键导出数据库落到默认库」验证（用户报告：选 ruoyi-vue-pro 导出却列出 master 的表）：
//  连接默认库=master、业务对象在独立库 dh_w58（dbo.w58_a 1 行，D0 建于树加载后——先刷新连接树）。
//  T1 刷新+展开后库节点 dh_w58 可见
//  T2 库节点合成右键 → 菜单「导出数据库…」→ DumpModal：标题含 dh_w58、表头 ctx 含 dh_w58、清单=[w58_a]
//     （修复前 db 为空 → tables() 落到会话默认库 master）
//  T3 取消关闭弹窗
//  D0 夹具 stage1；D8 check1；S0 版本 v0927.53；S5 无控制台错误；D9 cleanup
// 前置：共享 userData 里已配好连接「1」（mssql sa@master）；运行于独立新实例。合成事件纪律同 precfg。
const { execFileSync } = require('child_process');
const CDP = require('chrome-remote-interface');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fx58 = (mode) => String(execFileSync('node', ['D:/DataHelm/scripts/fx/fx-w58.js', mode], { encoding: 'utf8' }));
const titleAct = `(() => {
  const rows = [...document.querySelectorAll('.tree-wrap .ant-tree-treenode')].filter((r) => r.querySelector('.node-title') && r.getBoundingClientRect().height > 0);
  const f = rows.find((r) => r.querySelector('.node-title').textContent === 'TITLE');
  if (!f) return null;
  const t = f.querySelector('.node-title');
  const r0 = t.getBoundingClientRect();
  return { x: Math.round(r0.x + r0.width / 2), y: Math.round(r0.y + r0.height / 2) };
})()`;
(async () => {
  const client = await CDP({ port: Number(process.env.CDP_PORT || 9229) });
  const { Runtime, Log } = client;
  await Runtime.enable();
  await Log.enable();
  const errors = [];
  Log.entryAdded(({ entry }) => { if (entry.level === 'error') errors.push(entry.text.slice(0, 200)); });
  const ev = async (expr) => {
    const r = await Runtime.evaluate({ expression: expr, returnByValue: true });
    if (r.exceptionDetails) return { err: String(r.exceptionDetails.exception?.description || '').slice(0, 300) };
    return r.result.value;
  };
  // 合成事件：对 .node-title 派发 dblclick / contextmenu（precfg 纪律，不坐标点击）
  const nodeAct = async (title, type) => ev(`(() => {
    const rows = [...document.querySelectorAll('.tree-wrap .ant-tree-treenode')].filter((r) => r.querySelector('.node-title') && r.getBoundingClientRect().height > 0);
    const f = rows.find((r) => r.querySelector('.node-title').textContent === ${JSON.stringify(title)});
    if (!f) return 'no-node';
    const t = f.querySelector('.node-title');
    const r0 = t.getBoundingClientRect();
    t.dispatchEvent(new MouseEvent(${JSON.stringify(type)}, { bubbles: true, cancelable: true, clientX: Math.round(r0.x + 8), clientY: Math.round(r0.y + r0.height / 2) }));
    return 'ok';
  })()`);
  const menuClick = async (kw) => ev(`(() => {
    const it = [...document.querySelectorAll('.ctx-menu .ant-menu-item')].find((x) => x.textContent.replace(/\\s+/g, '').indexOf(${JSON.stringify(kw)}) >= 0);
    if (!it) return 'no-item';
    it.click();
    return 'ok';
  })()`);
  const pass = (n) => console.log('PASS', n);
  const fail = (n, d) => { console.log('FAIL', n, d || ''); process.exitCode = 1; };

  // ---- S0 版本 ----
  const sb = await ev(`document.querySelector('.statusbar').textContent.replace(/\\s+/g, '')`);
  /v0927\.53/.test(sb) ? pass('S0 状态栏 v0927.53') : fail('S0 状态栏 v0927.53', sb);

  // ---- D0 夹具 stage1（幂等）----
  try {
    const out = fx58('stage1');
    out.indexOf('W58-STAGE1-OK') >= 0 ? pass('D0 夹具 stage1（dh_w58：dbo.w58_a 1 行）') : fail('D0 stage1', out.slice(0, 120));
  } catch (e) {
    fail('D0 stage1', String(e.message).slice(0, 160));
  }

  // ---- 展开/刷新连接树（dh_w58 建于树加载后，必须刷新才出现）----
  let c1 = null;
  for (let i = 0; i < 12 && !c1; i += 1) { c1 = await ev(titleAct.replace(/TITLE/g, '1')); if (!c1) await sleep(500); }
  if (!c1) {
    fail('T1 前置', '连接「1」节点未出现');
  } else {
    const connected = await ev(`(() => {
      const rows = [...document.querySelectorAll('.tree-wrap .ant-tree-treenode')].filter((r) => r.querySelector('.node-title'));
      const f = rows.find((r) => r.querySelector('.node-title').textContent === '1');
      return !!(f && f.querySelector('.node-title.on'));
    })()`);
    if (!connected) { await nodeAct('1', 'dblclick'); await sleep(1600); }
    await nodeAct('1', 'contextmenu');
    await sleep(450);
    const rf = await menuClick('刷新');
    await sleep(1300);
    // 折叠则点 switcher 展开
    await ev(`(() => {
      const rows = [...document.querySelectorAll('.tree-wrap .ant-tree-treenode')].filter((r) => r.querySelector('.node-title') && r.getBoundingClientRect().height > 0);
      const f = rows.find((r) => r.querySelector('.node-title').textContent === '1');
      if (!f) return 'no-node';
      const sw = f.querySelector('.ant-tree-switcher');
      const hasKids = f.getAttribute('aria-expanded') === 'false' || !!sw;
      const anyDb = [...document.querySelectorAll('.tree-wrap .node-title')].some((t) => t.textContent === 'dh_w58');
      if (sw && !anyDb) sw.click();
      return 'ok';
    })()`);
    await sleep(1000);
    // ---- T1 库节点可见 ----
    let p = null;
    for (let i = 0; i < 10 && !p; i += 1) { p = await ev(titleAct.replace(/TITLE/g, 'dh_w58')); if (!p) await sleep(500); }
    p ? pass('T1 刷新+展开后库节点 dh_w58 可见（rf=' + rf + '）') : fail('T1 树展开', 'dh_w58 节点未出现');

    // ---- T2 库节点右键 → 导出数据库… → DumpModal 绑定 dh_w58 ----
    let modal = null;
    for (let attempt = 0; attempt < 3 && !modal; attempt += 1) {
      await nodeAct('dh_w58', 'contextmenu');
      await sleep(450);
      const clicked = await menuClick('导出数据库');
      if (clicked !== 'ok') { await sleep(700); continue; }
      for (let i = 0; i < 20 && !modal; i += 1) {
        await sleep(500);
        modal = await ev(`(() => {
          const m = document.querySelector('.ant-modal [data-dh-dump="tables"]');
          if (!m) return null;
          const title = (document.querySelector('.ant-modal .ant-modal-title') || {}).textContent || '';
          const ctx = (m.querySelector('div') || {}).textContent || '';
          const names = [...m.querySelectorAll('[data-dh-dump-name]')].map((x) => x.textContent.trim());
          if (!names.length && !m.textContent.includes('无表')) return null; // 仍在加载
          return { title: title.replace(/\\s+/g, ''), ctx: ctx.replace(/\\s+/g, ''), names };
        })()`);
      }
    }
    modal && modal.title.indexOf('dh_w58') >= 0 && modal.ctx.indexOf('dh_w58') >= 0 && modal.names.length === 1 && modal.names[0] === 'w58_a'
      ? pass('T2 库节点右键导出数据库 → 弹窗绑定 dh_w58（清单=[' + modal.names.join(',') + ']，非 master）')
      : fail('T2 导出弹窗绑定', JSON.stringify(modal).slice(0, 300));

    // ---- T3 取消关闭弹窗 ----
    await ev(`(() => {
      const btns = [...document.querySelectorAll('.ant-modal .ant-modal-footer .ant-btn')];
      const c = btns.find((b) => b.textContent.replace(/\\s+/g, '') === '取消');
      if (c) c.click();
      return !!c;
    })()`);
    await sleep(600);
    const gone = await ev(`!document.querySelector('.ant-modal [data-dh-dump="tables"]`);
    gone ? pass('T3 弹窗已取消关闭') : fail('T3 关闭弹窗', 'modal 仍在');
  }

  // ---- D8 库端核验 ----
  try {
    const out = fx58('check1');
    const line = (out.split('\n').find((l) => l.indexOf('CHECK-JSON') === 0) || '').slice(11);
    const info = JSON.parse(line);
    info.rows === 1 ? pass('D8 库端核验：w58_a 1 行') : fail('D8 库端核验', JSON.stringify(info));
  } catch (e) {
    fail('D8 库端核验', String(e.message).slice(0, 160));
  }

  errors.length === 0 ? pass('S5 无控制台错误') : fail('S5 无控制台错误', errors.slice(0, 3).join(' || '));

  // ---- D9 清理（放最后：cleanup 踢会话可能触发连接错误日志）----
  try {
    const out = fx58('cleanup');
    out.indexOf('W58-CLEANUP-OK') >= 0 ? pass('D9 夹具 cleanup（drop dh_w58 整库）') : fail('D9 cleanup', out.slice(0, 120));
  } catch (e) {
    fail('D9 cleanup', String(e.message).slice(0, 160));
  }

  await client.close();
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
