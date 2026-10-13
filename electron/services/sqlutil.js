'use strict';
// SQL 文本/标识符/字面量工具，四种方言共用

// ---- 语句切分：忽略引号、注释、$$ 内的分号；兼容 T-SQL 的 GO、MySQL 的 DELIMITER ----
const DELIM_RE = /^[ \t]*DELIMITER[ \t]+(\S+)[ \t]*$/im;
function splitStatements(input) {
  input = String(input || '').replace(/^[ \t]*GO[ \t]*$/gim, ';');
  const out = [];
  let cur = '';
  const s = input;
  const n = s.length;
  let i = 0;
  let state = 0; // 0=普通, 'line'|'block'|'dollar'=注释, 其他=引号字符
  let delim = ';'; // 当前语句结束符（MySQL 客户端 DELIMITER 指令可修改）
  let beginDepth = 0; // CREATE TRIGGER/PROCEDURE 等体内的 BEGIN…END 嵌套深度（体内分号不切分）
  let atLineStart = true;
  const push = () => {
    const t = cur.trim();
    if (t) out.push(t);
    cur = '';
  };
  while (i < n) {
    const c = s[i];
    if (state === 0) {
      // DELIMITER 指令必须真正位于行首（match.index===0，防止多行 ^ 越过行首导致 i 不前进）
      let dm = null;
      if (atLineStart) {
        const m = s.slice(i, i + 200).match(DELIM_RE);
        dm = m && m.index === 0 ? m : null;
      }
      if (dm) {
        delim = dm[1];
        const nl = s.indexOf('\n', i);
        i = nl === -1 ? n : nl;
        atLineStart = true;
        continue;
      }
      atLineStart = c === '\n' || (atLineStart && (c === ' ' || c === '\t' || c === '\r'));
      // BEGIN/CASE/END 关键字深度：仅 CREATE 语句里的块生效；CASE…END 在块内配平，避免把体内 CASE 的 END 误当块结束
      if (/[A-Za-z]/.test(c) && (i === 0 || !/[\w$]/.test(s[i - 1]))) {
        const m = s.slice(i, i + 8).match(/^(BEGIN|CASE|END)\b/i);
        if (m) {
          const kw = m[1].toUpperCase();
          if (kw === 'BEGIN' && /^\s*CREATE\b/i.test(cur)) beginDepth += 1;
          else if (kw === 'CASE' && beginDepth > 0) beginDepth += 1;
          else if (kw === 'END' && beginDepth > 0) beginDepth -= 1;
        }
      }
      if (c === "'" || c === '"' || c === '`') { state = c; cur += c; i++; }
      else if (c === '-' && s[i + 1] === '-') { state = 'line'; cur += '--'; i += 2; }
      else if (c === '/' && s[i + 1] === '*') { state = 'block'; cur += '/*'; i += 2; }
      else if (c === '$' && s.slice(i, i + 2) === '$$') { state = 'dollar'; cur += '$$'; i += 2; }
      else if (delim !== ';' ? s.startsWith(delim, i) : c === ';') {
        if (beginDepth === 0) push();
        else cur += s.substr(i, delim.length); // 体内分号保留，不切分
        i += delim.length;
      }
      else { cur += c; i++; }
    } else if (state === 'line') {
      if (c === '\n') state = 0;
      cur += c; i++;
    } else if (state === 'block') {
      if (c === '*' && s[i + 1] === '/') { state = 0; cur += '*/'; i += 2; }
      else { cur += c; i++; }
    } else if (state === 'dollar') {
      if (s.slice(i, i + 2) === '$$') { state = 0; cur += '$$'; i += 2; }
      else { cur += c; i++; }
    } else {
      // 引号内
      if (c === '\\') { cur += s.slice(i, i + 2); i += 2; }
      else if (c === state) {
        if (s[i + 1] === state) { cur += c + c; i += 2; }
        else { cur += c; state = 0; i++; }
      } else { cur += c; i++; }
    }
  }
  push();
  return out;
}

