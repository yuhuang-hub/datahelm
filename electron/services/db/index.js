'use strict';
const store = require('../connections');
const tunnel = require('../tunnel');
const drivers = {
  mysql: require('./mysql'),
  mariadb: require('./mysql'),
  postgres: require('./postgres'),
  sqlite: require('./sqlite'),
  mssql: require('./mssql'),
  mongo: require('./mongo'),
  redis: require('./redis'),
  oracle: require('./oracle'),
};

const RELATIONAL = ['mysql', 'mariadb', 'postgres', 'sqlite', 'mssql', 'oracle'];
const U = require('../sqlutil');

const sessions = new Map(); // connId -> session

async function openSession(connCfg) {
  const driver = drivers[connCfg.type];
  if (!driver) throw new Error('不支持的数据库类型: ' + connCfg.type);
  const c = { ...(connCfg.config || {}) };
  let tun = null;
  let localPort = 0;
  if (connCfg.type !== 'sqlite' && c.ssh && c.ssh.enabled) {
    tun = await tunnel.open(c.ssh, c.host, Number(c.port) || 3306);
    localPort = tun.port;
  }
  try {
    return await driver.create(c, localPort);
  } catch (e) {
    if (tun) tun.close();
    throw e;
  }
}

function info(s) {
  return { type: s.type, serverInfo: s.serverInfo };
}

async function open(id) {
  if (sessions.has(id)) return info(sessions.get(id));
  const cfg = store.get(id);
  if (!cfg) throw new Error('连接不存在（可能已被删除）');
  const s = await openSession(cfg);
  sessions.set(id, s);
  return info(s);
}

function close(id) {
  const s = sessions.get(id);
  if (s) {
    sessions.delete(id);
    try { s.close(); } catch {}
  }
}

async function test(cfg) {
  const s = await openSession(cfg);
  try {
    return s.serverInfo;
  } finally {
    try { s.close(); } catch {}
  }
}

async function call({ id, fn, args }) {
  const s = sessions.get(id);
  if (!s) throw new Error('连接未打开');
  if (typeof s[fn] !== 'function') throw new Error('未知操作: ' + fn);
  // 兼容两种调用习惯：args 为数组时逐个展开；否则视为单参数（对象/字符串）
  const list = Array.isArray(args) ? args : [args];
  return s[fn](...list);
}

// 数据传输：把源表整表复制到另一连接（建表 + 参数化分批写入）
// content：'copy' 结构+数据 / 'structure' 仅结构；exists：目标已存在时 'drop' 删除重建 / 'skip' 跳过 / 'error' 报错
const transfers = new Map(); // dstConnId -> session
async function transfer({ srcId, table, schema, db, dstId, dstDb, dstSchema, content = 'copy', exists = 'drop' }) {
  const src = sessions.get(srcId);
  if (!src) throw new Error('源连接未打开');
  if (!RELATIONAL.includes(src.type)) throw new Error('源连接类型不支持数据传输');
  const dstCfg = store.get(dstId);
  if (!dstCfg) throw new Error('目标连接不存在');
  if (!RELATIONAL.includes(dstCfg.type)) throw new Error('目标连接类型不支持数据传输（仅 MySQL/MariaDB/PostgreSQL/SQLite/SQL Server）');
  if (!transfers.has(dstId)) {
    try {
      transfers.set(dstId, await openSession(dstCfg));
    } catch (e) {
      transfers.delete(dstId);
      throw new Error('打开目标连接失败：' + e.message);
    }
  }
  const dst = transfers.get(dstId);
  const U = require('../sqlutil');
  const cols = await src.columns({ db, schema, table });
  if (!cols.length) throw new Error('读取不到表结构');
  // 目标建表（按目标已存在策略处理）
  const dstSchemaName =
    dstCfg.type === 'postgres' ? (dstSchema || 'public')
      : dstCfg.type === 'mssql' ? (dstSchema || 'dbo')
        : dstCfg.type === 'oracle' ? (dstSchema || '').toUpperCase()
          : null;
  let existing = [];
  try {
    existing = await dst.columns({ db: dstDb, schema: dstSchemaName, table });
  } catch {
    existing = [];
  }
  if (existing.length) {
    if (exists === 'skip') return { table, skipped: true, total: 0, copied: 0 };
    if (exists === 'error') throw new Error(`目标已存在同名表：${table}`);
    try {
      await dst.dropTable({ db: dstDb, schema: dstSchemaName, table });
    } catch {}
  }
  // 跨方言类型映射；PK 列强制 NOT NULL（sqlite PRAGMA 对 INTEGER PRIMARY KEY 报 notnull=0，而 T-SQL 不允许可空 PK）；
  // 自增列退化为普通整数（避免目标 IDENTITY/AUTO_INCREMENT 显式插值限制），默认值仅保留跨方言安全的字面量
  await dst.createTable({
    db: dstDb,
    schema: dstSchemaName,
    name: table,
    cols: cols.map((m) => {
      const t = U.mapType(src.type, m, dstCfg.type);
      return U.normCol({
        ...m,
        dataType: t.dataType,
        length: t.length,
        scale: t.scale,
        nullable: m.pk ? false : m.nullable,
        autoInc: false,
        defaultValue: U.transferDefault(m.defaultValue),
      });
    }),
  });
  if (content === 'structure') return { table, skipped: false, structureOnly: true, total: 0, copied: 0 };
  // 分批读取写入
  const names = cols.map((c) => c.name);
  const BATCH = 500;
  let copied = 0;
  for (let page = 1; ; page += 1) {
    const r = await src.page({ db, schema, table, pageNo: page, pageSize: BATCH });
    if (!r.rows.length) break;
    await dst.insertRows({ db: dstDb, schema: dstSchemaName, table, columns: names, rows: r.rows });
    copied += r.rows.length;
    if (r.rows.length < BATCH) break;
  }
  return { table, skipped: false, total: copied, copied };
}

