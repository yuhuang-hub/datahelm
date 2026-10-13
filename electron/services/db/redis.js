'use strict';
const Redis = require('ioredis');

// 所有来自界面的键名/模式先清洗控制字符，防止协议内联（参数按 argv 传输，无拼接）
const safeStr = (v) => String(v == null ? '' : v).replace(/[\r\n\0]/g, '');

async function create(cfg, localPort) {
  const client = new Redis({
    host: localPort ? '127.0.0.1' : (cfg.host || 'localhost'),
    port: localPort || Number(cfg.port) || 6379,
    password: cfg.password || undefined,
    db: cfg.db != null && cfg.db !== '' ? Number(cfg.db) : undefined,
    connectTimeout: 10000,
    maxRetriesPerRequest: 1,
    tls: cfg.ssl ? {} : undefined,
  });
  await new Promise((res, rej) => {
    client.once('ready', res);
    client.once('error', rej);
    setTimeout(() => rej(new Error('连接 Redis 超时')), 12000);
  });
  const srv = await client.info('server');
  const vm = srv.match(/redis_version:([\d.]+)/);

  const s = {
    type: 'redis',
    serverInfo: 'Redis ' + (vm ? vm[1] : ''),
    close: () => {
      try { client.disconnect(); } catch {}
    },

    // 树：有数据的 db
    async treeRoot() {
      const raw = await client.info('keyspace');
      const out = [];
      for (const line of String(raw).split('\n')) {
        const m = line.trim().match(/^db(\d+):keys=(\d+)/);
        if (m) out.push({ type: 'db', idx: Number(m[1]), keys: Number(m[2]), name: `db${m[1]}（${m[2]} 键）` });
      }
      return out;
    },
    async treeChildren() {
      return [];
    },

    // Redis 不提供自由命令行（安全收口：仅固定方法的键浏览），提示走键浏览器
    async query(arg) {
      const spec = typeof arg === 'string' ? { sqlText: arg } : arg || {};
      return [{
        sql: String(spec.sqlText || '').slice(0, 200),
        command: 'ERROR',
        columns: [], rows: [], rowCount: 0, elapsed: 0,
        error: 'Redis 连接不支持自由命令行，请双击左侧 db 节点打开键浏览器',
      }];
    },

    // ---- 键浏览（固定方法 + 清洗参数） ----
    async scanKeys({ db, pattern, cursor = '0', count = 200 }) {
      await client.select(Number(db) || 0);
      const [cur, keys] = await client.scan(String(cursor), 'MATCH', safeStr(pattern) || '*', 'COUNT', String(Number(count) || 200));
      const rows = [];
      for (const k of keys.slice(0, Number(count))) {
        rows.push([k, await client.type(k)]);
      }
      return { cursor: cur, rows };
    },
    async keyValue({ db, key }) {
      await client.select(Number(db) || 0);
      const k = safeStr(key);
      const type = await client.type(k);
      if (type === 'string') return { type, text: await client.get(k) };
      if (type === 'hash') return { type, pairs: Object.entries(await client.hgetall(k)) };
      if (type === 'list') return { type, items: (await client.lrange(k, 0, -1)).map(String) };
      if (type === 'set') return { type, items: (await client.smembers(k)).map(String) };
      if (type === 'zset') {
        const r = await client.zrangeWithScores(k, 0, -1);
        return { type, items: r.map((x) => `${x.value}  (score ${x.score})`) };
      }
      return { type, text: `(暂不支持展示 ${type})` };
    },
    async setKeyValue({ db, key, value }) {
      await client.select(Number(db) || 0);
      await client.set(safeStr(key), safeStr(value));
      return true;
    },
    async delKey({ db, keys }) {
      await client.select(Number(db) || 0);
      let n = 0;
      for (const k of keys || []) {
        n += await client.del(safeStr(k));
      }
      return n;
    },
    async dropDatabase({ db }) {
      await client.select(Number(db) || 0);
      await client.flushdb();
    },
    async createDatabase() {
      throw new Error('Redis 数据库编号固定（默认 0-15），无法新建');
    },

    // ---- 与通用 UI 的兼容 stub ----
    async columns() { throw new Error('Redis 无表结构，请使用键浏览器'); },
    async page() { throw new Error('Redis 请使用键浏览器（双击 db 节点）'); },
    async tables() { return []; },
    async ddl() { return '-- Redis 无 DDL'; },
    async objectDdl() { throw new Error('Redis 无此类对象'); },
    async createTable() { throw new Error('Redis 无表结构'); },
    async dropTable() { throw new Error('Redis 无表结构，请删除键'); },
    async truncateTable() { throw new Error('Redis 无表结构'); },
    async renameTable() { throw new Error('Redis 无表结构'); },
    async changes() { throw new Error('Redis 请通过键浏览器操作'); },
    async alterScript() { throw new Error('Redis 无表结构'); },
    async applyAlter() { throw new Error('Redis 无表结构'); },
  };
  return s;
}

module.exports = { create };
