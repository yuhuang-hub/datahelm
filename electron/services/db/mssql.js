'use strict';
const { Connection, Request, TYPES } = require('tedious');
const U = require('../sqlutil');

async function create(cfg, localPort) {
  const D = 'mssql';
  const conn = await new Promise((resolve, reject) => {
    const c = new Connection({
      server: cfg.host || 'localhost',
      authentication: { type: 'default', options: { userName: cfg.user || 'sa', password: cfg.password || '' } },
      options: {
        port: localPort || Number(cfg.port) || 1433,
        database: cfg.database || 'master',
        encrypt: cfg.encrypt !== false,
        trustServerCertificate: cfg.sslVerify !== true ? true : false, // 自签名证书默认信任，可配置
        connectTimeout: 15000,
        requestTimeout: 60000,
      },
    });
    c.on('connect', (err) => (err ? reject(err) : resolve(c)));
    c.on('error', (e) => reject(e));
    c.connect();
  });

  // tedious 单连接一次只能挂一个请求，串行化执行 SQL 批（TDS 协议，非 shell）
  // params 非空时按 @pN 占位符绑定 NVarChar 参数（服务器侧隐式转换类型）
  let chain = Promise.resolve();
  // 会话当前库跟踪：读路径的批前 USE 会改变会话库；query 据此判断是否需要 USE/切回默认
  const defDb = cfg.database || 'master';
  let curDb = defDb;
  // useBatch=true 走 execSqlBatch：保留会话 SET 状态（execSql 会按请求重置——SET SHOWPLAN 只能配 execSqlBatch）
  function runSql(text, db, params, useBatch) {
    const task = () =>
      new Promise((resolve, reject) => {
        const full = db ? `USE ${U.q(D, db)}; ${text}` : text;
        const resultsets = [];
        let cur = null;
        const finishCur = () => {
          if (cur && cur.columns.length) resultsets.push(cur);
          cur = null;
        };
        const req = new Request(full, (err, rowCount) => {
          if (err) {
            // tedious 批错误是 AggregateError（message 为空，真实错误在 errors 数组）
            const agg = err && Array.isArray(err.errors) && err.errors.length ? err.errors.map((x) => x.message || String(x)).join('; ') : null;
            reject(new Error(agg || (err && err.message) || String(err)));
            return;
          }
          finishCur();
          if (db) curDb = db; // 批前 USE 已改变会话库（语句失败也不回滚 USE）
          resolve({ resultsets, lastRowCount: rowCount || 0 });
        });
        if (params && params.length) {
          params.forEach((v, i) => req.addParameter('p' + i, TYPES.NVarChar, v === null ? null : String(v)));
        }
        req.on('columnMetadata', (cols) => {
          finishCur();
          cur = { columns: cols.map((c) => c.colName), rows: [] };
        });
        req.on('row', (row) => {
          if (!cur) cur = { columns: row.map((c) => c.metadata.colName), rows: [] };
          cur.rows.push(row.map((c) => c.value));
        });
        if (useBatch) conn.execSqlBatch(req);
        else conn.execSql(req);
      });
    const p = chain.then(task, task);
    chain = p.catch(() => {});
    return p;
  }

  const vRes = await runSql('SELECT @@VERSION AS v');
  const serverInfo = String(vRes.resultsets[0].rows[0][0]).split('\n')[0].trim();

  async function pkConstraintName(db, schema, table) {
    const r = await runSql(
      `SELECT name FROM sys.key_constraints WHERE parent_object_id = OBJECT_ID(${U.lit(D, `${db}.${schema}.${table}`)}) AND type = 'PK'`,
      db
    );
    return r.resultsets[0].rows.length ? r.resultsets[0].rows[0][0] : null;
  }

  // sp_rename 的 objname 纯点分路径（v0927.52 实测）：中段不能空——db 只有在 schema 存在时才可携带
  // （'db.表' 两段会被解析成 schema.表；带引号/双点形态一律语法错）。语句执行前已 USE 对应库，裸表名安全。
  function spPath(db, schema, ...rest) {
    return (schema ? [db, schema, ...rest] : rest).filter(Boolean).join('.');
  }

  const s = {
    type: D,
    serverInfo,
    close: () => {
      try { conn.close(); } catch {}
    },

    async treeRoot() {
      const r = await runSql('SELECT name FROM sys.databases WHERE state = 0 ORDER BY name');
      return r.resultsets[0].rows.map((row) => ({ type: 'db', name: row[0] }));
    },

    async treeChildren(node) {
      if (node.type === 'db') {
        return [
          { type: 'cat', kind: 'table', db: node.name, name: '表' },
          { type: 'cat', kind: 'view', db: node.name, name: '视图' },
          { type: 'cat', kind: 'procedure', db: node.name, name: '存储过程' },
          { type: 'cat', kind: 'function', db: node.name, name: '函数' },
          { type: 'cat', kind: 'trigger', db: node.name, name: '触发器' },
        ];
      }
      if (node.type === 'cat') {
        if (node.kind === 'table' || node.kind === 'view') {
          const typeChar = node.kind === 'view' ? 'V' : 'U';
          const r = await runSql(
            `SELECT s.name AS sch, o.name AS name FROM sys.objects o
             JOIN sys.schemas s ON s.schema_id = o.schema_id
             WHERE o.is_ms_shipped = 0 AND s.name NOT IN ('sys','INFORMATION_SCHEMA') AND o.type = '${typeChar}'
             ORDER BY s.name, o.name`,
            node.db
          );
          return r.resultsets[0].rows.map((row) => ({ type: node.kind, db: node.db, schema: row[0], name: row[1] }));
        }
        if (node.kind === 'procedure' || node.kind === 'function') {
          const typeFilter = node.kind === 'procedure' ? "o.type = 'P'" : "o.type IN ('FN','IF','TF')";
          const r = await runSql(
            `SELECT s.name AS sch, o.name AS name FROM sys.objects o
             JOIN sys.schemas s ON s.schema_id = o.schema_id
             WHERE o.is_ms_shipped = 0 AND s.name NOT IN ('sys','INFORMATION_SCHEMA') AND ${typeFilter}
             ORDER BY s.name, o.name`,
            node.db
          );
          return r.resultsets[0].rows.map((row) => ({ type: node.kind, db: node.db, schema: row[0], name: row[1] }));
        }
        if (node.kind === 'trigger') {
          const r = await runSql(
            `SELECT s.name AS sch, t.name AS name FROM sys.triggers t
             JOIN sys.objects o ON o.object_id = t.parent_id
             JOIN sys.schemas s ON s.schema_id = o.schema_id
             WHERE t.is_ms_shipped = 0 AND s.name NOT IN ('sys','INFORMATION_SCHEMA')
             ORDER BY s.name, t.name`,
            node.db
          );
          return r.resultsets[0].rows.map((row) => ({ type: 'trigger', db: node.db, schema: row[0], name: row[1] }));
        }
      }
      return [];
    },

    async columns({ db, schema, table }) {
      const sch = schema || 'dbo';
      const r = await runSql(
        `SELECT c.COLUMN_NAME, c.DATA_TYPE,
                c.CHARACTER_MAXIMUM_LENGTH, c.NUMERIC_PRECISION, c.NUMERIC_SCALE,
                c.IS_NULLABLE, c.COLUMN_DEFAULT,
                COLUMNPROPERTY(OBJECT_ID(${U.lit(D, `${db}.${sch}.${table}`)}), c.COLUMN_NAME, 'IsIdentity') AS ident
         FROM INFORMATION_SCHEMA.COLUMNS c
         WHERE c.TABLE_CATALOG = ${U.lit(D, db)} AND c.TABLE_SCHEMA = ${U.lit(D, sch)} AND c.TABLE_NAME = ${U.lit(D, table)}
         ORDER BY c.ORDINAL_POSITION`,
        db
      );
      const pkRes = await runSql(
        `SELECT kcu.COLUMN_NAME FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
         JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
           ON kcu.CONSTRAINT_NAME = tc.CONSTRAINT_NAME AND kcu.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA
         WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY' AND tc.CONSTRAINT_CATALOG = ${U.lit(D, db)}
           AND kcu.TABLE_SCHEMA = ${U.lit(D, sch)} AND kcu.TABLE_NAME = ${U.lit(D, table)}
         ORDER BY kcu.ORDINAL_POSITION`,
        db
      );
      const pkSet = new Set(pkRes.resultsets[0].rows.map((row) => row[0]));
      const withLen = ['CHAR', 'VARCHAR', 'NCHAR', 'NVARCHAR', 'BINARY', 'VARBINARY'];
      return r.resultsets[0].rows.map((row) => {
        const dt = String(row[1] || '').toUpperCase();
        const clen = row[2];
        const prec = row[3];
        const sc = row[4];
        let display = dt;
        if (clen != null && clen > 0 && clen < 2147483647 && withLen.includes(dt)) display = `${dt}(${clen})`;
        else if (prec != null && (dt === 'DECIMAL' || dt === 'NUMERIC')) display = `${dt}(${prec}${sc != null ? ',' + sc : ''})`;
        return {
          name: row[0],
          dataType: dt,
          display,
          length: clen != null && clen > 0 && clen < 2147483647 ? Number(clen) : prec != null ? Number(prec) : null,
          scale: sc != null ? Number(sc) : null,
          nullable: row[5] === 'YES',
          pk: pkSet.has(row[0]),
          autoInc: Number(row[7]) === 1,
          defaultValue: row[6],
          comment: '',
        };
      });
    },

    async tables({ db, schema }) {
      const sch = schema || 'dbo';
      const r = await runSql(
        `SELECT o.name FROM sys.objects o JOIN sys.schemas s ON s.schema_id = o.schema_id
         WHERE o.is_ms_shipped = 0 AND o.type = 'U' AND s.name = ${U.lit(D, sch)} ORDER BY o.name`,
        db
      );
      return r.resultsets[0].rows.map((row) => row[0]);
    },

    // 工具栏「表/视图」对象列表页：名称 + 行数（分区统计合计）+ 注释（MS_Description 扩展属性）。
    // typeChar 取值来自代码侧白名单（同 treeChildren 的表/视图分支），schema 名走 U.lit 标识符转义
    // v0927.52：schema='*' 枚举全部架构（对象列表页默认），行带 schema 字段；缺省/空仍默认 dbo（树内惯例）
    async objList({ db, schema, kind }) {
      const all = schema === '*';
      const sch = all ? '' : schema || 'dbo';
      const typeChar = kind === 'view' ? 'V' : 'U';
      const r = await runSql(
        `SELECT o.name, s.name AS sch,
                ISNULL((SELECT SUM(p.row_count) FROM sys.dm_db_partition_stats p
                        WHERE p.object_id = o.object_id AND p.index_id IN (0, 1)), 0),
                ISNULL((SELECT TOP 1 CAST(ep.value AS NVARCHAR(500)) FROM sys.extended_properties ep
                        WHERE ep.class = 1 AND ep.minor_id = 0 AND ep.major_id = o.object_id), '')
         FROM sys.objects o JOIN sys.schemas s ON s.schema_id = o.schema_id
         WHERE o.is_ms_shipped = 0 AND o.type = '${typeChar}'${all ? '' : ' AND s.name = ' + U.lit(D, sch)}
         ORDER BY s.name, o.name`,
        db
      );
      return r.resultsets[0].rows.map((row) => ({
        name: row[0],
        schema: row[1],
        rows: row[2] == null ? null : Number(row[2]),
        comment: row[3] == null ? '' : String(row[3]),
      }));
    },

    // 架构清单（对象列表页 schema 下拉；v0927.52）：排除系统架构与固定数据库角色
    async schemas({ db }) {
      const r = await runSql(
        `SELECT name FROM sys.schemas
         WHERE name NOT IN ('sys','INFORMATION_SCHEMA','guest') AND name NOT LIKE 'db[_]%'
         ORDER BY name`,
        db
      );
      return r.resultsets[0].rows.map((row) => row[0]);
    },

    // ---- 表对象内省：索引 / 唯一约束 / 外键 / 检查约束 / 触发器 / 表信息 ----
    async indexes({ db, schema, table }) {
      const sch = schema || 'dbo';
      // 约束后备索引（PK/UQ 约束）归 唯一键 页管理；含独立唯一索引；注释=class 7 扩展属性；
      // has_filter/filter_definition = 筛选索引（部分索引）谓词，原文保留（原样重写合法——canon 稳定）
      const r = await runSql(
        `SELECT i.name, c.name AS col, i.type_desc, i.is_unique, ic.is_descending_key,
               CAST(p.value AS NVARCHAR(MAX)) AS cmt,
               CAST(CASE WHEN i.has_filter = 1 THEN i.filter_definition ELSE NULL END AS NVARCHAR(4000)) AS flt
         FROM sys.indexes i
         JOIN sys.objects o ON o.object_id = i.object_id
         JOIN sys.schemas s ON s.schema_id = o.schema_id
         JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
         JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
         LEFT JOIN sys.extended_properties p ON p.class = 7 AND p.major_id = i.object_id AND p.minor_id = i.index_id AND p.name = 'MS_Description'
         WHERE s.name = ${U.lit(D, sch)} AND o.name = ${U.lit(D, table)} AND i.is_primary_key = 0 AND i.name IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM sys.key_constraints k WHERE k.parent_object_id = i.object_id AND k.unique_index_id = i.index_id)
         ORDER BY i.name, ic.key_ordinal`,
        db
      );
      const map = new Map();
      for (const row of r.resultsets[0].rows) {
        if (!map.has(row[0])) {
          map.set(row[0], {
            name: row[0],
            columns: [],
            dirs: [],
            type: String(row[2] || '').toUpperCase(),
            unique: Number(row[3]) === 1,
            comment: row[5] == null ? '' : String(row[5]),
            where: row[6] == null ? '' : String(row[6]),
          });
        }
        const g = map.get(row[0]);
        g.columns.push(row[1]);
        g.dirs.push(Number(row[4]) === 1 ? 'DESC' : '');
      }
      return [...map.values()];
    },
    async uniques({ db, schema, table }) {
      const sch = schema || 'dbo';
      // 聚集与否看后备索引 type_desc；注释挂在约束对象（class 1）上
      const r = await runSql(
        `SELECT k.name, c.name AS col, ix.type_desc,
               CAST(p.value AS NVARCHAR(MAX)) AS cmt
         FROM sys.key_constraints k
         JOIN sys.objects o ON o.object_id = k.parent_object_id
         JOIN sys.schemas s ON s.schema_id = o.schema_id
         JOIN sys.indexes ix ON ix.object_id = k.parent_object_id AND ix.index_id = k.unique_index_id
         JOIN sys.index_columns ic ON ic.object_id = k.parent_object_id AND ic.index_id = k.unique_index_id
         JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
         LEFT JOIN sys.extended_properties p ON p.class = 1 AND p.major_id = k.object_id AND p.minor_id = 0 AND p.name = 'MS_Description'
         WHERE s.name = ${U.lit(D, sch)} AND o.name = ${U.lit(D, table)} AND k.type = 'UQ'
         ORDER BY k.name, ic.key_ordinal`,
        db
      );
      const map = new Map();
      for (const row of r.resultsets[0].rows) {
        if (!map.has(row[0])) {
          map.set(row[0], { name: row[0], columns: [], clustered: String(row[2] || '').toUpperCase() === 'CLUSTERED', comment: row[3] == null ? '' : String(row[3]) });
        }
        map.get(row[0]).columns.push(row[1]);
      }
      return [...map.values()];
    },
    async fkeys({ db, schema, table }) {
      const sch = schema || 'dbo';
      const r = await runSql(
        `SELECT fk.name, pc.name AS col, rs.name AS rschema, rt.name AS rtable, rc.name AS rcol,
               fk.delete_referential_action_desc, fk.update_referential_action_desc,
               fk.is_disabled, fk.is_not_for_replication,
               CAST(p.value AS NVARCHAR(MAX)) AS cmt
         FROM sys.foreign_keys fk
         JOIN sys.objects o ON o.object_id = fk.parent_object_id
         JOIN sys.schemas s ON s.schema_id = o.schema_id
         JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
         JOIN sys.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id
         JOIN sys.objects rt ON rt.object_id = fkc.referenced_object_id
         JOIN sys.schemas rs ON rs.schema_id = rt.schema_id
         JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id
         LEFT JOIN sys.extended_properties p ON p.class = 1 AND p.major_id = fk.object_id AND p.minor_id = 0 AND p.name = 'MS_Description'
         WHERE s.name = ${U.lit(D, sch)} AND o.name = ${U.lit(D, table)}
         ORDER BY fk.name, fkc.constraint_column_id`,
        db
      );
      const map = new Map();
      for (const row of r.resultsets[0].rows) {
        if (!map.has(row[0])) {
          map.set(row[0], {
            name: row[0],
            columns: [],
            refSchema: row[2],
            refTable: row[3],
            refColumns: [],
            onDelete: String(row[5] || '').replace('_', ' '),
            onUpdate: String(row[6] || '').replace('_', ' '),
            enabled: Number(row[7]) !== 1,
            notForReplication: Number(row[8]) === 1,
            comment: row[9] == null ? '' : String(row[9]),
          });
        }
        const g = map.get(row[0]);
        g.columns.push(row[1]);
        g.refColumns.push(row[4]);
      }
      return [...map.values()];
    },
    async checks({ db, schema, table }) {
      const sch = schema || 'dbo';
      const r = await runSql(
        `SELECT cc.name, cc.definition, cc.is_disabled, cc.is_not_for_replication,
               CAST(p.value AS NVARCHAR(MAX)) AS cmt
         FROM sys.check_constraints cc
         JOIN sys.objects o ON o.object_id = cc.parent_object_id
         JOIN sys.schemas s ON s.schema_id = o.schema_id
         LEFT JOIN sys.extended_properties p ON p.class = 1 AND p.major_id = cc.object_id AND p.minor_id = 0 AND p.name = 'MS_Description'
         WHERE s.name = ${U.lit(D, sch)} AND o.name = ${U.lit(D, table)}
         ORDER BY cc.name`,
        db
      );
      return r.resultsets[0].rows.map((row) => ({
        name: row[0],
        expr: row[1],
        enabled: Number(row[2]) !== 1,
        notForReplication: Number(row[3]) === 1,
        comment: row[4] == null ? '' : String(row[4]),
      }));
    },
    async triggers({ db, schema, table }) {
      const sch = schema || 'dbo';
      const r = await runSql(
        `SELECT t.name, t.is_disabled, t.is_instead_of_trigger, te.type_desc AS ev
         FROM sys.triggers t
         JOIN sys.objects o ON o.object_id = t.parent_id
         JOIN sys.schemas s ON s.schema_id = o.schema_id
         JOIN sys.trigger_events te ON te.object_id = t.object_id
         WHERE t.is_ms_shipped = 0 AND s.name = ${U.lit(D, sch)} AND o.name = ${U.lit(D, table)}
         ORDER BY t.name`,
        db
      );
      return r.resultsets[0].rows.map((row) => ({
        name: row[0],
        timing: Number(row[2]) === 1 ? 'INSTEAD OF' : 'AFTER',
        event: String(row[3] || '').toUpperCase(),
        enabled: Number(row[1]) !== 1,
      }));
    },
    async toggleTrigger({ db, schema, table, name, enable }) {
      await runSql(`${enable ? 'ENABLE' : 'DISABLE'} TRIGGER ${U.q(D, name)} ON ${U.qualify(D, db, schema, table)}`, db);
      return { ok: true };
    },
    async tableInfo({ db, schema, table }) {
      const sch = schema || 'dbo';
      const r = await runSql(
        `SELECT CAST(p.value AS NVARCHAR(MAX)) FROM sys.extended_properties p
         WHERE p.major_id = OBJECT_ID(${U.lit(D, `${db}.${sch}.${table}`)}) AND p.minor_id = 0 AND p.class = 1 AND p.name = 'MS_Description'`,
        db
      );
      return { comment: (r.resultsets[0].rows[0] || [])[0] || '', options: {} };
    },

    async page({ db, schema, table, pageNo = 1, pageSize = 100, where, orderCol, orderDir }) {
      const full = U.qualify(D, db, schema, table);
      const cols = await s.columns({ db, schema, table });
      const colList = cols.map((c) => U.q(D, c.name)).join(', ');
      const w = where && where.trim() ? ` WHERE (${where})` : '';
      const ord = orderCol ? ` ORDER BY ${U.q(D, orderCol)} ${orderDir === 'DESC' ? 'DESC' : 'ASC'}` : ' ORDER BY (SELECT NULL)';
      const c = await runSql(`SELECT COUNT(*) AS total FROM ${full}${w}`, db);
      const r = await runSql(
        `SELECT ${colList} FROM ${full}${w}${ord} OFFSET ${(pageNo - 1) * pageSize} ROWS FETCH NEXT ${Number(pageSize)} ROWS ONLY`,
        db
      );
      return {
        columns: cols,
        rows: r.resultsets[0].rows,
        total: Number(c.resultsets[0].rows[0][0]),
      };
    },

    async query(arg) {
      const a = typeof arg === 'string' ? { sqlText: arg } : arg || {};
      const sqlText = a.sqlText || '';
      const out = [];
      // 查询页可切换目标库：会话级 USE 单独成批（CREATE VIEW/PROCEDURE 等 DDL 必须是批首语句，
      // 不能与 USE 同批；库名来自 treeRoot 枚举 + q() 转义）。未指定库时切回连接默认库，
      // 避免树读路径的批前 USE 让会话库漂移到别的库。
      const target = a.db != null && String(a.db) !== '' ? String(a.db) : null;
      if ((target || defDb) !== curDb) {
        await runSql(`USE ${U.q(D, target || defDb)}`);
        curDb = target || defDb;
      }
      for (const st of U.splitStatements(sqlText)) {
        const t0 = Date.now();
        try {
          // useBatch：execSqlBatch 保留会话 SET 状态（EXPLAIN 的 SET SHOWPLAN 需要；常规执行走 execSql）
          const { resultsets, lastRowCount } = await runSql(st, undefined, undefined, !!a.useBatch);
          const elapsed = Date.now() - t0;
          if (resultsets.length) {
            for (const rs of resultsets) {
              out.push({ sql: st, command: 'SELECT', columns: rs.columns, rows: rs.rows, rowCount: rs.rows.length, elapsed });
            }
          } else {
            out.push({ sql: st, command: 'OK', columns: [], rows: [], rowCount: lastRowCount, elapsed });
          }
        } catch (e) {
          out.push({ sql: st, command: 'ERROR', columns: [], rows: [], rowCount: 0, error: e.message, elapsed: Date.now() - t0 });
        }
      }
      return out;
    },

    async changes(spec) {
      const stmts = U.buildChangeSql(D, spec.db, spec.schema, spec.table, spec);
      for (const st of stmts) await runSql(st.sql, spec.db, st.params);
      return { executed: stmts.length };
    },

    async ddl({ db, schema, table }) {
      const cols = await s.columns({ db, schema, table });
      const full = U.qualify(D, db, schema, table);
      const body = cols
        .map((c) => `  ${U.q(D, c.name)} ${c.display}${c.autoInc ? ' IDENTITY(1,1)' : ''}${c.nullable ? ' NULL' : ' NOT NULL'}${c.defaultValue != null ? ' DEFAULT ' + c.defaultValue : ''}`)
        .join(',\n');
      const pk = cols.filter((c) => c.pk);
      const pkSql = pk.length ? `,\n  PRIMARY KEY (${pk.map((c) => U.q(D, c.name)).join(', ')})` : '';
      return `CREATE TABLE ${full} (\n${body}${pkSql}\n);\n-- 生成的近似 DDL（未含索引/约束）`;
    },

    async createTable(spec) {
      const sql = U.createTableSql(D, spec);
      await runSql(sql, spec.db);
      const extras = U.objectCreateSql(D, spec, U.qualify(D, spec.db, spec.schema, spec.name));
      for (const st of extras) await runSql(st, spec.db);
      return [sql, ...extras].join('\n');
    },

    // 仅生成建表 SQL（结构同步预览用）：与 createTable 完全同源，不执行
    async createTableScript(spec) {
      return [U.createTableSql(D, spec), ...U.objectCreateSql(D, spec, U.qualify(D, spec.db, spec.schema, spec.name))];
    },

    async alterScript(spec) {
      const sqls = [];
      const fq = (n) => U.qualify(D, spec.db, spec.schema, n);
      let tname = spec.table;
      const before = spec.before || [];
      const after = spec.after || [];
      if (spec.newName && spec.newName !== spec.table) {
        // sp_rename 纯点分路径（v0927.52：同 spPath 规则）
        sqls.push(`EXEC sp_rename ${U.lit(D, spPath(spec.db, spec.schema, spec.table))}, ${U.lit(D, spec.newName)};`);
        tname = spec.newName;
      }
      const T = () => fq(tname);
      const bpk = before.filter((c) => c.pk).map((c) => c.name).sort().join(',');
      const apk = after.filter((c) => c.pk).map((c) => c.name).sort().join(',');
      if (U.orderChanged(spec)) {
        // 拖拽排序（v0927.52）：SQL Server 无法原位移列，走重建表（与 SQLite 同法）——
        // 列集/主键/类型以 spec.after 为准（新建/删除/改名随重建一并生效）；
        // 原索引/唯一键/外键/检查随旧表消亡：先按 before 名录复原，后续 objectAlterSql 差异再删改增。
        // 限制：IDENTITY 列回灌显式值需 SET IDENTITY_INSERT（设计器场景默认不含）；他表引用本表的 FK 会阻塞 DROP
        const tmp = String(tname) + '__rebuild';
        const tmpFq = fq(tmp);
        // OBJECT_ID/sp_rename 的字符串参数必须用不带引号分隔符的纯点分路径（fq 产物含 " 分隔符会当成对象名一部分）
        const plainFq = String(tmpFq).replace(/"/g, '');
        const plainSchema = (spec.schema ? String(spec.schema) + '.' : '') + tmp;
        const keep = after.filter((c) => before.some((b) => b.name === (c.origName || c.name)));
        sqls.push(`IF OBJECT_ID(${U.lit(D, plainFq)}) IS NOT NULL DROP TABLE ${tmpFq};`);
        sqls.push(U.createTableSql(D, { ...spec, name: tmp, cols: after }));
        if (keep.length) {
          sqls.push(`INSERT INTO ${tmpFq} (${keep.map((c) => U.q(D, c.name)).join(', ')}) SELECT ${keep.map((c) => U.q(D, c.origName || c.name)).join(', ')} FROM ${T()};`);
        }
        sqls.push(`DROP TABLE ${T()};`);
        sqls.push(`EXEC sp_rename ${U.lit(D, plainSchema)}, ${U.lit(D, tname)};`);
        for (const it of spec.indexesBefore || []) sqls.push(...U.mssqlIndexCreate(D, spec, T(), it));
        for (const it of spec.uniquesBefore || []) sqls.push(...U.uqAddSqls(D, spec, T(), it));
        for (const it of spec.fkeysBefore || []) sqls.push(U.fkAddSql(D, spec, T(), it));
        for (const it of spec.checksBefore || []) sqls.push(...U.ckAddSqls(D, spec, T(), it));
      } else {
        if (bpk && bpk !== apk) {
          const cn = await pkConstraintName(spec.db, spec.schema, spec.table);
          if (cn) sqls.push(`ALTER TABLE ${T()} DROP CONSTRAINT ${U.q(D, cn)};`);
        }
        for (const c of after) {
          const b = before.find((x) => x.name === (c.origName || c.name));
          if (!b) {
            sqls.push(`ALTER TABLE ${T()} ADD ${U.columnDef(D, c).replace(/ IDENTITY\(1,1\)$/, '')};`);
            continue;
          }
          if (c.origName && c.origName !== c.name) {
            // sp_rename 列改名纯点分路径（v0927.52 实测：引号表名+裸列名混合形态语法错；中段不能空，见 spPath）
            sqls.push(`EXEC sp_rename ${U.lit(D, spPath(spec.db, spec.schema, tname, c.origName))}, ${U.lit(D, c.name)}, 'COLUMN';`);
          }
          const bn = U.normCol(b);
          bn.name = c.name;
          if (U.fullType(bn) !== U.fullType(c) || !!bn.nullable !== !!c.nullable) {
            sqls.push(`ALTER TABLE ${T()} ALTER COLUMN ${U.q(D, c.name)} ${U.fullType(c)} ${c.nullable ? 'NULL' : 'NOT NULL'};`);
          }
          // 默认值变更需改约束，暂不支持（可手工在查询中执行）
        }
        for (const b of before) {
          if (!after.find((c) => (c.origName || c.name) === b.name)) {
            sqls.push(`ALTER TABLE ${T()} DROP COLUMN ${U.q(D, b.name)};`);
          }
        }
        if (apk && bpk !== apk) {
          sqls.push(`ALTER TABLE ${T()} ADD PRIMARY KEY (${after.filter((c) => c.pk).map((c) => U.q(D, c.name)).join(', ')});`);
        }
      }
      // 索引 / 外键 / 唯一键 / 检查约束 / 表注释 差异
      sqls.push(...U.objectAlterSql(D, spec, fq(tname)));
      return sqls;
    },

    async applyAlter(spec) {
      const sqls = await s.alterScript(spec);
      for (const sql of sqls) await runSql(sql, spec.db);
      return { executed: sqls.length };
    },

    async dropTable({ db, schema, table }) {
      await runSql(`DROP TABLE ${U.qualify(D, db, schema, table)}`, db);
    },
    async truncateTable({ db, schema, table }) {
      await runSql(`TRUNCATE TABLE ${U.qualify(D, db, schema, table)}`, db);
    },
    async renameTable({ db, schema, table, newName }) {
      await runSql(`EXEC sp_rename ${U.lit(D, spPath(db, schema, table))}, ${U.lit(D, newName)}`, db);
    },

    // 他表引用本表的外键清单（v0927.52 设计器重建表提示用）：[{name, schema, table}]
    async inFkeys({ db, schema, table }) {
      const r = await runSql(
        `SELECT fk.name, s.name, t.name
         FROM sys.foreign_keys fk
         JOIN sys.objects t ON t.object_id = fk.parent_object_id
         JOIN sys.schemas s ON s.schema_id = t.schema_id
         JOIN sys.objects rt ON rt.object_id = fk.referenced_object_id
         JOIN sys.schemas rs ON rs.schema_id = rt.schema_id
         WHERE rt.name = @p0 AND rs.name = @p1
         ORDER BY s.name, t.name, fk.name`,
        db,
        [table, schema || 'dbo']
      );
      return r.resultsets[0].rows.map((row) => ({ name: row[0], schema: row[1], table: row[2] }));
    },
    async createDatabase(name) {
      await runSql(`CREATE DATABASE ${U.q(D, name)}`);
    },
    async dropDatabase({ db }) {
      await runSql(`DROP DATABASE ${U.q(D, db)}`);
    },

    // ---- 存储过程 / 函数 / 触发器 / 视图 / 索引 ----
    async objectDdl({ db, schema, kind, name, table }) {
      if (kind === 'index') {
        // OBJECT_DEFINITION 不覆盖索引：从系统目录合成建索引语句（名称全部参数绑定）
        const r = await runSql(
          `SELECT i.is_unique, i.has_filter, i.filter_definition, c.name AS col, ic.is_descending_key
           FROM sys.indexes i
           JOIN sys.objects o ON o.object_id = i.object_id
           JOIN sys.schemas s ON s.schema_id = o.schema_id
           JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.is_included_column = 0
           JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
           WHERE i.name = @p0 AND o.name = @p1 AND s.name = @p2
           ORDER BY ic.key_ordinal`,
          db,
          [name, table, schema || 'dbo']
        );
        const rows = (r.resultsets[0] && r.resultsets[0].rows) || [];
        if (!rows.length) return '-- 未找到索引';
        const uniq = Number(rows[0][0]) === 1;
        const cols = rows.map((x) => U.q(D, x[3]) + (Number(x[4]) === 1 ? ' DESC' : '')).join(', ');
        let sql = `CREATE ${uniq ? 'UNIQUE ' : ''}INDEX ${U.q(D, name)} ON ${U.qualify(D, null, schema, table)} (${cols})`;
        if (Number(rows[0][1]) === 1 && rows[0][2]) sql += ` WHERE ${rows[0][2]}`;
        return sql + ';';
      }
      const def = await runSql(
        `SELECT OBJECT_DEFINITION(OBJECT_ID(${U.lit(D, `${db}.${schema || 'dbo'}.${name}`)})) AS def`,
        db
      ).then((r) => (r.resultsets[0].rows.length ? r.resultsets[0].rows[0][0] : null));
      return def || `-- 未找到 ${kind} ${name}`;
    },
    async dropObject({ db, schema, kind, name, table }) {
      if (kind === 'index') {
        // DROP INDEX 是两段名 + ON 表（三段名语法错）
        await runSql(`DROP INDEX ${U.q(D, name)} ON ${U.qualify(D, null, schema, table)}`, db);
        return;
      }
      const kindMap = { procedure: 'PROCEDURE', function: 'FUNCTION', trigger: 'TRIGGER', view: 'VIEW' };
      // TRIGGER/PROCEDURE/FUNCTION/VIEW 是 schema 级对象：DROP 只允许两段名（三段名语法错）
      const target = kind === 'table' ? U.qualify(D, db, schema, name) : U.qualify(D, null, schema, name);
      await runSql(`DROP ${kindMap[kind]} ${target}`, db);
    },

    // 结构明细行删除（侧边栏索引/外键/唯一键/检查/触发器右键）：DDL 由引擎统一生成
    async dropStruct(arg) {
      for (const st of U.dropStructSql(D, arg)) await runSql(st, arg.db);
    },

    // 视图设计器保存：DDL 由引擎统一生成（标识符经 q() 转义）
    async createView(arg) {
      return this.query({ sqlText: U.createViewSql(D, arg), db: arg.db, schema: arg.schema });
    },

    // ---- 备份导出 ----
    async dumpTable({ db, schema, table }) {
      const parts = [];
      parts.push(await s.ddl({ db, schema, table }));
      const cols = await s.columns({ db, schema, table });
      const full = U.qualify(D, db, schema, table);
      const colList = cols.map((c) => U.q(D, c.name)).join(', ');
      const BATCH = 500;
      for (let page = 1; ; page += 1) {
        const r = await s.page({ db, schema, table, pageNo: page, pageSize: BATCH });
        if (!r.rows.length) break;
        for (const row of r.rows) {
          parts.push(`INSERT INTO ${full} (${colList}) VALUES (${row.map((v) => U.lit(D, v)).join(', ')});`);
        }
        if (r.rows.length < BATCH) break;
      }
      return parts.join('\n');
    },

    // ---- CSV 导入 / 批量插入（@pN NVarChar 参数绑定） ----
    async importCsv(spec) {
      const { parseCsv } = require('../csv');
      const fs = require('fs');
      const { header, rows } = parseCsv(fs.readFileSync(spec.file, 'utf8'));
      const cols = await s.columns({ db: spec.db, schema: spec.schema, table: spec.table });
      const known = new Set(cols.map((c) => c.name));
      const use = header.map((h) => (known.has(String(h).trim()) ? String(h).trim() : null));
      const full = U.qualify(D, spec.db, spec.schema, spec.table);
      let inserted = 0;
      for (const row of rows) {
        const entries = [];
        use.forEach((cn, i) => {
          if (!cn) return;
          let v = row[i];
          if (spec.nullEmpty !== false && v === '') v = null;
          entries.push([cn, v]);
        });
        if (!entries.length) continue;
        const st = U.insertOne(D, full, entries);
        await runSql(st.sql, spec.db, st.params);
        inserted += 1;
      }
      return { inserted, columns: header.filter((h) => known.has(String(h).trim())).length };
    },
    async insertRows(spec) {
      const full = U.qualify(D, spec.db, spec.schema, spec.table);
      const st = U.insertOne(D, full, spec.columns.map((c) => [c, null]));
      for (const r of spec.rows) await runSql(st.sql, spec.db, r);
      return { inserted: spec.rows.length };
    },
  };
  // v0927.52：空库名（''/缺省）统一回退连接默认库。树浏览/对象列表的批前 USE 会漂移会话库，
  // 读/写路径若沿用会话当前库会打到错误数据库上（query 自带会话级 USE 管理故豁免；
  // dropDatabase 豁免——删库这类破坏性操作不做静默兜底，缺库名应显式报错）。
  // 注意用普通函数 + f.call(this)：createView 内部走 this.query，箭头函数会丢 this 绑定（r13 回归教训）。
  for (const k of Object.keys(s)) {
    const f = s[k];
    if (k === 'query' || k === 'close' || k === 'dropDatabase' || typeof f !== 'function') continue;
    s[k] = function (a) {
      return f.call(this, a && typeof a === 'object' && (a.db == null || String(a.db) === '') ? { ...a, db: defDb } : a);
    };
  }
  return s;
}

module.exports = { create };