function closeTransfers() {
  for (const [, s] of transfers) {
    try { s.close(); } catch {}
  }
  transfers.clear();
}

// ---- 结构同步：比较源/目标库的表结构差异并生成 DDL（不执行；应用由渲染层按 spec 调 createTable/applyAlter/dropTable）----
// 与数据传输互补：传输只整表复制，结构同步对两边同名的表做列/索引/唯一键/外键/检查的差异 DDL
const syncs = new Map(); // connId -> 独立会话（前台已打开的连接直接复用前台会话）
async function syncSess(id) {
  if (sessions.has(id)) return sessions.get(id);
  if (!syncs.has(id)) {
    const cfg = store.get(id);
    if (!cfg) throw new Error('连接不存在（可能已被删除）');
    try {
      syncs.set(id, await openSession(cfg));
    } catch (e) {
      syncs.delete(id);
      throw new Error('打开连接失败：' + e.message);
    }
  }
  return syncs.get(id);
}
function closeSyncSessions() {
  for (const [, s] of syncs) {
    try { s.close(); } catch {}
  }
  syncs.clear();
}

// 唯一索引归入唯一键组的方言（与对象列表/对象树同一口径）；pg/mssql 唯一键走独立 uniques，独立唯一索引仍在索引组
const SYNC_IDX_AS_UQ = ['sqlite', 'mysql', 'mariadb'];
async function syncStruct(s, type, ctx) {
  const cols = await s.columns(ctx);
  const soft = async (m) => { try { return await m(); } catch { return []; } };
  const idxAll = (await soft(() => s.indexes(ctx))).filter((x) => String(x.origin || '') !== 'pk');
  let uniques = [];
  let indexes = idxAll;
  if (SYNC_IDX_AS_UQ.includes(type)) {
    uniques = idxAll.filter((x) => x.unique);
    indexes = idxAll.filter((x) => !x.unique);
  } else {
    uniques = await soft(() => s.uniques(ctx));
  }
  return { cols, indexes, uniques, fkeys: await soft(() => s.fkeys(ctx)), checks: await soft(() => s.checks(ctx)) };
}