// ---- 标识符 ----
function q(d, name) {
  name = String(name);
  if (d === 'mysql') return '`' + name.replace(/`/g, '``') + '`';
  return '"' + name.replace(/"/g, '""') + '"';
}

function qualify(d, db, schema, table) {
  const parts = [];
  if (db) parts.push(q(d, db));
  if (schema) parts.push(q(d, schema));
  else if (db && d === 'mssql') parts.push(''); // mssql 两段 [db].[表] 会被解析成 schema.表（v0927.52：空 schema 用默认架构形式 [db]..[表]）
  parts.push(q(d, table));
  return parts.join('.');
}

// ---- 字面量 ----
function lit(d, v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  if (typeof v === 'bigint') return String(v);
  if (typeof v === 'boolean') {
    if (d === 'mssql' || d === 'oracle') return v ? '1' : '0';
    return v ? 'TRUE' : 'FALSE';
  }
  if (v instanceof Uint8Array) {
    const hex = Buffer.from(v).toString('hex');
    if (d === 'mysql') return "X'" + hex + "'";
    if (d === 'mssql') return '0x' + hex;
    return "'" + hex + "'";
  }
  let s = v instanceof Date ? v.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '') : String(v);
  if (d === 'mysql') s = s.replace(/\\/g, '\\\\').replace(/'/g, "''");
  else s = s.replace(/'/g, "''");
  return (d === 'mssql' ? 'N' : '') + "'" + s + "'";
}

// ---- 类型 ----
const TYPE_ALIAS = {
  'CHARACTER VARYING': 'VARCHAR',
  'CHARACTER': 'CHAR',
  'TIMESTAMP WITHOUT TIME ZONE': 'TIMESTAMP',
  'TIME WITHOUT TIME ZONE': 'TIME',
  'DOUBLE PRECISION': 'DOUBLE',
  'BOOL': 'BOOLEAN',
  'INT': 'INTEGER',
  'INT8': 'BIGINT',
};

function fullType(c, d) {
  let t = String(c.dataType || 'VARCHAR').trim().toUpperCase();
  t = TYPE_ALIAS[t] || t;
  if (d === 'oracle') {
    const OM = {
      VARCHAR: 'VARCHAR2', TEXT: 'CLOB', TINYINT: 'NUMBER(3)', SMALLINT: 'NUMBER(5)',
      INTEGER: 'NUMBER(10)', BIGINT: 'NUMBER(19)', BOOLEAN: 'NUMBER(1)', DATETIME: 'TIMESTAMP',
      DOUBLE: 'BINARY_DOUBLE', FLOAT: 'BINARY_DOUBLE',
    };
    if (OM[t]) t = OM[t];
  }
  const withLen = ['CHAR', 'VARCHAR', 'VARCHAR2', 'NVARCHAR', 'NCHAR', 'BINARY', 'VARBINARY'];
  const hasLen = c.length !== '' && c.length !== null && c.length !== undefined;
  const hasScale = c.scale !== '' && c.scale !== null && c.scale !== undefined;
  if (hasLen && withLen.includes(t)) return `${t}(${c.length})`;
  if (hasLen && (t === 'DECIMAL' || t === 'NUMERIC' || t === 'NUMBER')) return `${t}(${c.length}${hasScale ? ',' + c.scale : ''})`;
  return t;
}

// 列定义（建表/加列/改列共用）。设计器列结构:
// { name, dataType, length, scale, nullable, pk, autoInc, defaultValue(原始SQL表达式), comment, origName }
function columnDef(d, c, opts = {}) {
  if (d === 'sqlite' && c.autoInc) {
    const pkInline = opts.create && c.pk;
    return [q(d, c.name), 'INTEGER', pkInline ? 'PRIMARY KEY' : '', c.nullable ? '' : 'NOT NULL', 'AUTOINCREMENT']
      .filter(Boolean).join(' ');
  }
  let t = fullType(c, d);
  if (d === 'pg' && opts.create && c.autoInc) t = t === 'BIGINT' ? 'BIGSERIAL' : 'SERIAL';
  let s = `${q(d, c.name)} ${t}`;
  s += c.nullable ? ' NULL' : ' NOT NULL';
  const dv = c.defaultValue == null ? '' : String(c.defaultValue).trim();
  if (dv !== '') s += ` DEFAULT ${dv}`;
  if (d === 'mysql' && c.autoInc) s += ' AUTO_INCREMENT';
  if (d === 'mssql' && c.autoInc && opts.create) s += ' IDENTITY(1,1)';
  if (d === 'mysql' && c.comment) s += ` COMMENT ${lit(d, c.comment)}`;
  return s;
}

function tableBodySql(d, cols, extras = {}) {
  const body = cols.map((c) => '  ' + columnDef(d, c, { create: true }));
  const pks = cols.filter((c) => c.pk).map((c) => c.name);
  const singleAuto = d === 'sqlite' && pks.length === 1 && cols.find((c) => c.name === pks[0]).autoInc;
  if (pks.length && !singleAuto) body.push(`  PRIMARY KEY (${pks.map((n) => q(d, n)).join(', ')})`);
  // 内联约束（SQLite 建表/重建表用）：外键与 CHECK
  for (const f of extras.fkeys || []) {
    if (!(f.columns || []).length || !f.refTable) continue;
    const cols2 = f.columns.map((n) => q(d, n)).join(', ');
    const rcols = (f.refColumns || []).map((n) => q(d, n)).join(', ');
    let s = `  ${f.name ? 'CONSTRAINT ' + q(d, f.name) + ' ' : ''}FOREIGN KEY (${cols2}) REFERENCES ${q(d, f.refTable)} (${rcols})`;
    if (f.onDelete && String(f.onDelete).toUpperCase() !== 'NO ACTION') s += ` ON DELETE ${String(f.onDelete).toUpperCase()}`;
    if (f.onUpdate && String(f.onUpdate).toUpperCase() !== 'NO ACTION') s += ` ON UPDATE ${String(f.onUpdate).toUpperCase()}`;
    body.push(s);
  }
  for (const c of extras.checks || []) {
    if (!c.expr) continue;
    body.push(`  ${c.name ? 'CONSTRAINT ' + q(d, c.name) + ' ' : ''}CHECK (${c.expr})`);
  }
  return body.join(',\n  ');
}

// ---- 数据传输：跨方言列类型映射 ----
// 先归一化为类型族，再按目标方言生成；未识别类型退化为文本族（任何方言都能承载）
const TY_FAM = {
  TINYINT: 'SINT', SMALLINT: 'SINT', SMALLSERIAL: 'SINT', YEAR: 'SINT', SHORT: 'SINT',
  MEDIUMINT: 'INT', INT: 'INT', INTEGER: 'INT', SERIAL: 'BIGINT', BIGSERIAL: 'BIGINT', BIGINT: 'BIGINT', LONG: 'BIGINT',
  BOOLEAN: 'BOOL', BOOL: 'BOOL', BIT: 'BOOL', LOGICAL: 'BOOL',
  DECIMAL: 'DEC', NUMERIC: 'DEC', MONEY: 'DEC', SMALLMONEY: 'DEC',
  FLOAT: 'FLT', REAL: 'FLT', DOUBLE: 'FLT', 'DOUBLE PRECISION': 'FLT',
  CHAR: 'CHAR', NCHAR: 'CHAR', CHARACTER: 'CHAR',
  VARCHAR: 'VCH', NVARCHAR: 'VCH', VARCHAR2: 'VCH', NVARCHAR2: 'VCH', STRING: 'VCH',
  TEXT: 'TEXT', CLOB: 'TEXT', NTEXT: 'TEXT', TINYTEXT: 'TEXT', MEDIUMTEXT: 'TEXT', LONGTEXT: 'TEXT', MEMO: 'TEXT',
  BINARY: 'BIN', VARBINARY: 'BIN', IMAGE: 'BIN', BLOB: 'BIN', LONGBLOB: 'BIN', MEDIUMBLOB: 'BIN', TINYBLOB: 'BIN', RAW: 'BIN', 'LONG RAW': 'BIN', GENERAL: 'BIN', OBJECT: 'BIN',
  DATE: 'DATE', TIME: 'TIME', DATETIME: 'DT', DATETIME2: 'DT', SMALLDATETIME: 'DT', TIMESTAMP: 'DT',
  JSON: 'JSON', JSONB: 'JSON',
  UNIQUEIDENTIFIER: 'UUID', GUID: 'UUID', UUID: 'UUID',
};

// sd/dd：源/目标方言（mysql|mariadb|postgres|sqlite|mssql|oracle）；col：驱动 columns() 的列元数据
// 返回 { dataType, length, scale }，length/scale 为 null 表示不适用
function mapType(sd, col, dd) {
  const raw = String(col.dataType || '').toUpperCase().trim();
  let fam = TY_FAM[raw] || 'TEXT';
  // SQLite INTEGER 即 64 位（rowid），跨方言按 BIGINT 对待避免溢出
  if (sd === 'sqlite' && raw === 'INTEGER') fam = 'BIGINT';
  const len = col.length == null ? 0 : Math.floor(Number(col.length) || 0); // mssql MAX/-1 → 0（无界）
  const sc = col.scale == null ? -1 : Math.floor(Number(col.scale) || 0);
  const out = (dataType, length = null, scale = null) => ({ dataType, length, scale });
  if (fam === 'SINT' || fam === 'INT' || fam === 'BIGINT' || fam === 'BOOL') {
    if (fam === 'BOOL') {
      if (dd === 'mysql' || dd === 'mariadb') return out('TINYINT', 1);
      if (dd === 'mssql') return out('BIT');
      if (dd === 'oracle') return out('NUMBER', 1, 0);
      return out('INTEGER'); // pg BOOLEAN 更准，但整数族保证数据兼容
    }
    const intTy = fam === 'SINT' ? 'SMALLINT' : fam === 'BIGINT' ? 'BIGINT' : 'INT';
    if (dd === 'sqlite') return out(fam === 'BIGINT' ? 'BIGINT' : 'INTEGER');
    if (dd === 'oracle') return out('NUMBER', fam === 'BIGINT' ? 19 : fam === 'SINT' ? 5 : 10, 0);
    if (dd === 'postgres') return out(fam === 'BIGINT' ? 'BIGINT' : fam === 'SINT' ? 'SMALLINT' : 'INTEGER');
    return out(intTy);
  }
  if (fam === 'DEC') {
    const p = Math.max(1, Math.min(len || 18, dd === 'mysql' || dd === 'mariadb' ? 65 : dd === 'oracle' ? 38 : dd === 'mssql' ? 38 : 1000));
    return out(dd === 'sqlite' ? 'NUMERIC' : dd === 'oracle' ? 'NUMBER' : 'DECIMAL', p, sc >= 0 ? Math.min(sc, p) : 0);
  }
  if (fam === 'FLT') {
    if (dd === 'postgres') return out('DOUBLE PRECISION');
    if (dd === 'oracle') return out('BINARY_DOUBLE');
    if (dd === 'mssql') return out('FLOAT'); // T-SQL 无 DOUBLE；FLOAT=float(53)
    if (dd === 'sqlite') return out('REAL');
    return out('DOUBLE');
  }
  if (fam === 'CHAR') return out('CHAR', Math.max(1, Math.min(len || 1, 8000)), null);
  if (fam === 'VCH') {
    if (dd === 'sqlite') return out('TEXT');
    if (dd === 'mssql') return len && len <= 4000 ? out('NVARCHAR', len) : out('NVARCHAR', 'MAX');
    if (dd === 'postgres') return len ? out('VARCHAR', Math.min(len, 10485760)) : out('TEXT');
    if (dd === 'oracle') return len ? out('VARCHAR2', Math.min(len, 4000)) : out('CLOB');
    return out('VARCHAR', len ? Math.min(len, 16000) : 255);
  }
  if (fam === 'TEXT') {
    if (dd === 'mysql' || dd === 'mariadb') return out('LONGTEXT');
    if (dd === 'mssql') return out('NVARCHAR', 'MAX');
    if (dd === 'oracle') return out('CLOB');
    return out('TEXT');
  }
  if (fam === 'BIN') {
    if (dd === 'postgres') return out('BYTEA');
    if (dd === 'mysql' || dd === 'mariadb') return out('LONGBLOB');
    if (dd === 'sqlite') return out('BLOB');
    return out('VARBINARY', 'MAX'); // mssql / oracle RAW 兜不住大对象
  }
  if (fam === 'DATE') return out('DATE');
  if (fam === 'TIME') return out(dd === 'oracle' ? 'TIMESTAMP' : 'TIME');
  if (fam === 'DT') {
    if (dd === 'sqlite') return out('TEXT');
    if (dd === 'mssql') return out('DATETIME2');
    if (dd === 'mysql' || dd === 'mariadb') return out('DATETIME');
    return out('TIMESTAMP'); // pg / oracle
  }
  if (fam === 'JSON') {
    if (dd === 'mysql' || dd === 'mariadb') return out('JSON');
    if (dd === 'postgres') return out('JSONB');
    if (dd === 'sqlite') return out('TEXT');
    return out('NVARCHAR', 'MAX'); // mssql / oracle（2024 前无原生 JSON 列）
  }
  if (fam === 'UUID') {
    if (dd === 'postgres') return out('UUID');
    if (dd === 'mssql') return out('UNIQUEIDENTIFIER');
    if (dd === 'sqlite') return out('TEXT');
    if (dd === 'mysql' || dd === 'mariadb') return out('CHAR', 36);
    return out('VARCHAR2', 36);
  }
  return out(dd === 'oracle' ? 'CLOB' : 'TEXT');
}

// 传输用的默认值白名单：仅放行跨方言安全的字面量，其余（如 mssql 的 ((0))、函数调用）丢弃
const DEF_OK = /^(NULL|CURRENT_TIMESTAMP(\(\))?|[+-]?\d+(\.\d+)?|'[^']*')$/i;
function transferDefault(v) {
  const s = String(v == null ? '' : v).trim();
  return DEF_OK.test(s) ? s : '';
}

function createTableSql(d, spec) {
  const extras = d === 'sqlite' ? { fkeys: spec.fkeysAfter || [], checks: spec.checksAfter || [] } : {};
  let s = `CREATE TABLE ${qualify(d, d === 'mysql' ? spec.db : null, spec.schema, spec.name)} (\n${tableBodySql(d, spec.cols, extras)}\n)`;
  if (d === 'mysql') {
    s += ' ENGINE=InnoDB DEFAULT CHARSET=utf8mb4';
    if (spec.comment) s += ` COMMENT=${lit(d, spec.comment)}`;
  }
  return s + ';';
}

// colMeta（驱动返回）-> 设计器列
function normCol(m) {
  return {
    name: m.name,
    dataType: (m.dataType || 'VARCHAR').toUpperCase(),
    length: m.length == null ? '' : m.length,
    scale: m.scale == null ? '' : m.scale,
    nullable: !!m.nullable,
    pk: !!m.pk,
    autoInc: !!m.autoInc,
    defaultValue: m.defaultValue == null ? '' : String(m.defaultValue),
    comment: m.comment || '',
    origName: m.name,
  };
}

// 设计器拖拽排序：幸存列（新增/删除以外）的先后顺序是否发生变化
function orderChanged(spec) {
  const before = (spec.before || []).map((c) => c.name);
  const bset = new Set(before);
  const afterSeq = (spec.after || []).map((c) => c.origName || c.name).filter((n) => bset.has(n));
  const aset = new Set(afterSeq);
  const beforeSeq = before.filter((n) => aset.has(n));
  return afterSeq.join('\u0001') !== beforeSeq.join('\u0001');
}

// ---- 数据变更 SQL（数据网格保存）----
// 值一律参数化绑定：mysql/sqlite 用 ?，pg 用 $n，mssql 用 @pN（NVarChar）
function phOf(d, i) {
  if (d === 'pg') return '$' + (i + 1);
  if (d === 'mssql') return '@p' + i;
  if (d === 'oracle') return ':' + (i + 1);
  return '?';
}

function normParam(d, v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
  if (v instanceof Uint8Array) return Buffer.from(v);
  if (d === 'mssql') return String(v); // tedious 统一 NVarChar，由服务器隐式转换
  return v;
}

function insertOne(d, full, entries) {
  return {
    sql: `INSERT INTO ${full} (${entries.map(([c]) => q(d, c)).join(', ')}) VALUES (${entries.map((_, i) => phOf(d, i)).join(', ')})`,
    params: entries.map(([, v]) => normParam(d, v)),
  };
}

function buildChangeSql(d, db, schema, table, spec) {
  const full = qualify(d, db, schema, table);
  const out = [];
  const whereParts = (row) => {
    const pkNames = spec.columns.filter((c) => c.pk).map((c) => c.name);
    const cols = pkNames.length ? pkNames : spec.columns.map((c) => c.name);
    return { cols, params: cols.map((c) => normParam(d, row[c])) };
  };
  for (const del of spec.deletes || []) {
    const w = whereParts(del.row);
    out.push({
      sql: `DELETE FROM ${full} WHERE ${w.cols.map((c, i) => `${q(d, c)}=${phOf(d, i)}`).join(' AND ')}`,
      params: w.params,
    });
  }
  for (const u of spec.updates || []) {
    const setEntries = Object.entries(u.set);
    if (!setEntries.length) continue;
    const w = whereParts(u.row);
    let pi = 0;
    const setSql = setEntries.map(([c]) => `${q(d, c)}=${phOf(d, pi++)}`).join(', ');
    const params = setEntries.map(([, v]) => normParam(d, v));
    const wSql = w.cols.map((c) => `${q(d, c)}=${phOf(d, pi++)}`).join(' AND ');
    out.push({ sql: `UPDATE ${full} SET ${setSql} WHERE ${wSql}`, params: params.concat(w.params) });
  }
  for (const ins of spec.inserts || []) {
    const entries = Object.entries(ins);
    if (entries.length) out.push(insertOne(d, full, entries));
  }
  return out;
}

// ---- 索引 / 外键 / 唯一键 / 检查约束：规范化与差异 ----
// 索引键分两类：普通标识符=列名（按方言转义）；其余=表达式键原样输出（mysql 函数键部分需括号包裹）
function isPlainIdxKey(c) {
  return /^[A-Za-z_\u0080-\uFFFF][A-Za-z0-9_$\u0080-\uFFFF]*$/.test(String(c).trim());
}
// 索引列 SQL：dirs 与 columns 平行数组（''=升序/默认，'DESC'=降序）
function idxColsSql(d, x) {
  return (x.columns || [])
    .map((c, i) => {
      const s = String(c).trim();
      const part = isPlainIdxKey(s) ? q(d, s) : d === 'mysql' ? `(${s})` : s;
      return part + (String((x.dirs || [])[i] || '').toUpperCase() === 'DESC' ? ' DESC' : '');
    })
    .join(', ');
}
// 内省用：CREATE INDEX 定义的键列表切分——顶层逗号（括号/引号/[]/`` 深度感知），剥离收尾 ASC/DESC，
// 纯引号包裹的单个标识符去引号还原为列名；表达式键保留方言规范化后的原文（原样重写即为合法 SQL）
function parseIndexParts(s) {
  const parts = [];
  let cur = '';
  let qt = '';
  let depth = 0;
  const push = () => {
    const t = cur.trim();
    if (t) parts.push(t);
    cur = '';
  };
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (qt) {
      cur += ch;
      if (ch === qt) {
        if (qt !== ']' && s[i + 1] === qt) {
          cur += s[i + 1];
          i += 1;
        } else qt = '';
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      qt = ch;
      cur += ch;
      continue;
    }
    if (ch === '[') {
      qt = ']';
      cur += ch;
      continue;
    }
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      push();
      continue;
    }
    cur += ch;
  }
  push();
  return parts.map((p) => {
    let k = p;
    let dir = '';
    const m = k.match(/^([\s\S]*?)\s+(ASC|DESC)$/i);
    if (m) {
      // 收尾 ASC/DESC 必须在括号深度 0（`(a - b) DESC` 可，表达式内部括号未闭合则不算）
      let dd = 0;
      let ok = true;
      for (const ch of m[1]) {
        if (ch === '(') dd += 1;
        else if (ch === ')') dd -= 1;
        if (dd < 0) {
          ok = false;
          break;
        }
      }
      if (ok && dd === 0) {
        k = m[1];
        dir = m[2].toUpperCase() === 'DESC' ? 'DESC' : '';
      }
    }
    k = k.trim();
    const qi = k.match(/^"((?:[^"]|"")+)"$/);
    const qb = k.match(/^\[((?:[^\]]|\]\])+)\]$/);
    if (qi) k = qi[1].replace(/""/g, '"');
    else if (qb) k = qb[1].replace(/\]\]/g, ']');
    return { k, dir };
  });
}
// pg_get_indexdef / sqlite_master 的 CREATE INDEX 定义解析：键列表 + 尾部 WHERE（保留方言规范化原文，
// 未改动时 before/after canon 一致——不产生假差异；用户改动后原样重写同样合法）
function indexDefKeys(def) {
  const openAt = (txt, from) => txt.indexOf('(', from);
  const open = openAt(String(def || ''), 0);
  if (open < 0) return { parts: [], where: '' };
  let depth = 0;
  let qt = '';
  let close = -1;
  for (let i = open; i < def.length; i += 1) {
    const ch = def[i];
    if (qt) {
      if (ch === qt) {
        if (def[i + 1] === qt) i += 1;
        else qt = '';
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      qt = ch;
      continue;
    }
    if (ch === '[') {
      qt = ']';
      continue;
    }
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close < 0) return { parts: [], where: '' };
  const keys = def.slice(open + 1, close);
  const tail = def.slice(close + 1).trim();
  const wm = tail.match(/^WHERE\s+([\s\S]+)$/i);
  return { parts: parseIndexParts(keys), where: wm ? wm[1].trim() : '' };
}
// 注释不进 canon：pg/mssql 注释单独走 COMMENT/扩展属性；mysql 索引注释只能重建，由 cmtOnly 补偿
// 列键与表达式键分别记 C:/E: 前缀；where 归一空白后进 canon（mysql 无部分索引不比对）
function idxCanon(x, d) {
  const cols = (x.columns || [])
    .map((c, i) => {
      const s = String(c).trim().replace(/\s+/g, ' ');
      return (isPlainIdxKey(s) ? 'C:' : 'E:') + s + ':' + (String((x.dirs || [])[i] || '').toUpperCase() === 'DESC' ? 'D' : 'A');
    })
    .join(',');
  const parts = [String(x.name || '').trim(), cols, !!x.unique];
  if (d !== 'sqlite') parts.push(String(x.type || '').trim().toUpperCase());
  if (d !== 'mysql') parts.push(String(x.where || '').replace(/\s+/g, ' ').trim());
  return parts.join('|');
}
function uqCanon(x, d) {
  const parts = [String(x.name || '').trim(), (x.columns || []).map((c) => String(c).trim()).join(',')];
  if (d === 'mssql') parts.push(!!x.clustered);
  return parts.join('|');
}
function fkCanon(x, d) {
  const parts = [
    String(x.name || '').trim(),
    (x.columns || []).map((c) => String(c).trim()).join(','),
    String(x.refSchema || '').trim(),
    String(x.refTable || '').trim(),
    (x.refColumns || []).map((c) => String(c).trim()).join(','),
    String(x.onDelete || '').toUpperCase(),
    String(x.onUpdate || '').toUpperCase(),
  ];
  if (d === 'mssql') parts.push(!!x.notForReplication); // 启用状态可在线 CHECK/NCHECK 切换，不进 canon
  return parts.join('|');
}
function ckCanon(x, d) {
  const parts = [String(x.name || '').trim(), String(x.expr || '').replace(/\s+/g, ' ').trim()];
  if (d === 'mssql') parts.push(!!x.notForReplication); // 启用状态可在线 CHECK/NCHECK 切换，不进 canon
  return parts.join('|');
}

// 按 name 对齐的差异：drop=需删除（含定义变更的旧项），add=需新建（含定义变更的新项）
function listDiff(before, after, canon) {
  const bmap = new Map((before || []).filter((x) => x && String(x.name || '').trim()).map((x) => [String(x.name).trim(), x]));
  const amap = new Map((after || []).filter((x) => x && String(x.name || '').trim()).map((x) => [String(x.name).trim(), x]));
  const drop = [];
  const add = [];
  for (const [name, b] of bmap) {
    const a = amap.get(name);
    if (!a) drop.push(b);
    else if (canon(b) !== canon(a)) {
      drop.push(b);
      add.push(a);
    }
  }
  for (const [name, a] of amap) if (!bmap.has(name)) add.push(a);
  return { drop, add };
}

function byName(arr) {
  return new Map((arr || []).filter((x) => x && String(x.name || '').trim()).map((x) => [String(x.name).trim(), x]));
}
// 结构未变、仅注释变化的同名项
function cmtOnly(before, after, canon) {
  const bmap = byName(before);
  const out = [];
  for (const a of after || []) {
    const b = bmap.get(String(a.name || '').trim());
    if (b && canon(b) === canon(a) && String(b.comment || '') !== String(a.comment || '')) out.push(a);
  }
  return out;
}
// 外键启用状态在线切换项（结构未变；仅 mssql 使用）
function enabledToggles(before, after, canon) {
  const bmap = byName(before);
  const out = [];
  for (const a of after || []) {
    const b = bmap.get(String(a.name || '').trim());
    if (b && canon(b) === canon(a) && (b.enabled === false) !== (a.enabled === false)) out.push(a);
  }
  return out;
}

function fkBody(d, x, refFq) {
  const cols = (x.columns || []).map((c) => q(d, c)).join(', ');
  const rcols = (x.refColumns || []).map((c) => q(d, c)).join(', ');
  let s = `FOREIGN KEY (${cols}) REFERENCES ${refFq} (${rcols})`;
  const od = String(x.onDelete || '').toUpperCase();
  const ou = String(x.onUpdate || '').toUpperCase();
  if (od && od !== 'NO ACTION') s += ` ON DELETE ${od}`;
  if (ou && ou !== 'NO ACTION') s += ` ON UPDATE ${ou}`;
  return s;
}

// 引用对象全名：refSchema 为空时沿用表所在的库/schema
function refQualify(d, spec, x) {
  const rs = String(x.refSchema || '').trim();
  if (d === 'mysql') return qualify(d, rs || spec.db, null, x.refTable);
  if (d === 'sqlite') return qualify(d, null, null, x.refTable);
  return qualify(d, null, rs || spec.schema, x.refTable);
}

// MySQL：ADD INDEX / ADD UNIQUE KEY（FULLTEXT/SPATIAL 无 USING、无 ASC/DESC）；MySQL 无部分索引，where 不生成
function mysqlIndexAdd(fq, it, unique) {
  const t = String(it.type || '').toUpperCase();
  const special = t === 'FULLTEXT' || t === 'SPATIAL';
  const cols = special ? (it.columns || []).map((c) => q('mysql', c)).join(', ') : idxColsSql('mysql', it);
  let s = `ALTER TABLE ${fq} ADD ${unique ? 'UNIQUE ' : ''}${special ? t + ' ' : ''}INDEX ${q('mysql', it.name)} (${cols})`;
  if (!special && (t === 'BTREE' || t === 'HASH')) s += ` USING ${t}`;
  if (it.comment) s += ` COMMENT ${lit('mysql', it.comment)}`;
  return s + ';';
}

// MSSQL：MS_Description 扩展属性 upsert（level2 为空 = 表本身；CONSTRAINT/INDEX 用 level2）
function mssqlProp(d, spec, level2type, level2name, value) {
  const sch = spec.schema || 'dbo';
  const tn = spec.newName || spec.table || '';
  const lv = [`@level0type = N'SCHEMA'`, `@level0name = ${lit(d, sch)}`, `@level1type = N'TABLE'`, `@level1name = ${lit(d, tn)}`];
  const fnArgs = [`N'SCHEMA'`, lit(d, sch), `N'TABLE'`, lit(d, tn)];
  if (level2type) {
    lv.push(`@level2type = N'${level2type}'`, `@level2name = ${lit(d, level2name)}`);
    fnArgs.push(`N'${level2type}'`, lit(d, level2name));
  }
  const args = lv.join(', ');
  const val = lit(d, value == null ? '' : String(value));
  return (
    `IF EXISTS (SELECT 1 FROM fn_listextendedproperty(N'MS_Description', ${fnArgs.join(', ')}))\n` +
    `  EXEC sp_updateextendedproperty @name = N'MS_Description', @value = ${val}, ${args};\n` +
    `ELSE\n` +
    `  EXEC sp_addextendedproperty @name = N'MS_Description', @value = ${val}, ${args};`
  );
}

function pgIndexCreate(d, spec, fq, it) {
  const am = String(it.type || '').toLowerCase() || 'btree';
  const schQ = (n) => qualify(d, null, spec.schema, n);
  const where = String(it.where || '').trim();
  const sqls = [`CREATE ${it.unique ? 'UNIQUE ' : ''}INDEX ${schQ(it.name)} ON ${fq} USING ${am} (${idxColsSql(d, it)})${where ? ' WHERE ' + where : ''};`];
  if (String(it.comment || '')) sqls.push(`COMMENT ON INDEX ${schQ(it.name)} IS ${lit(d, it.comment)};`);
  return sqls;
}

function mssqlIndexCreate(d, spec, fq, it) {
  const typ = String(it.type || '').toUpperCase() === 'CLUSTERED' ? 'CLUSTERED' : 'NONCLUSTERED';
  // mssql 索引键只能是列：表达式键（跨库同步传入）按位过滤；过滤后无键则跳过整个索引
  const pairs = (it.columns || []).map((c, i) => [String(c).trim(), i]).filter(([c]) => isPlainIdxKey(c));
  if (!pairs.length) return [];
  const keep = { ...it, columns: pairs.map(([c]) => c), dirs: pairs.map(([, i]) => (it.dirs || [])[i] || '') };
  const where = String(it.where || '').trim(); // 筛选索引（filtered index）
  const sqls = [`CREATE ${it.unique ? 'UNIQUE ' : ''}${typ} INDEX ${q(d, it.name)} ON ${fq} (${idxColsSql(d, keep)})${where ? ' WHERE ' + where : ''};`];
  if (String(it.comment || '')) sqls.push(mssqlProp(d, spec, 'INDEX', it.name, it.comment));
  return sqls;
}

// 外键 ADD（mssql：enabled=false 时 WITH NOCHECK ADD 后需再 NOCHECK——
// WITH NOCHECK 只是不校验存量行，约束本身仍是启用状态；禁用必须显式 NOCHECK CONSTRAINT）
function fkAddSql(d, spec, fq, it) {
  const refFq = refQualify(d, spec, it);
  if (d === 'mssql') {
    let s = `ALTER TABLE ${fq} ${it.enabled === false ? 'WITH NOCHECK' : 'WITH CHECK'} ADD CONSTRAINT ${q(d, it.name)} ${fkBody(d, it, refFq)}`;
    if (it.notForReplication) s += ' NOT FOR REPLICATION';
    s += ';';
    if (it.enabled === false) s += `\nALTER TABLE ${fq} NOCHECK CONSTRAINT ${q(d, it.name)};`;
    return s;
  }
  return `ALTER TABLE ${fq} ADD CONSTRAINT ${q(d, it.name)} ${fkBody(d, it, refFq)};`;
}

// 检查约束 ADD：与外键同规则——mssql 支持 NOT FOR REPLICATION 与禁用（WITH NOCHECK ADD 后需显式 NOCHECK）。
// 注意 CHECK 的 NOT FOR REPLICATION 必须在表达式括号前（CHECK NOT FOR REPLICATION (expr)），与外键写在子句尾不同
function ckAddSqls(d, spec, fq, it) {
  if (d === 'mssql') {
    let s = `ALTER TABLE ${fq} ${it.enabled === false ? 'WITH NOCHECK' : 'WITH CHECK'} ADD CONSTRAINT ${q(d, it.name)} CHECK ${it.notForReplication ? 'NOT FOR REPLICATION ' : ''}(${it.expr})`;
    s += ';';
    if (it.enabled === false) s += `\nALTER TABLE ${fq} NOCHECK CONSTRAINT ${q(d, it.name)};`;
    if (String(it.comment || '')) s += `\n${mssqlProp(d, spec, 'CONSTRAINT', it.name, it.comment)}`;
    return [s];
  }
  if (d === 'pg') {
    const sqls = [`ALTER TABLE ${fq} ADD CONSTRAINT ${q(d, it.name)} CHECK (${it.expr});`];
    if (String(it.comment || '')) sqls.push(`COMMENT ON CONSTRAINT ${q(d, it.name)} ON ${fq} IS ${lit(d, it.comment)};`);
    return sqls;
  }
  return [`ALTER TABLE ${fq} ADD CONSTRAINT ${q(d, it.name)} CHECK (${it.expr});`];
}

// 唯一键 ADD（mysql 走唯一索引；pg 约束；mssql 约束带 CLUSTERED/NONCLUSTERED；注释 pg/mssql 随建）
function uqAddSqls(d, spec, fq, it) {
  const colSql = (it.columns || []).map((c) => q(d, c)).join(', ');
  if (d === 'mysql') return [mysqlIndexAdd(fq, it, true)];
  if (d === 'pg') {
    const sqls = [`ALTER TABLE ${fq} ADD CONSTRAINT ${q(d, it.name)} UNIQUE (${colSql});`];
    if (String(it.comment || '')) sqls.push(`COMMENT ON CONSTRAINT ${q(d, it.name)} ON ${fq} IS ${lit(d, it.comment)};`);
    return sqls;
  }
  const sqls = [`ALTER TABLE ${fq} ADD CONSTRAINT ${q(d, it.name)} UNIQUE ${it.clustered ? 'CLUSTERED' : 'NONCLUSTERED'} (${colSql});`];
  if (String(it.comment || '')) sqls.push(mssqlProp(d, spec, 'CONSTRAINT', it.name, it.comment));
  return sqls;
}

// 新建表后追加的索引/约束/注释语句（mysql/pg/mssql；sqlite 走驱动内联+单独建索引）
function objectCreateSql(d, spec, fq) {
  const sqls = [];
  for (const it of spec.indexesAfter || []) {
    if (!String(it.name || '').trim() || !(it.columns || []).length) continue;
    if (d === 'mysql') sqls.push(mysqlIndexAdd(fq, it, !!it.unique));
    else if (d === 'pg') sqls.push(...pgIndexCreate(d, spec, fq, it));
    else if (d === 'mssql') sqls.push(...mssqlIndexCreate(d, spec, fq, it));
  }
  for (const it of spec.uniquesAfter || []) {
    if (!String(it.name || '').trim() || !(it.columns || []).length) continue;
    sqls.push(...uqAddSqls(d, spec, fq, it));
  }
  for (const it of spec.fkeysAfter || []) {
    if (!String(it.name || '').trim() || !(it.columns || []).length || !it.refTable) continue;
    sqls.push(fkAddSql(d, spec, fq, it));
    if (String(it.comment || '')) {
      if (d === 'pg') sqls.push(`COMMENT ON CONSTRAINT ${q(d, it.name)} ON ${fq} IS ${lit(d, it.comment)};`);
      else if (d === 'mssql') sqls.push(mssqlProp(d, spec, 'CONSTRAINT', it.name, it.comment));
    }
  }
  for (const it of spec.checksAfter || []) {
    if (!String(it.name || '').trim() || !String(it.expr || '').trim()) continue;
    sqls.push(...ckAddSqls(d, spec, fq, it));
  }
  if (d === 'pg' && spec.comment) sqls.push(`COMMENT ON TABLE ${fq} IS ${lit(d, spec.comment)};`);
  return sqls;
}

// 已有表的索引/约束/选项/注释差异 DDL（mysql/pg/mssql；sqlite 在驱动内处理重建）
function objectAlterSql(d, spec, fq) {
  const sqls = [];
  const iCanon = (x) => idxCanon(x, d);
  const uCanon = (x) => uqCanon(x, d);
  const fCanon = (x) => fkCanon(x, d);
  const cCanon = (x) => ckCanon(x, d);
  const iDiff = listDiff(spec.indexesBefore, spec.indexesAfter, iCanon);
  const uDiff = listDiff(spec.uniquesBefore, spec.uniquesAfter, uCanon);
  const fDiff = listDiff(spec.fkeysBefore, spec.fkeysAfter, fCanon);
  const cDiff = listDiff(spec.checksBefore, spec.checksAfter, ckCanon);
  const optB = (spec.infoBefore && spec.infoBefore.options) || {};
  const optA = spec.options || {};
  const cmtB = (spec.infoBefore && spec.infoBefore.comment) || '';
  const cmtA = String(spec.comment == null ? '' : spec.comment);
  const changedKeys = Object.keys(optA).filter((k) => String(optA[k] || '').trim() !== '' && String(optA[k]) !== String(optB[k] == null ? '' : optB[k]));

  if (d === 'mysql') {
    for (const it of iDiff.drop) sqls.push(`ALTER TABLE ${fq} DROP INDEX ${q(d, it.name)};`);
    for (const it of iDiff.add) sqls.push(mysqlIndexAdd(fq, it, !!it.unique));
    for (const it of uDiff.drop) sqls.push(`ALTER TABLE ${fq} DROP INDEX ${q(d, it.name)};`);
    for (const it of uDiff.add) sqls.push(mysqlIndexAdd(fq, it, true));
    // MySQL 无法在线改索引注释：结构未变仅注释变化时按 重建 处理
    for (const it of cmtOnly(spec.indexesBefore, spec.indexesAfter, iCanon)) {
      sqls.push(`ALTER TABLE ${fq} DROP INDEX ${q(d, it.name)};`);
      sqls.push(mysqlIndexAdd(fq, it, !!it.unique));
    }
    for (const it of cmtOnly(spec.uniquesBefore, spec.uniquesAfter, uCanon)) {
      sqls.push(`ALTER TABLE ${fq} DROP INDEX ${q(d, it.name)};`);
      sqls.push(mysqlIndexAdd(fq, it, true));
    }
    for (const it of fDiff.drop) sqls.push(`ALTER TABLE ${fq} DROP FOREIGN KEY ${q(d, it.name)};`);
    for (const it of fDiff.add) sqls.push(fkAddSql(d, spec, fq, it));
    for (const it of cDiff.drop) sqls.push(`ALTER TABLE ${fq} DROP CHECK ${q(d, it.name)};`);
    for (const it of cDiff.add) sqls.push(...ckAddSqls(d, spec, fq, it));
    if (changedKeys.length) {
      const pairs = changedKeys.map((k) => {
        const key = k === 'collation' ? 'COLLATE' : k === 'autoIncrement' ? 'AUTO_INCREMENT' : k === 'rowFormat' ? 'ROW_FORMAT' : k === 'keyBlockSize' ? 'KEY_BLOCK_SIZE' : k === 'engine' ? 'ENGINE' : k;
        return `${key}=${optA[k]}`;
      });
      sqls.push(`ALTER TABLE ${fq} ${pairs.join(', ')};`);
    }
    if (cmtA !== cmtB) sqls.push(`ALTER TABLE ${fq} COMMENT=${lit(d, cmtA)};`);
  } else if (d === 'pg') {
    const schQ = (n) => qualify(d, null, spec.schema, n); // 索引是 schema 级对象
    for (const it of iDiff.drop) sqls.push(`DROP INDEX ${schQ(it.name)};`);
    for (const it of iDiff.add) sqls.push(...pgIndexCreate(d, spec, fq, it));
    for (const it of cmtOnly(spec.indexesBefore, spec.indexesAfter, iCanon)) {
      sqls.push(`COMMENT ON INDEX ${schQ(it.name)} IS ${lit(d, it.comment == null ? '' : String(it.comment))};`);
    }
    for (const it of uDiff.drop) sqls.push(`ALTER TABLE ${fq} DROP CONSTRAINT ${q(d, it.name)};`);
    for (const it of uDiff.add) sqls.push(...uqAddSqls(d, spec, fq, it));
    for (const it of cmtOnly(spec.uniquesBefore, spec.uniquesAfter, uCanon)) {
      sqls.push(`COMMENT ON CONSTRAINT ${q(d, it.name)} ON ${fq} IS ${lit(d, it.comment == null ? '' : String(it.comment))};`);
    }
    for (const it of fDiff.drop) sqls.push(`ALTER TABLE ${fq} DROP CONSTRAINT ${q(d, it.name)};`);
    for (const it of fDiff.add) {
      sqls.push(fkAddSql(d, spec, fq, it));
      if (String(it.comment || '')) sqls.push(`COMMENT ON CONSTRAINT ${q(d, it.name)} ON ${fq} IS ${lit(d, it.comment)};`);
    }
    for (const it of cmtOnly(spec.fkeysBefore, spec.fkeysAfter, fCanon)) {
      sqls.push(`COMMENT ON CONSTRAINT ${q(d, it.name)} ON ${fq} IS ${lit(d, it.comment == null ? '' : String(it.comment))};`);
    }
    for (const it of cDiff.drop) sqls.push(`ALTER TABLE ${fq} DROP CONSTRAINT ${q(d, it.name)};`);
    for (const it of cDiff.add) sqls.push(...ckAddSqls(d, spec, fq, it));
    for (const it of cmtOnly(spec.checksBefore, spec.checksAfter, cCanon)) {
      sqls.push(`COMMENT ON CONSTRAINT ${q(d, it.name)} ON ${fq} IS ${lit(d, it.comment == null ? '' : String(it.comment))};`);
    }
    if (changedKeys.length) {
      const pairs = changedKeys.map((k) => {
        const v = optA[k];
        const sv = /^-?\d+$/.test(String(v)) ? String(v) : (/^(true|false)$/i.test(String(v)) ? String(v).toLowerCase() : lit(d, String(v)));
        return `${k}=${sv}`;
      });
      sqls.push(`ALTER TABLE ${fq} SET (${pairs.join(', ')});`);
    }
    if (cmtA !== cmtB) sqls.push(`COMMENT ON TABLE ${fq} IS ${lit(d, cmtA)};`);
  } else if (d === 'mssql') {
    for (const it of iDiff.drop) sqls.push(`DROP INDEX ${q(d, it.name)} ON ${fq};`);
    for (const it of iDiff.add) sqls.push(...mssqlIndexCreate(d, spec, fq, it));
    for (const it of cmtOnly(spec.indexesBefore, spec.indexesAfter, iCanon)) {
      sqls.push(mssqlProp(d, spec, 'INDEX', it.name, it.comment || ''));
    }
    for (const it of uDiff.drop) sqls.push(`ALTER TABLE ${fq} DROP CONSTRAINT ${q(d, it.name)};`);
    for (const it of uDiff.add) sqls.push(...uqAddSqls(d, spec, fq, it));
    for (const it of cmtOnly(spec.uniquesBefore, spec.uniquesAfter, uCanon)) {
      sqls.push(mssqlProp(d, spec, 'CONSTRAINT', it.name, it.comment || ''));
    }
    for (const it of fDiff.drop) sqls.push(`ALTER TABLE ${fq} DROP CONSTRAINT ${q(d, it.name)};`);
    for (const it of fDiff.add) {
      sqls.push(fkAddSql(d, spec, fq, it));
      if (String(it.comment || '')) sqls.push(mssqlProp(d, spec, 'CONSTRAINT', it.name, it.comment));
    }
    for (const it of enabledToggles(spec.fkeysBefore, spec.fkeysAfter, fCanon)) {
      sqls.push(
        it.enabled === false
          ? `ALTER TABLE ${fq} NOCHECK CONSTRAINT ${q(d, it.name)};`
          : `ALTER TABLE ${fq} WITH CHECK CHECK CONSTRAINT ${q(d, it.name)};`
      );
    }
    for (const it of cmtOnly(spec.fkeysBefore, spec.fkeysAfter, fCanon)) {
      sqls.push(mssqlProp(d, spec, 'CONSTRAINT', it.name, it.comment || ''));
    }
    for (const it of cDiff.drop) sqls.push(`ALTER TABLE ${fq} DROP CONSTRAINT ${q(d, it.name)};`);
    for (const it of cDiff.add) sqls.push(...ckAddSqls(d, spec, fq, it));
    for (const it of enabledToggles(spec.checksBefore, spec.checksAfter, cCanon)) {
      sqls.push(
        it.enabled === false
          ? `ALTER TABLE ${fq} NOCHECK CONSTRAINT ${q(d, it.name)};`
          : `ALTER TABLE ${fq} WITH CHECK CHECK CONSTRAINT ${q(d, it.name)};`
      );
    }
    for (const it of cmtOnly(spec.checksBefore, spec.checksAfter, cCanon)) {
      sqls.push(mssqlProp(d, spec, 'CONSTRAINT', it.name, it.comment || ''));
    }
    if (cmtA !== cmtB) sqls.push(mssqlProp(d, spec, null, null, cmtA));
    if (changedKeys.length) sqls.push('-- 注意：SQL Server 暂不支持表级选项图形配置，已忽略选项变更');
  }
  return sqls;
}

// 单个结构对象删除 DDL（侧边栏明细行右键删除）：kind: index/unique/fkey/check/trigger
// 与 objectAlterSql 的差异删除同口径；sqlite 唯一键实为唯一索引走 DROP INDEX，外键/检查需重建表
function dropStructSql(d, { db, schema, table, kind, name }) {
  const T = d === 'mysql' || d === 'mariadb' ? qualify(d, db, null, table) : qualify(d, null, schema, table);
  if (d === 'mysql' || d === 'mariadb') {
    if (kind === 'index' || kind === 'unique') return [`ALTER TABLE ${T} DROP INDEX ${q(d, name)};`];
    if (kind === 'fkey') return [`ALTER TABLE ${T} DROP FOREIGN KEY ${q(d, name)};`];
    if (kind === 'check') return [`ALTER TABLE ${T} DROP CHECK ${q(d, name)};`];
    return [`DROP TRIGGER ${qualify(d, db, null, name)};`];
  }
  if (d === 'pg') {
    if (kind === 'index') return [`DROP INDEX ${qualify(d, null, schema, name)};`];
    if (kind === 'trigger') return [`DROP TRIGGER ${q(d, name)} ON ${T};`]; // pg 触发器是表级对象
    return [`ALTER TABLE ${T} DROP CONSTRAINT ${q(d, name)};`];
  }
  if (d === 'mssql') {
    if (kind === 'index') return [`DROP INDEX ${q(d, name)} ON ${T};`];
    if (kind === 'trigger') return [`DROP TRIGGER ${qualify(d, null, schema, name)};`];
    return [`ALTER TABLE ${T} DROP CONSTRAINT ${q(d, name)};`];
  }
  if (d === 'sqlite') {
    if (kind === 'index' || kind === 'unique') return [`DROP INDEX ${q(d, name)};`];
    if (kind === 'trigger') return [`DROP TRIGGER ${q(d, name)};`];
    throw new Error('SQLite 删除外键/检查约束需重建表，请在表设计器中删除后保存');
  }
  if (d === 'oracle') {
    if (kind === 'index') return [`DROP INDEX ${qualify(d, null, schema, name)};`];
    if (kind === 'trigger') return [`DROP TRIGGER ${qualify(d, null, schema, name)};`];
    return [`ALTER TABLE ${T} DROP CONSTRAINT ${q(d, name)};`];
  }
  throw new Error(`该连接类型不支持结构删除: ${d}`);
}

// 建视图 DDL（各关系型方言）：标识符经 q() 转义；sqlite 无 CREATE OR REPLACE 先删后建；mssql 需 GO 分批
function createViewSql(d, { db, schema, name, select }) {
  const fq =
    d === 'mysql' || d === 'mariadb' ? (db ? `${q(d, db)}.${q(d, name)}` : q(d, name))
      : d === 'mssql' ? `${schema ? q(d, schema) : q(d, 'dbo')}.${q(d, name)}`
        : d === 'oracle' ? `${schema ? `${schema}.` : ''}${q(d, name)}`
          : `${schema ? `${q(d, schema)}.` : ''}${q(d, name)}`;
  if (d === 'sqlite') return `DROP VIEW IF EXISTS ${q(d, name)};\nCREATE VIEW ${q(d, name)} AS\n${select};`;
  if (d === 'mssql') return `DROP VIEW IF EXISTS ${fq};\nGO\nCREATE VIEW ${fq} AS\n${select};`;
  if (d === 'oracle') return `CREATE OR REPLACE VIEW ${fq} AS\n${select};\n/`;
  return `CREATE OR REPLACE VIEW ${fq} AS\n${select};`;
}

module.exports = {
  splitStatements,
  q,
  qualify,
  lit,
  fullType,
  columnDef,
  tableBodySql,
  createTableSql,
  normCol,
  mapType,
  transferDefault,
  orderChanged,
  insertOne,
  buildChangeSql,
  idxCanon,
  uqCanon,
  fkCanon,
  ckCanon,
  idxColsSql,
  isPlainIdxKey,
  parseIndexParts,
  indexDefKeys,
  listDiff,
  objectCreateSql,
  objectAlterSql,
  dropStructSql,
  createViewSql,
  // v0927.52 重建表复原件（postgres/mssql alterScript 重建分支用）
  pgIndexCreate,
  mssqlIndexCreate,
  fkAddSql,
  ckAddSqls,
  uqAddSqls,
};
