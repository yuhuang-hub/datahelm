'use strict';
const oracledb = require('oracledb');
const U = require('../sqlutil');

// thin 模式（纯 JS，无需 Oracle Instant Client）；CLOB 直接以字符串返回
oracledb.fetchAsString = [oracledb.CLOB];

const KIND_TYPE = {
  table: 'TABLE', view: 'VIEW', function: 'FUNCTION', procedure: 'PROCEDURE',
  trigger: 'TRIGGER', sequence: 'SEQUENCE',
  index: 'INDEX', type: 'TYPE', synonym: 'SYNONYM', package: 'PACKAGE',
  mviewlog: 'MATERIALIZED_VIEW_LOG', javasrc: 'JAVA_SOURCE', tablespace: 'TABLESPACE',
};
const DDL_TYPE = { ...KIND_TYPE, pubsynonym: 'PUBLIC_SYNONYM' };
const DROP_TYPE = {
  index: 'INDEX', type: 'TYPE', synonym: 'SYNONYM', package: 'PACKAGE', javasrc: 'JAVA SOURCE',
};

// Oracle 语句切分：脚本里有独占一行的 "/"（PL/SQL 块结束符）时按它切，
// 否则退回通用切分（引号/注释感知）
function splitOracle(text) {
  const t = String(text || '');
  if (/^\s*\/\s*$/m.test(t)) {
    return t
      .split(/^\s*\/\s*$/m)
      .map((x) => x.trim().replace(/;\s*$/, ''))
      .filter(Boolean);
  }
  return U.splitStatements(t);
}