// 人类可读的差异摘要（+ 新增 / - 缺失 / ≠ 变更）
function syncChanges(before, after, dstType) {
  const out = [];
  const bByName = new Map(before.cols.map((c) => [c.name, c]));
  const aNames = new Set(after.cols.map((c) => c.name));
  for (const c of after.cols) {
    const bc = bByName.get(c.name);
    if (!bc) {
      out.push(`+ 列 ${c.name} ${U.fullType(c, dstType)}`);
      continue;
    }
    const bn = U.normCol(bc);
    if (U.fullType(bn, dstType) !== U.fullType(c, dstType)) out.push(`≠ 列 ${c.name}：${U.fullType(bn, dstType)} → ${U.fullType(c, dstType)}`);
    if (!!bn.nullable !== !!c.nullable) out.push(`≠ 列 ${c.name}：${bn.nullable ? '可空' : '非空'} → ${c.nullable ? '可空' : '非空'}`);
    if (String(bn.defaultValue || '') !== String(c.defaultValue || '')) out.push(`≠ 列 ${c.name} 默认值：${bn.defaultValue || '无'} → ${c.defaultValue || '无'}`);
    if (!!bn.pk !== !!c.pk) out.push(`≠ 列 ${c.name} 主键标记变化`);
  }
  for (const c of before.cols) if (!aNames.has(c.name)) out.push(`- 列 ${c.name}`);
  if (U.orderChanged({ before: before.cols, after: after.cols })) out.push('≠ 列顺序变化');
  const dset = (label, b, a, canon) => {
    const d = U.listDiff(b, a, (x) => canon(x, dstType));
    for (const x of d.drop) out.push(`- ${label} ${x.name}`);
    for (const x of d.add) out.push(`+ ${label} ${x.name}`);
  };
  dset('索引', before.indexes, after.indexesOf, U.idxCanon);
  dset('唯一键', before.uniques, after.uniquesOf, U.uqCanon);
  dset('外键', before.fkeys, after.fkeysOf, U.fkCanon);
  dset('检查', before.checks, after.checksOf, U.ckCanon);
  return out;
}

