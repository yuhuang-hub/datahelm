'use strict';
// 表头右键菜单 + 排序验证
const CDP = require('chrome-remote-interface');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const client = await CDP({ port: Number(process.env.CDP_PORT || 9226) });
  const { Input, Runtime } = client;
  await Runtime.enable();
  const ev = async (expr) => (await Runtime.evaluate({ expression: expr, returnByValue: true })).result.value;
  const press = async (x, y, btn, cnt) => {
    await Input.dispatchMouseEvent({ type: 'mousePressed', x, y, button: btn, clickCount: cnt });
    await Input.dispatchMouseEvent({ type: 'mouseReleased', x, y, button: btn, clickCount: cnt });
  };
  const rclick = async (x, y) => { await press(x, y, 'right', 1); await sleep(450); };
  const lclick = async (x, y) => { await press(x, y, 'left', 1); await sleep(450); };
  const moveAway = async () => {
    await Input.dispatchMouseEvent({ type: 'mouseMoved', x: 700, y: 500 }); await sleep(150);
    await Input.dispatchMouseEvent({ type: 'mouseMoved', x: 800, y: 600 }); await sleep(350);
  };
  const menu = () => ev(`(() => {
    const d = [...document.querySelectorAll('.ant-dropdown')].find((x) => !x.classList.contains('ant-dropdown-hidden'));
    return d ? [...d.querySelectorAll('.ant-dropdown-menu-item')].map((i) => i.textContent) : null;
  })()`);
  const clickItemContains = (sub) => ev(`(() => {
    const d = [...document.querySelectorAll('.ant-dropdown')].find((x) => !x.classList.contains('ant-dropdown-hidden'));
    if (!d) return false;
    const it = [...d.querySelectorAll('.ant-dropdown-menu-item')].find((i) => i.textContent.includes('${sub}'));
    if (!it) return false;
    it.click();
    return true;
  })()`);

  const h = await ev(`(() => {
    const pane = document.querySelector('.ant-tabs-tabpane-active');
    const ths = [...pane.querySelectorAll('.grid-area .ant-table-thead th')].filter((t) => t.textContent.trim());
    const t = ths[0];
    if (!t) return null;
    const r = t.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), title: t.textContent.trim().slice(0, 10) };
  })()`);
  console.log('列头:', JSON.stringify(h));

  await lclick(800, 600);
  await rclick(h.x, h.y);
  await moveAway();
  const m = await menu();
  const ok = !!m && m.some((i) => i.replace(/\s+/g, '') === '复制列名') && m.some((i) => i.includes('升序排序')) && m.some((i) => i.includes('降序排序')) && m.some((i) => i.includes('取消排序'));
  console.log(ok ? 'PASS' : 'FAIL', 'G3 表头菜单', JSON.stringify(m));

  await clickItemContains('升序排序');
  await sleep(1500);
  const ctx1 = await ev(`(() => { const c = document.querySelector('.ant-tabs-tabpane-active .tab-toolbar .ctx'); return c ? c.textContent : ''; })()`);
  console.log(ctx1.includes('排序') ? 'PASS' : 'FAIL', 'G4 升序生效', ctx1);

  await rclick(h.x, h.y);
  await moveAway();
  await clickItemContains('取消排序');
  await sleep(1500);
  const ctx2 = await ev(`(() => { const c = document.querySelector('.ant-tabs-tabpane-active .tab-toolbar .ctx'); return c ? c.textContent : ''; })()`);
  console.log(!ctx2.includes('排序') ? 'PASS' : 'FAIL', 'G4b 取消排序', ctx2);

  await client.close();
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
