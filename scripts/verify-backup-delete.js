// CDP 验证：备份计划脏数据自愈 + 只删除点中的那一条
// 用法：先以 --remote-debugging-port=9222 启动应用，再 NODE_PATH=/d/DWDLPC/automation/node_modules node scripts/verify-backup-delete.js
const CRI = require('chrome-remote-interface');
const fs = require('fs');
const path = require('path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dataFile = path.join(process.env.APPDATA, 'DataHelm', 'backups.json');

async function main() {
  const browser = await CRI({ port: 9222 });
  const { Runtime } = browser;
  await Runtime.enable();

  const evalJs = async (expr) => {
    const r = await Runtime.evaluate({ expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('页面脚本异常: ' + JSON.stringify(r.exceptionDetails).slice(0, 400));
    return r.result.value;
  };

  // 1. 打开备份计划 tab
  const opened = await evalJs(`(() => {
    const b = document.querySelector('button[title="备份计划"]');
    if (!b) return 'NOT_FOUND';
    b.click();
    return 'OK';
  })()`);
  if (opened !== 'OK') throw new Error('未找到"备份计划"入口按钮');
  await sleep(1200);

  const rowsBefore = await evalJs(`[...document.querySelectorAll('.ant-table-row')].map(tr => tr.querySelector('td')?.textContent)`);
  console.log('删除前行数:', rowsBefore.length, JSON.stringify(rowsBefore));
  if (rowsBefore.length !== 3) throw new Error('自愈失败：期望 3 行，实际 ' + rowsBefore.length);

  // 2. 删除"计划B-重复"（antd 会把两字按钮渲染成"删 除"，需归一化空白再比较）
  const clickedRow = await evalJs(`(() => {
    const row = [...document.querySelectorAll('.ant-table-row')].find(tr => tr.textContent.includes('计划B-重复'));
    if (!row) return 'ROW_NOT_FOUND';
    const btn = [...row.querySelectorAll('button')].find(b => b.textContent.replace(/\\s+/g, '') === '删除');
    if (!btn) return 'BTN_NOT_FOUND';
    btn.click();
    return 'OK';
  })()`);
  if (clickedRow !== 'OK') throw new Error('行内删除按钮点击失败: ' + clickedRow);
  await sleep(800);

  // 3. 确认弹窗（按可见性过滤 modal wrap）
  const confirmed = await evalJs(`(() => {
    const wraps = [...document.querySelectorAll('.ant-modal-wrap')].filter(w => getComputedStyle(w).display !== 'none');
    const btn = wraps.flatMap(w => [...w.querySelectorAll('button')]).find(b => b.textContent.replace(/\\s+/g, '') === '删除');
    if (!btn) return 'CONFIRM_NOT_FOUND';
    btn.click();
    return 'OK';
  })()`);
  if (confirmed !== 'OK') throw new Error('确认弹窗未找到删除按钮');
  await sleep(1200);

  const rowsAfter = await evalJs(`[...document.querySelectorAll('.ant-table-row')].map(tr => tr.querySelector('td')?.textContent)`);
  console.log('删除后行数:', rowsAfter.length, JSON.stringify(rowsAfter));
  if (rowsAfter.length !== 2) throw new Error('BUG 未修复：期望剩 2 行，实际 ' + rowsAfter.length);
  if (rowsAfter.some((n) => n && n.includes('计划B'))) throw new Error('删除的不是点中的行');

  // 4. 校验磁盘数据
  const disk = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  const ids = disk.schedules.map((s) => s.id);
  const unique = new Set(ids).size === ids.length;
  console.log('磁盘剩余计划:', disk.schedules.map((s) => s.name), '| id 唯一:', unique);
  if (disk.schedules.length !== 2 || !unique) throw new Error('磁盘数据校验失败');

  console.log('PASS: 删除单条计划，其余保留，id 已自愈为唯一');
  browser.close();
  process.exit(0);
}

main().catch((e) => {
  console.error('FAIL:', e.message);
  process.exit(1);
});