async function syncCompare({ srcId, srcDb = '', srcSchema = '', dstId, dstDb = '', dstSchema = '' }, onProgress) {
  const srcCfg = store.get(srcId);
  const dstCfg = store.get(dstId);
  if (!srcCfg || !dstCfg) throw new Error('连接不存在（可能已被删除）');
  if (!RELATIONAL.includes(srcCfg.type)) throw new Error('源连接类型不支持结构同步');
  if (!RELATIONAL.includes(dstCfg.type)) throw new Error('目标连接类型不支持结构同步');
  const src = await syncSess(srcId);
  const dst = await syncSess(dstId);
  const st = srcCfg.type;
  const dt = dstCfg.type;
  const dstSchemaName =
    dt === 'postgres' ? (dstSchema || 'public')
      : dt === 'mssql' ? (dstSchema || 'dbo')
        : dt === 'oracle' ? (dstSchema || '').toUpperCase()
          : null;
  const srcTables = await src.tables({ db: srcDb, schema: srcSchema });
  const dstTables = await dst.tables({ db: dstDb, schema: dstSchema });
  const dstSet = new Set(dstTables);
  const items = [];
  // 源列 → 目标方言（与数据传输同一映射：PK 强制非空、自增退化、默认值白名单）；
  // 同方言时跳过映射原样传递（sqlite INTEGER→BIGINT 之类的家族归一会让自比较出现假差异）
  const mapCols = (cols) =>
    cols.map((m) => {
      const t = st === dt ? { dataType: (m.dataType || 'VARCHAR').toUpperCase(), length: m.length, scale: m.scale } : U.mapType(st, m, dt);
      return U.normCol({
        ...m,
        dataType: t.dataType,
        length: t.length,
        scale: t.scale,
        nullable: m.pk ? false : m.nullable,
        autoInc: false,
        defaultValue: U.transferDefault(m.defaultValue),
      });
    });
  // 目标侧列同样做 PK 非空矫正（sqlite PRAGMA 对 INTEGER PRIMARY KEY 报 notnull=0 的假可空）；
  // 默认值过同一白名单（mssql 的 ((0)) 之类方言字面量不该算差异）
  const coerceBefore = (cols) => cols.map((c) => ({ ...c, nullable: c.pk ? false : c.nullable, defaultValue: U.transferDefault(c.defaultValue) }));
  // 逐表进度回调：渲染层进度条显示「正在比较第 n/N 张：表名」（每张表开工前上报）。
  // 随后 setImmediate 让步一个事件循环：sqlite 的 sql.js 是同步阻塞，微任务链不会让
  // 事件循环转身，积压的进度 IPC 会攒到比较结束才一次性冲刷（进度条失去实时性）
  const prog = (p) => { if (onProgress) { try { onProgress(p); } catch {} } };
  const yieldLoop = () => (onProgress ? new Promise((r) => setImmediate(r)) : null);
  for (let ti = 0; ti < srcTables.length; ti += 1) {
    const name = srcTables[ti];
    prog({ table: name, index: ti + 1, total: srcTables.length });
    await yieldLoop();
    const a = await syncStruct(src, st, { db: srcDb, schema: srcSchema, table: name });
    if (!dstSet.has(name)) {
      const cols = mapCols(a.cols);
      const spec = {
        db: dt === 'sqlite' ? '' : dstDb,
        schema: dstSchemaName,
        name,
        cols,
        comment: '',
        indexesAfter: a.indexes,
        uniquesAfter: a.uniques,
        fkeysAfter: a.fkeys,
        checksAfter: a.checks,
      };
      let ddl = '';
      let err = '';
      try {
        ddl = (await dst.createTableScript(spec)).join('\n');
      } catch (e) {
        err = e.message;
      }
      const changes = [`+ 表（目标缺少，共 ${cols.length} 列）`];
      if (dt === 'oracle') changes.push('⚠ Oracle 目标仅同步列定义（索引/约束请手工补齐）');
      // 非 sqlite/oracle 目标：外键不进建表语句（引用表可能尚未创建），执行时建表后再 ALTER 补挂
      let fkSpec = null;
      if (dt !== 'sqlite' && dt !== 'oracle' && a.fkeys.length) {
        fkSpec = {
          db: dstDb,
          schema: dstSchemaName,
          table: name,
          newName: name,
          before: cols,
          after: cols.map((c) => ({ ...c })),
          indexesBefore: [], indexesAfter: [],
          uniquesBefore: [], uniquesAfter: [],
          fkeysBefore: [], fkeysAfter: a.fkeys,
          checksBefore: [], checksAfter: [],
          infoBefore: null, options: {}, comment: '',
        };
        try {
          const fkSqls = await dst.alterScript(fkSpec);
          if (fkSqls.length) ddl += '\n' + fkSqls.join('\n');
        } catch (e) {
          err = err || e.message;
        }
      }
      items.push({ table: name, status: 'create', changes, createSpec: spec, fkSpec, ddl, err });
      continue;
    }
    const b = await syncStruct(dst, dt, { db: dstDb, schema: dstSchema, table: name });
    const beforeCols = coerceBefore(b.cols);
    const cols = mapCols(a.cols);
    const after = {
      cols,
      indexesOf: a.indexes,
      uniquesOf: a.uniques,
      fkeysOf: a.fkeys,
      checksOf: a.checks,
    };
    const changes = syncChanges({ ...b, cols: beforeCols }, after, dt);
    if (!changes.length) {
      items.push({ table: name, status: 'same', changes: [] });
      continue;
    }
    const spec = {
      db: dt === 'sqlite' ? '' : dstDb,
      schema: dstSchemaName,
      table: name,
      newName: name,
      before: beforeCols,
      after: cols,
      indexesBefore: b.indexes, indexesAfter: a.indexes,
      uniquesBefore: b.uniques, uniquesAfter: a.uniques,
      fkeysBefore: b.fkeys, fkeysAfter: a.fkeys,
      checksBefore: b.checks, checksAfter: a.checks,
      infoBefore: null, options: {}, comment: '',
    };
    let ddl = '';
    let err = '';
    try {
      ddl = (await dst.alterScript(spec)).join('\n');
    } catch (e) {
      err = e.message;
    }
    items.push({ table: name, status: 'diff', changes, spec, ddl, err });
  }
  const srcSet = new Set(srcTables);
  for (const name of dstTables) {
    if (!srcSet.has(name)) items.push({ table: name, status: 'extra', changes: ['- 表（目标独有，可选删除）'], ddl: '' });
  }
  return { items, srcType: st, dstType: dt, targetCtx: { db: dt === 'sqlite' ? '' : dstDb, schema: dstSchemaName } };
}

