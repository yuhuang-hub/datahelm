'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  conn: {
    list: () => ipcRenderer.invoke('conn:list'),
    save: (c) => ipcRenderer.invoke('conn:save', c),
    remove: (id) => ipcRenderer.invoke('conn:delete', id),
    test: (cfg) => ipcRenderer.invoke('conn:test', cfg),
  },
  db: {
    open: (id) => ipcRenderer.invoke('db:open', id),
    close: (id) => ipcRenderer.invoke('db:close', id),
    call: (id, fn, args) => ipcRenderer.invoke('db:call', { id, fn, args }),
    transfer: (payload) => ipcRenderer.invoke('db:transfer', payload),
    syncCompare: (payload) => ipcRenderer.invoke('db:syncCompare', payload),
    dataCompare: (payload) => ipcRenderer.invoke('db:dataCompare', payload),
    onSyncProgress: (cb) => {
      const h = (_e, p) => { try { cb(p); } catch {} };
      ipcRenderer.on('db:syncProgress', h);
      return () => { try { ipcRenderer.removeListener('db:syncProgress', h); } catch {} };
    },
    dataApply: (payload) => ipcRenderer.invoke('db:dataApply', payload),
    dump: (payload) => ipcRenderer.invoke('db:dump', payload),
    explain: (payload) => ipcRenderer.invoke('db:explain', payload),
  },
  pickFile: (opts) => ipcRenderer.invoke('sys:pickFile', opts),
  imp: { parse: (file) => ipcRenderer.invoke('imp:parse', { file }) },
  pickDir: (opts) => ipcRenderer.invoke('sys:pickDir', opts),
  saveFile: (opts) => ipcRenderer.invoke('sys:saveFile', opts),
  pickSavePath: (opts) => ipcRenderer.invoke('sys:pickSavePath', opts),
  openPath: (p) => ipcRenderer.invoke('sys:openPath', p),
  copy: (text) => ipcRenderer.invoke('sys:copy', text),
  app: {
    onCloseRequest: (cb) => ipcRenderer.on('dh-close-request', () => cb()),
    confirmClose: () => ipcRenderer.send('dh-close-confirm'),
    requestClose: () => ipcRenderer.invoke('sys:requestClose'),
    uiReady: () => ipcRenderer.send('dh-ui-ready'),
  },
  queries: {
    list: () => ipcRenderer.invoke('queries:list'),
    save: (q) => ipcRenderer.invoke('queries:save', q),
    remove: (id) => ipcRenderer.invoke('queries:delete', id),
  },
  models: {
    list: (connId) => ipcRenderer.invoke('models:list', connId),
    save: (m) => ipcRenderer.invoke('models:save', m),
    remove: (id) => ipcRenderer.invoke('models:delete', id),
  },
  backup: {
    list: () => ipcRenderer.invoke('backup:list'),
    save: (sc) => ipcRenderer.invoke('backup:save', sc),
    remove: (id) => ipcRenderer.invoke('backup:delete', id),
    toggle: (id, enabled) => ipcRenderer.invoke('backup:toggle', { id, enabled }),
    run: (id) => ipcRenderer.invoke('backup:run', id),
    defaultDir: () => ipcRenderer.invoke('backup:defaultDir'),
    files: (dir) => ipcRenderer.invoke('backup:files', dir),
    runSqlFile: (payload) => ipcRenderer.invoke('db:runSqlFile', payload),
  },
});
