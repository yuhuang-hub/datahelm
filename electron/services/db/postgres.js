'use strict';
const pg = require('pg');
const U = require('../sqlutil');

// 日期/时间保持原始字符串，避免时区转换
pg.types.setTypeParser(1082, (v) => v);
pg.types.setTypeParser(1114, (v) => v);
pg.types.setTypeParser(1184, (v) => v);

async function create(cfg, localPort) {
  const D = 'pg';
  // SSL 证书严格校验由连接配置 sslVerify 控制（DB 客户端惯例：自签名证书场景默认放宽）
  const sslOpts = cfg.ssl ? { rejectUnauthorized: Boolean(cfg.sslVerify) } : undefined;
  const client = new pg.Client({
    host: localPort ? '127.0.0.1' : (cfg.host || 'localhost'),
    port: localPort || Number(cfg.port) || 5432,
    user: cfg.user || 'postgres',
    password: cfg.password || '',
    database: cfg.database || 'postgres',
    connectionTimeoutMillis: 10000,
    ssl: sslOpts,
  });
  await client.connect();
  const vr = await client.query('SELECT version()');
  const serverInfo = vr.rows[0].version.split(' ').slice(0, 2).join(' ');

  async function pkName(tableQualified) {
    const r = await client.query(
      "SELECT conname FROM pg_constraint WHERE conrelid = $1::regclass AND contype = 'p'",
      [tableQualified]
    );
    return r.rows[0] ? r.rows[0].conname : tableQualified.replace(/"/g, '') + '_pkey';
  }

  const s = {
    type: D,
    serverInfo,
    close: () => client.end().catch(() => {}),

    async treeRoot() {
      const r = await client.query(
        "SELECT schema_name AS name FROM information_schema.schemata WHERE schema_name NOT IN ('pg_catalog', 'information_schema') AND schema_name NOT LIKE 'pg_toast%' ORDER BY 1"
      );
      return r.rows.map((x) => ({ type: 'schema', name: x.name }));
    },

    async treeChildren(node) {
      if (node.type === 'schema') {
        return [
          { type: 'cat', kind: 'table', schema: node.name, name: '表' },
          { type: 'cat', kind: 'view', schema: node.name, name: '视图' },
          { type: 'cat', kind: 'sequence', schema: node.name, name: '序列' },
          { type: 'cat', kind: 'function', schema: node.name, name: '函数' },
          { type: 'cat', kind: 'procedure', schema: node.name, name: '存储过程' },
          { type: 'cat', kind: 'trigger', schema: node.name, name: '触发器' },
        ];
      }
      if (node.type === 'cat') {
        if (node.kind === 'table' || node.kind === 'view') {
          const r = await client.query(
            'SELECT table_name AS name, table_type AS tt FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name',
            [node.schema]
          );
          const want = node.kind === 'view' ? 'VIEW' : 'BASE TABLE';
          return r.rows.filter((x) => x.tt === want).map((x) => ({ type: node.kind, schema: node.schema, name: x.name }));
        }
        if (node.kind === 'sequence') {
          const r = await client.query(
            'SELECT sequencename AS name FROM pg_sequences WHERE schemaname = $1 ORDER BY sequencename',
            [node.schema]
          );
          return r.rows.map((x) => ({ type: 'sequence', schema: node.schema, name: x.name }));
        }
        if (node.kind === 'function' || node.kind === 'procedure') {
          const r = await client.query(
            `SELECT DISTINCT p.proname AS name FROM pg_proc p
             JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = $1 AND p.prokind = $2
             ORDER BY 1`,
            [node.schema, node.kind === 'function' ? 'f' : 'p']
          );
          return r.rows.map((x) => ({ type: node.kind, schema: node.schema, name: x.name }));
        }
        if (node.kind === 'trigger') {
          const r = await client.query(
            `SELECT DISTINCT t.tgname AS name FROM pg_trigger t
             JOIN pg_class c ON c.oid = t.tgrelid
             JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = $1 AND NOT t.tgisinternal
             ORDER BY 1`,
            [node.schema]
          );
          return r.rows.map((x) => ({ type: 'trigger', schema: node.schema, name: x.name }));
        }
      }
      return [];
    },

    async columns({ schema, table }) {
      const r = await client.query(
        `SELECT a.attname AS name,
                format_type(a.atttypid, a.atttypmod) AS ftype,
                (NOT a.attnotnull) AS nullable,
                CASE WHEN a.atthasdef THEN pg_get_expr(d.adbin, d.adrelid) END AS dflt,
                col_description(a.attrelid, a.attnum) AS comment,
                EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = a.attrelid AND i.indisprimary AND a.attnum = ANY(i.indkey)) AS pk,
                (a.attidentity <> '') AS ident
         FROM pg_attribute a
         LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
         WHERE a.attrelid = ($1 || '.' || $2)::regclass AND a.attnum > 0 AND NOT a.attisdropped
         ORDER BY a.attnum`,
        [schema || 'public', table]
      );
      return r.rows.map((x) => {
        const m = /^([\w ]+?)\s*(?:\((\d+)(?:,(\d+))?\))?$/.exec(x.ftype);
        const dflt = x.dflt;
        return {
          name: x.name,
          dataType: m ? m[1].trim().toUpperCase() : String(x.ftype).toUpperCase(),
          display: x.ftype,
          length: m && m[2] ? Number(m[2]) : null,
          scale: m && m[3] ? Number(m[3]) : null,
          nullable: !!x.nullable,
          pk: !!x.pk,
          autoInc: !!x.ident || /nextval\s*\(/i.test(dflt || ''),
          defaultValue: dflt,
          comment: x.comment || '',
        };
      });
    },

    async tables({ schema }) {
      const r = await client.query(
        'SELECT table_name AS name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name',
        [schema || 'public']
      );
      return r.rows.map((x) => x.name);
    },

    // 工具栏「表/视图」对象列表页：名称 + 行数（rel_tuples 统计值，未分析时为 -1/0）+ 注释（pg_class 上的注释）
    async objList({ schema, kind }) {
      const relkind = kind === 'view' ? "IN ('v','m')" : "IN ('r','p')";
      const r = await client.query(
        `SELECT c.relname AS name, c.reltuples::bigint AS cnt,
                COALESCE(obj_description(c.oid, 'pg_class'), '') AS cmt
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = $1 AND c.relkind ${relkind} AND NOT c.relispartition
         ORDER BY c.relname`,
        [schema || 'public']
      );
      return r.rows.map((x) => ({
        name: x.name,
        rows: x.cnt == null || Number(x.cnt) < 0 ? null : Number(x.cnt),
        comment: String(x.cmt || ''),
      }));
    },

    // ---- 表对象内省：索引 / 唯一约束 / 外键 / 检查约束 / 触发器 / 表信息 ----
    async indexes({ schema, table }) {
      // 约束后备索引（PK/UNIQUE 约束）归 唯一键 页管理；此处含独立唯一索引
      // 键列表从 pg_get_indexdef 逐键解析：表达式键（indkey attnum=0，无法经 pg_attribute 关联）原样保留；
      // WHERE 谓词取 pg_get_expr(indpred)（含外层括号，原样重写合法——未改动时 canon 稳定不产生假差异）
      const r = await client.query(
        `SELECT i.relname AS name, am.amname AS am, ix.indisunique AS uniq,
                pg_get_indexdef(ix.indexrelid) AS def,
                pg_get_expr(ix.indpred, ix.indrelid) AS pred,
                obj_description(i.oid, 'pg_class') AS cmt
         FROM pg_index ix
         JOIN pg_class t ON t.oid = ix.indrelid
         JOIN pg_class i ON i.oid = ix.indexrelid
         JOIN pg_am am ON am.oid = i.relam
         JOIN pg_namespace n ON n.oid = t.relnamespace
         WHERE n.nspname = $1 AND t.relname = $2 AND NOT ix.indisprimary
           AND NOT EXISTS (SELECT 1 FROM pg_constraint cc WHERE cc.conindid = ix.indexrelid)
         ORDER BY i.relname, ix.indexrelid`,
        [schema || 'public', table]
      );
      return r.rows.map((x) => {
        const keys = U.indexDefKeys(String(x.def || ''));
        return {
          name: x.name,
          columns: keys.parts.map((p) => p.k),
          dirs: keys.parts.map((p) => p.dir),
          type: String(x.am || 'btree').toUpperCase(),
          unique: !!x.uniq,
          comment: x.cmt || '',
          where: x.pred ? String(x.pred).trim() : '',
        };
      });
    },
    async uniques({ schema, table }) {
      const r = await client.query(
        `SELECT con.conname AS name, pg_get_constraintdef(con.oid) AS def,
                obj_description(con.oid, 'pg_constraint') AS cmt
         FROM pg_constraint con
         JOIN pg_class c ON c.oid = con.conrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = $1 AND c.relname = $2 AND con.contype = 'u'
         ORDER BY con.conname`,
        [schema || 'public', table]
      );
      return r.rows.map((x) => {
        const m = /\((.+)\)\s*$/.exec(x.def || '');
        return {
          name: x.name,
          columns: m ? m[1].split(',').map((c) => c.trim().replace(/"/g, '')) : [],
          comment: x.cmt || '',
        };
      });
    },
    async fkeys({ schema, table }) {
      const r = await client.query(
        `SELECT con.conname AS name, pg_get_constraintdef(con.oid, true) AS def,
                rn.nspname AS rschema, rc.relname AS rtable,
                obj_description(con.oid, 'pg_constraint') AS cmt
         FROM pg_constraint con
         JOIN pg_class c ON c.oid = con.conrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_class rc ON rc.oid = con.confrelid
         JOIN pg_namespace rn ON rn.oid = rc.relnamespace
         WHERE n.nspname = $1 AND c.relname = $2 AND con.contype = 'f'
         ORDER BY con.conname`,
        [schema || 'public', table]
      );
      return r.rows.map((x) => {
        const def = x.def || '';
        const m = /^FOREIGN KEY \((.+?)\) REFERENCES (.+?)\s*\((.+?)\)(.*)$/i.exec(def.replace(/\s+/g, ' '));
        if (!m) return { name: x.name, columns: [], refSchema: x.rschema, refTable: x.rtable, refColumns: [], onDelete: 'NO ACTION', onUpdate: 'NO ACTION', comment: x.cmt || '' };
        const tail = m[4] || '';
        const od = /ON DELETE (CASCADE|SET NULL|SET DEFAULT|RESTRICT|NO ACTION)/i.exec(tail);
        const ou = /ON UPDATE (CASCADE|SET NULL|SET DEFAULT|RESTRICT|NO ACTION)/i.exec(tail);
        return {
          name: x.name,
          columns: m[1].split(',').map((c) => c.trim().replace(/"/g, '')),
          refSchema: x.rschema,
          refTable: x.rtable,
          refColumns: m[3].split(',').map((c) => c.trim().replace(/"/g, '')),
          onDelete: od ? od[1].toUpperCase() : 'NO ACTION',
          onUpdate: ou ? ou[1].toUpperCase() : 'NO ACTION',
          comment: x.cmt || '',
        };
      });
    },
    // 他表引用本表的外键清单（v0927.52 设计器重建表提示用）：[{name, schema, table}]
    async inFkeys({ schema, table }) {
      const r = await client.query(
        `SELECT con.conname AS name, cn.nspname AS sch, c.relname AS tbl
         FROM pg_constraint con
         JOIN pg_class c ON c.oid = con.conrelid
         JOIN pg_namespace cn ON cn.oid = c.relnamespace
         JOIN pg_class rc ON rc.oid = con.confrelid
         JOIN pg_namespace rn ON rn.oid = rc.relnamespace
         WHERE con.contype = 'f' AND rn.nspname = $1 AND rc.relname = $2
         ORDER BY cn.nspname, c.relname, con.conname`,
        [schema || 'public', table]
      );
      return r.rows.map((x) => ({ name: x.name, schema: x.sch, table: x.tbl }));
    },
    async checks({ schema, table }) {
      const r = await client.query(
        `SELECT con.conname AS name, pg_get_constraintdef(con.oid, true) AS def,
                obj_description(con.oid, 'pg_constraint') AS cmt
         FROM pg_constraint con
         JOIN pg_class c ON c.oid = con.conrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = $1 AND c.relname = $2 AND con.contype = 'c'
         ORDER BY con.conname`,
        [schema || 'public', table]
      );
      return r.rows.map((x) => {
        const def = x.def || '';
        const l = def.indexOf('(');
        const rr = def.lastIndexOf(')');
        return { name: x.name, expr: l >= 0 && rr > l ? def.slice(l + 1, rr) : def, comment: x.cmt || '' };
      });
    },
    async triggers({ schema, table }) {
      const r = await client.query(
        `SELECT t.tgname AS name, pg_get_triggerdef(t.oid) AS sql, t.tgenabled
         FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = $1 AND c.relname = $2 AND NOT t.tgisinternal
         ORDER BY t.tgname`,
        [schema || 'public', table]
      );
      return r.rows.map((x) => ({ name: x.name, sql: x.sql, enabled: x.tgenabled !== 'D' }));
    },
    async toggleTrigger({ schema, table, name, enable }) {
      await client.query(`ALTER TABLE ${U.qualify(D, null, schema, table)} ${enable ? 'ENABLE' : 'DISABLE'} TRIGGER ${U.q(D, name)}`);
      return { ok: true };
    },
    async tableInfo({ schema, table }) {
      const cmt = await client.query('SELECT obj_description(($1 || \'.\' || $2)::regclass) AS cmt', [schema || 'public', table]);
      const opt = await client.query(
        `SELECT c.reloptions FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2`,
        [schema || 'public', table]
      );
      const options = {};
      for (const s of (opt.rows[0] || {}).reloptions || []) {
        const i = s.indexOf('=');
        if (i > 0) options[s.slice(0, i)] = s.slice(i + 1);
      }
      return { comment: (cmt.rows[0] || {}).cmt || '', options };
    },

    async page({ schema, table, pageNo = 1, pageSize = 100, where, orderCol, orderDir }) {
      const full = U.qualify(D, null, schema, table);
      const cols = await s.columns({ schema, table });
      const colList = cols.map((c) => U.q(D, c.name)).join(', ');
      const w = where && where.trim() ? ` WHERE (${where})` : '';
      const ord = orderCol ? ` ORDER BY ${U.q(D, orderCol)} ${orderDir === 'DESC' ? 'DESC' : 'ASC'}` : '';
      const c = await client.query(`SELECT COUNT(*)::bigint AS total FROM ${full}${w}`);
      const r = await client.query(
        `SELECT ${colList} FROM ${full}${w}${ord} LIMIT ${Number(pageSize)} OFFSET ${(pageNo - 1) * pageSize}`
      );
      return {
        columns: cols,
        rows: r.rows.map((row) => cols.map((c2) => row[c2.name])),
        total: Number(c.rows[0].total),
      };
    },

    async query(arg) {
      const a = typeof arg === 'string' ? { sqlText: arg } : arg || {};
      const sqlText = a.sqlText || '';
      const out = [];
      // 查询页可切换目标 schema：会话级 search_path（名来自 treeRoot 枚举 + q() 转义，非用户拼接）
      if (a.schema) await client.query(`SET search_path TO ${U.q(D, a.schema)}`);
      for (const st of U.splitStatements(sqlText)) {
        const t0 = Date.now();
        try {
          const r = await client.query(st);
          const elapsed = Date.now() - t0;
          if (r.fields && r.fields.length) {
            out.push({
              sql: st, command: 'SELECT', columns: r.fields.map((f) => f.name),
              rows: r.rows.map((row) => r.fields.map((f) => row[f.name])),
              rowCount: r.rows.length, elapsed,
            });
          } else {
            out.push({
              sql: st, command: r.command || 'OK', columns: [], rows: [],
              rowCount: r.rowCount || 0, elapsed,
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
      for (const st of stmts) await client.query(st.sql, st.params);
      return { executed: stmts.length };
    },

    async ddl({ schema, table }) {
      const cols = await s.columns({ schema, table });
      const full = U.qualify(D, null, schema, table);
      const body = cols
        .map((c) => `  ${U.q(D, c.name)} ${c.display}${c.nullable ? '' : ' NOT NULL'}${c.defaultValue != null ? ' DEFAULT ' + c.defaultValue : ''}`)
        .join(',\n');
      const pk = cols.filter((c) => c.pk);
      const pkSql = pk.length ? `,\n  PRIMARY KEY (${pk.map((c) => U.q(D, c.name)).join(', ')})` : '';
      return `CREATE TABLE ${full} (\n${body}${pkSql}\n);\n-- 生成的近似 DDL（未含索引/约束）`;
    },

    async createTable(spec) {
      const sql = U.createTableSql(D, spec);
      await client.query(sql);
      const extras = U.objectCreateSql(D, spec, U.qualify(D, null, spec.schema, spec.name));
      for (const st of extras) await client.query(st);
      return [sql, ...extras].join('\n');
    },

    // 仅生成建表 SQL（结构同步预览用）：与 createTable 完全同源，不执行
    async createTableScript(spec) {
      return [U.createTableSql(D, spec), ...U.objectCreateSql(D, spec, U.qualify(D, null, spec.schema, spec.name))];
    },

    async alterScript(spec) {
      const sqls = [];
      const fq = (n) => U.qualify(D, null, spec.schema, n);
      let tname = spec.table;
      const before = spec.before || [];
      const after = spec.after || [];
      if (spec.newName && spec.newName !== spec.table) {
        sqls.push(`ALTER TABLE ${fq(spec.table)} RENAME TO ${U.q(D, spec.newName)};`);
        tname = spec.newName;
      }
      const T = () => fq(tname);
      const bpk = before.filter((c) => c.pk).map((c) => c.name).sort().join(',');
      const apk = after.filter((c) => c.pk).map((c) => c.name).sort().join(',');
      if (U.orderChanged(spec)) {
        // 拖拽排序（v0927.52）：PostgreSQL 无法原位移列，走重建表（与 SQLite 同法）——
        // 列集/主键/类型以 spec.after 为准（新建/删除/改名随重建一并生效）；
        // 原索引/唯一键/外键/检查随旧表消亡：先按 before 名录复原，后续 objectAlterSql 差异再删改增。
        // 限制：他表引用本表的 FK 会阻塞 DROP TABLE；列注释随重建丢失（如需可重设）
        const tmp = String(tname) + '__rebuild';
        const tmpFq = fq(tmp);
        const keep = after.filter((c) => before.some((b) => b.name === (c.origName || c.name)));
        sqls.push(`DROP TABLE IF EXISTS ${tmpFq};`);
        sqls.push(U.createTableSql(D, { ...spec, name: tmp, cols: after }));
        if (keep.length) {
          sqls.push(`INSERT INTO ${tmpFq} (${keep.map((c) => U.q(D, c.name)).join(', ')}) SELECT ${keep.map((c) => U.q(D, c.origName || c.name)).join(', ')} FROM ${T()};`);
        }
        sqls.push(`DROP TABLE ${T()};`);
        sqls.push(`ALTER TABLE ${tmpFq} RENAME TO ${U.q(D, tname)};`);
        for (const it of spec.indexesBefore || []) sqls.push(...U.pgIndexCreate(D, spec, T(), it));
        for (const it of spec.uniquesBefore || []) sqls.push(...U.uqAddSqls(D, spec, T(), it));
        for (const it of spec.fkeysBefore || []) sqls.push(U.fkAddSql(D, spec, T(), it));
        for (const it of spec.checksBefore || []) sqls.push(...U.ckAddSqls(D, spec, T(), it));
      } else {
        if (bpk && bpk !== apk) {
          const cn = await pkName(fq(spec.table));
          sqls.push(`ALTER TABLE ${T()} DROP CONSTRAINT ${U.q(D, cn)};`);
        }
        for (const c of after) {
          const b = before.find((x) => x.name === (c.origName || c.name));
          if (!b) {
            sqls.push(`ALTER TABLE ${T()} ADD COLUMN ${U.columnDef(D, c)};`);
            continue;
          }
          if (c.origName && c.origName !== c.name) {
            sqls.push(`ALTER TABLE ${T()} RENAME COLUMN ${U.q(D, c.origName)} TO ${U.q(D, c.name)};`);
          }
          const bn = U.normCol(b);
          bn.name = c.name;
          if (U.fullType(bn) !== U.fullType(c)) {
            sqls.push(`ALTER TABLE ${T()} ALTER COLUMN ${U.q(D, c.name)} TYPE ${U.fullType(c)} USING ${U.q(D, c.name)}::${U.fullType(c)};`);
          }
          if (!!bn.nullable !== !!c.nullable) {
            sqls.push(`ALTER TABLE ${T()} ALTER COLUMN ${U.q(D, c.name)} ${c.nullable ? 'DROP NOT NULL' : 'SET NOT NULL'};`);
          }
          if ((bn.defaultValue || '') !== (c.defaultValue || '')) {
            sqls.push(`ALTER TABLE ${T()} ALTER COLUMN ${U.q(D, c.name)} ${c.defaultValue ? 'SET DEFAULT ' + String(c.defaultValue).trim() : 'DROP DEFAULT'};`);
          }
          if ((bn.comment || '') !== (c.comment || '')) {
            sqls.push(`COMMENT ON COLUMN ${T()}.${U.q(D, c.name)} IS ${U.lit(D, c.comment || '')};`);
          }
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
      // 索引 / 外键 / 唯一键 / 检查约束 / 表选项 / 表注释 差异
      sqls.push(...U.objectAlterSql(D, spec, fq(tname)));
      return sqls;
    },

    async applyAlter(spec) {
      const sqls = await s.alterScript(spec);
      for (const sql of sqls) await client.query(sql);
      return { executed: sqls.length };
    },

    async dropTable({ schema, table }) {
      await client.query(`DROP TABLE ${U.qualify(D, null, schema, table)}`);
    },
    async truncateTable({ schema, table }) {
      await client.query(`TRUNCATE TABLE ${U.qualify(D, null, schema, table)}`);
    },
    async renameTable({ schema, table, newName }) {
      await client.query(`ALTER TABLE ${U.qualify(D, null, schema, table)} RENAME TO ${U.q(D, newName)}`);
    },
    async createDatabase(name) {
      await client.query(`CREATE DATABASE ${U.q(D, name)} ENCODING 'UTF8'`);
    },
    async dropDatabase({ db }) {
      await client.query(`DROP DATABASE ${U.q(D, db)}`);
    },

    // ---- 函数 / 存储过程 / 触发器 / 视图 / 序列 / 索引 ----
    async objectDdl({ schema, kind, name }) {
      const sch = schema || 'public';
      if (kind === 'index') {
        const r = await client.query('SELECT indexdef FROM pg_indexes WHERE schemaname = $1 AND indexname = $2 LIMIT 1', [sch, name]);
        return r.rows[0] ? r.rows[0].indexdef + ';' : '-- 未找到索引';
      }
      if (kind === 'function' || kind === 'procedure') {
        const r = await client.query(
          `SELECT pg_get_functiondef(p.oid) AS def FROM pg_proc p
           JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = $1 AND p.proname = $2 LIMIT 1`,
          [sch, name]
        );
        return r.rows[0] ? r.rows[0].def : '-- 未找到对象';
      }
      if (kind === 'view') {
        const r = await client.query(
          `SELECT 'CREATE OR REPLACE VIEW ' || $1 || '.' || c.relname || ' AS ' || pg_get_viewdef(c.oid, true) AS def
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind = 'v' LIMIT 1`,
          [sch, name]
        );
        return r.rows[0] ? r.rows[0].def + ';' : '-- 未找到视图';
      }
      if (kind === 'trigger') {
        const r = await client.query(
          `SELECT pg_get_triggerdef(t.oid) AS def FROM pg_trigger t
           JOIN pg_class c ON c.oid = t.tgrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = $1 AND t.tgname = $2 LIMIT 1`,
          [sch, name]
        );
        return r.rows[0] ? r.rows[0].def + ';' : '-- 未找到触发器';
      }
      if (kind === 'sequence') {
        const r = await client.query(
          'SELECT * FROM pg_sequences WHERE schemaname = $1 AND sequencename = $2',
          [sch, name]
        );
        const x = r.rows[0] || {};
        return `-- 序列 ${sch}.${name}\n` + Object.entries(x).map(([k, v]) => `${k}: ${v}`).join('\n');
      }
      throw new Error('不支持的对象类型: ' + kind);
    },
    async dropObject({ schema, kind, name, table }) {
      const kindMap = { function: 'FUNCTION', procedure: 'FUNCTION', sequence: 'SEQUENCE', view: 'VIEW', trigger: 'TRIGGER', index: 'INDEX' };
      // pg 触发器是表级对象：DROP TRIGGER name ON 表（schema 属于表引用）
      if (kind === 'trigger' && table) {
        await client.query(`DROP TRIGGER ${U.q(D, name)} ON ${U.qualify(D, null, schema, table)}`);
        return;
      }
      await client.query(`DROP ${kindMap[kind]} ${U.qualify(D, null, schema, name)}`);
    },

    // 结构明细行删除（侧边栏索引/外键/唯一键/检查/触发器右键）：DDL 由引擎统一生成
    async dropStruct(arg) {
      for (const st of U.dropStructSql(D, arg)) await client.query(st);
    },

    // 视图设计器保存：DDL 由引擎统一生成（标识符经 q() 转义）
    async createView(arg) {
      return this.query({ sqlText: U.createViewSql(D, arg), db: arg.db, schema: arg.schema });
    },

    // ---- 用户与权限 ----
    async users() {
      const r = await client.query(
        "SELECT rolname, rolsuper, rolcanlogin FROM pg_roles WHERE rolname NOT LIKE $1 ORDER BY rolname",
        ['pg\\_%']
      );
      return r.rows.map((x) => ({ name: x.rolname, host: '', super: x.rolsuper, canLogin: x.rolcanlogin }));
    },
    async createUser({ user, password }) {
      await client.query(`CREATE ROLE ${U.q(D, user)} LOGIN PASSWORD ${U.lit(D, password || '')}`);
    },
    async dropUser({ user }) {
      await client.query(`DROP ROLE IF EXISTS ${U.q(D, user)}`);
    },
    async listGrants({ user }) {
      const r = await client.query(
        `SELECT grantee, table_schema, table_name, privilege_type
         FROM information_schema.role_table_grants WHERE grantee = $1 ORDER BY table_schema, table_name LIMIT 300`,
        [user]
      );
      return r.rows.map((x) => `${x.grantee}: ${x.privilege_type} ON ${x.table_schema}.${x.table_name}`);
    },
    async grantTo({ user, privs, db }) {
      const allowed = ['ALL PRIVILEGES', 'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'DROP', 'ALTER', 'REFERENCES', 'TRUNCATE'];
      const list = (privs || []).filter((p) => allowed.includes(p));
      if (!list.length) throw new Error('未选择任何权限');
      const scope = db && db.trim() ? `DATABASE ${U.q(D, db.trim())}` : 'ALL TABLES IN SCHEMA public';
      await client.query(`GRANT ${list.join(', ')} ON ${scope} TO ${U.q(D, user)}`);
    },

    // ---- 备份导出 ----
    // content：'all' 结构+数据（备份/默认） / 'structure' 仅结构 / 'data' 仅数据（视图无数据可导，跳过）
    async dumpTable({ schema, table, content = 'all' }) {
      const parts = [];
      const isView = (await client.query(
        "SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=$2 AND c.relkind='v'",
        [schema || 'public', table]
      )).rows.length;
      if (content === 'data' && isView) return `-- 视图 ${table} 无数据可导出`;
      const cols = await s.columns({ schema, table });
      // 自增列（serial/identity 的 DEFAULT 都指向一个序列）：序列必须先建——目标端执行 CREATE TABLE 时
      // DEFAULT nextval(...) 里的 ::regclass 在解析期就要解析序列名，序列不存在直接报错；
      // 数据导完再 setval 把序列对齐到已导入的最大 id，之后不写 id 的新增才能接着自增
      const NEXTVAL = /nextval\('([^']+)'/i;
      const seqs = isView ? [] : cols
        .map((c) => ({ col: c.name, seq: (String(c.defaultValue || '').match(NEXTVAL) || [])[1] }))
        .filter((x) => x.seq);
      if (seqs.length && content !== 'data') parts.push(await s.dumpSequences(seqs, schema));
      if (content !== 'data') {
        if (isView) {
          parts.push(await s.objectDdl({ schema, kind: 'view', name: table }));
        } else {
          parts.push(await s.ddl({ schema, table }));
        }
      }
      const full = U.qualify(D, null, schema, table);
      const colList = cols.map((c) => U.q(D, c.name)).join(', ');
      const BATCH = 500;
      let rowCount = 0;
      if (content !== 'structure') {
        for (let page = 1; ; page += 1) {
          const r = await s.page({ schema, table, pageNo: page, pageSize: BATCH });
          if (!r.rows.length) break;
          for (const row of r.rows) {
            parts.push(`INSERT INTO ${full} (${colList}) VALUES (${row.map((v) => U.lit(D, v)).join(', ')});`);
          }
          rowCount += r.rows.length;
          if (r.rows.length < BATCH) break;
        }
        if (seqs.length && rowCount > 0) {
          for (const x of seqs) {
            parts.push(`SELECT setval('${x.seq.replace(/'/g, "''")}', GREATEST(COALESCE((SELECT MAX(${U.q(D, x.col)}) FROM ${full}), 1), 1));`);
          }
        }
      }
      return parts.join('\n');
    },

    // 表内自增列引用的序列 → CREATE SEQUENCE（带源端参数，恢复后行为与源一致）。
    // 数值参数取 pg_sequences 原文拼接：MAXVALUE 可达 2^63-1，超 JS 安全整数，Number() 会丢精度；
    // 仅以 /^-?\d+$/ 校验防注入。identity 列导出后退化为 DEFAULT nextval（serial 等价形式）
    async dumpSequences(seqs, schema) {
      const fq = (n) => (/[."]/.test(n) ? n : `${schema || 'public'}.${n}`);
      const r = await client.query(
        `SELECT schemaname || '.' || sequencename AS fq, start_value, increment_by, min_value, max_value, cache_size, cycle
         FROM pg_sequences WHERE (schemaname || '.' || sequencename) = ANY($1::text[])`,
        [seqs.map((x) => fq(x.seq))]
      );
      const byFq = new Map(r.rows.map((row) => [row.fq, row]));
      return seqs.map((x) => {
        const p = byFq.get(fq(x.seq)) || {};
        const num = (v) => (/^-?\d+$/.test(String(v == null ? '' : v)) ? String(v) : '');
        const opts = [
          num(p.increment_by) && `INCREMENT BY ${num(p.increment_by)}`,
          num(p.min_value) && `MINVALUE ${num(p.min_value)}`,
          num(p.max_value) && `MAXVALUE ${num(p.max_value)}`,
          num(p.start_value) && `START WITH ${num(p.start_value)}`,
          num(p.cache_size) && `CACHE ${num(p.cache_size)}`,
          p.cycle == null ? '' : (p.cycle ? 'CYCLE' : 'NO CYCLE'),
        ].filter(Boolean).join(' ');
        return `CREATE SEQUENCE IF NOT EXISTS ${x.seq}${opts ? ' ' + opts : ''};`;
      }).join('\n');
    },

    // ---- CSV 导入 / 批量插入（参数化） ----
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
      await client.query('BEGIN');
      try {
        for (const st of stmts) await client.query(st.sql, st.params);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      }
      return { inserted: stmts.length, columns: header.filter((h) => known.has(String(h).trim())).length };
    },
    async insertRows(spec) {
      const full = U.qualify(D, null, spec.schema, spec.table);
      const ph = spec.columns.map((_, i) => '$' + (i + 1)).join(', ');
      const sql = `INSERT INTO ${full} (${spec.columns.map((c) => U.q(D, c)).join(', ')}) VALUES (${ph})`;
      await client.query('BEGIN');
      try {
        for (const r of spec.rows) await client.query(sql, r);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      }
      return { inserted: spec.rows.length };
    },
  };
  return s;
}

module.exports = { create };