// ---- 数据同步：按主键逐行比较两库同名表的数据，生成预览 SQL；应用复用网格编辑的 changes 路径（值全部参数化绑定）----
const DATA_ROW_CAP = 50000;
// 比较归一：数值按值比较（mssql DECIMAL 以字符串返回，'10.50' 应与 10.5 相等）；
// 日期归一为日期/日期时间字符串（mssql DATE 返回 Date 对象）；二进制转十六进制；前缀避免跨类型碰撞
function dval(v) {
  if (v === null || v === undefined) return '\u0000';
  if (v instanceof Date) {
    const iso = v.toISOString();
    return '\u0002' + (iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso.slice(0, 19).replace('T', ' '));
  }
  if (v instanceof Uint8Array || Buffer.isBuffer(v)) return '\u0003' + Buffer.from(v).toString('hex');
  if (typeof v === 'number') return '\u0004' + v;
  const t = String(v).trim();
  if (t !== '' && /^-?\d+(\.\d+)?$/.test(t)) return '\u0004' + Number(t);
  return '\u0001' + String(v);
}
// 拉一页全列数据并转小写键对象（page 返回的行数组与其 columns 对齐；同名表行数远小于上限时可整体载入）
async function dataRows(sess, ctx) {
  const r = await sess.page({ ...ctx, pageNo: 1, pageSize: DATA_ROW_CAP });
  const cols = r.columns || [];
  const lower = cols.map((c) => String(c.name).toLowerCase());
  const rows = (r.rows || []).map((arr) => {
    const o = {};
    lower.forEach((n, i) => { o[n] = arr[i]; });
    return o;
  });
  return { cols, rows, total: Number(r.total) || rows.length };
}
// 单表比较：变化集按目标侧列名组织（dstCols 含 pk 标记，可直接交给驱动 changes 执行）
async function dataDiffTable(name, src, sctx, dst, dctx) {
  const a = await dataRows(src, sctx);
  const b = await dataRows(dst, dctx);
  if (a.total > DATA_ROW_CAP || b.total > DATA_ROW_CAP) return { status: 'skip', changes: ['⚠ 行数超过上限（5 万行/表），跳过比较'] };
  const apk = a.cols.filter((c) => c.pk).map((c) => String(c.name).toLowerCase()).sort();
  const bpk = b.cols.filter((c) => c.pk).map((c) => String(c.name).toLowerCase()).sort();
  if (!apk.length || bpk.join(',') !== apk.join(',')) {
    return { status: 'nopk', changes: ['⚠ 两边主键列不一致（或无主键），无法按主键比较'] };
  }
  const pkLower = new Set(apk);
  // 同名列（按目标侧命名，含主键列）：比较列 = 同名非主键列；值从源行按小写名取
  const dstCols = b.cols.filter((c) => a.cols.some((d) => String(d.name).toLowerCase() === String(c.name).toLowerCase()));
  const pkDst = dstCols.filter((c) => pkLower.has(String(c.name).toLowerCase()));
  const dataCols = dstCols.filter((c) => !pkLower.has(String(c.name).toLowerCase()));
  if (!dataCols.length) return { status: 'skip', changes: ['⚠ 除主键外没有同名列，无需数据同步'] };
  const keyOf = (o) => apk.map((k) => dval(o[k])).join('\u0001');
  const bmap = new Map();
  for (const o of b.rows) bmap.set(keyOf(o), o);
  const aKeys = new Set();
  const inserts = [];
  const updates = [];
  const deletes = [];
  for (const so of a.rows) {
    const k = keyOf(so);
    aKeys.add(k);
    const to = bmap.get(k);
    if (!to) {
      const row = {};
      dstCols.forEach((c) => { row[c.name] = so[c.name.toLowerCase()]; });
      inserts.push(row);
      continue;
    }
    const set = {};
    dataCols.forEach((c) => {
      if (dval(so[c.name.toLowerCase()]) !== dval(to[c.name.toLowerCase()])) set[c.name] = so[c.name.toLowerCase()];
    });
    if (Object.keys(set).length) {
      const row = {};
      pkDst.forEach((c) => { row[c.name] = to[c.name.toLowerCase()]; });
      updates.push({ row, set });
    }
  }
  for (const to of b.rows) {
    if (!aKeys.has(keyOf(to))) {
      const row = {};
      pkDst.forEach((c) => { row[c.name] = to[c.name.toLowerCase()]; });
      deletes.push({ row });
    }
  }
  if (!inserts.length && !updates.length && !deletes.length) return { status: 'same', changes: [] };
  return { status: 'diff', inserts, updates, deletes, dstCols, pkDst, changes: [] };
}
// 预览 SQL（仅展示；执行端走 changes 的参数化语句，不执行这些字面量）
function dataPreviewSql(dt, dstDb, dstSchemaName, name, d) {
  const full = U.qualify(dt, ['mysql', 'mariadb', 'mssql'].includes(dt) ? dstDb : null, dstSchemaName, name);
  const out = [];
  for (const row of d.inserts) {
    const names = Object.keys(row);
    out.push(`INSERT INTO ${full} (${names.map((c) => U.q(dt, c)).join(', ')}) VALUES (${names.map((c) => U.lit(dt, row[c])).join(', ')});`);
  }
  for (const u of d.updates) {
    out.push(`UPDATE ${full} SET ${Object.keys(u.set).map((c) => `${U.q(dt, c)}=${U.lit(dt, u.set[c])}`).join(', ')} WHERE ${d.pkDst.map((c) => `${U.q(dt, c)}=${U.lit(dt, u.row[c])}`).join(' AND ')};`);
  }
  for (const x of d.deletes) {
    out.push(`DELETE FROM ${full} WHERE ${d.pkDst.map((c) => `${U.q(dt, c)}=${U.lit(dt, x.row[c])}`).join(' AND ')};`);
  }
  const more = out.length - 100;
  if (more > 0) {
    out.length = 100;
    out.push(`-- ……另有 ${more} 条（应用时全部执行）`);
  }
  return out;
}
// 比较/应用共用的核心：遍历同名表并逐表求差异（only 限定表集合；diff 项携带完整变化集供应用）
async function dataSyncCore({ srcId, srcDb = '', srcSchema = '', dstId, dstDb = '', dstSchema = '', only = null, onProgress = null }) {
  const srcCfg = store.get(srcId);
  const dstCfg = store.get(dstId);
  if (!srcCfg || !dstCfg) throw new Error('连接不存在（可能已被删除）');
  if (!RELATIONAL.includes(srcCfg.type)) throw new Error('源连接类型不支持数据同步');
  if (!RELATIONAL.includes(dstCfg.type)) throw new Error('目标连接类型不支持数据同步');
  const src = await syncSess(srcId);
  const dst = await syncSess(dstId);
  const st = srcCfg.type;
  const dt = dstCfg.type;
  const dstSchemaName =
    dt === 'postgres' ? (dstSchema || 'public')
      : dt === 'mssql' ? (dstSchema || 'dbo')
        : dt === 'oracle' ? (dstSchema || '').toUpperCase()
          : null;
  const srcTables = await src.tables({ db: srcDb, schema: srcSchema });
  const dstTables = await dst.tables({ db: dstDb, schema: dstSchema });
  const dstSet = new Set(dstTables);
  const want = only && only.length ? new Set(only) : null;
  const items = [];
  // 逐表进度回调（与结构同步同形：每张表开工前上报 {table,index,total}）；
  // setImmediate 让步事件循环，保证进度 IPC 实时冲刷（见 syncCompare 同款注释）
  const prog = (p) => { if (onProgress) { try { onProgress(p); } catch {} } };
  const yieldLoop = () => (onProgress ? new Promise((r) => setImmediate(r)) : null);
  for (let ti = 0; ti < srcTables.length; ti += 1) {
    const name = srcTables[ti];
    if (want && !want.has(name)) continue;
    prog({ table: name, index: ti + 1, total: srcTables.length });
    await yieldLoop();
    if (!dstSet.has(name)) {
      items.push({ table: name, status: 'dstmissing', changes: ['- 目标缺少该表（请先用结构同步建表）'], inserts: 0, updates: 0, deletes: 0 });
      continue;
    }
    let d;
    try {
      d = await dataDiffTable(name, src, { db: srcDb, schema: srcSchema, table: name }, dst, { db: dstDb, schema: dstSchemaName, table: name });
    } catch (e) {
      items.push({ table: name, status: 'skip', changes: ['⚠ 比较失败：' + e.message], inserts: 0, updates: 0, deletes: 0 });
      continue;
    }
    if (d.status === 'diff') {
      let sql = '';
      let err = '';
      try {
        sql = dataPreviewSql(dt, dstDb, dstSchemaName, name, d).join('\n');
      } catch (e) {
        err = e.message;
      }
      const parts = [];
      if (d.inserts.length) parts.push(`+ ${d.inserts.length} 行（目标缺少）`);
      if (d.updates.length) parts.push(`≠ ${d.updates.length} 行（同键不同值）`);
      if (d.deletes.length) parts.push(`- ${d.deletes.length} 行（目标多出）`);
      items.push({ table: name, status: 'diff', inserts: d.inserts.length, updates: d.updates.length, deletes: d.deletes.length, changes: parts, sql, err, diff: d });
    } else {
      items.push({ table: name, status: d.status, inserts: 0, updates: 0, deletes: 0, changes: d.changes });
    }
  }
  return { items, dt, dstDb, dstSchemaName };
}
async function dataCompare(payload, onProgress) {
  const { items } = await dataSyncCore({ ...payload, onProgress });
  // 轻量化：渲染层只要计数与预览（应用端在主进程重新求差异，不回传变化集）
  return { items: items.map((x) => ({ table: x.table, status: x.status, inserts: x.inserts, updates: x.updates, deletes: x.deletes, changes: x.changes, sql: x.sql || '', err: x.err || '' })) };
}
async function dataApply({ srcId, srcDb, srcSchema, dstId, dstDb, dstSchema, tables, ops }) {
  const use = { insert: true, update: true, delete: true, ...(ops || {}) };
  const core = await dataSyncCore({ srcId, srcDb, srcSchema, dstId, dstDb, dstSchema, only: tables || [] });
  const dst = await syncSess(dstId);
  const results = [];
  for (const it of core.items) {
    if (!it.diff) {
      results.push({ table: it.table, status: it.status, inserts: 0, updates: 0, deletes: 0, executed: 0, skipped: true });
      continue;
    }
    const d = it.diff;
    const spec = {
      db: ['mysql', 'mariadb', 'mssql'].includes(core.dt) ? core.dstDb : null,
      schema: core.dstSchemaName,
      table: it.table,
      columns: d.dstCols,
      inserts: use.insert ? d.inserts : [],
      updates: use.update ? d.updates : [],
      deletes: use.delete ? d.deletes : [],
    };
    // 逐表执行：单表失败记入结果，不中断其余表
    try {
      const r = await dst.changes(spec);
      results.push({ table: it.table, status: 'done', inserts: spec.inserts.length, updates: spec.updates.length, deletes: spec.deletes.length, executed: r.executed, skipped: false });
    } catch (e) {
      results.push({ table: it.table, status: 'error', inserts: 0, updates: 0, deletes: 0, executed: 0, error: e.message });
    }  }
  return { results };
}

