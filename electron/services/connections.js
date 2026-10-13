'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// 连接配置持久化到 userData/connections.json（纯文本保存，与 Navicat 配置文件做法类似）
function file() {
  const app = require('electron').app;
  return path.join(app.getPath('userData'), 'connections.json');
}

let cache = null;

function load() {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(file(), 'utf8'));
  } catch {
    cache = { connections: [] };
  }
  return cache;
}

function persist() {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(cache, null, 2));
}

function list() {
  return load().connections;
}

function save(c) {
  const d = load();
  if (c.id) {
    const i = d.connections.findIndex((x) => x.id === c.id);
    if (i >= 0) d.connections[i] = c;
    else d.connections.push(c);
  } else {
    c.id = crypto.randomUUID();
    d.connections.push(c);
  }
  persist();
  return c;
}

function remove(id) {
  const d = load();
  d.connections = d.connections.filter((x) => x.id !== id);
  cache = d;
  persist();
}

function get(id) {
  return list().find((x) => x.id === id);
}

module.exports = { list, save, remove, get };
