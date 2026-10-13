'use strict';
// 网格单元格右键菜单实测（antd Dropdown → .ant-dropdown-menu-item）
const CDP = require('chrome-remote-interface');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const client = await CDP({ port: Number(process.env.CDP_PORT || 9227) });
  const { Input, Runtime } = client;
  await Runtime.enable();
  const ev = async (expr) => {
    const r = await Runtime.evaluate({ expression: expr, returnByValue: true });
    if (r.exceptionDetails) return { err: 'exception' };
    return r.result.value;
  };
  const press = async (x, y, btn, cnt) => {
    await Input.dispatchMouseEvent({ type: 'mousePressed', x, y, button: btn, clickCount: cnt });
    await Input.dispatchMouseEvent({ type: 'mouseReleased', x, y, button: btn, clickCount: cnt });
  };
  // 打开 employees 表
  const treePos = (title) => ev(`(() => {
    const rows = [...document.querySelectorAll('.tree-wrap .ant-tree-treenode')].filter((r) => r.querySelector('.node-title') && r.getBoundingClientRect().height > 0);
    const f = rows.find((r) => r.querySelector('.node-title').textContent === ${JSON.stringify(title)});
    if (!f) return null;
    const r = f.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`);
  const dbl = async (p) => { await press(p.x, p.y, 'left', 1); await sleep(80); await press(p.x, p.y, 'left', 2); await sleep(1200); };
  await dbl(await treePos('演示 SQLite 库'));
  await dbl(await treePos('表'));
  await sleep(300);
  await dbl(await treePos('employees'));
  await sleep(1200);
  // 右键第一个数据单元格
  const c = await ev(`(() => {
    const x = [...document.querySelectorAll('.dh-grid .ant-table-tbody .cell')].find((e) => e.offsetParent);
    if (!x) return null;
    const r = x.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`);
  if (!c) { console.log('FAIL 无单元格'); client.close(); process.exit(1); return; }
  await press(c.x, c.y, 'right', 1);
  await sleep(450);
  const items = await ev(`(() => {
    const d = [...document.querySelectorAll('.ant-dropdown')].find((x) => x.offsetParent);
    return d ? [...d.querySelectorAll('.ant-dropdown-menu-item')].map((i) => i.textContent.replace(/\\s+/g, '')) : null;
  })()`);
  console.log('数据格菜单:', JSON.stringify(items));
  const ok = items && items.length >= 9 && items.includes('复制为INSERT语句') && items.includes('新增记录') && items.includes('删除此行') && items.includes('刷新');
  console.log(ok ? 'PASS 网格单元格菜单完整（' + items.length + ' 项）' : 'FAIL 网格单元格菜单');
  // 表头右键
  await press(650, 640, 'left', 1); await sleep(300);
  const h = await ev(`(() => {
    const x = document.querySelector('.dh-grid .ant-table-thead th');
    if (!x) return null;
    const r = x.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`);
  await press(h.x, h.y, 'right', 1);
  await sleep(450);
  const hItems = await ev(`(() => {
    const d = [...document.querySelectorAll('.ant-dropdown')].find((x) => x.offsetParent);
    return d ? [...d.querySelectorAll('.ant-dropdown-menu-item')].map((i) => i.textContent.replace(/\\s+/g, '')) : null;
  })()`);
  console.log('表头菜单:', JSON.stringify(hItems));
  const okH = hItems && hItems.includes('复制列名') && hItems.includes('升序排序') && hItems.includes('取消排序');
  console.log(okH ? 'PASS 表头菜单完整' : 'FAIL 表头菜单');
  await press(650, 640, 'left', 1);
  client.close();
  if (!ok || !okH) process.exit(1);
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