async function create(cfg, localPort) {
  const D = 'oracle';
  const service = String(cfg.serviceName || '').trim();
  const connectString =
    service.startsWith('(')
      ? service // 完整 TNS 串
      : `${localPort ? '127.0.0.1' : cfg.host || 'localhost'}:${localPort || Number(cfg.port) || 1521}/${service || 'ORCL'}`;
  const conn = await oracledb.getConnection({
    user: cfg.user || '',
    password: cfg.password || '',
    connectString,
  });

  // Oracle 单会话不支持并发执行，串行化（同 MSSQL 的 TDS 做法）
  let chain = Promise.resolve();
  function run(sql, binds, opts) {
    const task = () =>
      conn.execute(sql, binds || {}, Object.assign({ autoCommit: true, maxRows: 5000 }, opts || {}));
    const p = chain.then(task, task);
    chain = p.catch(() => {});
    return p;
  }

  let serverInfo = 'Oracle 数据库';
  try {
    const v = await run("SELECT banner FROM v$version WHERE banner LIKE 'Oracle%'");
    if (v.rows.length) serverInfo = String(v.rows[0][0]).trim();
  } catch {} // 无 v$version 权限时退回默认

  const s = {
    type: D,
    serverInfo,
    close: () => {
      try { conn.close(); } catch {}
    },

    async treeRoot() {
      const r = await run('SELECT username FROM all_users ORDER BY username');
      // 实例级目录（不属于某个方案）：公用对象 / 表空间 / 回收站（模型目录由界面层注入）
      return [
        ...r.rows.map((row) => ({ type: 'schema', name: row[0] })),
        { type: 'cat', kind: 'pubsynonym', name: '公用同义词' },
        { type: 'cat', kind: 'pubdblink', name: '公用数据库链接' },
        { type: 'cat', kind: 'tablespace', name: '表空间' },
        { type: 'cat', kind: 'recyclebin', name: '回收站' },
      ];
    },

    async treeChildren(node) {
      if (node.type === 'schema') {
        return [
          { type: 'cat', kind: 'table', schema: node.name, name: '表' },
          { type: 'cat', kind: 'view', schema: node.name, name: '视图' },
          { type: 'cat', kind: 'function', schema: node.name, name: '函数' },
          { type: 'cat', kind: 'procedure', schema: node.name, name: '存储过程' },
          { type: 'cat', kind: 'trigger', schema: node.name, name: '触发器' },
          { type: 'cat', kind: 'sequence', schema: node.name, name: '序列' },
          { type: 'cat', kind: 'type', schema: node.name, name: '类型' },
          { type: 'cat', kind: 'synonym', schema: node.name, name: '同义词' },
          { type: 'cat', kind: 'package', schema: node.name, name: '包' },
          { type: 'cat', kind: 'mviewlog', schema: node.name, name: '实体化视图日志' },
          { type: 'cat', kind: 'dblink', schema: node.name, name: '数据库链接' },
          { type: 'cat', kind: 'xmlschema', schema: node.name, name: 'XML 架构' },
          { type: 'cat', kind: 'javasrc', schema: node.name, name: 'Java 源码' },
        ];
      }
      if (node.type === 'cat') {
        if (node.kind === 'recyclebin') {
          const r = await run('SELECT object_name, original_name, type, droptime FROM user_recyclebin ORDER BY droptime DESC');
          return r.rows.map((row) => ({ type: 'recycle', name: row[1] || row[0], bin: row[0], rtype: row[2], droptime: row[3] }));
        }
        if (node.kind === 'pubsynonym') {
          const r = await run("SELECT synonym_name FROM all_synonyms WHERE owner = 'PUBLIC' ORDER BY synonym_name");
          return r.rows.map((row) => ({ type: 'pubsynonym', name: row[0] }));
        }
        if (node.kind === 'pubdblink') {
          const r = await run("SELECT db_link FROM all_db_links WHERE owner = 'PUBLIC' ORDER BY db_link");
          return r.rows.map((row) => ({ type: 'pubdblink', name: row[0] }));
        }
        if (node.kind === 'tablespace') {
          const r = await run('SELECT tablespace_name FROM user_tablespaces ORDER BY tablespace_name');
          return r.rows.map((row) => ({ type: 'tablespace', name: row[0] }));
        }
        const b = { o: node.schema };
        if (node.kind === 'table') {
          const r = await run(
            'SELECT table_name FROM all_tables WHERE owner = :o AND nested = \'NO\' AND secondary = \'NO\' AND table_name NOT LIKE \'BIN$%\' ORDER BY table_name',
            b
          );
          return r.rows.map((row) => ({ type: 'table', schema: node.schema, name: row[0] }));
        }
        if (node.kind === 'view') {
          const r = await run('SELECT view_name FROM all_views WHERE owner = :o ORDER BY view_name', b);
          return r.rows.map((row) => ({ type: 'view', schema: node.schema, name: row[0] }));
        }
        if (node.kind === 'function' || node.kind === 'procedure' || node.kind === 'type' || node.kind === 'package' || node.kind === 'javasrc') {
          const t = node.kind === 'function' ? 'FUNCTION'
            : node.kind === 'procedure' ? 'PROCEDURE'
            : node.kind === 'type' ? 'TYPE'
            : node.kind === 'package' ? 'PACKAGE'
            : 'JAVA SOURCE';
          const r = await run(
            "SELECT object_name FROM all_objects WHERE owner = :o AND object_type = :t AND generated = 'N' AND status = 'VALID' ORDER BY object_name",
            { o: node.schema, t }
          );
          return r.rows.map((row) => ({ type: node.kind, schema: node.schema, name: row[0] }));
        }
        if (node.kind === 'trigger') {
          const r = await run('SELECT trigger_name FROM all_triggers WHERE owner = :o ORDER BY trigger_name', b);
          return r.rows.map((row) => ({ type: 'trigger', schema: node.schema, name: row[0] }));
        }
        if (node.kind === 'sequence') {
          const r = await run('SELECT sequence_name FROM all_sequences WHERE sequence_owner = :o ORDER BY sequence_name', b);
          return r.rows.map((row) => ({ type: 'sequence', schema: node.schema, name: row[0] }));
        }
        if (node.kind === 'synonym') {
          const r = await run('SELECT synonym_name FROM all_synonyms WHERE owner = :o ORDER BY synonym_name', b);
          return r.rows.map((row) => ({ type: 'synonym', schema: node.schema, name: row[0] }));
        }
        if (node.kind === 'mviewlog') {
          const r = await run('SELECT master, log_table FROM all_mview_logs WHERE owner = :o ORDER BY master', b);
          return r.rows.map((row) => ({ type: 'mviewlog', schema: node.schema, name: row[1], table: row[0] }));
        }
        if (node.kind === 'dblink') {
          const r = await run('SELECT db_link FROM all_db_links WHERE owner = :o ORDER BY db_link', b);
          return r.rows.map((row) => ({ type: 'dblink', schema: node.schema, name: row[0] }));
        }
        if (node.kind === 'xmlschema') {
          const r = await run('SELECT schema FROM user_xml_schemas ORDER BY schema');
          return r.rows.map((row) => ({ type: 'xmlschema', schema: node.schema, name: row[0] }));
        }
      }
      return [];
    },

    async columns({ schema, table }) {
      const r = await run(
        `SELECT column_name, data_type, char_length, data_precision, data_scale, nullable, data_default
         FROM all_tab_columns WHERE owner = :o AND table_name = :t ORDER BY column_id`,
        { o: schema, t: table }
      );
      return r.rows.map((row) => {
        const dt = String(row[1]).toUpperCase();
        const isNum = /NUMBER|BINARY/.test(dt);
        return {
          name: row[0],
          dataType: dt,
          display: dt === 'NUMBER' && row[3] ? `NUMBER(${row[3]}${row[4] != null ? ',' + row[4] : ''})` : dt,
          length: isNum ? (row[3] != null ? Number(row[3]) : null) : row[2] != null ? Number(row[2]) : null,
          scale: row[4] != null ? Number(row[4]) : null,
          nullable: row[5] === 'Y',
          pk: false,
          autoInc: /identity/i.test(String(row[6] || '')),
          defaultValue: row[6] != null ? String(row[6]).trim() : null,
          comment: '',
        };
      });
    },

    async tables({ schema }) {
      const r = await run(
        "SELECT table_name FROM all_tables WHERE owner = :o AND nested = 'NO' AND secondary = 'NO' AND table_name NOT LIKE 'BIN$%' ORDER BY table_name",
        { o: schema }
      );
      return r.rows.map((row) => row[0]);
    },

    // 工具栏「表/视图」对象列表页：名称 + 行数（all_tables 统计值，可为空）+ 注释（all_tab_comments；视图无行数统计）
    async objList({ schema, kind }) {
      if (kind === 'view') {
        const r = await run(
          `SELECT v.view_name, COALESCE(c.comments, '')
           FROM all_views v LEFT JOIN all_tab_comments c ON c.owner = v.owner AND c.table_name = v.view_name
           WHERE v.owner = :o ORDER BY v.view_name`,
          { o: schema }
        );
        return r.rows.map((row) => ({ name: row[0], rows: null, comment: row[1] == null ? '' : String(row[1]) }));
      }
      const r = await run(
        `SELECT t.table_name, t.num_rows, COALESCE(c.comments, '')
         FROM all_tables t LEFT JOIN all_tab_comments c ON c.owner = t.owner AND c.table_name = t.table_name
         WHERE t.owner = :o AND t.nested = 'NO' AND t.secondary = 'NO' AND t.table_name NOT LIKE 'BIN$%'
         ORDER BY t.table_name`,
        { o: schema }
      );
      return r.rows.map((row) => ({
        name: row[0],
        rows: row[1] == null ? null : Number(row[1]),
        comment: row[2] == null ? '' : String(row[2]),
      }));
    },

    async page({ schema, table, pageNo = 1, pageSize = 100, where, orderCol, orderDir }) {
      const full = U.qualify(D, null, schema, table);
      const cols = await s.columns({ schema, table });
      const colList = cols.map((c) => U.q(D, c.name)).join(', ');
      const w = where && where.trim() ? ` WHERE (${where})` : '';
      const ord = orderCol ? ` ORDER BY ${U.q(D, orderCol)} ${orderDir === 'DESC' ? 'DESC' : 'ASC'}` : '';
      const cnt = await run(`SELECT COUNT(*) FROM ${full}${w}`);
      const r = await run(
        `SELECT * FROM (
           SELECT t.*, ROWNUM rn FROM (
             SELECT ${colList} FROM ${full}${w}${ord}
           ) t WHERE ROWNUM <= :hi
         ) WHERE rn > :lo`,
        { hi: pageNo * pageSize, lo: (pageNo - 1) * pageSize },
        { maxRows: Number(pageSize) + 10 }
      );
      return {
        columns: cols,
        rows: r.rows.map((row) => row.slice(0, cols.length)), // 末列是行号 rn，丢弃
        total: Number(cnt.rows[0][0]),
      };
    },

    async query(arg) {
      const a = typeof arg === 'string' ? { sqlText: arg } : arg || {};
      const sqlText = a.sqlText || '';
      const out = [];
      // 查询页可切换目标 schema：会话级 CURRENT_SCHEMA（名来自 treeRoot 枚举 + q() 转义，非用户拼接）
      if (a.schema) await run(`ALTER SESSION SET CURRENT_SCHEMA = ${U.q(D, a.schema)}`);
      for (const st of splitOracle(sqlText)) {
        const t0 = Date.now();
        try {
          const r = await run(st);
          const elapsed = Date.now() - t0;
          if (r.metaData && r.metaData.length) {
            out.push({
              sql: st, command: 'SELECT', columns: r.metaData.map((m) => m.name),
              rows: r.rows,
              rowCount: r.rows.length, elapsed,
            });
          } else {
            out.push({
              sql: st, command: 'OK', columns: [], rows: [],
              rowCount: r.rowsAffected || 0, elapsed,
            });
          }
        } catch (e) {
          out.push({ sql: st, command: 'ERROR', columns: [], rows: [], rowCount: 0, error: e.message, elapsed: Date.now() - t0 });
        }
      }
      return out;
    },

    async changes(spec) {
      const stmts = U.buildChangeSql(D, null, spec.schema, spec.table, spec);
      for (const st of stmts) await run(st.sql, st.params);
      return { executed: stmts.length };
    },

    async ddl({ schema, table }) {
      const r = await run('SELECT dbms_metadata.get_ddl(:t, :n, :o) FROM dual', { t: 'TABLE', n: table, o: schema });
      return String(r.rows[0][0]);
    },

    async createTable(spec) {
      const sql = U.createTableSql(D, { ...spec, schema: spec.schema });
      await run(sql);
      return sql;
    },

    // 仅生成建表 SQL（结构同步预览用）：与 createTable 同源（Oracle 目标仅同步列定义）
    async createTableScript(spec) {
      return [U.createTableSql(D, { ...spec, schema: spec.schema })];
    },

    async alterScript() {
      throw new Error('Oracle 表结构变更请直接编写 ALTER TABLE 语句（查询窗口执行）');
    },
    async applyAlter() {
      throw new Error('Oracle 表结构变更请直接编写 ALTER TABLE 语句（查询窗口执行）');
    },

    async dropTable({ schema, table }) {
      await run(`DROP TABLE ${U.qualify(D, null, schema, table)} PURGE`);
    },
    async truncateTable({ schema, table }) {
      await run(`TRUNCATE TABLE ${U.qualify(D, null, schema, table)}`);
    },
    async renameTable({ schema, table, newName }) {
      await run(`ALTER TABLE ${U.qualify(D, null, schema, table)} RENAME TO ${U.q(D, newName)}`);
    },
    async createDatabase() {
      throw new Error('Oracle 的“数据库”即方案（用户），请在服务器上 CREATE USER 后用它登录');
    },
    async dropDatabase() {
      throw new Error('Oracle 不支持在此删除方案，请使用 DROP USER ... CASCADE');
    },

    // ---- 对象（视图/函数/存储过程/触发器/序列/索引/类型/同义词/包 等）----
    async objectDdl(arg) {
      const { schema, kind, name, table } = arg;
      if (kind === 'recycle') {
        return [
          '-- 回收站对象（FLASHBACK 可还原）',
          `原始名: ${arg.original || name}`,
          `对象名: ${arg.bin || name}`,
          `类型: ${arg.rtype || ''}`,
          `删除时间: ${arg.droptime || ''}`,
          `-- 还原：FLASHBACK TABLE "${arg.bin || name}" TO BEFORE DROP;`,
        ].join('\n');
      }
      if (kind === 'dblink' || kind === 'pubdblink') {
        const r = await run(
          'SELECT username, host FROM all_db_links WHERE owner = :o AND db_link = :n',
          { o: kind === 'pubdblink' ? 'PUBLIC' : schema, n: name }
        );
        const row = r.rows[0] || [];
        return [
          `CREATE ${kind === 'pubdblink' ? 'PUBLIC ' : ''}DATABASE LINK ${U.q(D, name)}`,
          `  CONNECT TO ${row[0] || '<用户>'} IDENTIFIED BY <密码不可见>`,
          `  USING '${String(row[1] || '').replace(/'/g, "''")}';`,
        ].join('\n');
      }
      if (kind === 'xmlschema') {
        return [
          `-- XML 架构：${name}`,
          '-- 注册：BEGIN DBMS_XMLSCHEMA.registerSchema(schemaUrl => :url, xmldoc => :doc); END;',
          '-- 删除：BEGIN DBMS_XMLSCHEMA.deleteSchema(schemaUrl => :url); END;',
        ].join('\n');
      }
      const t = DDL_TYPE[kind];
      if (!t) throw new Error('不支持的对象类型: ' + kind);
      const pub = kind === 'pubsynonym' || kind === 'pubdblink' || kind === 'tablespace';
      try {
        const r = await run(
          pub ? 'SELECT dbms_metadata.get_ddl(:t, :n) FROM dual' : 'SELECT dbms_metadata.get_ddl(:t, :n, :o) FROM dual',
          pub ? { t, n: name } : { t, n: name, o: schema }
        );
        return String(r.rows[0][0]).trim() || '-- 空定义';
      } catch (e) {
        if (kind === 'tablespace') return `-- 无法读取表空间 DDL（可能缺少权限）：${e.message}`;
        if (kind === 'mviewlog' && table) return `-- 实体化视图日志（主表 ${table}）\n-- DROP MATERIALIZED VIEW LOG ON ${U.qualify(D, null, schema, table)};`;
        throw e;
      }
    },
    async dropObject({ schema, kind, name, table }) {
      if (kind === 'pubsynonym') {
        await run(`DROP PUBLIC SYNONYM ${U.q(D, name)}`);
        return;
      }
      if (kind === 'pubdblink') {
        await run(`DROP PUBLIC DATABASE LINK ${U.q(D, name)}`);
        return;
      }
      if (kind === 'dblink') {
        await run(`DROP DATABASE LINK ${U.q(D, name)}`);
        return;
      }
      if (kind === 'mviewlog') {
        await run(`DROP MATERIALIZED VIEW LOG ON ${U.qualify(D, null, schema, table)}`);
        return;
      }
      if (kind === 'xmlschema') {
        await run('BEGIN dbms_xmlschema.deleteSchema(:n); END;', { n: name });
        return;
      }
      if (kind === 'tablespace') {
        throw new Error('为安全起见，表空间不在界面内删除，请在数据库服务器上手动管理');
      }
      const t = DROP_TYPE[kind] || KIND_TYPE[kind];
      if (!t) throw new Error('不支持的对象类型: ' + kind);
      await run(`DROP ${t} ${U.qualify(D, null, schema, name)}`);
    },

    // 结构明细行删除（侧边栏索引/外键/唯一键/检查/触发器右键）：DDL 由引擎统一生成
    async dropStruct(arg) {
      for (const st of U.dropStructSql(D, arg)) await run(st);
    },

    // ---- 回收站：还原 / 彻底删除 / 清空（BIN$ 名来自 user_recyclebin 枚举）----
    async recycleRestore({ bin }) {
      await run(`FLASHBACK TABLE ${U.q(D, bin)} TO BEFORE DROP`);
    },
    async recyclePurge({ bin }) {
      await run(`PURGE TABLE ${U.q(D, bin)}`);
    },
    async recycleEmpty() {
      await run('PURGE RECYCLEBIN');
    },

    // 视图设计器保存：DDL 由引擎统一生成（标识符经 q() 转义）
    async createView(arg) {
      return this.query({ sqlText: U.createViewSql(D, arg), db: arg.db, schema: arg.schema });
    },

    // ---- CSV 导入 / 批量插入（参数化）----
    async importCsv(spec) {
      const { parseCsv } = require('../csv');
      const fs = require('fs');
      const { header, rows } = parseCsv(fs.readFileSync(spec.file, 'utf8'));
      const cols = await s.columns({ schema: spec.schema, table: spec.table });
      const known = new Set(cols.map((c) => c.name));
      const use = header.map((h) => (known.has(String(h).trim()) ? String(h).trim() : null));
      const full = U.qualify(D, null, spec.schema, spec.table);
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
      for (const st of stmts) await run(st.sql, st.params);
      return { inserted: stmts.length, columns: header.filter((h) => known.has(String(h).trim())).length };
    },
    async insertRows(spec) {
      const full = U.qualify(D, null, spec.schema, spec.table);
      const sql = `INSERT INTO ${full} (${spec.columns.map((c) => U.q(D, c)).join(', ')}) VALUES (${spec.columns
        .map((_, i) => ':' + (i + 1))
        .join(', ')})`;
      for (const r of spec.rows) await run(sql, r);
      return { inserted: spec.rows.length };
    },

    // ---- 备份导出 ----
    async dumpTable({ schema, table }) {
      const parts = [];
      try {
        parts.push(await s.ddl({ schema, table }) + ';');
      } catch {
        parts.push('-- 无法取得 ' + table + ' 的 DDL');
      }
      const cols = await s.columns({ schema, table });
      const full = U.qualify(D, null, schema, table);
      const colList = cols.map((c) => U.q(D, c.name)).join(', ');
      const BATCH = 500;
      for (let page = 1; ; page += 1) {
        const r = await run(
          `SELECT * FROM (SELECT t.*, ROWNUM rn FROM (SELECT ${colList} FROM ${full}) t WHERE ROWNUM <= :hi) WHERE rn > :lo`,
          { hi: page * BATCH, lo: (page - 1) * BATCH },
          { maxRows: BATCH + 10 }
        );
        if (!r.rows.length) break;
        for (const row of r.rows) {
          parts.push(
            `INSERT INTO ${full} (${colList}) VALUES (${cols.map((c, i) => U.lit(D, row[i])).join(', ')});`
          );
        }
        if (r.rows.length < BATCH) break;
      }
      return parts.join('\n');
    },
  };
  return s;
}

module.exports = { create };