// 按连接 id 打开一个临时会话（备份/列表用完即关，不复用前台会话）
async function openTemp(id) {
  const cfg = store.get(id);
  if (!cfg) throw new Error('连接不存在（可能已被删除）');
  return openSession(cfg);
}

// ---- 运行 SQL 文件（还原备份）：把 .sql 脚本逐句在目标连接原样执行 ----
// text 由 IPC 边界（main.js）校验文件后读出传入；语句经 call('query') 逐句执行——
// 与查询页完全同一条分发路径（驱动内部按方言处理注释/引号/GO/DELIMITER），本层不做任何拼接改写；
// stopOnError=true 时首个错误即停，否则记下错误继续
// 先 open()：还原目标在前台打开（sqlite 共享同一份内存副本，还原结果树里即时可见且落盘一致）
async function runSqlFile({ connId, db, schema, text, stopOnError }) {
  await open(connId);
  const t0 = Date.now();
  let ok = 0;
  const errs = [];
  for (const s of U.splitStatements(text)) {
    // 每句一次调用：mssql 的 CREATE VIEW/PROCEDURE 等要求批首，单句成批最稳
    const rs = await call({ id: connId, fn: 'query', args: { sqlText: s, db: db || undefined, schema: schema || undefined } });
    const bad = rs.find((r) => r.command === 'ERROR');
    if (bad) {
      errs.push({ sql: s.length > 160 ? `${s.slice(0, 160)}…` : s, error: String(bad.error || '') });
      if (stopOnError) break;
    } else {
      ok += 1;
    }
  }
  return { total: ok + errs.length, ok, errors: errs, elapsed: Date.now() - t0 };
}

