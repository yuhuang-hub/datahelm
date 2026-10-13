import { fmt } from './format';

// 统一导出格式化：columns = 列名数组；rows = 行数组（每行与列对齐的值数组）
export const FORMATS = [
  { v: 'csv', l: 'CSV', ext: 'csv' },
  { v: 'json', l: 'JSON', ext: 'json' },
  { v: 'sql', l: 'SQL INSERT', ext: 'sql' },
  { v: 'md', l: 'Markdown', ext: 'md' },
  { v: 'html', l: 'HTML', ext: 'html' },
];

const csvEsc = (s) => (/[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s);

export function buildCsv(columns, rows) {
  const head = columns.map((n) => csvEsc(String(n))).join(',');
  const lines = rows.map((r) => columns.map((_, i) => csvEsc(fmt(r[i]))).join(','));
  return '\ufeff' + [head, ...lines].join('\r\n');
}

// JSON 保留原生类型（null/数字/布尔/Date→ISO 字符串），便于程序再消费
export function buildJson(columns, rows) {
  const fix = (v) => {
    if (v === undefined) return null;
    if (v instanceof Date) return v.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
    if (v instanceof Uint8Array) return fmt(v);
    if (v && typeof v === 'object') return v; // 对象/数组原样（Mongo 文档等）
    return v;
  };
  return JSON.stringify(rows.map((r) => Object.fromEntries(columns.map((n, i) => [n, fix(r[i])]))), null, 2);
}

// SQL 字面量：NULL / 数字布尔裸值 / 二进制 0x… / 其余字符串转义（'' 翻倍）
function sqlLit(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (v instanceof Date) return `'${v.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '')}'`;
  if (v instanceof Uint8Array) return '0x' + Array.from(v).map((b) => b.toString(16).padStart(2, '0')).join('');
  return `'${String(v).replace(/'/g, "''")}'`;
}

// 批量多值 INSERT（每 500 行一条语句，兼容大结果集）
export function buildInserts(columns, rows, table) {
  const t = table && table.trim() ? table.trim() : 'TABLE1';
  if (!rows.length) return `-- 「${t}」无数据`;
  const lit = (r) => `(${columns.map((_, i) => sqlLit(r[i])).join(', ')})`;
  const out = [];
  for (let i = 0; i < rows.length; i += 500) {
    out.push(`INSERT INTO ${t} (${columns.join(', ')}) VALUES\n${rows.slice(i, i + 500).map(lit).join(',\n')};`);
  }
  return out.join('\n\n');
}

export function buildMarkdown(columns, rows) {
  const esc = (v) => fmt(v).replace(/\|/g, '\\|').replace(/\n/g, '<br>');
  const head = `| ${columns.map(String).join(' | ')} |`;
  const sep = `| ${columns.map(() => '---').join(' | ')} |`;
  const body = rows.map((r) => `| ${columns.map((_, i) => esc(r[i])).join(' | ')} |`);
  return [head, sep, ...body].join('\n');
}

const hesc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function buildHtml(columns, rows, title) {
  const th = columns.map((n) => `<th>${hesc(n)}</th>`).join('');
  const trs = rows
    .map((r) => `<tr>${columns.map((_, i) => (r[i] === null || r[i] === undefined ? `<td class="null">NULL</td>` : `<td>${hesc(fmt(r[i]))}</td>`)).join('')}</tr>`)
    .join('\n');
  return [
    '<!DOCTYPE html>',
    '<html><head><meta charset="utf-8">',
    `<title>${hesc(title || 'DataHelm 导出')}</title>`,
    '<style>body{font:13px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;margin:24px;color:#333}',
    'table{border-collapse:collapse}th,td{border:1px solid #d9d9d9;padding:4px 10px;text-align:left;white-space:nowrap}',
    'th{background:#f5f5f5}tr:nth-child(even){background:#fafafa}.null{color:#bbb}p{color:#999}</style></head><body>',
    `<h3>${hesc(title || '导出数据')}</h3>`,
    `<p>${columns.length} 列 · ${rows.length} 行 · DataHelm 导出</p>`,
    `<table><tr>${th}</tr>\n${trs}\n</table></body></html>`,
  ].join('\n');
}

export function buildExport(v, columns, rows, table, title) {
  switch (v) {
    case 'json':
      return buildJson(columns, rows);
    case 'sql':
      return buildInserts(columns, rows, table);
    case 'md':
      return buildMarkdown(columns, rows);
    case 'html':
      return buildHtml(columns, rows, title);
    default:
      return buildCsv(columns, rows);
  }
}
