'use strict';
const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');
const U = require('../sqlutil');

let SQLPromise = null;
function loadSqlJs() {
  if (!SQLPromise) {
    SQLPromise = initSqlJs({ locateFile: (f) => path.join(path.dirname(require.resolve('sql.js')), f) });
  }
  return SQLPromise;
}

async function create(cfg) {
  const D = 'sqlite';
  const SQL = await loadSqlJs();
  const file = cfg.file || '';
  const existed = !!(file && fs.existsSync(file));
  const db = existed ? new SQL.Database(fs.readFileSync(file)) : new SQL.Database();
  const persist = () => {
    if (file) fs.writeFileSync(file, Buffer.from(db.export()));
  };
  if (file && !existed) persist(); // 新建库文件

  function all(sql, params = []) {
    const stmt = db.prepare(sql);
    try {
      stmt.bind(params);
      const out = [];
      while (stmt.step()) out.push(stmt.getAsObject());
      return out;
    } finally {
      stmt.free();
    }
  }

  const serverInfo = 'SQLite ' + all('SELECT sqlite_version() AS v')[0].v;

  // 结构性变更（删列/改类型/改约束/调列顺序）无法用 ALTER 完成，需要重建表
  function needsRebuild(spec) {
    if (U.orderChanged(spec)) return true; // 拖拽排序：重建时按 after 顺序建列
    const before = spec.before || [];
    const after = spec.after || [];
    const bpk = before.filter((c) => c.pk).map((c) => c.name).sort().join(',');
    const apk = after.filter((c) => c.pk).map((c) => c.name).sort().join(',');
    if (bpk !== apk) return true;
    for (const c of after) {
      const b = before.find((x) => x.name === (c.origName || c.name));
      if (!b) continue; // ADD COLUMN 原生支持
      const bn = U.normCol(b);
      bn.name = c.name;
      if (U.fullType(bn) !== U.fullType(c)) return true;
      if (!!bn.nullable !== !!c.nullable) return true;
      if ((bn.defaultValue || '') !== (c.defaultValue || '')) return true;
      if (!!bn.autoInc !== !!c.autoInc) return true;
    }
    for (const b of before) {
      if (!after.find((c) => (c.origName || c.name) === b.name)) return true; // DROP COLUMN
    }
    return false;
  }

  const s = {
    type: D,
    serverInfo,
    close: () => persist(),

    async treeRoot() {
      // 索引不再单列目录（v0921.20）：随对象列表页表行展开查看
      return [
        { type: 'cat', kind: 'table', name: '表' },
        { type: 'cat', kind: 'view', name: '视图' },
        { type: 'cat', kind: 'trigger', name: '触发器' },
      ];
    },

    async treeChildren(node) {
      if (node.type === 'cat') {
        if (node.kind === 'trigger') {
          const rows = all("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name NOT LIKE 'sqlite_%' ORDER BY name");
          return rows.map((r) => ({ type: 'trigger', name: r.name }));
        }
        const type = node.kind === 'view' ? 'view' : 'table';
        const rows = all("SELECT name FROM sqlite_master WHERE type = ? AND name NOT LIKE 'sqlite_%' ORDER BY name", [type]);
        return rows.map((r) => ({ type: node.kind, name: r.name }));
      }
      return [];
    },

    async columns({ table }) {
      const rows = all(`PRAGMA table_info(${U.q(D, table)})`);
      const ddlRow = all("SELECT sql FROM sqlite_master WHERE type IN ('table','view') AND name = ?", [table])[0] || {};
      const hasAutoInc = /AUTOINCREMENT/i.test(ddlRow.sql || '');
      return rows.map((r) => {
        const raw = String(r.type || '').trim();
        const m = /^(\w+)\s*(?:\(\s*(\d+)\s*(?:,\s*(\d+)\s*)?\))?$/.exec(raw);
        return {
          name: r.name,
          dataType: (m ? m[1] : raw).toUpperCase() || 'BLOB',
          display: raw.toUpperCase(),
          length: m && m[2] ? Number(m[2]) : null,
          scale: m && m[3] ? Number(m[3]) : null,
          nullable: !r.notnull,
          pk: !!r.pk,
          autoInc: hasAutoInc && !!r.pk && /int/i.test(raw),
          defaultValue: r.dflt_value,
          comment: '',
        };
      });
    },

    async tables() {
      return all("SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name").map((r) => r.name);
    },

    // 工具栏「表/视图」对象列表页：名称 + 行数（COUNT 实测；视图不计数）+ 注释（sqlite 无表注释）
    async objList({ kind }) {
      const type = kind === 'view' ? 'view' : 'table';
      const names = all("SELECT name FROM sqlite_master WHERE type = ? AND name NOT LIKE 'sqlite_%' ORDER BY name", [type]).map((r) => r.name);
      return names.map((name) => {
        let n = null;
        if (type === 'table') {
          try {
            n = all(`SELECT COUNT(*) AS c FROM ${U.q(D, name)}`)[0].c;
          } catch {}
        }
        return { name, rows: n, comment: '' };
      });
    },

    // ---- 表对象内省：索引 / 外键 / 检查约束 / 触发器 / 表信息 ----
    async indexes({ table }) {
      // origin: c=CREATE INDEX, u=UNIQUE 约束, pk=主键（排除）
      // 键列表/WHERE 从 sqlite_master 原始 DDL 解析（支持表达式键、部分索引、降序，原样 round-trip）；
      // 自动索引（UNIQUE 约束后备，sql 为 NULL）退回 index_xinfo（仅普通列）
      return all(`PRAGMA index_list(${U.q(D, table)})`)
        .filter((r) => String(r.origin || 'c') !== 'pk')
        .map((r) => {
          const ddl = (all('SELECT sql FROM sqlite_master WHERE type = ? AND name = ?', ['index', r.name])[0] || {}).sql || '';
          const parsed = ddl ? U.indexDefKeys(String(ddl)) : null;
          if (parsed && parsed.parts.length) {
            return {
              name: r.name,
              columns: parsed.parts.map((p) => p.k),
              dirs: parsed.parts.map((p) => p.dir),
              unique: !!r.unique,
              origin: String(r.origin || 'c'),
              where: parsed.where,
            };
          }
          const cols = all(`PRAGMA index_xinfo(${U.q(D, r.name)})`).filter((x) => x.key !== 0 && x.name != null);
          return {
            name: r.name,
            columns: cols.map((x) => x.name),
            dirs: cols.map((x) => (Number(x.desc) === 1 ? 'DESC' : '')),
            unique: !!r.unique,
            origin: String(r.origin || 'c'),
            where: '',
          };
        });
    },
    async fkeys({ table }) {
      // SQLite 外键匿名，用列表 id 合成稳定名（仅用于界面展示与对齐）
      const rows = all(`PRAGMA foreign_key_list(${U.q(D, table)})`);
      const byId = new Map();
      for (const r of rows) {
        if (!byId.has(r.id)) {
          byId.set(r.id, { id: r.id, refTable: r.table, columns: [], refColumns: [], onDelete: r.on_delete, onUpdate: r.on_update });
        }
        const g = byId.get(r.id);
        g.columns.push(r.from);
        g.refColumns.push(r.to);
      }
      return [...byId.values()].map((g) => ({
        name: 'fk_' + g.id,
        columns: g.columns,
        refTable: g.refTable,
        refColumns: g.refColumns,
        onDelete: g.onDelete,
        onUpdate: g.onUpdate,
      }));
    },
    // 他表引用本表的外键清单（v0927.52 设计器重建表提示用）：扫全库各表的 foreign_key_list 反查
    // SQLite 外键匿名，name 用「引用表 fk_id」合成展示名
    async inFkeys({ table }) {
      const out = [];
      for (const r of all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")) {
        for (const fk of all(`PRAGMA foreign_key_list(${U.q(D, r.name)})`)) {
          if (String(fk.table) === String(table)) out.push({ name: r.name + ' fk_' + fk.id, schema: '', table: r.name });
        }
      }
      return out;
    },
    async checks({ table }) {
      // CHECK 存在于 CREATE TABLE 文本中：括号配平扫描顶层逗号切分后识别
      const ddl = (all('SELECT sql FROM sqlite_master WHERE type = ? AND name = ?', ['table', table])[0] || {}).sql || '';
      const open = ddl.indexOf('(');
      if (open < 0) return [];
      let depth = 0;
      let end = -1;
      for (let i = open; i < ddl.length; i += 1) {
        if (ddl[i] === '(') depth += 1;
        else if (ddl[i] === ')') {
          depth -= 1;
          if (depth === 0) {
            end = i;
            break;
          }
        }
      }
      if (end < 0) return [];
      const body = ddl.slice(open + 1, end);
      const parts = [];
      let d2 = 0;
      let cur = '';
      let inStr = false;
      let q2 = '';
      for (const ch of body) {
        if (inStr) {
          cur += ch;
          if (ch === q2) inStr = false;
          continue;
        }
        if (ch === "'" || ch === '"') {
          inStr = true;
          q2 = ch;
          cur += ch;
          continue;
        }
        if (ch === '(') d2 += 1;
        if (ch === ')') d2 -= 1;
        if (ch === ',' && d2 === 0) {
          parts.push(cur);
          cur = '';
          continue;
        }
        cur += ch;
      }
      if (cur.trim()) parts.push(cur);
      const out = [];
      for (const p of parts) {
        const m = /^\s*(?:CONSTRAINT\s+(?:"([^"]+)"|\[([^\]]+)\]|(\w+))\s+)?CHECK\s*\(([\s\S]*)\)\s*$/i.exec(p);
        if (m) out.push({ name: m[1] || m[2] || m[3] || '', expr: m[4].trim() });
      }
      return out;
    },
    async triggers({ table }) {
      return all("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ? AND name NOT LIKE 'sqlite_%' ORDER BY name", [table]).map((r) => ({ name: r.name, sql: r.sql }));
    },
    async tableInfo() {
      return { comment: '', options: {} }; // SQLite 无表注释/表级选项
    },

    async page({ table, pageNo = 1, pageSize = 100, where, orderCol, orderDir }) {
      const full = U.q(D, table);
      const cols = await s.columns({ table });
      const colList = cols.map((c) => U.q(D, c.name)).join(', ');
      const w = where && where.trim() ? ` WHERE (${where})` : '';
      const ord = orderCol ? ` ORDER BY ${U.q(D, orderCol)} ${orderDir === 'DESC' ? 'DESC' : 'ASC'}` : '';
      const total = all(`SELECT COUNT(*) AS c FROM ${full}${w}`)[0].c;
      const rows = all(
        `SELECT ${colList} FROM ${full}${w}${ord} LIMIT ${Number(pageSize)} OFFSET ${(pageNo - 1) * pageSize}`
      );
      return {
        columns: cols,
        rows: rows.map((r) => cols.map((c) => (c.name in r ? r[c.name] : null))),
        total: Number(total),
      };
    },

    async query(arg) {
      const sqlText = typeof arg === 'string' ? arg : (arg && arg.sqlText) || '';
      const out = [];
      for (const st of U.splitStatements(sqlText)) {
        const t0 = Date.now();
        try {
          const rs = db.exec(st);
          const modified = db.getRowsModified();
          const elapsed = Date.now() - t0;
          if (rs.length && rs[0].columns && rs[0].columns.length) {
            for (const r of rs) {
              out.push({ sql: st, command: 'SELECT', columns: r.columns, rows: r.values, rowCount: r.values.length, elapsed });
            }
          } else {
            out.push({ sql: st, command: 'OK', columns: [], rows: [], rowCount: modified, elapsed });
          }
        } catch (e) {
          out.push({ sql: st, command: 'ERROR', columns: [], rows: [], rowCount: 0, error: e.message, elapsed: Date.now() - t0 });
        }
      }
      // 执行过写语句（INSERT/UPDATE/DDL 等）立即落盘：查询页手敲的写入与"运行 SQL 文件"还原共用此路径
      if (out.some((r) => r.command === 'OK')) persist();
      return out;
    },

    async changes(spec) {
      const stmts = U.buildChangeSql(D, null, null, spec.table, spec);
      db.run('BEGIN');
      try {
        for (const st of stmts) db.run(st.sql, st.params);
        db.run('COMMIT');
      } catch (e) {
        try { db.run('ROLLBACK'); } catch {}
        throw e;
      }
      persist();
      return { executed: stmts.length };
    },

    async ddl({ table }) {
      const row = all('SELECT sql FROM sqlite_master WHERE type IN ("table","view") AND name = ?', [table])[0];
      return row ? row.sql + ';' : '-- 未找到对象';
    },

    async createTable(spec) {
      const sql = U.createTableSql(D, { ...spec, schema: null });
      db.exec(sql);
      const extras = [];
      for (const it of [...(spec.indexesAfter || []), ...(spec.uniquesAfter || []).map((u) => ({ ...u, unique: true }))]) {
        if (String(it.name || '').trim() && (it.columns || []).length) {
          extras.push(`CREATE ${it.unique ? 'UNIQUE ' : ''}INDEX ${U.q(D, it.name)} ON ${U.q(D, spec.name)} (${U.idxColsSql(D, it)})${it.where ? ' WHERE ' + String(it.where).trim() : ''};`);
        }
      }
      for (const st of extras) db.exec(st);
      persist();
      return [sql, ...extras].join('\n');
    },

    // 仅生成建表 SQL（结构同步预览用）：与 createTable 完全同源，不执行（外键/CHECK 已内联在 CREATE TABLE 里）
    async createTableScript(spec) {
      const sql = U.createTableSql(D, { ...spec, schema: null });
      const extras = [];
      for (const it of [...(spec.indexesAfter || []), ...(spec.uniquesAfter || []).map((u) => ({ ...u, unique: true }))]) {
        if (String(it.name || '').trim() && (it.columns || []).length) {
          extras.push(`CREATE ${it.unique ? 'UNIQUE ' : ''}INDEX ${U.q(D, it.name)} ON ${U.q(D, spec.name)} (${U.idxColsSql(D, it)})${it.where ? ' WHERE ' + String(it.where).trim() : ''};`);
        }
      }
      return [sql, ...extras];
    },

    async alterScript(spec) {
      const sqls = [];
      let t = spec.table;
      if (spec.newName && spec.newName !== spec.table) {
        sqls.push(`ALTER TABLE ${U.q(D, t)} RENAME TO ${U.q(D, spec.newName)};`);
        t = spec.newName;
      }
      const normFk = (f) => ({
        columns: (f.columns || []).map(String),
        refTable: String(f.refTable || ''),
        refColumns: (f.refColumns || []).map(String),
        onDelete: String(f.onDelete || '').toUpperCase(),
        onUpdate: String(f.onUpdate || '').toUpperCase(),
      });
      const normCk = (c) => ({ name: String(c.name || '').trim(), expr: String(c.expr || '').replace(/\s+/g, ' ').trim() });
      const fkChanged = JSON.stringify((spec.fkeysBefore || []).map(normFk)) !== JSON.stringify((spec.fkeysAfter || []).map(normFk));
      const ckChanged = JSON.stringify((spec.checksBefore || []).map(normCk)) !== JSON.stringify((spec.checksAfter || []).map(normCk));
      if (!needsRebuild(spec) && !fkChanged && !ckChanged) {
        for (const c of spec.after || []) {
          const b = (spec.before || []).find((x) => x.name === (c.origName || c.name));
          if (!b) sqls.push(`ALTER TABLE ${U.q(D, t)} ADD COLUMN ${U.columnDef(D, c)};`);
          else if (c.origName && c.origName !== c.name) {
            sqls.push(`ALTER TABLE ${U.q(D, t)} RENAME COLUMN ${U.q(D, c.origName)} TO ${U.q(D, c.name)};`);
          }
        }
      } else {
        // 重建表（含外键/CHECK 内联）：先记录原索引 DDL，重建后按当前表名复原
        const originIdx = all("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL ORDER BY name", [spec.table]);
        const tmp = t + '__rebuild';
        const keep = (spec.after || []).filter((c) =>
          (spec.before || []).some((b) => b.name === (c.origName || c.name))
        );
        sqls.push(`DROP TABLE IF EXISTS ${U.q(D, tmp)};`);
        sqls.push(`CREATE TABLE ${U.q(D, tmp)} (\n${U.tableBodySql(D, spec.after || [], { fkeys: spec.fkeysAfter || [], checks: spec.checksAfter || [] })}\n);`);
        if (keep.length) {
          sqls.push(
            `INSERT INTO ${U.q(D, tmp)} (${keep.map((c) => U.q(D, c.name)).join(', ')}) SELECT ${keep
              .map((c) => U.q(D, c.origName || c.name))
              .join(', ')} FROM ${U.q(D, t)};`
          );
        }
        sqls.push(`DROP TABLE ${U.q(D, t)};`);
        sqls.push(`ALTER TABLE ${U.q(D, tmp)} RENAME TO ${U.q(D, t)};`);
        // 复原原索引（表已改名时把 ON 旧表名 替换为当前名）
        for (const r of originIdx) {
          let isql = String(r.sql || '').trim();
          if (spec.newName && spec.newName !== spec.table) {
            const re = new RegExp('(\\sON\\s+)("?' + String(spec.table).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"?)', 'i');
            isql = isql.replace(re, '$1' + U.q(D, t));
          }
          if (isql) sqls.push(isql + (isql.endsWith(';') ? '' : ';'));
        }
      }
      // 索引/唯一键差异（与是否重建无关；重建路径先复原原索引，DROP 变更/删除项后再建新项）
      const allBefore = [...(spec.indexesBefore || []), ...(spec.uniquesBefore || []).map((u) => ({ ...u, unique: true }))];
      const allAfter = [...(spec.indexesAfter || []), ...(spec.uniquesAfter || []).map((u) => ({ ...u, unique: true }))];
      const diff = U.listDiff(allBefore, allAfter, U.idxCanon);
      for (const it of diff.drop) sqls.push(`DROP INDEX IF EXISTS ${U.q(D, it.name)};`);
      for (const it of diff.add) {
        sqls.push(`CREATE ${it.unique ? 'UNIQUE ' : ''}INDEX ${U.q(D, it.name)} ON ${U.q(D, t)} (${U.idxColsSql(D, it)})${it.where ? ' WHERE ' + String(it.where).trim() : ''};`);
      }
      const optChanged = Object.entries(spec.options || {}).some(([, v]) => String(v || '').trim() !== '');
      const cmtChanged = String(spec.comment || '') !== String((spec.infoBefore && spec.infoBefore.comment) || '');
      if (optChanged || cmtChanged) sqls.push('-- 注意：SQLite 不支持表级选项/表注释，已忽略该部分变更');
      return sqls;
    },

    async applyAlter(spec) {
      const sqls = await s.alterScript(spec);
      db.run('BEGIN');
      try {
        for (const sql of sqls) db.exec(sql);
        db.run('COMMIT');
      } catch (e) {
        try { db.run('ROLLBACK'); } catch {}
        throw e;
      }
      persist();
      return { executed: sqls.length };
    },

    async dropTable({ table }) {
      db.exec(`DROP TABLE ${U.q(D, table)}`);
      persist();
    },
    async truncateTable({ table }) {
      db.exec(`DELETE FROM ${U.q(D, table)}`);
      persist();
    },
    async renameTable({ table, newName }) {
      db.exec(`ALTER TABLE ${U.q(D, table)} RENAME TO ${U.q(D, newName)}`);
      persist();
    },
    async createDatabase() {
      throw new Error('SQLite 为单文件数据库，请直接新建/选择 .db 文件');
    },
    async dropDatabase() {
      throw new Error('SQLite 请直接删除数据库文件');
    },

    // ---- 触发器 / 视图 / 索引 ----
    async objectDdl({ kind, name }) {
      if (kind === 'index') {
        const row = all("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?", [name])[0];
        return row ? row.sql + ';' : '-- 未找到索引';
      }
      if (kind !== 'trigger' && kind !== 'view') throw new Error('SQLite 仅支持触发器/视图/索引源码查看');
      const row = all('SELECT sql FROM sqlite_master WHERE type = ? AND name = ?', [kind, name])[0];
      return row ? row.sql + ';' : '-- 未找到对象';
    },
    async dropObject({ kind, name }) {
      if (kind !== 'trigger' && kind !== 'view' && kind !== 'index') throw new Error('SQLite 仅支持删除触发器/视图/索引');
      db.exec(`DROP ${kind === 'trigger' ? 'TRIGGER' : kind === 'view' ? 'VIEW' : 'INDEX'} ${U.q(D, name)}`);
      persist();
    },

    // 结构明细行删除（侧边栏右键）：DDL 由引擎统一生成（唯一键=唯一索引可删；外键/检查需重建表，dropStructSql 会抛错）
    async dropStruct(arg) {
      for (const st of U.dropStructSql(D, arg)) db.exec(st);
      persist();
    },

    // 视图设计器保存：DDL 由引擎统一生成（标识符经 q() 转义）；query() 仅内存态，需 persist 落盘
    async createView(arg) {
      const out = await this.query({ sqlText: U.createViewSql(D, arg), db: arg.db, schema: arg.schema });
      persist();
      return out;
    },

    // ---- 备份导出 ----
    async dumpTable({ table }) {
      const parts = [];
      const row = all('SELECT sql FROM sqlite_master WHERE type IN (\'table\',\'view\') AND name = ?', [table])[0];
      parts.push(row ? row.sql + ';' : '-- 未找到 ' + table);
      const cols = await s.columns({ table });
      const full = U.q(D, table);
      const colList = cols.map((c) => U.q(D, c.name)).join(', ');
      const BATCH = 500;
      for (let page = 1; ; page += 1) {
        const r = await s.page({ table, pageNo: page, pageSize: BATCH });
        if (!r.rows.length) break;
        for (const rw of r.rows) {
          parts.push(`INSERT INTO ${full} (${colList}) VALUES (${rw.map((v) => U.lit(D, v)).join(', ')});`);
        }
        if (r.rows.length < BATCH) break;
      }
      return parts.join('\n');
    },

    // ---- CSV 导入 / 批量插入（参数化） ----
    async importCsv(spec) {
      const { parseCsv } = require('../csv');
      const fs = require('fs');
      const { header, rows } = parseCsv(fs.readFileSync(spec.file, 'utf8'));
      const cols = await s.columns({ table: spec.table });
      const known = new Set(cols.map((c) => c.name));
      const use = header.map((h) => (known.has(String(h).trim()) ? String(h).trim() : null));
      const full = U.q(D, spec.table);
      const stmts = [];
      for (const row of rows) {
        const entries = [];
        use.forEach((cn, i) => {
          if (!cn) return;
          let v = row[i];
          if (spec.nullEmpty !== false && v === '') v = null;
          entries.push([cn, v]);
        });
        if (entries.length) stmts.push(U.insertOne(D, full, entries));
      }
      db.run('BEGIN');
      try {
        for (const st of stmts) db.run(st.sql, st.params);
        db.run('COMMIT');
      } catch (e) {
        try { db.run('ROLLBACK'); } catch {}
        throw e;
      }
      persist();
      return { inserted: stmts.length, columns: header.filter((h) => known.has(String(h).trim())).length };
    },
    async insertRows(spec) {
      const full = U.q(D, spec.table);
      const sql = `INSERT INTO ${full} (${spec.columns.map((c) => U.q(D, c)).join(', ')}) VALUES (${spec.columns.map(() => '?').join(', ')})`;
      db.run('BEGIN');
      try {
        for (const r of spec.rows) db.run(sql, r);
        db.run('COMMIT');
      } catch (e) {
        try { db.run('ROLLBACK'); } catch {}
        throw e;
      }
      persist();
      return { inserted: spec.rows.length };
    },
  };
  return s;
}

module.exports = { create };
