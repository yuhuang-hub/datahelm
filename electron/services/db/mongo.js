'use strict';
const { MongoClient, ObjectId } = require('mongodb');

async function create(cfg, localPort) {
  const host = localPort ? '127.0.0.1' : (cfg.host || 'localhost');
  const port = localPort || Number(cfg.port) || 27017;
  let url = `mongodb://${host}:${port}`;
  if (cfg.user) {
    const auth = encodeURIComponent(cfg.user) + ':' + encodeURIComponent(cfg.password || '') + '@';
    url = `mongodb://${auth}${host}:${port}/${cfg.authDb || 'admin'}?authSource=${encodeURIComponent(cfg.authDb || 'admin')}`;
  }
  const client = new MongoClient(url, { serverSelectionTimeoutMS: 10000 });
  await client.connect();
  const bi = await client.db(cfg.authDb || 'admin').admin().buildInfo();

  const parseJson = (str, what) => {
    if (!str || !String(str).trim()) return {};
    try {
      const o = JSON.parse(str);
      if (o && typeof o === 'object') return o;
    } catch {}
    throw new Error(`${what} 不是合法的 JSON`);
  };
  const flat = (v) => {
    if (v === null || v === undefined) return null;
    if (v instanceof Date) return v.toISOString();
    if (typeof v === 'object') {
      try { return JSON.stringify(v); } catch { return String(v); }
    }
    return v;
  };
  const toId = (v) => (ObjectId.isValid(String(v)) ? new ObjectId(String(v)) : v);

  const s = {
    type: 'mongo',
    serverInfo: `MongoDB ${bi.version}`,
    close: () => client.close().catch(() => {}),

    async treeRoot() {
      const r = await client.db().admin().listDatabases();
      return r.databases.map((d) => ({ type: 'db', name: d.name }));
    },

    async treeChildren(node) {
      if (node.type === 'db') {
        return [{ type: 'cat', kind: 'collection', db: node.name, name: '集合' }];
      }
      if (node.type === 'cat' && node.kind === 'collection') {
        const cols = await client.db(node.db).listCollections().toArray();
        return cols.map((c) => ({ type: 'table', db: node.db, name: c.name }));
      }
      return [];
    },

    async columns({ db, table }) {
      const docs = await client.db(db).collection(table).aggregate([{ $sample: { size: 50 } }]).toArray();
      const keys = [];
      const seen = new Set();
      for (const d of docs) {
        for (const k of Object.keys(d)) {
          if (!seen.has(k)) { seen.add(k); keys.push(k); }
        }
      }
      if (!seen.has('_id')) keys.unshift('_id');
      return keys.map((k) => ({
        name: k, dataType: 'JSON', display: '', length: null, scale: null,
        nullable: true, pk: k === '_id', autoInc: false, defaultValue: null, comment: '', editable: false,
      }));
    },

    async tables({ db }) {
      const cols = await client.db(db).listCollections().toArray();
      return cols.map((c) => c.name);
    },

    async page({ db, table, pageNo = 1, pageSize = 100, where, orderCol, orderDir }) {
      const coll = client.db(db).collection(table);
      const filter = parseJson(where, '筛选条件');
      const total = await coll.countDocuments(filter);
      const sort = orderCol ? { [orderCol]: orderDir === 'DESC' ? -1 : 1 } : {};
      const docs = await coll.find(filter).sort(sort).skip((pageNo - 1) * pageSize).limit(Number(pageSize)).toArray();
      const cols = await s.columns({ db, table });
      const names = cols.map((c) => c.name);
      const rows = docs.map((d) => names.map((nm) => (nm === '_id' ? String(d._id ?? '') : flat(d[nm] === undefined ? null : d[nm]))));
      return { columns: cols, rows, total, readonly: true };
    },

    // Mongo 查询：输入 JSON，如 {"collection":"users","filter":{},"sort":{"_id":-1},"limit":100}
    async query(arg) {
      const spec = typeof arg === 'string' ? { sqlText: arg } : arg || {};
      const text = String(spec.sqlText || '').replace(/--.*$/gm, '').trim();
      const t0 = Date.now();
      let qs;
      try {
        qs = JSON.parse(text);
      } catch {
        return [{
          sql: text, command: 'ERROR', columns: [], rows: [], rowCount: 0, elapsed: 0,
          error: 'MongoDB 查询需输入 JSON：{"collection":"名称","filter":{},"sort":{},"limit":100}',
        }];
      }
      try {
        const dbName = qs.db || spec.db;
        const coll = client.db(dbName).collection(qs.collection);
        const find = qs.pipeline
          ? coll.aggregate(qs.pipeline)
          : coll.find(qs.filter || {}).sort(qs.sort || {}).skip(qs.skip || 0).limit(qs.limit || 100);
        const docs = await find.toArray();
        const keys = [];
        const seen = new Set();
        for (const d of docs) for (const k of Object.keys(d)) if (!seen.has(k)) { seen.add(k); keys.push(k); }
        return [{
          sql: text, command: 'SELECT', columns: keys, rowCount: docs.length, elapsed: Date.now() - t0,
          rows: docs.map((d) => keys.map((k) => (k === '_id' ? String(d[k] ?? '') : flat(d[k] === undefined ? null : d[k])))),
        }];
      } catch (e) {
        return [{ sql: text, command: 'ERROR', columns: [], rows: [], rowCount: 0, error: e.message, elapsed: Date.now() - t0 }];
      }
    },

    // 仅支持按 _id 删除；文档结构不支持单元格编辑
    async changes(spec) {
      if ((spec.updates || []).length || (spec.inserts || []).length) {
        throw new Error('MongoDB 为文档结构，暂不支持单元格编辑；删除行按 _id 生效');
      }
      const coll = client.db(spec.db).collection(spec.table);
      let n = 0;
      for (const del of spec.deletes || []) {
        const id = del.row && del.row._id;
        if (id === undefined || id === null) continue;
        const r = await coll.deleteOne({ _id: toId(id) });
        n += r.deletedCount;
      }
      return { executed: n };
    },

    async ddl({ db, table }) {
      const idx = await client.db(db).collection(table).indexes();
      return idx.map((i) => JSON.stringify(i)).join('\n');
    },

    async objectDdl() {
      throw new Error('MongoDB 无此类对象');
    },

    async createTable(spec) {
      await client.db(spec.db).createCollection(spec.name);
      return `db.createCollection(${JSON.stringify(spec.name)})`;
    },
    async dropTable({ db, table }) {
      await client.db(db).collection(table).drop();
    },
    async truncateTable({ db, table }) {
      await client.db(db).collection(table).deleteMany({});
    },
    async renameTable({ db, table, newName }) {
      await client.db('admin').command({ renameCollection: `${db}.${table}`, to: `${db}.${newName}` });
    },
    async createDatabase(name) {
      await client.db(name).createCollection('init');
    },
    async dropDatabase({ db }) {
      await client.db(db).dropDatabase();
    },
    async alterScript() {
      throw new Error('MongoDB 无固定表结构，无设计器');
    },
    async applyAlter() {
      throw new Error('MongoDB 无固定表结构，无设计器');
    },
  };
  return s;
}

module.exports = { create };