// ---- 查询解释（EXPLAIN 执行计划）：把查询页语句包上各方言的解释命令，经 call('query') 逐句执行 ----
// 语句来自查询编辑器（与「运行」同源），本层只加方言前缀/辅助语句、不改写语句本身；
// mssql 的 SET SHOWPLAN_TEXT 必须独占批次且走 execSqlBatch（execSql 按请求重置会话 SET 态——
// DATEFORMAT 探针证实），query() 的逐句分批 + useBatch 满足；结尾 OFF 即使中间语句出错也会执行，不毒化会话；
// oracle 的 PLAN_TABLE 三步（清空→PLAN→DISPLAY）同样靠逐句分批
const EXPLAIN_STID = 'DHEXPLAIN';
const EXPLAIN_WRAP = {
  mysql: (s) => `EXPLAIN ${s}`,
  mariadb: (s) => `EXPLAIN ${s}`,
  sqlite: (s) => `EXPLAIN QUERY PLAN ${s}`,
  postgres: (s) => `EXPLAIN ${s}`,
  mssql: (s) => `SET SHOWPLAN_TEXT ON;\n${s};\nSET SHOWPLAN_TEXT OFF;`,
  oracle: (s) =>
    `DELETE FROM PLAN_TABLE WHERE STATEMENT_ID = '${EXPLAIN_STID}';\nEXPLAIN PLAN SET STATEMENT_ID = '${EXPLAIN_STID}' FOR ${s};\nSELECT PLAN_TABLE_OUTPUT FROM TABLE(DBMS_XPLAN.DISPLAY(NULL, '${EXPLAIN_STID}'))`,
};
async function explainQuery({ connId, db, schema, sqlText }) {
  const [first] = U.splitStatements(String(sqlText || ''));
  if (!first) throw new Error('没有可解释的语句');
  const cfg = store.get(connId);
  if (!cfg) throw new Error('连接不存在（可能已被删除）');
  const wrap = EXPLAIN_WRAP[cfg.type];
  if (!wrap) throw new Error('该数据库类型暂不支持解释');
  await open(connId);
  const t0 = Date.now();
  const out = await call({
    id: connId,
    fn: 'query',
    args: { sqlText: wrap(first), db: db || undefined, schema: schema || undefined, useBatch: cfg.type === 'mssql' || undefined },
  });
  // mssql 兜底：错误路径下序列末尾的 SET SHOWPLAN_TEXT OFF 偶发未生效（会话残留计划态，普通运行也返回计划行）；
  // 成功/失败都无条件再补一发 OFF（幂等无害），确保会话干净
  if (cfg.type === 'mssql') {
    try {
      await call({ id: connId, fn: 'query', args: { sqlText: 'SET SHOWPLAN_TEXT OFF;', db: db || undefined, useBatch: true } });
    } catch {}
  }
  const bad = out.find((r) => r.command === 'ERROR');
  if (bad) throw new Error(String(bad.error || '解释失败'));
  // mssql SHOWPLAN_TEXT 会把「语句回显行」和「算子树行」拆成多个结果集（query() 每个 resultset 一条记录），按序合并
  const planParts = out.filter((r) => r.command === 'SELECT' && r.columns && r.columns.length);
  if (!planParts.length) return { columns: ['说明'], rows: [['（该语句没有返回执行计划）']], rowCount: 1 };
  const columns = planParts[0].columns;
  const rows = planParts.reduce((acc, r) => acc.concat(r.rows || []), []);
  return { columns, rows, rowCount: rows.length, elapsed: Date.now() - t0 };
}

module.exports = { open, close, test, call, transfer, closeTransfers, openTemp, syncCompare, closeSyncSessions, dataCompare, dataApply, runSqlFile, explainQuery };
