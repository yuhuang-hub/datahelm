import React, { useEffect, useRef, useState } from 'react';
import { Button, Checkbox, Input, Modal, Progress, Radio, Space, message } from 'antd';
import { ExportOutlined, FolderOpenOutlined } from '@ant-design/icons';
import { dbApi, dbDump, pickSavePath, subscribeSyncProgress } from '../api';

// 请求关联 ID 自增序号（仅用于隔离并发导出的进度事件，非加密用途）
let DUMP_REQ_SEQ = 1;

// 数据库导出（转储 SQL 文件）：
//   state = { connId, db, schema, tables?, lockTables?, title? }
//   - tables 预置且 lockTables：单表导出入口（隐藏表选择列表）
//   - 否则加载全部表（含视图）供勾选，默认全选
//   内容三选一：架构+数据 / 仅架构 / 仅数据；主进程逐表写文件，进度经 syncProgress 通道（kind='dump'）实时回推
export default function DumpModal({ state, conns, onClose }) {
  const [tables, setTables] = useState(null); // null=加载中；[{name, checked}]
  const [content, setContent] = useState('all'); // all / structure / data
  const [file, setFile] = useState('');
  const [logs, setLogs] = useState([]);
  const [prog, setProg] = useState(null); // {table, index, total}
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const logRef = useRef(null);
  const reqRef = useRef(0); // 当前导出请求 id（0=无进行中的导出，迟到进度事件据此丢弃）
  const { connId, db, schema } = state || {};
  const conn = conns.find((c) => c.id === connId);

  useEffect(() => {
    if (!state) return undefined;
    const preset = state.tables && state.lockTables;
    setTables(preset ? state.tables.map((n) => ({ name: n, checked: true })) : null);
    setContent('all');
    setLogs([]);
    setProg(null);
    setBusy(false);
    setDone(false);
    reqRef.current = 0;
    const base = state.db || state.schema || (conns.find((c) => c.id === state.connId) || {}).name || 'export';
    setFile(`${base}.sql`);
    if (preset) return undefined;
    let alive = true;
    dbApi(state.connId, 'tables', { db: state.db, schema: state.schema })
      .then((list) => {
        if (alive) setTables(list.map((n) => ({ name: n, checked: true })));
      })
      .catch((e) => {
        if (alive) {
          setTables([]);
          setLogs((p) => [...p, { k: 'err', t: '读取表列表失败：' + e.message }]);
        }
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  // 进度订阅：只认当前请求（kind='dump' + reqId）；导出结束后 reqRef 归零，迟到事件全部丢弃
  useEffect(
    () =>
      subscribeSyncProgress((p) => {
        if (!p || p.kind !== 'dump' || p.reqId !== reqRef.current) return;
        setProg({ table: p.table || '', index: p.index || 0, total: p.total || 0 });
        setLogs((prev) => [...prev, { k: 'info', t: `[${p.index}/${p.total}] 正在导出 ${p.table}` }]);
      }),
    []
  );

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logs]);

  if (!state) return null;
  const selected = (tables || []).filter((t) => t.checked);
  const allChecked = !!tables && !!tables.length && tables.every((t) => t.checked);
  const toggle = (name, checked) => setTables((p) => (p || []).map((t) => (t.name === name ? { ...t, checked } : t)));
  const toggleAll = (checked) => setTables((p) => (p || []).map((t) => ({ ...t, checked })));
  const addLog = (k, t) => setLogs((p) => [...p, { k, t }]);
  const canRun = !busy && !!selected.length && !!file.trim();
  const suggestName = () => {
    const base = db || schema || (conn && conn.name) || 'export';
    const suffix = content === 'structure' ? '_structure' : content === 'data' ? '_data' : '';
    return `${base}${suffix}.sql`;
  };
  const browse = async () => {
    const p = await pickSavePath({
      title: '导出为 SQL 文件',
      defaultPath: file.trim() || suggestName(),
      filters: [{ name: 'SQL', extensions: ['sql'] }],
    });
    if (p) setFile(p);
  };
  const run = async () => {
    const reqId = 'dump' + (DUMP_REQ_SEQ += 1);
    reqRef.current = reqId;
    const mode = content === 'structure' ? '仅架构' : content === 'data' ? '仅数据' : '架构+数据';
    setBusy(true);
    setDone(false);
    setLogs([{ k: 'info', t: `开始导出：${selected.length} 个对象（${mode}）→ ${file}` }]);
    try {
      const r = await dbDump({ connId, db, schema, tables: selected.map((t) => t.name), content, file: file.trim(), reqId });
      reqRef.current = 0;
      (r.errors || []).forEach((e) => addLog('err', `${e.table}：失败：${e.error}`));
      addLog(r.errors && r.errors.length ? 'err' : 'ok', `结束：成功 ${r.ok}/${r.objects}${r.errors && r.errors.length ? `，失败 ${r.errors.length}` : ''}`);
      if (r.errors && r.errors.length) message.warning(`导出完成：成功 ${r.ok}、失败 ${r.errors.length}（详见日志）`);
      else message.success(`已导出 ${r.objects} 个对象：${r.file}`);
      setDone(true);
    } catch (e) {
      reqRef.current = 0;
      addLog('err', '导出失败：' + e.message);
      message.error('导出失败：' + e.message);
    } finally {
      setBusy(false);
    }
  };
  const percent = done ? 100 : prog && prog.total ? Math.round((prog.index / prog.total) * 100) : 0;
  return (
    <Modal
      open
      width={680}
      title={
        <span>
          <ExportOutlined style={{ color: '#0e8a6a', marginRight: 6 }} />
          {state.title || '导出数据库'}
        </span>
      }
      onCancel={() => {
        if (!busy) onClose();
      }}
      okText={busy ? '导出中…' : '开始导出'}
      cancelText={done ? '关闭' : '取消'}
      cancelButtonProps={{ disabled: busy }}
      confirmLoading={busy}
      okButtonProps={{ disabled: !canRun }}
      onOk={run}
    >
      <div style={{ display: 'flex', gap: 16 }}>
        {state.tables && state.lockTables ? (
          <div style={{ flex: '1 1 40%' }} data-dh-dump="objs">
            <div style={{ marginBottom: 4 }}>导出对象：</div>
            <div className="dh-tr-list">
              {state.tables.map((n) => (
                <div key={n} className="dh-tr-row" data-dh-dump-name={n} style={{ padding: '2px 10px' }}>
                  {n}
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div style={{ flex: '1 1 48%' }} data-dh-dump="tables">
            <div style={{ marginBottom: 4 }}>
              表（{conn ? conn.name : ''}
              {db || schema ? ` · ${db || schema}` : ''}）：
            </div>
            <div className="dh-tr-list">
              {tables === null ? (
                <div style={{ padding: 12, color: '#999' }}>表列表加载中…</div>
              ) : !tables.length ? (
                <div style={{ padding: 12, color: '#999' }}>无表</div>
              ) : (
                tables.map((t) => (
                  <div key={t.name} className="dh-tr-row" data-dh-dump-name={t.name}>
                    <Checkbox checked={t.checked} onChange={(e) => toggle(t.name, e.target.checked)}>
                      {t.name}
                    </Checkbox>
                  </div>
                ))
              )}
            </div>
            <div style={{ marginTop: 4 }}>
              <Checkbox checked={allChecked} disabled={!tables || !tables.length} onChange={(e) => toggleAll(e.target.checked)} data-dh-dump="all">
                全选
              </Checkbox>
              <span style={{ marginLeft: 8, color: '#999', fontSize: 12 }}>已选 {selected.length}/{tables ? tables.length : 0}</span>
            </div>
          </div>
        )}
        <div style={{ flex: '1 1 52%' }}>
          <div style={{ marginBottom: 4 }}>导出内容：</div>
          <Radio.Group value={content} onChange={(e) => setContent(e.target.value)} data-dh-dump="content">
            <Space direction="vertical" size={2}>
              <Radio value="all">架构 + 数据</Radio>
              <Radio value="structure">仅架构</Radio>
              <Radio value="data">仅数据</Radio>
            </Space>
          </Radio.Group>
          <div style={{ marginTop: 10, marginBottom: 4 }}>输出文件：</div>
          <Space.Compact style={{ width: '100%' }}>
            <Input value={file} onChange={(e) => setFile(e.target.value)} placeholder="选择或输入 .sql 文件路径" data-dh-dump="file" />
            <Button icon={<FolderOpenOutlined />} onClick={browse} disabled={busy} data-dh-dump="browse">
              浏览…
            </Button>
          </Space.Compact>
          <div style={{ color: '#999', fontSize: 12, marginTop: 10 }}>
            逐表转储为 SQL（数据每 500 行一批分页读取）；仅数据模式要求目标库已存在同名表。
          </div>
        </div>
      </div>
      {busy || prog ? (
        <div style={{ marginTop: 10 }} data-dh-dump="progress">
          <Progress percent={percent} size="small" status={busy ? 'active' : done ? 'success' : 'normal'} />
        </div>
      ) : null}
      <div
        ref={logRef}
        className="dh-tr-logs"
        data-dh-dump="logs"
        style={{ marginTop: 10, maxHeight: 150, overflow: 'auto', background: '#fafafa', border: '1px solid #eee', borderRadius: 4, padding: '6px 8px', fontSize: 12, fontFamily: 'Consolas, monospace' }}
      >
        {logs.length ? logs.map((x, i) => (
          <div key={i} data-dh-dump-log={x.k} style={{ color: x.k === 'err' ? '#cf1322' : x.k === 'ok' ? '#389e0d' : '#555' }}>
            {x.t}
          </div>
        )) : <div style={{ color: '#bbb' }}>执行日志</div>}
      </div>
    </Modal>
  );
}
