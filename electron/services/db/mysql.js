'use strict';
const mysql = require('mysql2/promise');
const U = require('../sqlutil');

async function create(cfg, localPort) {
  const D = 'mysql';
  // SSL 证书严格校验由连接配置 sslVerify 控制（DB 客户端惯例：自签名证书场景默认放宽）
  const sslOpts = cfg.ssl ? { rejectUnauthorized: Boolean(cfg.sslVerify) } : undefined;
  const conn = await mysql.createConnection({
    host: localPort ? '127.0.0.1' : (cfg.host || 'localhost'),
    port: localPort || Number(cfg.port) || 3306,
    user: cfg.user || 'root',
    password: cfg.password || '',
    database: cfg.database || undefined,
    dateStrings: true,
    multipleStatements: false,
    ssl: sslOpts,
    connectTimeout: 10000,
  });
  const [[{ v }]] = await conn.query('SELECT VERSION() AS v');

  const s = {
    type: D,
    serverInfo: /mariadb/i.test(v) ? `MariaDB ${v}` : `MySQL ${v}`,
    close: () => conn.end().catch(() => {}),

    async treeRoot() {
      const [rows] = await conn.query('SHOW DATABASES');
      return rows.map((r) => ({ type: 'db', name: r.Database }));
    },

    async treeChildren(node) {
      if (node.type === 'db') {
        return [
          { type: 'cat', kind: 'table', db: node.name, name: '表' },
          { type: 'cat', kind: 'view', db: node.name, name: '视图' },
          { type: 'cat', kind: 'function', db: node.name, name: '函数' },
          { type: 'cat', kind: 'procedure', db: node.name, name: '存储过程' },
          { type: 'cat', kind: 'trigger', db: node.name, name: '触发器' },
          { type: 'cat', kind: 'event', db: node.name, name: '事件' },
        ];
      }
      if (node.type === 'cat') {
        if (node.kind === 'table' || node.kind === 'view') {
          const [rows] = await conn.query(
            'SELECT TABLE_NAME AS name, TABLE_TYPE AS tt FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME',
            [node.db]
          );
          const want = node.kind === 'view' ? 'VIEW' : 'BASE TABLE';
          return rows.filter((r) => r.tt === want).map((r) => ({ type: node.kind, db: node.db, name: r.name }));
        }
        if (node.kind === 'function' || node.kind === 'procedure') {
          const [rows] = await conn.query(
            'SELECT ROUTINE_NAME AS name FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ? AND ROUTINE_TYPE = ? ORDER BY ROUTINE_NAME',
            [node.db, node.kind === 'function' ? 'FUNCTION' : 'PROCEDURE']
          );
          return rows.map((r) => ({ type: node.kind, db: node.db, name: r.name }));
        }
        if (node.kind === 'trigger') {
          const [rows] = await conn.query(
            'SELECT TRIGGER_NAME AS name FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ? ORDER BY TRIGGER_NAME',
            [node.db]
          );
          return rows.map((r) => ({ type: 'trigger', db: node.db, name: r.name }));
        }
        if (node.kind === 'event') {
          const [rows] = await conn.query(
            'SELECT EVENT_NAME AS name FROM information_schema.EVENTS WHERE EVENT_SCHEMA = ? ORDER BY EVENT_NAME',
            [node.db]
          );
          return rows.map((r) => ({ type: 'event', db: node.db, name: r.name }));
        }
      }
      return [];
    },

    async columns({ db, table }) {
      const [rows] = await conn.query(
        `SELECT COLUMN_NAME name, DATA_TYPE dt, COLUMN_TYPE ct,
                IFNULL(CHARACTER_MAXIMUM_LENGTH, NUMERIC_PRECISION) len, NUMERIC_SCALE sc,
                IS_NULLABLE nn, COLUMN_DEFAULT dflt, COLUMN_KEY ck, EXTRA ex, COLUMN_COMMENT cmt
         FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
        [db, table]
      );
      return rows.map((r) => ({
        name: r.name,
        dataType: String(r.dt).toUpperCase(),
        display: r.ct,
        length: r.len == null ? null : Number(r.len),
        scale: r.sc == null ? null : Number(r.sc),
        nullable: r.nn === 'YES',
        pk: r.ck === 'PRI',
        autoInc: /auto_increment/i.test(r.ex || ''),
        defaultValue: r.dflt,
        comment: r.cmt || '',
      }));
    },

    async tables({ db }) {
      const [rows] = await conn.query(
        'SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME',
        [db]
      );
      return rows.map((r) => r.name);
    },

    // 工具栏「表/视图」对象列表页：名称 + 行数（统计信息，约值）+ 注释（视图的 TABLE_COMMENT 是 'VIEW' 标记，不展示）
    async objList({ db, kind }) {
      const tt = kind === 'view' ? 'VIEW' : 'BASE TABLE';
      const [rows] = await conn.query(
        'SELECT TABLE_NAME AS name, TABLE_ROWS AS cnt, TABLE_COMMENT AS cmt FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = ? ORDER BY TABLE_NAME',
        [db, tt]
      );
      return rows.map((r) => ({
        name: r.name,
        rows: r.cnt == null ? null : Number(r.cnt),
        comment: kind === 'view' ? '' : String(r.cmt || ''),
      }));
    },

    // ---- 表对象内省：索引 / 外键 / 检查约束 / 触发器 / 表信息 ----
    async indexes({ db, table }) {
      // SHOW INDEX: Collation='D' 即该列降序；Index_type=BTREE/HASH/FULLTEXT/SPATIAL；Index_comment=索引注释
      const [rows] = await conn.query('SHOW INDEX FROM ' + U.qualify(D, db, null, table));
      const map = new Map();
      for (const r of rows) {
        if (String(r.Key_name).toUpperCase() === 'PRIMARY') continue;
        if (!map.has(r.Key_name)) {
          map.set(r.Key_name, {
            name: r.Key_name,
            columns: [],
            dirs: [],
            type: String(r.Index_type || '').toUpperCase(),
            unique: Number(r.Non_unique) === 0,
            comment: String(r.Index_comment || ''),
          });
        }
        const g = map.get(r.Key_name);
        g.columns.push(r.Column_name);
        g.dirs.push(r.Collation === 'D' ? 'DESC' : '');
      }
      return [...map.values()];
    },
    async fkeys({ db, table }) {
      const [rows] = await conn.query(
        `SELECT kcu.CONSTRAINT_NAME AS cn, kcu.COLUMN_NAME AS col,
                kcu.REFERENCED_TABLE_SCHEMA AS rts, kcu.REFERENCED_TABLE_NAME AS rt, kcu.REFERENCED_COLUMN_NAME AS rc,
                rc2.DELETE_RULE AS dr, rc2.UPDATE_RULE AS ur
         FROM information_schema.KEY_COLUMN_USAGE kcu
         LEFT JOIN information_schema.REFERENTIAL_CONSTRAINTS rc2
           ON rc2.CONSTRAINT_SCHEMA = kcu.TABLE_SCHEMA AND rc2.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
         WHERE kcu.TABLE_SCHEMA = ? AND kcu.TABLE_NAME = ? AND kcu.REFERENCED_TABLE_NAME IS NOT NULL
         ORDER BY kcu.CONSTRAINT_NAME, kcu.ORDINAL_POSITION`,
        [db, table]
      );
      const map = new Map();
      for (const r of rows) {
        if (!map.has(r.cn)) {
          map.set(r.cn, { name: r.cn, columns: [], refSchema: r.rts, refTable: r.rt, refColumns: [], onDelete: r.dr, onUpdate: r.ur });
        }
        const g = map.get(r.cn);
        g.columns.push(r.col);
        g.refColumns.push(r.rc);
      }
      return [...map.values()];
    },
    async checks({ db, table }) {
      try {
        const [rows] = await conn.query(
          `SELECT cc.CONSTRAINT_NAME AS cn, cc.CHECK_CLAUSE AS expr
           FROM information_schema.CHECK_CONSTRAINTS cc
           JOIN information_schema.TABLE_CONSTRAINTS tc
             ON tc.CONSTRAINT_SCHEMA = cc.CONSTRAINT_SCHEMA AND tc.CONSTRAINT_NAME = cc.CONSTRAINT_NAME
           WHERE tc.TABLE_SCHEMA = ? AND tc.TABLE_NAME = ? AND tc.CONSTRAINT_TYPE = 'CHECK'`,
          [db, table]
        );
        return rows.map((r) => ({ name: r.cn, expr: r.expr }));
      } catch {
        return []; // MariaDB / 旧版 MySQL 无 CHECK_CONSTRAINTS
      }
    },
    async triggers({ db, table }) {
      const [rows] = await conn.query(
        `SELECT TRIGGER_NAME AS name, ACTION_TIMING AS timing, EVENT_MANIPULATION AS event
         FROM information_schema.TRIGGERS WHERE EVENT_OBJECT_SCHEMA = ? AND EVENT_OBJECT_TABLE = ? ORDER BY TRIGGER_NAME`,
        [db, table]
      );
      return rows;
    },
    async tableInfo({ db, table }) {
      const [rows] = await conn.query(
        `SELECT TABLE_COMMENT AS cmt, ENGINE AS eng, TABLE_COLLATION AS coll, AUTO_INCREMENT AS ai
         FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
        [db, table]
      );
      const r = rows[0] || {};
      return {
        comment: r.cmt || '',
        options: { engine: r.eng || '', collation: r.coll || '', autoIncrement: r.ai == null ? '' : String(r.ai) },
      };
    },

    async page({ db, table, pageNo = 1, pageSize = 100, where, orderCol, orderDir }) {
      const full = U.qualify(D, db, null, table);
      const cols = await s.columns({ db, table });
      const colList = cols.map((c) => U.q(D, c.name)).join(', ');
      const w = where && where.trim() ? ` WHERE (${where})` : '';
      const ord = orderCol ? ` ORDER BY ${U.q(D, orderCol)} ${orderDir === 'DESC' ? 'DESC' : 'ASC'}` : '';
      const [[{ total }]] = await conn.query(`SELECT COUNT(*) AS total FROM ${full}${w}`);
      const [rows] = await conn.query(
        `SELECT ${colList} FROM ${full}${w}${ord} LIMIT ${Number(pageSize)} OFFSET ${(pageNo - 1) * pageSize}`
      );
      return {
        columns: cols,
        rows: rows.map((r) => cols.map((c) => r[c.name])),
        total: Number(total),
      };
    },

    async query(arg) {
      const a = typeof arg === 'string' ? { sqlText: arg } : arg || {};
      const sqlText = a.sqlText || '';
      const out = [];
      // 查询页可切换目标库：会话级 USE（库名来自 treeRoot 枚举 + q() 转义，非用户拼接）
      if (a.db) await conn.query(`USE ${U.q(D, a.db)}`);
      for (const st of U.splitStatements(sqlText)) {
        const t0 = Date.now();
        try {
          const [res, fields] = await conn.query(st);
          const elapsed = Date.now() - t0;
          if (fields && fields.length) {
            out.push({
              sql: st, command: 'SELECT', columns: fields.map((f) => f.name),
              rows: res.map((r) => fields.map((f) => r[f.name])),
              rowCount: res.length, elapsed,
            });
          } else {
            out.push({
              sql: st, command: 'OK', columns: [], rows: [],
              rowCount: res.affectedRows || 0, info: res.info, elapsed,
            });
          }
        } catch (e) {
          out.push({ sql: st, command: 'ERROR', columns: [], rows: [], rowCount: 0, error: e.message, elapsed: Date.now() - t0 });
        }
      }
      return out;
    },

    async changes(spec) {
      const stmts = U.buildChangeSql(D, spec.db, null, spec.table, spec);
      for (const st of stmts) await conn.query(st.sql, st.params);
      return { executed: stmts.length };
    },

    async ddl({ db, table }) {
      const [rows] = await conn.query('SHOW CREATE TABLE ' + U.qualify(D, db, null, table));
      return rows[0]['Create Table'];
    },

    async createTable(spec) {
      const sql = U.createTableSql(D, spec);
      await conn.query(sql);
      const extras = U.objectCreateSql(D, spec, U.qualify(D, spec.db, null, spec.name));
      for (const st of extras) await conn.query(st);
      return [sql, ...extras].join('\n');
    },

    // 仅生成建表 SQL（结构同步预览用）：与 createTable 完全同源，不执行
    async createTableScript(spec) {
      return [U.createTableSql(D, spec), ...U.objectCreateSql(D, spec, U.qualify(D, spec.db, null, spec.name))];
    },

    async alterScript(spec) {
      const sqls = [];
      const fq = (n) => U.qualify(D, spec.db, null, n);
      let tname = spec.table;
      const before = spec.before || [];
      const after = spec.after || [];
      if (spec.newName && spec.newName !== spec.table) {
        sqls.push(`RENAME TABLE ${fq(spec.table)} TO ${fq(spec.newName)}`);
        tname = spec.newName;
      }
      const bpk = before.filter((c) => c.pk).map((c) => c.name).sort().join(',');
      const apk = after.filter((c) => c.pk).map((c) => c.name).sort().join(',');
      if (bpk && bpk !== apk) sqls.push(`ALTER TABLE ${fq(tname)} DROP PRIMARY KEY;`);
      // 拖拽排序：为每列生成 FIRST/AFTER 定位（ADD 与 MODIFY 都带上，按 after 顺序串成链）
      const reorder = U.orderChanged(spec);
      let prev = null;
      for (const c of after) {
        const b = before.find((x) => x.name === (c.origName || c.name));
        const posSql = reorder ? (prev ? ` AFTER ${U.q(D, prev)}` : ' FIRST') : '';
        if (!b) {
          sqls.push(`ALTER TABLE ${fq(tname)} ADD COLUMN ${U.columnDef(D, c)}${posSql};`);
          prev = c.name;
          continue;
        }
        if (c.origName && c.origName !== c.name) {
          sqls.push(`ALTER TABLE ${fq(tname)} RENAME COLUMN ${U.q(D, c.origName)} TO ${U.q(D, c.name)};`);
        }
        const bn = U.normCol(b);
        bn.name = c.name;
        if (reorder || U.columnDef(D, bn) !== U.columnDef(D, c)) {
          sqls.push(`ALTER TABLE ${fq(tname)} MODIFY COLUMN ${U.columnDef(D, c)}${posSql};`);
        }
        prev = c.name;
      }
      for (const b of before) {
        if (!after.find((c) => (c.origName || c.name) === b.name)) {
          sqls.push(`ALTER TABLE ${fq(tname)} DROP COLUMN ${U.q(D, b.name)};`);
        }
      }
      if (apk && bpk !== apk) {
        sqls.push(`ALTER TABLE ${fq(tname)} ADD PRIMARY KEY (${after.filter((c) => c.pk).map((c) => U.q(D, c.name)).join(', ')});`);
      }
      // 索引 / 外键 / 唯一键 / 检查约束 / 表选项 / 表注释 差异
      sqls.push(...U.objectAlterSql(D, spec, fq(tname)));
      return sqls;
    },

    async applyAlter(spec) {
      const sqls = await s.alterScript(spec);
      for (const sql of sqls) await conn.query(sql);
      return { executed: sqls.length };
    },

    async dropTable({ db, table }) {
      await conn.query(`DROP TABLE ${U.qualify(D, db, null, table)}`);
    },
    async truncateTable({ db, table }) {
      await conn.query(`TRUNCATE TABLE ${U.qualify(D, db, null, table)}`);
    },
    async renameTable({ db, table, newName }) {
      await conn.query(`RENAME TABLE ${U.qualify(D, db, null, table)} TO ${U.qualify(D, db, null, newName)}`);
    },
    async createDatabase(name) {
      await conn.query(`CREATE DATABASE ${U.q(D, name)} DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci`);
    },
    async dropDatabase({ db }) {
      await conn.query(`DROP DATABASE ${U.q(D, db)}`);
    },

    // ---- 函数/过程/触发器/事件/视图/索引 ----
    async objectDdl({ db, kind, name, table }) {
      if (kind === 'index') {
        // SHOW CREATE INDEX 不给可执行 DDL，从 STATISTICS 合成建索引语句（全部绑定参数）
        const [rows] = await conn.query(
          'SELECT NON_UNIQUE, COLUMN_NAME, SUB_PART, INDEX_TYPE FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_NAME = ? ORDER BY SEQ_IN_INDEX',
          [db, table, name]
        );
        if (!rows.length) return '-- 未找到索引';
        const uniq = Number(rows[0].NON_UNIQUE) === 0;
        const cols = rows
          .map((r) => U.q(D, r.COLUMN_NAME) + (r.SUB_PART ? `(${Number(r.SUB_PART)})` : ''))
          .join(', ');
        const using = rows[0].INDEX_TYPE && rows[0].INDEX_TYPE !== 'BTREE' ? ` USING ${rows[0].INDEX_TYPE}` : '';
        return `CREATE ${uniq ? 'UNIQUE ' : ''}INDEX ${U.q(D, name)} ON ${U.qualify(D, db, null, table)} (${cols})${using};`;
      }
      const kindMap = { function: 'FUNCTION', procedure: 'PROCEDURE', trigger: 'TRIGGER', event: 'EVENT', view: 'VIEW' };
      const k = kindMap[kind];
      if (!k) throw new Error('不支持的对象类型: ' + kind);
      const [rows] = await conn.query(`SHOW CREATE ${k} ${U.qualify(D, db, null, name)}`);
      const r = rows[0] || {};
      const key = Object.keys(r).find((x) => /^Create /i.test(x) || /Original Statement/i.test(x));
      return key ? r[key] : JSON.stringify(r);
    },
    async dropObject({ db, kind, name, table }) {
      if (kind === 'index') {
        await conn.query(`DROP INDEX ${U.q(D, name)} ON ${U.qualify(D, db, null, table)}`);
        return;
      }
      const kindMap = { function: 'FUNCTION', procedure: 'PROCEDURE', trigger: 'TRIGGER', event: 'EVENT', view: 'VIEW' };
      await conn.query(`DROP ${kindMap[kind]} ${U.qualify(D, db, null, name)}`);
    },

    // 结构明细行删除（侧边栏索引/外键/唯一键/检查/触发器右键）：DDL 由引擎统一生成
    async dropStruct(arg) {
      for (const st of U.dropStructSql(D, arg)) await conn.query(st);
    },

    // 视图设计器保存：DDL 由引擎统一生成（标识符经 q() 转义）
    async createView(arg) {
      return this.query({ sqlText: U.createViewSql(D, arg), db: arg.db, schema: arg.schema });
    },

    // ---- 用户与权限 ----
    async users() {
      const [rows] = await conn.query('SELECT user, host FROM mysql.user ORDER BY user, host');
      return rows.map((r) => ({ name: r.user, host: r.host }));
    },
    async createUser({ user, host, password }) {
      await conn.query(`CREATE USER ${U.lit(D, user)}@${U.lit(D, host || '%')} IDENTIFIED BY ${U.lit(D, password || '')}`);
    },
    async dropUser({ user, host }) {
      await conn.query(`DROP USER ${U.lit(D, user)}@${U.lit(D, host || '%')}`);
    },
    async listGrants({ user, host }) {
      const [rows] = await conn.query(`SHOW GRANTS FOR ${U.lit(D, user)}@${U.lit(D, host || '%')}`);
      return rows.map((r) => Object.values(r)[0]);
    },
    async grantTo({ user, host, privs, db }) {
      const allowed = ['ALL PRIVILEGES', 'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'DROP', 'ALTER', 'INDEX', 'REFERENCES'];
      const list = (privs || []).filter((p) => allowed.includes(p));
      if (!list.length) throw new Error('未选择任何权限');
      const scope = db && db.trim() ? U.q(D, db.trim()) + '.*' : '*.*';
      await conn.query(`GRANT ${list.join(', ')} ON ${scope} TO ${U.lit(D, user)}@${U.lit(D, host || '%')}`);
    },

    // ---- 备份导出 ----
    async dumpTable({ db, table }) {
      const parts = [];
      try {
        parts.push(await s.ddl({ db, table }) + ';');
      } catch {
        parts.push('-- 无法取得 ' + table + ' 的 DDL');
      }
      const cols = await s.columns({ db, table });
      const full = U.qualify(D, db, null, table);
      const colList = cols.map((c) => U.q(D, c.name)).join(', ');
      const BATCH = 500;
      for (let page = 1; ; page += 1) {
        const r = await s.page({ db, table, pageNo: page, pageSize: BATCH });
        if (!r.rows.length) break;
        for (const row of r.rows) {
          parts.push(`INSERT INTO ${full} (${colList}) VALUES (${row.map((v) => U.lit(D, v)).join(', ')});`);
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
      const cols = await s.columns({ db: spec.db, table: spec.table });
      const known = new Set(cols.map((c) => c.name));
      const use = header.map((h) => (known.has(String(h).trim()) ? String(h).trim() : null));
      const full = U.qualify(D, spec.db, null, spec.table);
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
      await conn.query('START TRANSACTION');
      try {
        for (const st of stmts) await conn.query(st.sql, st.params);
        await conn.query('COMMIT');
      } catch (e) {
        await conn.query('ROLLBACK');
        throw e;
      }
      return { inserted: stmts.length, columns: header.filter((h) => known.has(String(h).trim())).length };
    },
    async insertRows(spec) {
      const full = U.qualify(D, spec.db, null, spec.table);
      const sql = `INSERT INTO ${full} (${spec.columns.map((c) => U.q(D, c)).join(', ')}) VALUES (${spec.columns.map(() => '?').join(', ')})`;
      await conn.query('START TRANSACTION');
      try {
        for (const r of spec.rows) await conn.query(sql, r);
        await conn.query('COMMIT');
      } catch (e) {
        await conn.query('ROLLBACK');
        throw e;
      }
      return { inserted: spec.rows.length };
    },
  };
  return s;
}

module.exports = { create };
