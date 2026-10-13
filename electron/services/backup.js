'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');
const connStore = require('./connections');

// 备份计划：持久化到 userData/backups.json；主进程内 30s 轮询调度
// 计划结构: { id, name, connId, connName, db, schema, tables[], dir,
//             mode: 'daily'|'interval', time: 'HH:mm', minutes: N,
//             enabled, lastRunAt, lastStatus, lastFile }
function file() {
  const app = require('electron').app;
  return path.join(app.getPath('userData'), 'backups.json');
}

let cache = null;

function load() {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(file(), 'utf8'));
  } catch {
    cache = { schedules: [] };
  }
  if (!cache || !Array.isArray(cache.schedules)) cache = { schedules: [] };
  // 自愈：历史数据可能缺 id 或 id 重复，若不补齐，按 id 删除会一次匹配掉多行
  const seen = new Set();
  let dirty = false;
  cache.schedules = cache.schedules.map((sc) => {
    const item = { ...sc };
    if (!Array.isArray(item.tables)) {
      item.tables = [];
      dirty = true;
    }
    if (!item.id || seen.has(item.id)) {
      item.id = crypto.randomUUID();
      dirty = true;
    }
    seen.add(item.id);
    return item;
  });
  if (dirty) persist();
  return cache;
}

function persist() {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(cache, null, 2));
}

function list() {
  return load().schedules;
}

function upsert(sc) {
  const d = load();
  if (sc.id) {
    const i = d.schedules.findIndex((x) => x.id === sc.id);
    if (i >= 0) {
      d.schedules[i] = { ...d.schedules[i], ...sc };
      persist();
      return d.schedules[i];
    }
  }
  const item = {
    id: sc.id || crypto.randomUUID(),
    name: sc.name || '备份计划',
    connId: sc.connId || '',
    connName: sc.connName || '',
    db: sc.db || '',
    schema: sc.schema || '',
    tables: Array.isArray(sc.tables) ? sc.tables : [],
    dir: sc.dir || defaultDir(),
    mode: sc.mode === 'interval' ? 'interval' : 'daily',
    time: /^\d{1,2}:\d{2}$/.test(sc.time || '') ? sc.time : '03:00',
    minutes: Number(sc.minutes) || 60,
    enabled: sc.enabled !== false,
    lastRunAt: 0,
    lastStatus: '',
    lastFile: '',
  };
  d.schedules.push(item);
  persist();
  return item;
}

function remove(id) {
  if (typeof id !== 'string' || !id) throw new Error('无效的备份计划 id，已拒绝删除');
  const d = load();
  d.schedules = d.schedules.filter((x) => x.id !== id);
  persist();
}

function setEnabled(id, enabled) {
  const d = load();
  const i = d.schedules.findIndex((x) => x.id === id);
  if (i >= 0) {
    d.schedules[i].enabled = !!enabled;
    persist();
  }
}

function defaultDir() {
  const app = require('electron').app;
  return path.join(app.getPath('userData'), 'backups');
}

// ---- 还原：列出备份目录里的 .sql 文件（按修改时间倒序），供"运行 SQL 文件"选择 ----
function files(dir) {
  const d = typeof dir === 'string' && dir.trim() ? dir.trim() : defaultDir();
  let names = [];
  try {
    names = fs.readdirSync(d);
  } catch {
    return []; // 目录不存在/不可读 → 空列表（前端提示选择目录或浏览文件）
  }
  return names
    .filter((f) => /\.sql$/i.test(f))
    .map((f) => {
      const p = path.join(d, f);
      try {
        const st = fs.statSync(p);
        return st.isFile() ? { file: p, name: f, size: st.size, mtime: st.mtimeMs, dir: d } : null;
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.mtime - a.mtime);
}

// ---- 执行一次备份：dump 指定连接/库/表到 SQL 文件 ----
async function runOnce(sc) {
  const conn = connStore.get(sc.connId);
  if (!conn) throw new Error('连接不存在（可能已被删除）');
  const session = await db.openTemp(sc.connId);
  const stamp = new Date()
    .toLocaleString('sv-SE', { hour12: false })
    .replace(/[:T ]/g, (m) => (m === ' ' ? '_' : ''));
  try {
    const tableList = sc.tables && sc.tables.length
      ? sc.tables
      : await session.tables({ db: sc.db || undefined, schema: sc.schema || undefined });
    const parts = [
      `-- DataHelm 备份`,
      `-- 计划: ${sc.name}`,
      `-- 连接: ${conn.name}（${conn.type}）`,
      `-- 数据库: ${sc.db || '-'}  schema: ${sc.schema || '-'}`,
      `-- 生成时间: ${new Date().toLocaleString('zh-CN')}`,
      `-- 共 ${tableList.length} 个对象`,
      '',
    ];
    for (const t of tableList) {
      parts.push(`-- ---------- ${t} ----------`);
      try {
        parts.push(await session.dumpTable({ db: sc.db || undefined, schema: sc.schema || undefined, table: t }));
      } catch (e) {
        parts.push(`-- 导出 ${t} 失败: ${e.message}`);
      }
      parts.push('');
    }
    const dir = sc.dir || defaultDir();
    fs.mkdirSync(dir, { recursive: true });
    const safe = String(sc.name || 'backup').replace(/[\\/:*?"<>|]/g, '_');
    const outFile = path.join(dir, `${safe}_${stamp}.sql`);
    fs.writeFileSync(outFile, parts.join('\n'), 'utf8');
    return { file: outFile, objects: tableList.length };
  } finally {
    try { session.close(); } catch {}
  }
}

async function runNow(id) {
  const sc = list().find((x) => x.id === id);
  if (!sc) throw new Error('备份计划不存在');
  const r = await markRun(sc);
  return r;
}

async function markRun(sc) {
  try {
    const r = await runOnce(sc);
    updateState(sc.id, Date.now(), '成功：' + r.objects + ' 个对象 → ' + path.basename(r.file), r.file);
    return r;
  } catch (e) {
    updateState(sc.id, Date.now(), '失败：' + e.message, '');
    throw e;
  }
}

function updateState(id, at, status, file) {
  const d = load();
  const i = d.schedules.findIndex((x) => x.id === id);
  if (i >= 0) {
    d.schedules[i].lastRunAt = at;
    d.schedules[i].lastStatus = status;
    d.schedules[i].lastFile = file;
    persist();
  }
}

// ---- 调度：30 秒轮询 ----
function dailyDueAt(time) {
  const [h, m] = String(time || '03:00').split(':').map(Number);
  const now = new Date();
  const at = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h || 0, m || 0, 0);
  return at.getTime();
}

function isDue(sc, now) {
  if (!sc.enabled) return false;
  if (sc.mode === 'interval') {
    return !sc.lastRunAt || now - sc.lastRunAt >= (sc.minutes || 60) * 60000;
  }
  const dueAt = dailyDueAt(sc.time);
  return now >= dueAt && (!sc.lastRunAt || sc.lastRunAt < dueAt);
}

let timer = null;
function startScheduler() {
  if (timer) return;
  timer = setInterval(() => {
    const now = Date.now();
    for (const sc of list()) {
      if (isDue(sc, now)) {
        markRun(sc).catch(() => {}); // 状态已写进 lastStatus
      }
    }
  }, 30000);
  if (timer.unref) timer.unref();
}

module.exports = { list, upsert, remove, setEnabled, runNow, startScheduler, defaultDir, isDue, files };
