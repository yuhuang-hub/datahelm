// 稳定打开演示库的表：点 switcher 展开箭头（非双击切换），列真实表名后打开第一张表
const CRI = require('chrome-remote-interface');
const fs = require('fs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const b = await CRI({ port: 9222 });
  const { Runtime, Page } = b;
  await Runtime.enable();
  await Page.enable();
  const ev = async (expr) => {
    const r = await Runtime.evaluate({ expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 200));
    return r.result.value;
  };
  const titles = () => ev(`[...document.querySelectorAll('.node-title')].map((n) => n.textContent.trim())`);

  // 1. 确保连接已展开（点 conn 行的 switcher 箭头；已展开则跳过）
  let t = await titles();
  if (!t.some((x) => x === '表')) {
    await ev(`(() => { const row = [...document.querySelectorAll('.ant-tree-treenode')].find((r) => r.textContent.includes('演示 SQLite 库')); const s = row && row.querySelector('.ant-tree-switcher'); if (s) { s.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); s.click(); } return 1; })()`);
    await sleep(1500);
  }
  // 2. 展开“表”分类（点 switcher，不切换）
  t = await titles();
  console.log('before:', JSON.stringify(t));
  await ev(`(() => { const row = [...document.querySelectorAll('.ant-tree-treenode')].find((r) => /^表/.test(r.querySelector('.node-title') ? r.querySelector('.node-title').textContent.trim() : '')); if (!row) return 'NO_ROW'; const s = row.querySelector('.ant-tree-switcher'); if (!s) return 'NO_SWITCHER'; s.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); s.click(); return 'OK'; })()`);
  await sleep(1500);
  t = await titles();
  console.log('after :', JSON.stringify(t));

  // 3. 打开第一张表（排除分类名）
  const cats = ['表', '视图', '触发器', '函数', '存储过程', '事件', '序列'];
  const tableName = t.find((x) => !cats.includes(x) && x !== '演示 SQLite 库' && x !== '1');
  if (!tableName) { console.log('NO_TABLE'); process.exit(1); }
  console.log('opening:', tableName);
  await ev(`(() => { const n = [...document.querySelectorAll('.node-title')].find((x) => x.textContent.trim() === ${JSON.stringify(tableName)}); if (!n) return 'NOT_FOUND'; n.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); return 'OK'; })()`);
  await sleep(2000);

  const info = await ev(`(() => {
    const rows = document.querySelectorAll('.grid-area .ant-table-row').length;
    const headCells = [...document.querySelectorAll('.grid-area .ant-table-thead .ant-table-cell')];
    const heads = headCells.map((h) => ({
      text: h.textContent.trim().slice(0, 30),
      w: Math.round(h.getBoundingClientRect().width),
    }));
    const firstRow = document.querySelector('.grid-area .ant-table-row');
    const rowCells = firstRow ? [...firstRow.querySelectorAll('.ant-table-cell')].map((c) => Math.round(c.getBoundingClientRect().width)) : [];
    const selHead = document.querySelector('.grid-area .ant-table-thead .ant-table-selection-column');
    return { rows, heads, rowCells, selHeadW: selHead ? Math.round(selHead.getBoundingClientRect().width) : null };
  })()`);
  console.log(JSON.stringify(info, null, 1));
  const shot = await Page.captureScreenshot({ format: 'png' });
  fs.writeFileSync('D:/DataHelm/.tmp-shot3.png', Buffer.from(shot.data, 'base64'));
  console.log('shot3 saved');
  b.close();
  process.exit(0);
}

main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
