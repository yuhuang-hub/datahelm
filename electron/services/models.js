'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// 保存的 ER 模型（跨会话持久化到 userData/models.json）：
//  {id, name, connId, db, schema, tables:[表名], createdAt, updatedAt}
function file() {
  const app = require('electron').app;
  return path.join(app.getPath('userData'), 'models.json');
}

let cache = null;

function load() {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(file(), 'utf8'));
  } catch {
    cache = { models: [] };
  }
  if (!cache || !Array.isArray(cache.models)) cache = { models: [] };
  const seen = new Set();
  let dirty = false;
  cache.models = cache.models.map((m) => {
    const item = { ...m };
    if (!item.id || seen.has(item.id)) {
      item.id = crypto.randomUUID();
      dirty = true;
    }
    seen.add(item.id);
    if (!Array.isArray(item.tables)) {
      item.tables = [];
      dirty = true;
    }
    return item;
  });
  if (dirty) persist();
  return cache;
}

function persist() {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(cache, null, 2));
}

function list(connId) {
  const all = load().models.slice().sort((a, b) => a.name.localeCompare(String(b.name), 'zh'));
  return connId ? all.filter((m) => m.connId === connId) : all;
}

function save(m) {
  const d = load();
  const now = Date.now();
  if (m.id) {
    const i = d.models.findIndex((x) => x.id === m.id);
    if (i >= 0) {
      d.models[i] = { ...d.models[i], ...m, updatedAt: now };
      persist();
      return d.models[i];
    }
  }
  const item = {
    id: m.id || crypto.randomUUID(),
    name: m.name || '未命名模型',
    connId: m.connId || '',
    db: m.db || '',
    schema: m.schema || '',
    tables: Array.isArray(m.tables) ? m.tables.map(String) : [],
    createdAt: m.createdAt || now,
    updatedAt: now,
  };
  d.models.push(item);
  persist();
  return item;
}

function remove(id) {
  if (typeof id !== 'string' || !id) throw new Error('无效的模型 id，已拒绝删除');
  const d = load();
  d.models = d.models.filter((x) => x.id !== id);
  persist();
}

module.exports = { list, save, remove };
