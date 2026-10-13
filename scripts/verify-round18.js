'use strict';
// v0927.52 真实软件图标 + 主窗「就绪后才显示」（DH_SPLASH_MS=8000 实例，9228）：
//  I1 图标资源存在：electron/icons/icon.svg + icon.png（PNG 魔数、非平凡大小）
//  T1 主窗首次可见的瞬间：__dhReadyConns ≥1（连接在显示前已加载）、树里连接行已提交 DOM
//  T2 日志时序：SPLASH shown ≤ CONNS-READY ≤ MAIN shown；MAIN shown - shown ≥8000；
//     SPLASH closed ≥ MAIN shown；无 DH-MAIN forced / DH-ERR / RENDER-GONE
//  E1 空状态占位换成同款 AppIcon 原子 svg（不再是 ⛵ emoji）
//  S0 状态栏版本 / S5 无控制台错误
const CDP = require('chrome-remote-interface');
const fs = require('fs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const pass = (n) => console.log('PASS', n);
  const fail = (n, d) => { console.log('FAIL', n, d || ''); process.exitCode = 1; };
  const PORT = Number(process.env.CDP_PORT) || 9228;

  // ---- I1 图标资源 ----
  try {
    const svg = fs.readFileSync('D:/DataHelm/electron/icons/icon.svg');
    const png = fs.readFileSync('D:/DataHelm/electron/icons/icon.png');
    const pngOk = png.length > 5000 && png[0] === 0x89 && png[1] === 0x50 && png[2] === 0x4e && png[3] === 0x47;
    const svgOk = svg.length > 500 && /原子|atom/.test(String(svg).slice(0, 400));
    if (svgOk && pngOk) pass(`I1 图标资源（icon.svg ${svg.length}B / icon.png ${png.length}B）`);
    else fail('I1 图标资源', `svg=${svg.length}B svgOk=${svgOk} png=${png.length}B pngMagic=${pngOk}`);
  } catch (e) { fail('I1 图标资源', e.message); }

  // ---- 主窗口：等待 reveal（可见），捕获首帧就绪状态 ----
  // List/ws 轮询重试：起套件太早 ws 会 CLOSE（readyState 3）
  let list = [];
  let mainT = null;
  for (let i = 0; i < 12 && !mainT; i += 1) {
    try { list = await CDP.List({ port: PORT }); } catch { await sleep(600); }
    mainT = list.find((t) => t.type === 'page' && !t.url.includes('splash.html'));
    if (!mainT) await sleep(500);
  }
  if (!mainT) { fail('T1 显示即就绪', 'no main target'); process.exit(1); }
  let client = null;
  for (let i = 0; i < 6 && !client; i += 1) {
    try { client = await CDP({ target: mainT.webSocketDebuggerUrl }); } catch { await sleep(600); }
  }
  if (!client) { fail('T1 显示即就绪', 'main ws refused x6'); process.exit(1); }
  const { Runtime, Log } = client;
  await Runtime.enable();
  await Log.enable();
  const errors = [];
  Log.entryAdded(({ entry }) => { if (entry.level === 'error') errors.push(entry.text.slice(0, 200)); });
  const ev = async (x) => { const r = await Runtime.evaluate({ expression: x, returnByValue: true }); return r.result.value; };

  // 8s Splash 实例：reveal 发生在 shown+8000 之后。等日志出现 DH-MAIN shown（reveal 时刻）再取
  // 「显示瞬间」的 DOM/状态快照（DOM 在 ui-ready 前已提交）。
  // 注：不能用 visibilityState 轮询——本环境下隐藏窗也报 visible（backgroundThrottling/遮挡跟踪行为），
  // 会在 reveal 前提前放行，导致 T2 读日志时 DH-MAIN shown 尚未落盘
  let revealed = false;
  // ui-debug.log 跨 boot 累积：陈旧的 'DH-MAIN shown' 会让 includes() 立即放行（曾在电池里读到上一轮
  // boot 的行，Δ 为负）。这里按「行数增加」等本轮 boot 自己的行
  const countLine = (s, kw) => s.split('\n').filter((l) => l.includes(kw)).length;
  let baseMain = 0;
  try { baseMain = countLine(fs.readFileSync('D:/DataHelm/.tmp-ud7/ui-debug.log', 'utf8'), 'DH-MAIN shown'); } catch {}
  const t0 = Date.now();
  while (Date.now() - t0 < 22000) {
    try {
      revealed = countLine(fs.readFileSync('D:/DataHelm/.tmp-ud7/ui-debug.log', 'utf8'), 'DH-MAIN shown') > baseMain;
    } catch {}
    if (revealed) break;
    await sleep(200);
  }
  const snap = await ev(`(() => ({
    vis: document.visibilityState,
    readyConns: (typeof window.__dhReadyConns === 'number') ? window.__dhReadyConns : -1,
    treeTitles: [...document.querySelectorAll('.tree-wrap .node-title')].filter((n) => n.getBoundingClientRect().height > 0).map((n) => n.textContent.trim()).filter(Boolean),
  }))()`);
  if (revealed && snap && snap.readyConns >= 1 && snap.treeTitles.length >= 1) {
    pass(`T1 主窗首次可见即有连接（__dhReadyConns=${snap.readyConns}，树行：${snap.treeTitles.slice(0, 2).join('、')}）`);
  } else fail('T1 显示即就绪', JSON.stringify({ revealed, snap }));

  // ---- T2 日志时序 ----
  // reveal 后 Splash 还有 ~0.5-1s 的放大淡出 + closed 落盘：等「本轮 boot 自己的」closed 行（行数增加），
  // 陈旧行 includes() 会立即放行、.pop() 捞到上一轮 boot 的时序
  {
    let baseClosed = 0;
    try { baseClosed = countLine(fs.readFileSync('D:/DataHelm/.tmp-ud7/ui-debug.log', 'utf8'), 'DH-SPLASH closed'); } catch {}
    const tw = Date.now();
    while (Date.now() - tw < 20000) {
      try {
        if (countLine(fs.readFileSync('D:/DataHelm/.tmp-ud7/ui-debug.log', 'utf8'), 'DH-SPLASH closed') > baseClosed) break;
      } catch {}
      await sleep(200);
    }
  }
  try {
    const log = fs.readFileSync('D:/DataHelm/.tmp-ud7/ui-debug.log', 'utf8');
    const ts = (l) => Date.parse(l.slice(0, 24));
    const last = (kw) => log.split('\n').filter((l) => l.includes(kw)).pop();
    const sh = last('DH-SPLASH shown v0927.52');
    const cr = last('DH-CONNS-READY');
    const ms = last('DH-MAIN shown');
    const sc = last('DH-SPLASH closed');
    const nReady = cr ? Number((cr.match(/n=(\d+)/) || [0, 0])[1]) : -1;
    if (sh && cr && ms && nReady >= 1) {
      pass(`T2a 关键日志齐全（shown → conns-ready n=${nReady} → main shown）`);
    } else fail('T2a 关键日志齐全', JSON.stringify({ sh: !!sh, cr: !!cr, ms: !!ms, nReady }));
    if (ts(cr) <= ts(ms)) pass(`T2b 连接就绪 ≤ 主窗显示（Δ=${ts(ms) - ts(cr)}ms）`);
    else fail('T2b 连接就绪 ≤ 主窗显示', `Δ=${ts(ms) - ts(cr)}ms`);
    if (ts(ms) - ts(sh) >= 8000) pass(`T2c 主窗显示不早于 Splash 最短展示（${ts(ms) - ts(sh)}ms）`);
    else fail('T2c Splash 最短展示', `${ts(ms) - ts(sh)}ms`);
    if (sc && ts(sc) >= ts(ms)) pass(`T2d Splash 关闭不早于主窗显示（Δ=${ts(sc) - ts(ms)}ms）`);
    else fail('T2d Splash 关闭时序', JSON.stringify({ sc: !!sc }));
    // T2e 只看本轮 boot（最后一个 APP-START 之后）：历史 boot 的陈旧 DH-ERR / DH-MAIN forced 不算本轮问题
    const ls = log.split('\n');
    const bi = ls.map((l, i) => (l.includes('APP-START') ? i : -1)).reduce((a, b) => Math.max(a, b), -1);
    const boot = ls.slice(bi).join('\n');
    const forced = boot.includes('DH-MAIN forced');
    const crashed = boot.includes('DH-ERR') || boot.includes('RENDER-GONE');
    if (!forced && !crashed) pass('T2e 无强制显示/渲染错误');
    else fail('T2e 无强制显示/渲染错误', JSON.stringify({ forced, crashed }));
  } catch (e) { fail('T2 日志时序', e.message); }

  // ---- E1 空状态图标 ----
  const empty = await ev(`(() => {
    const el = document.querySelector('.empty-logo');
    if (!el) return null;
    const svg = el.querySelector('svg.dh-appicon');
    return { hasSvg: !!svg, txt: el.textContent.trim(), w: svg ? Math.round(svg.getBoundingClientRect().width) : 0 };
  })()`);
  if (empty && empty.hasSvg && empty.w >= 40 && !empty.txt.includes('⛵')) {
    pass(`E1 空状态使用软件图标原子 svg（${empty.w}px，无 ⛵ emoji）`);
  } else fail('E1 空状态图标', JSON.stringify(empty));

  // ---- S0 / S5 ----
  const ver = await ev(`document.querySelector('.statusbar').textContent`);
  if (/v0927.52/.test(String(ver))) pass('S0 状态栏 v0927.52'); else fail('S0 状态栏 v0927.52', String(ver).slice(0, 100));
  await sleep(600);
  if (!errors.length) pass('S5 无控制台错误'); else fail('S5 无控制台错误', errors.slice(0, 3).join(' | '));

  await client.close();
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
