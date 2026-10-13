'use strict';
// v0927.52 关闭 DevTools 快捷键验证：
//  T1 Ctrl+Shift+I 合成按键 → /json/list 无 devtools:// 目标（主进程 before-input-event 拦截）
//  T2 F12 同上
//  T3 拦截不影响应用：evaluate 通路 + 状态栏仍在
//  S0 版本 v0927.52 / S5 无控制台错误
// 目标清单经 127.0.0.1:<CDP_PORT>/json/list 读取（端口限制 9222-9230 测试段，本机回环）
const http = require('http');
const CDP = require('chrome-remote-interface');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = Number(process.env.CDP_PORT || 9230);
const listTargets = () =>
  new Promise((resolve, reject) => {
    if (!(PORT >= 9222 && PORT <= 9230)) {
      reject(new Error('port out of test range'));
      return;
    }
    http
      .get({ host: '127.0.0.1', port: PORT, path: '/json/list', timeout: 4000 }, (res) => {
        let s = '';
        res.on('data', (d) => { s += d; });
        res.on('end', () => {
          try { resolve(JSON.parse(s)); } catch (e) { reject(e); }
        });
      })
      .on('error', reject);
  });
const devtoolsCount = async () => {
  const ts = await listTargets();
  return ts.filter((t) => String(t.url || '').indexOf('devtools://') === 0).length;
};
(async () => {
  const client = await CDP({ port: PORT });
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
  const key = async (opts) => {
    await Input.dispatchKeyEvent(Object.assign({ type: 'keyDown' }, opts));
    await Input.dispatchKeyEvent(Object.assign({ type: 'keyUp' }, opts));
    await sleep(150);
  };
  const pass = (n) => console.log('PASS', n);
  const fail = (n, d) => { console.log('FAIL', n, d || ''); process.exitCode = 1; };

  // ---- S0 版本 ----
  const sb = await ev(`document.querySelector('.statusbar').textContent.replace(/\\s+/g, '')`);
  if (!/v0927\.52/.test(sb)) fail('S0 状态栏 v0927.52', sb);
  else pass('S0 状态栏 v0927.52');

  const before = await devtoolsCount();

  // ---- T1 Ctrl+Shift+I ----
  await key({ key: 'i', code: 'KeyI', windowsVirtualKeyCode: 73, modifiers: 10 }); // Ctrl=2 | Shift=8
  await sleep(1000);
  const afterI = await devtoolsCount();
  before === 0 && afterI === 0
    ? pass('T1 Ctrl+Shift+I 已拦截（devtools 目标数 ' + afterI + '）')
    : fail('T1 Ctrl+Shift+I', 'before=' + before + ' after=' + afterI);

  // ---- T2 F12 ----
  await key({ key: 'F12', code: 'F12', windowsVirtualKeyCode: 123, modifiers: 0 });
  await sleep(1000);
  const afterF12 = await devtoolsCount();
  afterF12 === 0
    ? pass('T2 F12 已拦截（devtools 目标数 ' + afterF12 + '）')
    : fail('T2 F12', 'after=' + afterF12);

  // ---- T3 应用不受影响 ----
  const one = await ev('1 + 1');
  const sb2 = await ev(`!!document.querySelector('.statusbar')`);
  one === 2 && sb2 === true
    ? pass('T3 拦截不影响渲染/求值通路（1+1=' + one + '，状态栏在）')
    : fail('T3 应用存活', JSON.stringify({ one, sb2 }));

  errors.length === 0 ? pass('S5 无控制台错误') : fail('S5 无控制台错误', errors.slice(0, 3).join(' || '));
  await client.close();
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
