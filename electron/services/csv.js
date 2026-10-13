'use strict';
const fs = require('fs');

// 简明 CSV 解析：支持引号/转义（""）/CRLF/BOM，自动嗅探分隔符（, ; \t）
function parseCsv(text) {
  text = String(text || '').replace(/^\ufeff/, '');
  const head = text.slice(0, 5000);
  const counts = [
    [',', (head.match(/,/g) || []).length],
    [';', (head.match(/;/g) || []).length],
    ['\t', (head.match(/\t/g) || []).length],
  ].sort((a, b) => b[1] - a[1]);
  const delim = counts[0][1] > 0 ? counts[0][0] : ',';

  const rows = [];
  let row = [];
  let cur = '';
  let inQ = false;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { cur += '"'; i += 2; }
        else { inQ = false; i++; }
      } else { cur += c; i++; }
    } else if (c === '"') { inQ = true; i++; }
    else if (c === delim) { row.push(cur); cur = ''; i++; }
    else if (c === '\r' || c === '\n') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cur); cur = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
      i++;
    } else { cur += c; i++; }
  }
  row.push(cur);
  if (row.length > 1 || row[0] !== '') rows.push(row);
  const header = (rows.shift() || []).map((h) => String(h).trim());
  return { header, rows };
}

// JSON 表格化：顶层数组（对象数组取键并集；二维数组用 列1..N）；嵌套对象/数组值 JSON.stringify，null 保留
function jsonCell(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'object') return JSON.stringify(v);
  return v;
}
function parseJsonTable(text) {
  const data = JSON.parse(text);
  if (!Array.isArray(data) || !data.length) throw new Error('JSON 需为非空数组（对象数组或二维数组）');
  if (data.every((r) => Array.isArray(r))) {
    const n = Math.max(...data.map((r) => r.length));
    const header = Array.from({ length: n }, (_, i) => '列' + (i + 1));
    return { header, rows: data.map((r) => header.map((_, i) => jsonCell(r[i]))) };
  }
  if (data.every((r) => r && typeof r === 'object' && !Array.isArray(r))) {
    const keys = [];
    for (const r of data) for (const k of Object.keys(r)) if (!keys.includes(k)) keys.push(k);
    return { header: keys, rows: data.map((r) => keys.map((k) => jsonCell(r[k]))) };
  }
  throw new Error('JSON 数组元素需统一为对象或数组');
}

// 导入向导：按扩展名解析文件（.json → JSON，其余按 CSV 嗅探分隔符）
function parseImportFile(file) {
  const p = String(file || '');
  const text = fs.readFileSync(p, 'utf8').replace(/^\ufeff/, '');
  if (/\.json$/i.test(p)) {
    const { header, rows } = parseJsonTable(text);
    return { format: 'json', header, rows };
  }
  const { header, rows } = parseCsv(text);
  return { format: 'csv', header, rows };
}

module.exports = { parseCsv, parseImportFile };
