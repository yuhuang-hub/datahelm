// CDP 综合验证：树省略号 / 右键菜单 / 单击编辑+边框+放弃更改 / 可视化筛选排序
// 启动：npx electron . --remote-debugging-port=9222 后运行本脚本
const CRI = require('chrome-remote-interface');
const fs = require('fs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (s) => String(s || '').replace(/\s+/g, '');
const SHOT_DIR = 'D:/DataHelm/.tmp-test';
const results = [];
function step(name, ok, detail) {
  results.push({ name, ok, detail: detail || '' });
  console.log((ok ? 'PASS' : 'FAIL') + ' | ' + name + (detail ? ' | ' + detail : ''));
}

async function main() {
  const browser = await CRI({ port: 9222 });
  const { Runtime, Page } = browser;
  await Runtime.enable();
  await Page.enable();

  const evalJs = async (expr) => {
    const r = await Runtime.evaluate({ expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('页面脚本异常: ' + JSON.stringify(r.exceptionDetails).slice(0, 400));
    return r.result.value;
  };
  const shot = async (name) => {
    await sleep(300);
    const r = await Page.captureScreenshot({ format: 'png' });
    fs.writeFileSync(SHOT_DIR + '/' + name + '.png', Buffer.from(r.data, 'base64'));
  };
  const dbl = (elExpr) => evalJs(`(() => { const el = ${elExpr}; if (!el) return false; el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); return true; })()`);
  const clickText = (scopeExpr, text, kind) =>
    evalJs(`(() => {
      const norm = (s) => String(s || '').replace(/\\s+/g, '');
      const scope = ${scopeExpr} || document;
      const els = [...scope.querySelectorAll('${kind || 'button'}')];
      const el = els.find((b) => norm(b.textContent) === ${JSON.stringify(norm(text))} || norm(b.textContent).includes(${JSON.stringify(norm(text))}));
      if (!el) return false; el.click(); return true;
    })()`);
  // antd Select：点开并按可见下拉里的选项标题选择
  const pickSelect = async (selExpr, optionTitle) => {
    await evalJs(`(() => { const el = ${selExpr}; if (!el) return false; el.querySelector('.ant-select-selector')?.click?.() ?? el.click(); return true; })()`);
    await sleep(350);
    const okOpt = await evalJs(`(() => {
      const dd = [...document.querySelectorAll('.ant-select-dropdown')].filter((d) => !d.className.includes('hidden') && getComputedStyle(d).display !== 'none');
      const opt = dd.flatMap((d) => [...d.querySelectorAll('.ant-select-item-option')]).find((o) => (o.title || o.textContent).startsWith(${JSON.stringify(optionTitle)}));
      if (!opt) return false; opt.click(); return true;
    })()`);
    await sleep(250);
    return okOpt;
  };
  const typeIn = (inputExpr, text) =>
    evalJs(`(() => {
      const input = ${inputExpr};
      if (!input) return false;
      const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      set.call(input, ${JSON.stringify(text)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
  const ctxMenu = async (elExpr) => {
    await evalJs(`(() => { const el = ${elExpr}; if (!el) return false; el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 })); return true; })()`);
    await sleep(450);
  };

  // ========== A. 连接树：长名省略号 + 无横向滚动 ==========
  await sleep(2500);
  const connOpened = await dbl(`[...document.querySelectorAll('.node-title')].find((n) => n.textContent.includes('测试演示 SQLite 库'))`);
  await sleep(1500);
  // 展开“表”分类
  await dbl(`[...document.querySelectorAll('.node-title')].find((n) => /^表/.test(n.textContent.trim()))`);
  await sleep(900);
  const treeCheck = await evalJs(`(() => {
    const long = [...document.querySelectorAll('.node-title')].find((n) => n.textContent.includes('very_long_table_name'));
    if (!long) return { found: false };
    const cs = getComputedStyle(long);
    const wrap = document.querySelector('.tree-wrap');
    return {
      found: true,
      whiteSpace: cs.whiteSpace,
      ellipsis: cs.textOverflow,
      singleLine: long.offsetHeight < 30,
      truncated: long.scrollWidth > long.clientWidth,
      treeScrollW: wrap.scrollWidth, treeClientW: wrap.clientWidth,
      noHScroll: wrap.scrollWidth <= wrap.clientWidth + 2,
    };
  })()`);
  step('A1 树长名单行省略号', treeCheck.found && treeCheck.whiteSpace === 'nowrap' && treeCheck.singleLine && treeCheck.truncated, JSON.stringify(treeCheck));
  step('A2 树无横向溢出/空白', treeCheck.noHScroll, `scrollW=${treeCheck.treeScrollW} clientW=${treeCheck.treeClientW}`);
  await shot('01-tree-ellipsis');

  // ========== B. 右键菜单 ==========
  await ctxMenu(`[...document.querySelectorAll('.node-title')].find((n) => n.textContent.trim() === 'users')`);
  const menuLabels = await evalJs(`[...document.querySelectorAll('.ant-dropdown:not(.ant-dropdown-hidden) .ant-dropdown-menu-item')].map((i) => i.textContent.trim())`);
  const need = ['打开表', '设计表', '新建查询', '复制表名', '复制DDL', '复制SELECT语句', '复制INSERT模板', '查看行数', '导出SQL转储…', '重命名…', '清空表', '删除表', '刷新'];
  const missing = need.filter((k) => !menuLabels.some((l) => norm(l).includes(norm(k))));
  step('B1 表右键菜单丰富', menuLabels.length >= 10 && missing.length === 0, `共${menuLabels.length}项; 缺失: ${missing.join(',') || '无'} | ${menuLabels.join(' / ')}`);
  await shot('02-table-context-menu');
  // 查看行数
  const clickedCount = await clickText(`document.querySelector('.ant-dropdown:not(.ant-dropdown-hidden)')`, '查看行数', '.ant-dropdown-menu-item');
  await sleep(700);
  const countText = await evalJs(`(() => { const m = [...document.querySelectorAll('.ant-modal-confirm, .ant-modal')].filter((x) => getComputedStyle(x).display !== 'none')[0]; return m ? m.textContent : ''; })()`);
  step('B2 查看行数弹窗', clickedCount && /共\s*5\s*行/.test(countText), countText.slice(0, 60));
  await clickText(`[...document.querySelectorAll('.ant-modal-wrap')].filter((w) => getComputedStyle(w).display !== 'none')[0]`, '知道了', 'button');
  await sleep(400);

  // ========== C. 单击编辑 + 边框 + 放弃更改 ==========
  // 双击 users 打开数据表
  await dbl(`[...document.querySelectorAll('.node-title')].find((n) => n.textContent.trim() === 'users')`);
  await sleep(1500);
  const gridReady = await evalJs(`!!document.querySelector('.ant-table-row')`);
  if (!gridReady) step('C0 打开数据表', false, '未出现表格行');
  // 单击第1行 name 列（第2列）单元格
  const clicked = await evalJs(`(() => {
    const tr = document.querySelector('.ant-table-row');
    if (!tr) return false;
    const td = tr.querySelectorAll('td')[2];
    if (!td) return false;
    td.querySelector('.cell')?.click();
    return true;
  })()`);
  await sleep(500);
  const editState = await evalJs(`(() => {
    const input = document.querySelector('.ant-table-tbody input.cell-edit-input');
    if (!input) return { editing: false };
    const cs = getComputedStyle(input);
    return { editing: true, focused: document.activeElement === input, shadow: cs.boxShadow.slice(0, 60) };
  })()`);
  step('C1 单击直接进入编辑', clicked && editState.editing, JSON.stringify(editState));
  step('C2 编辑框聚焦+绿色边框', editState.focused && /0e8a6a|40,\s*138,\s*106|46,\s*160,\s*120/.test(editState.shadow || ''), editState.shadow);
  await shot('03-cell-editing');
  // 输入新值并回车
  await typeIn(`document.querySelector('.ant-table-tbody input.cell-edit-input')`, 'AliceX');
  await evalJs(`(() => { const i = document.querySelector('.ant-table-tbody input.cell-edit-input'); if (i) { i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); } return true; })()`);
  await sleep(500);
  const afterEdit = await evalJs(`(() => {
    const tr = document.querySelector('.ant-table-row');
    const normT = (s) => String(s || '').replace(/\\s+/g, '');
    return { text: tr ? tr.textContent : '', hasDirty: !!document.querySelector('.cell.dirty'), cancelBtn: [...document.querySelectorAll('button')].some((b) => normT(b.textContent) === '放弃更改') };
  })()`);
  step('C3 编辑生效(脏单元格+放弃按钮可用)', afterEdit.text.includes('AliceX') && afterEdit.hasDirty && afterEdit.cancelBtn, JSON.stringify(afterEdit));
  // 放弃更改
  await clickText(`document`, '放弃更改');
  await sleep(500);
  const afterCancel = await evalJs(`(() => {
    const tr = document.querySelector('.ant-table-row');
    return { text: tr ? tr.textContent : '', hasDirty: !!document.querySelector('.cell.dirty') };
  })()`);
  step('C4 放弃更改恢复原值', afterCancel.text.includes('Alice') && !afterCancel.text.includes('AliceX') && !afterCancel.hasDirty, afterCancel.text.slice(0, 40));

  // ========== D. 可视化筛选/排序 ==========
  await clickText(`document.querySelector('.tab-toolbar')`, '筛选/排序');
  await sleep(500);
  const panelOpen = await evalJs(`!!document.querySelector('.filter-panel')`);
  if (!panelOpen) step('D0 筛选面板打开', false, '');
  // 条件：city = Beijing（数值列 age 裸值逻辑稍后由 SQL 预览验证）
  const sels = await evalJs(`document.querySelectorAll('.filter-panel .ant-select').length`);
  const okCol = await pickSelect(`document.querySelectorAll('.filter-panel .ant-select')[0]`, 'city');
  await typeIn(`document.querySelector('.filter-cond input')`, 'Beijing');
  // 排序：id 降序
  const okSortCol = await pickSelect(`[...document.querySelectorAll('.filter-panel .ant-select')].slice(-2)[0]`, 'id');
  const okDir = await pickSelect(`[...document.querySelectorAll('.filter-panel .ant-select')].slice(-1)[0]`, '降序');
  const sqlPreview = await evalJs(`document.querySelector('.filter-sql') ? document.querySelector('.filter-sql').textContent : ''`);
  step('D1 面板条件/排序配置', sels >= 4 && okCol && okSortCol && okDir, `selects=${sels} col=${okCol} sort=${okSortCol} dir=${okDir}`);
  await shot('04-filter-panel');
  // 应用
  const applied = await clickText(`document.querySelector('.filter-panel')`, '应用');
  await sleep(900);
  const gridAfter = await evalJs(`(() => {
    const rows = [...document.querySelectorAll('.ant-table-row')];
    const names = rows.map((r) => r.querySelectorAll('td')[2] && r.querySelectorAll('td')[2].textContent.trim());
    const ctx = document.querySelector('.tab-toolbar .ctx') ? document.querySelector('.tab-toolbar .ctx').textContent : '';
    return { count: rows.length, names, ctx };
  })()`);
  step('D2 筛选生效(仅Beijing 2行, Carol在前=降序)', applied && gridAfter.count === 2 && gridAfter.names[0] === 'Carol' && gridAfter.names[1] === 'Alice', JSON.stringify(gridAfter));
  step('D3 SQL 正确(city=Beijing 引号转义)', /city\\s*=\\s*'Beijing'/.test(gridAfter.ctx) && /id\\s*DESC/.test(gridAfter.ctx), gridAfter.ctx);
  await shot('05-filter-applied');
  // 重开面板应回显 + SQL 模式
  await clickText(`document.querySelector('.tab-toolbar')`, '筛选/排序');
  await sleep(500);
  const reopen = await evalJs(`(() => {
    const conds = [...document.querySelectorAll('.filter-cond')];
    const colSel = conds[0] && conds[0].querySelector('.ant-select-selection-item');
    return { conds: conds.length, col: colSel ? colSel.textContent : '' };
  })()`);
  const toggled = await clickText(`document.querySelector('.filter-panel')`, '切换SQL模式', 'a');
  await sleep(400);
  const rawSql = await evalJs(`document.querySelector('.filter-panel textarea') ? document.querySelector('.filter-panel textarea').value : ''`);
  step('D4 面板回显+SQL模式带出WHERE', reopen.conds === 1 && norm(reopen.col).includes('city') && /city\\s*=\\s*'Beijing'/.test(rawSql), `col=${reopen.col} sql=${rawSql}`);
  // 清除全部
  await clickText(`document.querySelector('.filter-panel')`, '清除全部');
  await sleep(900);
  const cleared = await evalJs(`document.querySelectorAll('.ant-table-row').length`);
  step('D5 清除筛选恢复全部行', cleared === 5, `rows=${cleared}`);

  await shot('06-final');
  browser.close();
  const fails = results.filter((r) => !r.ok);
  console.log(fails.length ? `\n== ${fails.length} 项失败 ==` : '\n== 全部通过 ==');
  process.exit(fails.length ? 1 : 0);
}

main().catch((e) => {
  console.error('SCRIPT ERROR:', e.message);
  process.exit(2);
});
