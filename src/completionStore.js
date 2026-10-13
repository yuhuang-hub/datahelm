// 补全配置（v0927.44）：内置片段清单 + localStorage 持久化 + window 事件广播。
// SqlEditor 各实例自行订阅（弹层打开时经 ref 读最新值，不重建 CodeMirror 扩展 → 撤销历史不受影响）。
// 片段模板用 CodeMirror 片段语法：占位符 序号{:名称}，展开后 Tab 逐个跳转。

// 占位符串用拼接生成（ph(1,'列1') → "$" + "{" + "1:列1}"），源码里不出现模板串字面量
const ph = (n, name) => '$' + '{' + n + (name ? ':' + name : '') + '}';

// 内置片段（与此前硬编码在 SqlEditor 里的 7 个一致；builtin 由「label+模板均与默认一致」判定）
export const DEFAULT_SNIPPETS = [
  { label: 'sel', detail: '片段·SELECT 骨架', template: 'SELECT\n  ' + ph(1, '列1') + ', ' + ph(2, '列2') + '\nFROM ' + ph(3, '表名') + '\nWHERE ' + ph(4, '条件') },
  { label: 'ssf', detail: '片段·查全表', template: 'SELECT *\nFROM ' + ph(1, '表名') },
  { label: 'ins', detail: '片段·INSERT', template: 'INSERT INTO ' + ph(1, '表名') + ' (' + ph(2, '列') + ')\nVALUES (' + ph(3, '值') + ');' },
  { label: 'up', detail: '片段·UPDATE', template: 'UPDATE ' + ph(1, '表名') + '\nSET ' + ph(2, '列') + ' = ' + ph(3, '值') + '\nWHERE ' + ph(4, '条件') + ';' },
  { label: 'del', detail: '片段·DELETE', template: 'DELETE FROM ' + ph(1, '表名') + '\nWHERE ' + ph(2, '条件') + ';' },
  { label: 'ij', detail: '片段·内连接', template: 'INNER JOIN ' + ph(1, '表名') + ' ON ' + ph(2, '条件') },
  { label: 'lj', detail: '片段·左连接', template: 'LEFT JOIN ' + ph(1, '表名') + ' ON ' + ph(2, '条件') },
];

// 前缀合法性：字母开头，字母/数字/下划线，1-16 位
export const LABEL_RE = /^[A-Za-z][A-Za-z0-9_]{0,15}$/;

const KEY = 'dh_completion_v1';
const EVT = 'dh-completion-change';
const MAX_SNIPPETS = 50;
const MAX_TPL = 2000;

const isBuiltin = (label, template) => DEFAULT_SNIPPETS.some((d) => d.label === label && d.template === template);

const sanitizeSnippets = (arr) => {
  if (!Array.isArray(arr)) return null;
  const seen = new Set();
  const out = [];
  for (const it of arr) {
    if (!it || typeof it !== 'object') continue;
    const label = String(it.label || '').trim();
    const template = String(it.template || '');
    if (!LABEL_RE.test(label) || !template.trim() || template.length > MAX_TPL) continue;
    if (seen.has(label)) continue;
    seen.add(label);
    out.push({ label, template, detail: String(it.detail || '').slice(0, 40), builtin: isBuiltin(label, template) });
  }
  return out.slice(0, MAX_SNIPPETS);
};

export const defaultCfg = () => ({ snippets: DEFAULT_SNIPPETS.map((s) => ({ ...s, builtin: true })), keywordsOn: true, snippetsOn: true });

export function loadCfg() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (!raw || typeof raw !== 'object') return defaultCfg();
    const snippets = sanitizeSnippets(raw.snippets);
    if (!snippets) return defaultCfg();
    return { snippets, keywordsOn: raw.keywordsOn !== false, snippetsOn: raw.snippetsOn !== false };
  } catch {
    return defaultCfg();
  }
}

// 写入持久化 + 广播（detail 携带清洗后的配置，订阅方无需回读）
export function saveCfg(cfg) {
  // 开关归一：缺省为开，仅显式 false 为关
  const clean = {
    snippets: sanitizeSnippets(cfg && cfg.snippets) || [],
    keywordsOn: !(cfg && cfg.keywordsOn === false),
    snippetsOn: !(cfg && cfg.snippetsOn === false),
  };
  try { localStorage.setItem(KEY, JSON.stringify(clean)); } catch {}
  try { window.dispatchEvent(new CustomEvent(EVT, { detail: clean })); } catch {}
  return clean;
}

export function resetCfg() {
  return saveCfg(defaultCfg());
}

export function subscribe(fn) {
  const h = (e) => { try { fn((e && e.detail) || loadCfg()); } catch {} };
  window.addEventListener(EVT, h);
  return () => window.removeEventListener(EVT, h);
}
