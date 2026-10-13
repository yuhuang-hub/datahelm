// 精查树行内对齐（2x 放大截图 + DOM 测量）
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
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 250));
    return r.result.value;
  };

  // 展开树到表节点
  const titles = () => ev(`[...document.querySelectorAll('.node-title')].map((n) => n.textContent.trim())`);
  let t = await titles();
  if (!t.some((x) => x === '表')) {
    await ev(`(() => { const row = [...document.querySelectorAll('.ant-tree-treenode')].find((r) => r.textContent.includes('演示 SQLite 库')); const s = row && row.querySelector('.ant-tree-switcher'); if (s) { s.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); s.click(); } return 1; })()`);
    await sleep(1500);
  }
  t = await titles();
  if (!t.includes('employees')) {
    await ev(`(() => { const row = [...document.querySelectorAll('.ant-tree-treenode')].find((r) => { const n = r.querySelector('.node-title'); return n && /^表/.test(n.textContent.trim()); }); if (!row) return 0; const s = row.querySelector('.ant-tree-switcher'); s.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); s.click(); return 1; })()`);
    await sleep(1500);
  }

  const m = await ev(`(() => {
    const out = [];
    for (const label of ['演示 SQLite 库', '表', 'employees']) {
      const row = [...document.querySelectorAll('.ant-tree-treenode')].find((r) => {
        const n = r.querySelector('.node-title');
        return n && n.textContent.trim().startsWith(label);
      });
      if (!row) { out.push({ label, err: 'NO_ROW' }); continue; }
      const sw = row.querySelector('.ant-tree-switcher');
      const icon = row.querySelector('.ant-tree-iconEle');
      const title = row.querySelector('.node-title');
      const rw = row.getBoundingClientRect();
      const rs = sw ? sw.getBoundingClientRect() : null;
      const ri = icon ? icon.getBoundingClientRect() : null;
      const rt = title.getBoundingClientRect();
      const st = getComputedStyle(row);
      out.push({
        label,
        rowH: Math.round(rw.height),
        rowAlign: st.alignItems,
        switcher: rs ? { top: Math.round(rs.top), h: Math.round(rs.height), centerY: Math.round(rs.top + rs.height / 2) } : null,
        icon: ri ? { top: Math.round(ri.top), h: Math.round(ri.height), centerY: Math.round(ri.top + ri.height / 2), left: Math.round(ri.left) } : null,
        title: { top: Math.round(rt.top), h: Math.round(rt.height), centerY: Math.round(rt.top + rt.height / 2), left: Math.round(rt.left) },
        titleLineHeight: getComputedStyle(title).lineHeight,
        titleFontSize: getComputedStyle(title).fontSize,
        titlePadding: getComputedStyle(title).padding,
      });
    }
    return out;
  })()`);
  console.log(JSON.stringify(m, null, 1));

  // 2x 放大截图树前几个节点
  const q = await ev(`(() => { const s = document.querySelector('.sidebar'); const r = s.getBoundingClientRect(); return JSON.stringify({ x: r.x, y: r.y, w: r.width, h: 200 }); })()`);
  const clip = JSON.parse(q);
  const shot = await Page.captureScreenshot({ format: 'png', clip: { x: clip.x, y: clip.y, width: clip.w, height: clip.h }, scale: 2 });
  fs.writeFileSync('D:/DataHelm/.tmp-tree-2x.png', Buffer.from(shot.data, 'base64'));
  console.log('2x shot saved');
  b.close();
  process.exit(0);
}

main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
