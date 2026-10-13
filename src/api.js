const bridge = window.api;

export const connApi = bridge.conn;
export const appApi = bridge.app;
export const dbOpen = bridge.db.open;
export const dbClose = bridge.db.close;
export const pickFile = bridge.pickFile;
// 导入向导：主进程解析（{ok,data|error} 包装在此解开）
export const impApi = {
  parse: async (file) => {
    const r = await bridge.imp.parse(file);
    if (!r) throw new Error('主进程无响应');
    if (!r.ok) throw new Error(r.error || '解析失败');
    return r.data;
  },
};
export const pickDir = bridge.pickDir;
export const saveFile = bridge.saveFile;
export const openPath = bridge.openPath;
export const copyText = bridge.copy;
export const queriesApi = bridge.queries;
export const modelApi = bridge.models;
export const backupApi = bridge.backup;

// 统一数据库调用：返回 {ok,data|error}
export async function dbApi(id, fn, args) {
  const r = await bridge.db.call(id, fn, args);
  if (!r) throw new Error('主进程无响应');
  if (!r.ok) throw new Error(r.error || '未知错误');
  return r.data;
}

// 数据传输（源连接已打开；目标由主进程另建会话）
export async function dbTransfer(payload) {
  const r = await bridge.db.transfer(payload);
  if (!r) throw new Error('主进程无响应');
  if (!r.ok) throw new Error(r.error || '未知错误');
  return r.data;
}

// 结构同步比较（源/目标会话由主进程按需打开；应用回走 dbApi 的 createTable/applyAlter/dropTable）
export async function dbSyncCompare(payload) {
  const r = await bridge.db.syncCompare(payload);
  if (!r) throw new Error('主进程无响应');
  if (!r.ok) throw new Error(r.error || '未知错误');
  return r.data;
}

// 数据同步：比较返回计数与预览 SQL；应用在主进程重新求差异后走参数化 changes 执行
export async function dbDataCompare(payload) {
  const r = await bridge.db.dataCompare(payload);
  if (!r) throw new Error('主进程无响应');
  if (!r.ok) throw new Error(r.error || '未知错误');
  return r.data;
}
export async function dbDataApply(payload) {
  const r = await bridge.db.dataApply(payload);
  if (!r) throw new Error('主进程无响应');
  if (!r.ok) throw new Error(r.error || '未知错误');
  return r.data;
}

// 同步比较进度订阅：主进程逐表回推 {kind,reqId,table,index,total}
// （kind=struct|data；reqId 由发起比较的页签生成，并发的两个比较互不串台）
export function subscribeSyncProgress(cb) {
  if (!bridge.db || !bridge.db.onSyncProgress) return () => {};
  return bridge.db.onSyncProgress(cb);
}

// 查询解释（EXPLAIN 执行计划）：主进程按方言包装语句（SHOWPLAN/QUERY PLAN 等）后执行并回传计划结果集
export async function dbExplain(payload) {
  const r = await bridge.db.explain(payload);
  if (!r) throw new Error('主进程无响应');
  if (!r.ok) throw new Error(r.error || '未知错误');
  return r.data;
}

// 运行 SQL 文件（还原备份）：列出备份目录 .sql 文件；执行走主进程 query 分发逐句原样执行
export async function backupFiles(dir) {
  return bridge.backup.files(dir);
}
export async function runSqlFile(payload) {
  const r = await bridge.backup.runSqlFile(payload);
  if (!r) throw new Error('主进程无响应');
  if (!r.ok) throw new Error(r.error || '未知错误');
  return r.data;
}
