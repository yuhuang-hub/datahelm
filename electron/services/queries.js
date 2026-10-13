'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// 保存的查询（跨会话持久化到 userData/queries.json）
function file() {
  const app = require('electron').app;
  return path.join(app.getPath('userData'), 'queries.json');
}

let cache = null;

function load() {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(file(), 'utf8'));
  } catch {
    cache = { queries: [] };
  }
  if (!cache || !Array.isArray(cache.queries)) cache = { queries: [] };
  // 自愈：补齐缺失/重复的 id，避免按 id 删除时一次匹配掉多行
  const seen = new Set();
  let dirty = false;
  cache.queries = cache.queries.map((q) => {
    const item = { ...q };
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
  return load().queries.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

function save(q) {
  const d = load();
  const now = Date.now();
  if (q.id) {
    const i = d.queries.findIndex((x) => x.id === q.id);
    if (i >= 0) {
      d.queries[i] = { ...d.queries[i], ...q, updatedAt: now };
      persist();
      return d.queries[i];
    }
  }
  const item = {
    id: q.id || crypto.randomUUID(),
    name: q.name || '未命名查询',
    connId: q.connId || '',
    db: q.db || '',
    schema: q.schema || '',
    text: q.text || '',
    createdAt: q.createdAt || now,
    updatedAt: now,
  };
  d.queries.push(item);
  persist();
  return item;
}

function remove(id) {
  if (typeof id !== 'string' || !id) throw new Error('无效的查询 id，已拒绝删除');
  const d = load();
  d.queries = d.queries.filter((x) => x.id !== id);
  persist();
}

module.exports = { list, save, remove };
